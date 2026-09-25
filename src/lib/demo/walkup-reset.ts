import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEMO_JOIN_CODE, DEMO_GUEST_EMAIL_DOMAIN } from "@/lib/demo/gate";

/**
 * Walk-up reset (PLAN_DEMO_MODE.md D6) — the safe, mid-day reset between talk
 * shows. It does NOT touch the showcase class or the lecturer's seeded history.
 *
 * Steps:
 *  1. Delete guest accounts older than `maxAgeHours` (FK cascade removes their
 *     enrollments, sessions, and answers). `maxAgeHours = 0` deletes ALL guests.
 *  2. Build the current guest-id set + locate the demo class.
 *  3. Strip non-guest enrollments from the demo class (a visitor who scanned
 *     with their REAL account before/after a show must not linger in the demo
 *     roster).
 *  4. Recreate a FRESH walk-up practice quiz by cloning the newest existing
 *     demo-class quiz's questions (quizzes are one-way lifecycle: recreate,
 *     never re-publish a closed/revealed row). The stale quizzes are deleted
 *     ONLY AFTER the replacement is verified live — a failed clone must never
 *     leave the demo class with nothing to play.
 *
 * Direct table writes under the service role (rather than an RPC) are the
 * deliberate posture for this booth-only reset: every other assessment write
 * goes through a SECURITY DEFINER RPC (ARCHITECTURE §6.4), but this path is
 * (a) flag+lecturer gated in the route, (b) not reachable in a production
 * deployment, and (c) exactly the seed-script posture. Documented exception.
 *
 * `scripts/demo-reset.mjs` mirrors these steps for CLI use (a bare node fetch
 * cannot present the SSR session cookie the route requires). `gate.test.ts`
 * pins the shared literals and `walkup-reset.test.ts` pins the failure-branch
 * ordering, so the two implementations cannot silently drift.
 */

/** Kept in sync with scripts/seed-demo.mjs and scripts/demo-reset.mjs. */
export const DEMO_LECTURER_EMAIL = "demo-lecturer@innovision.test";

export interface WalkupResetOptions {
  /** Delete guests older than this many hours. 0 = delete all guests. */
  maxAgeHours?: number;
  /** Skip the guest-deletion arm (e.g. a quiz-only refresh). */
  skipGuestPurge?: boolean;
}

export interface WalkupResetSummary {
  guestsDeleted: number;
  realEnrollmentsRemoved: number;
  quizRecreated: boolean;
  newQuizId: string | null;
  staleQuizzesDeleted: number;
  demoClassFound: boolean;
  /**
   * Why the quiz recreation did not happen (for the /demo operator). Absent on
   * success. Values: "questions_read_error" | "source_empty" | "create_failed"
   * | "insert_failed" | "publish_failed" | "no_lecturer".
   */
  quizRecreateFailedReason?: string;
}

const DEFAULT_MAX_AGE_HOURS = 2;

interface DemoUsers {
  /** Every current guest account id (email ends with the guest domain). */
  guestIds: Set<string>;
  /** The demo lecturer's auth id, or null when not seeded. */
  demoLecturerId: string | null;
  /** All users, for the purge arm. */
  users: { id: string; email?: string | null; created_at?: string | null }[];
}

/**
 * One paginated pass over auth users, shared by every arm of the reset so the
 * pagination logic cannot drift between them. Offsets are read before any
 * deletion, so there is no page-shift hazard.
 */
async function listDemoUsers(admin: SupabaseClient<Database>): Promise<DemoUsers> {
  const guestIds = new Set<string>();
  let demoLecturerId: string | null = null;
  const users: DemoUsers["users"] = [];

  for (let page = 1; page <= 40; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 500, page });
    if (error) break;
    const batch = data?.users ?? [];
    if (batch.length === 0) break;
    for (const u of batch) {
      users.push({ id: u.id, email: u.email, created_at: u.created_at });
      if (u.email?.endsWith(`@${DEMO_GUEST_EMAIL_DOMAIN}`)) guestIds.add(u.id);
      if (u.email === DEMO_LECTURER_EMAIL) demoLecturerId = u.id;
    }
    if (batch.length < 500) break;
  }

  return { guestIds, demoLecturerId, users };
}

export async function resetWalkup(
  admin: SupabaseClient<Database> = createAdminClient(),
  opts: WalkupResetOptions = {},
): Promise<WalkupResetSummary> {
  const maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const summary: WalkupResetSummary = {
    guestsDeleted: 0,
    realEnrollmentsRemoved: 0,
    quizRecreated: false,
    newQuizId: null,
    staleQuizzesDeleted: 0,
    demoClassFound: false,
  };

  const { guestIds, demoLecturerId, users } = await listDemoUsers(admin);

  // 1. Purge guests (auth.users delete cascades profile + enrollments + sessions
  //    + answers).
  if (!opts.skipGuestPurge) {
    const cutoffMs = Date.now() - maxAgeHours * 3600_000;
    const toDelete = users.filter(
      (u) =>
        u.email?.endsWith(`@${DEMO_GUEST_EMAIL_DOMAIN}`) &&
        (u.created_at ? Date.parse(u.created_at) : 0) <= cutoffMs,
    );
    for (const u of toDelete) {
      const { error } = await admin.auth.admin.deleteUser(u.id);
      if (!error) summary.guestsDeleted += 1;
    }
  }

  // 2. Locate the demo class.
  const { data: demoClass } = await admin
    .from("classes")
    .select("id")
    .eq("join_code", DEMO_JOIN_CODE)
    .maybeSingle();
  if (!demoClass?.id) return summary;
  summary.demoClassFound = true;

  // 3. Remove enrollments whose student is NOT a guest. A real-account visitor
  //    who scanned the demo QR is dropped from the demo roster.
  const { data: enrollments } = await admin
    .from("class_enrollments")
    .select("student_id")
    .eq("class_id", demoClass.id);
  const realIds = [...new Set((enrollments ?? []).map((e) => e.student_id))].filter(
    (id) => id && !guestIds.has(id),
  );
  if (realIds.length > 0) {
    const { error } = await admin
      .from("class_enrollments")
      .delete()
      .eq("class_id", demoClass.id)
      .in("student_id", realIds);
    if (!error) summary.realEnrollmentsRemoved = realIds.length;
  }

  // 4. Recreate the walk-up quiz from the newest existing demo-class quiz.
  const { data: quizzes } = await admin
    .from("quizzes")
    .select("id, created_at")
    .eq("class_id", demoClass.id)
    .order("created_at", { ascending: false });
  const source = quizzes?.[0];

  if (source && demoLecturerId) {
    const createdBy = demoLecturerId;
    const { data: questions, error: questionsError } = await admin
      .from("questions")
      .select(
        "order_index, type, prompt, options, correct_index, correct_indices, answer_key, explanation, max_score",
      )
      .eq("quiz_id", source.id)
      .order("order_index", { ascending: true });

    // A FAILED read or an EMPTY source must abort the recreation: publishing a
    // zero-question quiz is impossible (quiz_status_transition RAISES) and
    // would otherwise strand the source behind an empty replacement. Never
    // touch the source on either condition.
    if (questionsError || !questions || questions.length === 0) {
      summary.quizRecreateFailedReason = questionsError
        ? "questions_read_error"
        : "source_empty";
      return summary;
    }
    const qRows = questions;

    // insert-as-draft (quiz_status_transition forces it), then publish.
    const title = `Try InnoVision Live Demo (${new Date().toISOString().slice(0, 16).replace("T", " ")})`;
    const { data: created, error: createError } = await admin
      .from("quizzes")
      .insert({
        class_id: demoClass.id,
        created_by: createdBy,
        title,
        mode: "practice",
        time_limit_sec: null,
        gestures_enabled: false,
      })
      .select("id")
      .single();

    if (createError || !created?.id) {
      // Do NOT touch the source: with no replacement, deleting stale quizzes
      // would strand the demo class.
      summary.quizRecreateFailedReason = "create_failed";
      return summary;
    }

    const newQuizId = created.id;

    if (qRows.length > 0) {
      const { error: qError } = await admin.from("questions").insert(
        qRows.map((q) => ({
          quiz_id: newQuizId,
          order_index: q.order_index,
          type: q.type,
          prompt: q.prompt,
          options: q.options,
          correct_index: q.correct_index,
          correct_indices: q.correct_indices,
          answer_key: q.answer_key,
          explanation: q.explanation,
          max_score: q.max_score,
        })),
      );
      if (qError) {
        // Half-built quiz: remove it and leave the source in place.
        await admin.from("quizzes").delete().eq("id", newQuizId);
        summary.quizRecreateFailedReason = "insert_failed";
        return summary;
      }
    }

    const { error: publishError } = await admin
      .from("quizzes")
      .update({ status: "live" })
      .eq("id", newQuizId);
    if (publishError) {
      await admin.from("quizzes").delete().eq("id", newQuizId);
      summary.quizRecreateFailedReason = "publish_failed";
      return summary;
    }

    // Replacement is verified live — NOW prune the stale walk-up quizzes.
    const staleIds = (quizzes ?? [])
      .map((q) => q.id)
      .filter((id) => id !== newQuizId);
    if (staleIds.length > 0) {
      const { count } = await admin
        .from("quizzes")
        .delete({ count: "exact" })
        .in("id", staleIds);
      summary.staleQuizzesDeleted = count ?? 0;
    }
    summary.quizRecreated = true;
    summary.newQuizId = newQuizId;
  } else if (source && !demoLecturerId) {
    // Demo class + a quiz exist but the seeded demo lecturer is gone: surface a
    // reason so /demo tells the operator to re-run seed:demo rather than
    // silently leaving a stale quiz.
    summary.quizRecreateFailedReason = "no_lecturer";
  }

  return summary;
}
