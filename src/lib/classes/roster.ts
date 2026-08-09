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
};

/**
 * Fetch the roster for a class: enrollments joined with student full names.
 * Used by both the lecturer detail page and the GET /api/classes/[id] route so
 * the two-step fetch lives in one place. `enrolled_at` is a string (ISO) from
 * PostgREST.
 */
export async function getClassRoster(
  supabase: SupabaseClient<Database>,
  classId: string,
): Promise<{ roster: RosterEntry[]; error: string | null }> {
  const { data: enrollmentRows, error: enrollmentError } = await supabase
    .from("class_enrollments")
    .select("student_id, enrolled_at")
    .eq("class_id", classId)
    .order("enrolled_at", { ascending: true })
    .limit(500);

  if (enrollmentError) return { roster: [], error: enrollmentError.message };

  const rows = enrollmentRows ?? [];
  const studentIds = rows.map((r) => r.student_id);
  let nameById = new Map<string, string | null>();

  if (studentIds.length > 0) {
    const { data: students, error: studentsError } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", studentIds);
    if (studentsError) return { roster: [], error: studentsError.message };
    nameById = new Map((students ?? []).map((s) => [s.id, s.full_name]));
  }

  const roster = rows.map((e) => ({
    student_id: e.student_id,
    enrolled_at: e.enrolled_at,
    full_name: nameById.get(e.student_id) ?? null,
  }));

  return { roster, error: null };
}
