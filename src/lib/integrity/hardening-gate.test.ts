import { afterEach, describe, expect, it } from "vitest";
import { isIntegrityHardeningEnabled } from "./hardening-gate";

const ENV_KEY = "NEXT_PUBLIC_INTEGRITY_HARDENING_OFF";

// The gate reads process.env at CALL time (mirrors seam-gate.ts), so a plain
// synchronous save/set/restore around each assertion is sufficient.
function withEnv(value: string | undefined, run: () => void): void {
  const prev = process.env[ENV_KEY];
  try {
    if (value === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = value;
    run();
  } finally {
    if (prev === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prev;
  }
}

describe("isIntegrityHardeningEnabled", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("enabled by default (env unset) — hardening on in production", () => {
    withEnv(undefined, () => {
      expect(isIntegrityHardeningEnabled()).toBe(true);
    });
  });

  it("enabled for any value other than the exact kill switch", () => {
    withEnv("0", () => {
      expect(isIntegrityHardeningEnabled()).toBe(true);
    });
    withEnv("", () => {
      expect(isIntegrityHardeningEnabled()).toBe(true);
    });
  });

  it("disabled only by the exact '1' dev bypass", () => {
    withEnv("1", () => {
      expect(isIntegrityHardeningEnabled()).toBe(false);
    });
  });
});
