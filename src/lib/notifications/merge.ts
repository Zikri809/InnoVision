import type { NotificationItem } from "./types";

/**
 * Pure merge of realtime/poll arrivals into the rendered list (U1).
 * Dedupe by id (realtime + poll overlap by design), newest-seq first,
 * capped so a fan-out burst cannot grow the list unbounded.
 */
export function mergeNotifications(
  prev: NotificationItem[],
  incoming: NotificationItem[],
  cap = 100,
): NotificationItem[] {
  const byId = new Map<string, NotificationItem>();
  for (const item of prev) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()]
    .sort((a, b) => b.seq - a.seq)
    .slice(0, cap);
}
