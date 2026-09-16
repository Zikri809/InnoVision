import {
  DIGEST_TYPES,
  PINNED_TYPES,
  type NotificationItem,
  type NotificationType,
} from "./types";

/**
 * Panel row shaping (pure). Kept out of the bell component so the grouping
 * contract is unit-testable — the panel's row count intentionally differs
 * from the unread badge (grouping is presentation-only, PLAN §5.1).
 *
 * Callers pass items newest-first (the order `mergeNotifications` maintains),
 * so each group's `items[0]` is its newest member.
 */

export interface DigestGroup {
  type: NotificationType;
  /** Every event behind the row, newest first — ALL of them are unread. */
  items: NotificationItem[];
  newest: NotificationItem;
}

export interface Entry {
  key: string;
  item?: NotificationItem;
  group?: DigestGroup;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Groups unread digest events per entity (`class_id`, else `quiz_id`, else id). */
export function splitEntries(items: NotificationItem[]): {
  pinned: NotificationItem[];
  recent: Entry[];
} {
  const pinned = items.filter((n) => n.readAt == null && PINNED_TYPES.has(n.type));
  const pinnedIds = new Set(pinned.map((n) => n.id));
  const recent: Entry[] = [];
  const groups = new Map<string, DigestGroup>();
  for (const n of items) {
    if (pinnedIds.has(n.id)) continue;
    // Digest grouping applies to UNREAD events only: a read event renders as
    // its own row, so the badge and the row count diverge by design.
    if (n.readAt == null && DIGEST_TYPES.has(n.type)) {
      const entity = str(n.payload.class_id) ?? str(n.payload.quiz_id) ?? n.id;
      const gk = `${n.type}:${entity}`;
      const existing = groups.get(gk);
      if (existing) {
        existing.items.push(n);
      } else {
        const group: DigestGroup = { type: n.type, items: [n], newest: n };
        groups.set(gk, group);
        recent.push({ key: gk, group });
      }
    } else {
      recent.push({ key: n.id, item: n });
    }
  }
  return { pinned, recent };
}

/**
 * Every notification id a row stands for. A grouped row covers all its
 * members — marking only `newest` read left the rest unread, so the badge
 * barely moved and the row kept re-rendering as a smaller group.
 */
export function entryIds(entry: Entry): string[] {
  if (entry.group) return entry.group.items.map((n) => n.id);
  return entry.item ? [entry.item.id] : [];
}
