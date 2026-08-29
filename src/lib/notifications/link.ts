import type { NotificationType } from "./types";

/**
 * Client-derived deep links (D-decision in PLAN_NOTIFICATIONS §2: no
 * link_url column — routes stay in code, not in historical rows).
 *
 * List-page targets never probe. Entity targets whose destination can 404
 * after source deletion (quizzes are deletable while unattempted; sessions
 * are reset-cascadeable) carry a probe so the caller can intercept the miss
 * (toast/redirect/mark-read).
 */
export interface ResolvedLink {
  href: string;
  /** RLS-scoped existence check to run before navigating. */
  probe?: { table: "quizzes" | "quiz_sessions"; id: string };
  /**
   * `results_revealed` fallback chain: try to resolve the caller's own
   * completed session for this quiz → /play/[sessionId], else href.
   */
  resolveSessionQuizId?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function resolveNotificationLink(
  type: NotificationType,
  payload: Record<string, unknown>,
): ResolvedLink {
  const quizId = str(payload.quiz_id);
  const classId = str(payload.class_id);
  const sessionId = str(payload.session_id);

  switch (type) {
    // Student list pages — always valid, no probe.
    case "quiz_live":
    case "session_reset":
    case "quiz_closed":
      return { href: "/student/quizzes" };
    case "results_revealed":
      return {
        href: "/student/quizzes",
        resolveSessionQuizId: quizId,
      };
    // IO-1: the student is told their flagged attempt is unlocked — land
    // them back IN the attempt (probe first: the session may have been
    // reset since; RLS own-sessions makes the probe self-scoping).
    case "session_unlocked":
      return sessionId
        ? {
            href: `/play/${sessionId}`,
            probe: { table: "quiz_sessions", id: sessionId },
          }
        : { href: "/student/quizzes" };
    case "removed_from_class":
    case "class_archived":
      return { href: "/student/classes" };

    // Lecturer class page — classes archive (never hard-delete via app), and
    // the lecturer owns it; no probe.
    case "student_joined":
      return { href: `/lecturer/classes/${classId ?? ""}` };
    case "face_enrollment_held":
      return { href: "/lecturer/classes" };

    // Lecturer quiz links — actions live on the results dashboard, not the
    // read-only session detail page. Draft quizzes are deletable with
    // cascade, so probe first.
    default:
      return quizId
        ? {
            href: `/lecturer/quizzes/${quizId}/results`,
            probe: { table: "quizzes", id: quizId },
          }
        : { href: "/lecturer/quizzes" };
  }
}
