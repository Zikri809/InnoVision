import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { requireUser } from "@/lib/classes/guards";
import { internalError, notFound } from "@/lib/http";

/**
 * Feature guards for quiz/question route handlers.
 *
 * Route handlers can be hit directly (bypassing page layouts), so every
 * handler self-checks. Pattern mirrors lib/classes/guards.ts:
 *  - `requireUser` resolves the authenticated lecturer (reused from classes).
 *  - the *owner* pre-check resolves the resource through RLS and an explicit
 *    owner filter so "not found" and "not allowed" are both a clean 404 —
 *    never an oracle about which class/quiz exists.
 *
 * Ownership is CLASS ownership (`quiz.class_id → classes.lecturer_id =
 * auth.uid()`), matching the RLS policies exactly — NOT `created_by`, which
 * could drift. This is the single source of truth for "can this lecturer
 * mutate this quiz?".
 */

export type OwnerResult =
  | { ok: true; userId: string }
  | { ok: false; response: Response };

/**
 * Resolve a class as owned by the authenticated lecturer.
 * Returns 404 for missing/non-owned (no oracle), 503 for DB errors.
 */
export async function requireClassOwner(
  supabase: SupabaseClient<Database>,
  classId: string,
): Promise<OwnerResult> {
  const auth = await requireUser(supabase, "lecturer");
  if (!auth.ok) return auth;

  const { data: cls, error } = await supabase
    .from("classes")
    .select("id")
    .eq("id", classId)
    .eq("lecturer_id", auth.userId)
    .maybeSingle();

  if (error) {
    console.error("requireClassOwner error:", error);
    return { ok: false, response: internalError("Could not complete the request right now.") };
  }
  if (!cls) return { ok: false, response: notFound() };

  return { ok: true, userId: auth.userId };
}

/**
 * Resolve a quiz as owned by the authenticated lecturer (via its class).
 * Also returns the quiz row so callers avoid a second fetch.
 */
export async function requireQuizOwner(
  supabase: SupabaseClient<Database>,
  quizId: string,
): Promise<
  | {
      ok: true;
      userId: string;
      quiz: {
        id: string;
        class_id: string;
        title: string;
        mode: Database["public"]["Enums"]["quiz_mode"];
        status: Database["public"]["Enums"]["quiz_status"];
        time_limit_sec: number | null;
      };
    }
  | { ok: false; response: Response }
> {
  const auth = await requireUser(supabase, "lecturer");
  if (!auth.ok) return auth;

  // Single owner-filtered query: the inner join to classes with an explicit
  // lecturer_id filter resolves ownership in ONE round trip (not two) while
  // keeping the no-oracle 404 semantics — a non-owner lecturer (or a quiz that
  // doesn't exist) gets zero rows → 404. RLS is the backstop; the explicit
  // filter is what makes this guard not silently depend on RLS.
  //
  // The joined `classes.lecturer_id` column is used ONLY as the filter — it is
  // not returned to callers. We build the returned quiz from explicit fields so
  // the idempotent publish path can never leak the nested classes payload.
  const { data: row, error } = await supabase
    .from("quizzes")
    .select(
      "id, class_id, title, mode, status, time_limit_sec, classes!inner(lecturer_id)",
    )
    .eq("id", quizId)
    .eq("classes.lecturer_id", auth.userId)
    .maybeSingle();

  if (error) {
    console.error("requireQuizOwner error:", error);
    return { ok: false, response: internalError("Could not complete the request right now.") };
  }
  if (!row) return { ok: false, response: notFound() };

  const quiz = {
    id: row.id,
    class_id: row.class_id,
    title: row.title,
    mode: row.mode,
    status: row.status,
    time_limit_sec: row.time_limit_sec,
  };

  return { ok: true, userId: auth.userId, quiz };
}
