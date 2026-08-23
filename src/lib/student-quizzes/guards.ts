import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { requireUser } from "@/lib/classes/guards";
import { internalError, notFound, unauthorized } from "@/lib/http";

/**
 * Feature guards for student practice-quiz route handlers.
 *
 * Two authz tiers (PLAN D-SQ6), matching the RLS policies exactly:
 *  - AUTHORING (create/edit/delete/share own quizzes): student role + creator
 *    filter. `created_by` IS the ownership model here (unlike lecturer quizzes,
 *    where ownership rides through the class).
 *  - PLAYING (resolve shared code / grade answers): any authenticated user —
 *    students AND lecturers. The DB SELECT policy has no role predicate either;
 *    these guards must never drift from it.
 *
 * Route handlers can be hit directly, so every handler self-checks. The owner
 * pre-check resolves the resource through RLS plus an explicit creator filter
 * so "not found" and "not allowed" are both a clean no-oracle 404.
 */

export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; response: Response };

export type OwnerResult =
  | { ok: true; userId: string; quiz: StudentQuizRow }
  | { ok: false; response: Response };

export type StudentQuizRow = {
  id: string;
  created_by: string;
  title: string;
  description: string | null;
  share_code: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Any authenticated user (no role predicate) — for the two play routes only.
 */
export async function requireAnyUser(
  supabase: SupabaseClient<Database>,
): Promise<AuthResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: unauthorized() };
  return { ok: true, userId: user.id };
}

/**
 * Resolve a student quiz as owned by the authenticated STUDENT (creator).
 * Returns 404 for missing/non-owned (no oracle), 503 for DB errors.
 */
export async function requireStudentQuizOwner(
  supabase: SupabaseClient<Database>,
  quizId: string,
): Promise<OwnerResult> {
  const auth = await requireUser(supabase, "student");
  if (!auth.ok) return auth;

  const { data: quiz, error } = await supabase
    .from("student_quizzes")
    .select(
      "id, created_by, title, description, share_code, created_at, updated_at",
    )
    .eq("id", quizId)
    .eq("created_by", auth.userId)
    .maybeSingle();

  if (error) {
    console.error("requireStudentQuizOwner error:", error);
    return { ok: false, response: internalError("Could not complete the request right now.") };
  }
  if (!quiz) return { ok: false, response: notFound() };

  return {
    ok: true,
    userId: auth.userId,
    quiz: quiz as unknown as StudentQuizRow,
  };
}
