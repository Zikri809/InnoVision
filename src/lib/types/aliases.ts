import type { Database } from "@/lib/types/database";

/**
 * Convenience aliases over the generated Supabase types.
 *
 * Kept in their own file (NOT appended to database.ts) so that regenerating
 * types with `npm run gen:types` can never silently drop them.
 */

export type UserRole = Database["public"]["Enums"]["user_role"];

export type SupportedLocale = "en" | "ms";

export type Profile = Database["public"]["Tables"]["profiles"]["Row"] & {
  locale?: SupportedLocale;
};

export type Class = Database["public"]["Tables"]["classes"]["Row"];
export type ClassEnrollment = Database["public"]["Tables"]["class_enrollments"]["Row"];
export type StudentClassView = Database["public"]["Views"]["student_class_view"]["Row"];
export type StudentRosterView = Database["public"]["Views"]["student_roster_view"]["Row"];

export type QuizMode = Database["public"]["Enums"]["quiz_mode"];

export type QuizStatus = Database["public"]["Enums"]["quiz_status"];

export type QuestionType = Database["public"]["Enums"]["question_type"];

export type Quiz = Database["public"]["Tables"]["quizzes"]["Row"];

export type Question = Database["public"]["Tables"]["questions"]["Row"];

export type SessionStatus = Database["public"]["Enums"]["session_status"];

export type QuizSession = Database["public"]["Tables"]["quiz_sessions"]["Row"];

export type SessionAnswer = Database["public"]["Tables"]["session_answers"]["Row"];

export type FaceCheckTrigger = Database["public"]["Enums"]["face_check_trigger"];

export type FaceCheck = Database["public"]["Tables"]["face_checks"]["Row"];

export type AuditEvent = Database["public"]["Tables"]["audit_events"]["Row"];

export type LecturerAuditEvent =
  Database["public"]["Views"]["lecturer_audit_view"]["Row"];

export type LecturerClassCard = Pick<
  Class,
  "id" | "title" | "join_code" | "created_at" | "archived_at"
> & {
  quizCount: number;
};

export type ArchivedClassCard = Pick<
  Class,
  "id" | "title" | "join_code" | "created_at" | "archived_at"
> & {
  quizCount: number;
};

