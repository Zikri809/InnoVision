import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// The prod warn reads NODE_ENV + the seam flag too — the tests control all
// three and silence the console. NODE_ENV is a read-only property on
// process.env under @types/node, so it is swapped through a mutable alias
// (Vitest's own vi.stubEnv does exactly this under the hood).
function withNodeEnv(value: string | undefined, run: () => void): void {
  const prevNode = process.env.NODE_ENV;
  const prevSeam = process.env.NEXT_PUBLIC_E2E_FAKE_SEAM;
  const env = process.env as { NODE_ENV?: string };
  try {
    env.NODE_ENV = value;
    delete process.env.NEXT_PUBLIC_E2E_FAKE_SEAM;
    run();
  } finally {
    env.NODE_ENV = prevNode;
    if (prevSeam === undefined) delete process.env.NEXT_PUBLIC_E2E_FAKE_SEAM;
    else process.env.NEXT_PUBLIC_E2E_FAKE_SEAM = prevSeam;
  }
}

describe("isIntegrityHardeningEnabled", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
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

  // The warn is memoized at MODULE level, so each warn assertion needs a
  // fresh module instance (vi.resetModules + dynamic import) — a shared
  // instance would let earlier tests consume the once-per-session warn and
  // make later assertions pass vacuously.
  async function freshGate(): Promise<typeof isIntegrityHardeningEnabled> {
    vi.resetModules();
    const mod = await import("./hardening-gate");
    return mod.isIntegrityHardeningEnabled;
  }

  it("warns when the kill switch is on in a production build", async () => {
    const gate = await freshGate();
    withNodeEnv("production", () => {
      withEnv("1", () => {
        gate();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain("[integrity-gate]");
      });
    });
  });

  it("warns at most once per session even across repeated calls", async () => {
    const gate = await freshGate();
    withNodeEnv("production", () => {
      withEnv("1", () => {
        gate();
        gate();
        gate();
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("does not warn in a development build", async () => {
    const gate = await freshGate();
    withNodeEnv("development", () => {
      withEnv("1", () => {
        gate();
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });

  it("does not warn when the harness seam is set (legitimately hardened-off prod build)", async () => {
    const gate = await freshGate();
    withNodeEnv("production", () => {
      process.env.NEXT_PUBLIC_E2E_FAKE_SEAM = "1";
      withEnv("1", () => {
        gate();
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });

  it("does not warn when hardening is simply enabled (no kill switch)", async () => {
    const gate = await freshGate();
    withNodeEnv("production", () => {
      withEnv(undefined, () => {
        gate();
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });
});
