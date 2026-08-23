import { describe, expect, it } from "vitest";
import { mergeNotifications } from "../merge";
import type { NotificationItem } from "../types";

function item(seq: number, id = `n${seq}`, readAt: string | null = null): NotificationItem {
  return { id, seq, type: "quiz_live", payload: {}, readAt, createdAt: new Date(0).toISOString() };
}

describe("mergeNotifications", () => {
  it("merges arrivals, dedupes by id, sorts by seq desc", () => {
    const prev = [item(1), item(3)];
    const incoming = [item(2), item(3, "n3", new Date().toISOString())];
    const out = mergeNotifications(prev, incoming);
    expect(out.map((n) => n.seq)).toEqual([3, 2, 1]);
  });

  it("incoming rows win on id conflict (fresh server state)", () => {
    const prev = [item(5, "n5", null)];
    const incoming = [item(5, "n5", "2026-01-01T00:00:00Z")];
    const out = mergeNotifications(prev, incoming);
    expect(out[0].readAt).toBe("2026-01-01T00:00:00Z");
  });

  it("caps the list length", () => {
    const prev = Array.from({ length: 30 }, (_, i) => item(i + 1));
    const out = mergeNotifications(prev, [], 20);
    expect(out).toHaveLength(20);
    expect(out[0].seq).toBe(30);
  });

  it("handles empty inputs", () => {
    expect(mergeNotifications([], [])).toEqual([]);
  });
});
