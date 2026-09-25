import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEMO_JOIN_CODE,
  DEMO_GUEST_EMAIL_DOMAIN,
  isDemoModeEnabled,
  isGuestEmail,
} from "@/lib/demo/gate";
import { normalizeJoinCode } from "@/lib/classes/join-code";

/**
 * Demo-mode gate invariants (PLAN_DEMO_MODE.md).
 *
 * The load-bearing assertions:
 *  1. the flag is explicit-only (`"1"`), never dev-auto-on;
 *  2. DEMO_JOIN_CODE is a LEGAL join code (the DB CHECK alphabet excludes
 *     O/0/1/I/L) and survives normalizeJoinCode unchanged — the middleware/page
 *     predicates compare normalized input against it;
 *  3. DEMO_JOIN_CODE matches the literal seeded in scripts/seed-demo.mjs
 *     (a drift here would silently break the QR walk-up flow);
 *  4. isGuestEmail only matches the demo domain.
 */

const ORIGINAL = process.env.NEXT_PUBLIC_DEMO_MODE;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_DEMO_MODE;
  else process.env.NEXT_PUBLIC_DEMO_MODE = ORIGINAL;
});

describe("isDemoModeEnabled", () => {
  it("is true only for the exact string '1'", () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "1";
    expect(isDemoModeEnabled()).toBe(true);

    for (const off of ["0", "", "true", "yes", "on", "1 ", "01", undefined]) {
      if (off === undefined) delete process.env.NEXT_PUBLIC_DEMO_MODE;
      else process.env.NEXT_PUBLIC_DEMO_MODE = off;
      expect(isDemoModeEnabled(), `value=${JSON.stringify(off)}`).toBe(false);
    }
  });

  it("is NOT auto-on in development (explicit-only, unlike the dev playground)", () => {
    // The module reads a single env var with no NODE_ENV branch; pin that by
    // unsetting the flag and asserting false regardless of NODE_ENV.
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    expect(isDemoModeEnabled()).toBe(false);
  });
});

describe("DEMO_JOIN_CODE", () => {
  it("is a legal normalized join code", () => {
    expect(normalizeJoinCode(DEMO_JOIN_CODE)).toBe(DEMO_JOIN_CODE);
    expect(DEMO_JOIN_CODE).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });

  it("normalizes from lower/space/dash variants to the constant", () => {
    for (const variant of [
      DEMO_JOIN_CODE.toLowerCase(),
      ` ${DEMO_JOIN_CODE} `,
      `${DEMO_JOIN_CODE.slice(0, 3)}-${DEMO_JOIN_CODE.slice(3)}`,
    ]) {
      expect(normalizeJoinCode(variant)).toBe(DEMO_JOIN_CODE);
    }
  });

  it("MATCHES the join code literalled in scripts/seed-demo.mjs (drift guard)", () => {
    const seed = readFileSync(
      path.join(process.cwd(), "scripts", "seed-demo.mjs"),
      "utf8",
    );
    // The demo class is seeded with an explicit literal; find it.
    expect(seed).toContain(`joinCode: "${DEMO_JOIN_CODE}"`);
  });
});

describe("isGuestEmail", () => {
  it("matches only the demo guest domain", () => {
    expect(isGuestEmail(`guest-abcd1234@${DEMO_GUEST_EMAIL_DOMAIN}`)).toBe(true);
    expect(isGuestEmail("student1@innovision.test")).toBe(false);
    expect(isGuestEmail(`evil@not-${DEMO_GUEST_EMAIL_DOMAIN}.example`)).toBe(false);
    expect(isGuestEmail(null)).toBe(false);
    expect(isGuestEmail(undefined)).toBe(false);
    expect(isGuestEmail("")).toBe(false);
  });
});

describe("demo constant parity with scripts", () => {
  it.each(["scripts/seed-demo.mjs", "scripts/demo-reset.mjs"])(
    "%s uses the same join code + lecturer email literals",
    (rel) => {
      const src = readFileSync(path.join(process.cwd(), rel), "utf8");
      expect(src, `${rel} join code`).toContain(`"${DEMO_JOIN_CODE}"`);
      expect(src, `${rel} lecturer email`).toContain("demo-lecturer@innovision.test");
    },
  );

  it("scripts/demo-reset.mjs uses the same guest domain", () => {
    const src = readFileSync(
      path.join(process.cwd(), "scripts/demo-reset.mjs"),
      "utf8",
    );
    expect(src).toContain(DEMO_GUEST_EMAIL_DOMAIN);
  });
});
