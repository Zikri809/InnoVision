import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CameraFailureError,
  classifyCameraFailure,
  type CameraFailure,
} from "./camera";

/**
 * SQ-5 / AX-7 shared kernel: typed camera-failure taxonomy. Every getUserMedia
 * rejection class must map to actionable copy; unknown must stay honest
 * (boot timeouts / health-probe failures are NOT permission problems).
 */
function namedError(name: string): DOMException {
  return new DOMException("mock", name);
}

describe("camera failure taxonomy (SQ-5, U-CF1..U-CF4)", () => {
  it("U-CF1 maps every rejection class to its cause", () => {
    expect(classifyCameraFailure(namedError("NotAllowedError"))).toBe("permission");
    expect(classifyCameraFailure(namedError("PermissionDeniedError"))).toBe("permission");
    expect(classifyCameraFailure(namedError("NotFoundError"))).toBe("no_device");
    expect(classifyCameraFailure(namedError("DevicesNotFoundError"))).toBe("no_device");
    expect(classifyCameraFailure(namedError("OverconstrainedError"))).toBe("no_device");
    expect(classifyCameraFailure(namedError("NotReadableError"))).toBe("device_busy");
    expect(classifyCameraFailure(namedError("TrackStartError"))).toBe("device_busy");
    expect(classifyCameraFailure(namedError("SecurityError"))).toBe("security");
  });

  it("U-CF2 unknown/absent names stay 'unknown' (honest fallback)", () => {
    expect(classifyCameraFailure(namedError("AbortError"))).toBe("unknown");
    expect(classifyCameraFailure(new Error("timeout"))).toBe("unknown");
    expect(classifyCameraFailure("some string")).toBe("unknown");
    expect(classifyCameraFailure(null)).toBe("unknown");
    expect(classifyCameraFailure(undefined)).toBe("unknown");
  });

  it("U-CF3 a CameraFailureError keeps its original classification (no re-wrapping loss)", () => {
    const wrapped = new CameraFailureError("permission", "denied");
    expect(classifyCameraFailure(wrapped)).toBe("permission");
  });

  it("U-CF4 every failure value has enroll-page copy in both locales", () => {
    // Guard copy <-> taxonomy drift: the enroll panel t()s
    // `cameraFailure.<failure>.body` for EVERY classification — a new
    // CameraFailure variant without a key would render a raw key path.
    const failures: CameraFailure[] = [
      "permission",
      "no_device",
      "device_busy",
      "security",
      "unsupported",
      "unknown",
    ];
    for (const locale of ["en", "ms"] as const) {
      const messages = JSON.parse(
        readFileSync(resolve(`src/messages/${locale}.json`), "utf8"),
      ) as Record<string, unknown>;
      let node: unknown = messages;
      for (const part of ["student", "face", "cameraFailure"]) {
        node = (node as Record<string, unknown>)[part];
      }
      expect(node, locale).toBeTruthy();
      for (const failure of failures) {
        const branch = (node as Record<string, unknown>)[failure];
        expect(branch, `${locale}.${failure}`).toBeTruthy();
        expect(
          typeof (branch as Record<string, unknown>).body === "string" &&
            ((branch as Record<string, unknown>).body as string).length > 0,
          `${locale}.${failure}.body`,
        ).toBe(true);
        // The four actionable causes also carry a settings/next-step hint.
        if (["permission", "no_device", "device_busy", "security"].includes(failure)) {
          expect(
            typeof (branch as Record<string, unknown>).hint === "string" &&
              ((branch as Record<string, unknown>).hint as string).length > 0,
            `${locale}.${failure}.hint`,
          ).toBe(true);
        }
      }
    }
  });
});
