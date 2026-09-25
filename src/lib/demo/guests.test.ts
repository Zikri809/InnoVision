import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import {
  randomGuestMatric,
  randomGuestPassword,
  randomGuestEmailLocalPart,
  guestDisplayName,
  isUniqueViolation,
  joinDemoClass,
  DEMO_GUEST_EMAIL_DOMAIN,
} from "@/lib/demo/guests";
import { DEMO_JOIN_CODE } from "@/lib/demo/gate";

/**
 * Demo guest helpers (PLAN_DEMO_MODE.md D2).
 *
 * The unit suite covers the PURE helpers and the join-RPC result mapping. The
 * route's provisioning path (createUser + sign-in + cookie) is exercised in the
 * route test with a mocked admin client.
 */

describe("randomGuestMatric", () => {
  it("is always a 6-digit 98xxxx value (never the reserved 99xxxx range)", () => {
    for (let i = 0; i < 2000; i++) {
      const m = randomGuestMatric();
      expect(m).toMatch(/^98[0-9]{4}$/);
      expect(m).not.toMatch(/^99/);
    }
  });

  it("covers both ends of the 980000–989999 range (not clamped)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(randomGuestMatric());
    const numeric = [...seen].map(Number);
    expect(Math.min(...numeric)).toBeGreaterThanOrEqual(980_000);
    expect(Math.max(...numeric)).toBeLessThanOrEqual(989_999);
    // Sanity: a random draw over 10k values should hit a spread of buckets.
    expect(new Set([...seen].map((m) => m.slice(0, 4))).size).toBeGreaterThan(3);
  });
});

describe("randomGuestPassword / email local-part", () => {
  it("produces distinct, non-trivial values", () => {
    const passwords = new Set(Array.from({ length: 200 }, () => randomGuestPassword()));
    expect(passwords.size).toBe(200);
    for (const p of passwords) expect(p.length).toBeGreaterThanOrEqual(20);

    const locals = new Set(Array.from({ length: 200 }, () => randomGuestEmailLocalPart()));
    expect(locals.size).toBe(200);
    for (const l of locals) expect(l).toMatch(/^guest-[0-9a-f]{8}$/);
  });
});

describe("guestDisplayName", () => {
  it("formats the roster label", () => {
    expect(guestDisplayName(1)).toBe("Guest #1 (Visitor)");
    expect(guestDisplayName(42)).toBe("Guest #42 (Visitor)");
  });

  it("never exceeds the profiles.full_name CHECK bound (120)", () => {
    const name = guestDisplayName(Number.MAX_SAFE_INTEGER);
    expect(name.length).toBeLessThanOrEqual(120);
  });
});

describe("isUniqueViolation", () => {
  it("detects Postgres 23505 across error shapes", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(
      isUniqueViolation({ message: 'duplicate key value violates unique constraint "profiles_matric_no_unique"' }),
    ).toBe(true);
    expect(isUniqueViolation({ message: "A user with this email address has already been registered" })).toBe(true);
  });

  it("is false for unrelated errors and nullish input", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation({ code: "42P01", message: "relation does not exist" })).toBe(false);
  });
});

/** Minimal rpc-only fake for the user client. */
function rpcClient(impl: SupabaseClient<Database>["rpc"]): SupabaseClient<Database> {
  return { rpc: impl } as unknown as SupabaseClient<Database>;
}

describe("joinDemoClass", () => {
  it("calls join_class with the demo code and treats a class result as success", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { class: { id: "c1", title: "InnoVision Live Demo" } },
      error: null,
    });
    const res = await joinDemoClass(rpcClient(rpc));
    expect(res).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("join_class", { code: DEMO_JOIN_CODE });
  });

  it("treats already_enrolled as success (idempotent)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { error: "already_enrolled" }, error: null });
    expect(await joinDemoClass(rpcClient(rpc))).toEqual({ ok: true });
  });

  it("maps a transport error to join_unavailable (never a raw message)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await joinDemoClass(rpcClient(rpc))).toEqual({ ok: false, error: "join_unavailable" });
  });

  it("maps non-object / unknown RPC payloads to a typed failure, never a crash", async () => {
    for (const data of [null, 42, "x", { error: "matric_required" }, { error: "invalid_code" }]) {
      const rpc = vi.fn().mockResolvedValue({ data, error: null });
      const res = await joinDemoClass(rpcClient(rpc));
      expect(res.ok).toBe(false);
      expect(typeof res.error).toBe("string");
    }
  });
});

describe("DEMO_GUEST_EMAIL_DOMAIN", () => {
  it("is the demo domain the reset selector relies on", () => {
    expect(DEMO_GUEST_EMAIL_DOMAIN).toBe("demo.innovision.test");
  });
});
