import { describe, expect, it } from "vitest";
import { entryIds, splitEntries } from "../digest";
import type { NotificationItem, NotificationType } from "../types";

function item(
  seq: number,
  type: NotificationType,
  payload: Record<string, unknown> = {},
  readAt: string | null = null,
): NotificationItem {
  return {
    id: `n${seq}`,
    seq,
    type,
    payload,
    readAt,
    createdAt: new Date(0).toISOString(),
  };
}

/** Newest-first, the order mergeNotifications maintains. */
const newestFirst = (items: NotificationItem[]) =>
  [...items].sort((a, b) => b.seq - a.seq);

describe("splitEntries", () => {
  it("groups unread digest events per entity and counts every member", () => {
    const items = newestFirst([
      item(1, "student_joined", { class_id: "c1" }),
      item(2, "student_joined", { class_id: "c1" }),
      item(3, "student_joined", { class_id: "c1" }),
      item(4, "student_joined", { class_id: "c1" }),
    ]);
    const { recent, pinned } = splitEntries(items);
    expect(pinned).toHaveLength(0);
    expect(recent).toHaveLength(1);
    expect(recent[0].group?.items).toHaveLength(4);
    // The rendered row is the newest event of the group.
    expect(recent[0].group?.newest.seq).toBe(4);
  });

  it("keeps distinct entities in distinct groups", () => {
    const items = newestFirst([
      item(1, "session_submitted", { quiz_id: "q1" }),
      item(2, "session_submitted", { quiz_id: "q2" }),
      item(3, "session_submitted", { quiz_id: "q1" }),
    ]);
    const { recent } = splitEntries(items);
    expect(recent).toHaveLength(2);
    expect(recent.map((e) => e.group?.items.length).sort()).toEqual([1, 2]);
  });

  it("falls back to the row id when the payload carries no entity", () => {
    const items = newestFirst([
      item(1, "incident_clip_recorded", {}),
      item(2, "incident_clip_recorded", {}),
    ]);
    const { recent } = splitEntries(items);
    // No class_id/quiz_id → each event is its own group, never merged blindly.
    expect(recent).toHaveLength(2);
  });

  it("does NOT group read digest events (they render as their own rows)", () => {
    const items = newestFirst([
      item(1, "student_joined", { class_id: "c1" }, "2026-01-01T00:00:00Z"),
      item(2, "student_joined", { class_id: "c1" }, "2026-01-01T00:00:00Z"),
    ]);
    const { recent } = splitEntries(items);
    expect(recent).toHaveLength(2);
    expect(recent.every((e) => e.item !== undefined)).toBe(true);
  });

  it("splits unread pinned types into the pinned section, not the digest", () => {
    const items = newestFirst([
      item(1, "session_flagged", { quiz_id: "q1" }),
      item(2, "session_flagged", { quiz_id: "q1" }),
      item(3, "student_joined", { class_id: "c1" }),
    ]);
    const { pinned, recent } = splitEntries(items);
    expect(pinned.map((n) => n.seq)).toEqual([2, 1]);
    expect(recent).toHaveLength(1);
    expect(recent[0].group?.type).toBe("student_joined");
  });

  it("pinned rows leave the pinned section once read (row stays in recent)", () => {
    const items = newestFirst([
      item(1, "session_flagged", { quiz_id: "q1" }, "2026-01-01T00:00:00Z"),
    ]);
    const { pinned, recent } = splitEntries(items);
    expect(pinned).toHaveLength(0);
    expect(recent).toHaveLength(1);
    expect(recent[0].item?.readAt).toBe("2026-01-01T00:00:00Z");
  });
});

describe("entryIds", () => {
  it("returns every id behind a grouped row", () => {
    const items = newestFirst([
      item(1, "student_joined", { class_id: "c1" }),
      item(2, "student_joined", { class_id: "c1" }),
      item(3, "student_joined", { class_id: "c1" }),
      item(4, "student_joined", { class_id: "c1" }),
    ]);
    const { recent } = splitEntries(items);
    // Regression: tapping the row used to mark only `newest`, leaving 3 unread
    // so the badge barely moved and the row re-rendered as a smaller group.
    expect(entryIds(recent[0])).toEqual(["n4", "n3", "n2", "n1"]);
  });

  it("returns the single id for a plain row", () => {
    const { recent } = splitEntries([item(1, "quiz_live", { quiz_id: "q1" })]);
    expect(entryIds(recent[0])).toEqual(["n1"]);
  });

  it("never returns an empty list for a rendered entry", () => {
    const items = newestFirst([
      item(1, "student_joined", { class_id: "c1" }),
      item(2, "session_flagged", { quiz_id: "q1" }),
    ]);
    const { pinned, recent } = splitEntries(items);
    for (const entry of [...recent, { key: "p", item: pinned[0] }]) {
      expect(entryIds(entry).length).toBeGreaterThan(0);
    }
  });
});
