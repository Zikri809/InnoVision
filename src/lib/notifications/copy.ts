import type { NotificationType } from "./types";

/**
 * Typed copy map — every notification type must resolve its keys in BOTH
 * locales (asserted by the U3 unit test); t() keys are never built outside
 * this record (the i18n checker validates literal args only).
 *
 * `byMode` lets a type render mode-specific copy (payload.mode is whitelisted
 * in the 0022 quiz_live payload): students must be able to tell a practice
 * quiz from an assessment at headline-glance.
 */
export interface NotificationCopy {
  titleKey: string;
  bodyKey: string;
}

export const NOTIF_COPY: Record<
  NotificationType,
  NotificationCopy & { byMode?: Record<"practice" | "assessment", NotificationCopy> }
> = {
  quiz_live: {
    titleKey: "items.quiz_live.title",
    bodyKey: "items.quiz_live.body",
    byMode: {
      practice: {
        titleKey: "items.quiz_live.practice.title",
        bodyKey: "items.quiz_live.practice.body",
      },
      assessment: {
        titleKey: "items.quiz_live.assessment.title",
        bodyKey: "items.quiz_live.assessment.body",
      },
    },
  },
  results_revealed: { titleKey: "items.results_revealed.title", bodyKey: "items.results_revealed.body" },
  session_reset: { titleKey: "items.session_reset.title", bodyKey: "items.session_reset.body" },
  removed_from_class: { titleKey: "items.removed_from_class.title", bodyKey: "items.removed_from_class.body" },
  class_archived: { titleKey: "items.class_archived.title", bodyKey: "items.class_archived.body" },
  student_joined: { titleKey: "items.student_joined.title", bodyKey: "items.student_joined.body" },
  session_submitted: { titleKey: "items.session_submitted.title", bodyKey: "items.session_submitted.body" },
  session_flagged: { titleKey: "items.session_flagged.title", bodyKey: "items.session_flagged.body" },
  quiz_completed_all: { titleKey: "items.quiz_completed_all.title", bodyKey: "items.quiz_completed_all.body" },
  incident_clip_recorded: { titleKey: "items.incident_clip_recorded.title", bodyKey: "items.incident_clip_recorded.body" },
  face_unavailable_reported: { titleKey: "items.face_unavailable_reported.title", bodyKey: "items.face_unavailable_reported.body" },
  face_enrollment_held: { titleKey: "items.face_enrollment_held.title", bodyKey: "items.face_enrollment_held.body" },
  quiz_closed: { titleKey: "items.quiz_closed.title", bodyKey: "items.quiz_closed.body" },
};

export const DIGEST_COPY_KEYS = [
  "digest.student_joined",
  "digest.session_submitted",
  "digest.quiz_completed_all",
  "digest.incident_clip_recorded",
] as const;

/** Mode-aware copy resolution (payload.mode drives quiz_live variants). */
export function copyFor(
  type: NotificationType,
  payload: Record<string, unknown>,
): NotificationCopy {
  const copy = NOTIF_COPY[type];
  if (copy.byMode) {
    const mode = payload.mode === "assessment" ? "assessment" : "practice";
    return copy.byMode[mode];
  }
  return copy;
}

/** Static panel/bell chrome keys that must exist alongside item copy. */
export const PANEL_KEYS = [
  "bell.label",
  "bell.labelUnread",
  "panel.title",
  "panel.markAllRead",
  "panel.loadMore",
  "panel.pinnedLabel",
  "panel.emptyTitle",
  "panel.emptyBody",
  "panel.sheetDescription",
  "panel.clearConfirmTitle",
  "panel.clearConfirmBody",
  "a11y.newCount",
] as const;
