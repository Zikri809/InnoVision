/**
 * Notification domain types shared by the bell UI and the realtime/poll
 * pipeline. Mirrors `public.notification_type` + `public.notifications`
 * (migration 0022) and docs/PLAN_NOTIFICATIONS.md §1 urgency tiers.
 */
export const NOTIFICATION_TYPES = [
  "quiz_live",
  "results_revealed",
  "session_reset",
  "removed_from_class",
  "class_archived",
  "student_joined",
  "session_submitted",
  "session_flagged",
  "quiz_completed_all",
  "incident_clip_recorded",
  "face_unavailable_reported",
  "face_enrollment_held",
  "quiz_closed",
  "session_unlocked",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Renders in the panel's pinned "Needs attention" section while unread. */
export const PINNED_TYPES: ReadonlySet<NotificationType> = new Set([
  "session_reset",
  "removed_from_class",
  "class_archived",
  "session_flagged",
  "face_unavailable_reported",
  "face_enrollment_held",
  "session_unlocked",
]);

/** Grouped per entity in the UI ("12 new submissions"); never pinned. */
export const DIGEST_TYPES: ReadonlySet<NotificationType> = new Set([
  "student_joined",
  "session_submitted",
  "quiz_completed_all",
  "incident_clip_recorded",
]);

export interface NotificationItem {
  id: string;
  seq: number;
  type: NotificationType;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

/** Raw postgres_changes / select row shape from Supabase. */
export interface RawNotificationRow {
  id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

export function isNotificationType(value: unknown): value is NotificationType {
  return (
    typeof value === "string" &&
    (NOTIFICATION_TYPES as readonly string[]).includes(value)
  );
}

export function mapRawRow(row: RawNotificationRow): NotificationItem | null {
  if (!isNotificationType(row.type)) return null;
  return {
    id: row.id,
    seq: Number(row.seq),
    type: row.type,
    payload: row.payload ?? {},
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}
