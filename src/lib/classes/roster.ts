import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

export type RosterEntry = {
  student_id: string;
  enrolled_at: string;
  full_name: string | null;
  /** profiles.matric_no (0027) — appended to the roster view for exports. */
  matric_no: string | null;
};

/**
 * Fetch the roster for a class via the student_roster_view: enrollments joined
 * with student full names + matric numbers, scoped by is_lecturer_of_class.
 * Used by both the lecturer detail page and the GET /api/classes/[id] route so
 * the fetch lives in one place. `enrolled_at` is a string (ISO) from PostgREST.
 *
 * The view projects ONLY student_id/full_name/enrolled_at/matric_no — it can
 * never expose biometric data (face_enrollment_status) or other profile
 * columns to a lecturer (security audit MED-3; matric added by 0027 as
 * directory data). Direct `profiles` SELECT is self-only.
 */
export const ROSTER_LIMIT = 100;

export async function getClassRoster(
  supabase: SupabaseClient<Database>,
  classId: string,
): Promise<{ roster: RosterEntry[]; error: string | null }> {
  const { data: rows, error } = await supabase
    .from("student_roster_view")
    .select("student_id, full_name, enrolled_at, matric_no")
    .eq("class_id", classId)
    .order("enrolled_at", { ascending: true })
    .limit(ROSTER_LIMIT);

  if (error) return { roster: [], error: error.message };

  // The view's generated types mark columns nullable; the underlying columns
  // are NOT NULL. Narrow to the non-null shape the client expects.
  const roster = (rows ?? [])
    .filter((r) => r.student_id && r.enrolled_at)
    .map((r) => ({
      student_id: r.student_id!,
      enrolled_at: r.enrolled_at!,
      full_name: r.full_name,
      matric_no: r.matric_no ?? null,
    }));

  return { roster, error: null };
}
