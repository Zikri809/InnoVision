import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  copyFor,
  DIGEST_COPY_KEYS,
  NOTIF_COPY,
  PANEL_KEYS,
} from "../copy";
import { DIGEST_TYPES, NOTIFICATION_TYPES } from "../types";

/**
 * U3: every notification type's copy keys must exist in BOTH locale files.
 * The i18n checker only validates literal t() arguments — the bell resolves
 * keys through the typed NOTIF_COPY record, so this test is the guard that
 * a missing key can never render a raw key path in production.
 */
const locales = ["en", "ms"] as const;

function loadMessages(locale: (typeof locales)[number]): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(`src/messages/${locale}.json`), "utf8"),
  ) as Record<string, unknown>;
}

function hasKey(messages: Record<string, unknown>, key: string): boolean {
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object" || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" && node.length > 0;
}

describe("notification i18n coverage (U3)", () => {
  for (const locale of locales) {
    const messages = loadMessages(locale);

    it(`[${locale}] resolves title+body for all ${NOTIFICATION_TYPES.length} types`, () => {
      for (const type of NOTIFICATION_TYPES) {
        expect(hasKey(messages, `notifications.${NOTIF_COPY[type].titleKey}`), type).toBe(true);
        expect(hasKey(messages, `notifications.${NOTIF_COPY[type].bodyKey}`), type).toBe(true);
      }
    });

    it(`[${locale}] resolves byMode variants for mode-aware types`, () => {
      for (const type of NOTIFICATION_TYPES) {
        const byMode = NOTIF_COPY[type].byMode;
        if (!byMode) continue;
        for (const mode of ["practice", "assessment"] as const) {
          expect(
            hasKey(messages, `notifications.${byMode[mode].titleKey}`),
            `${type}.${mode}.title`,
          ).toBe(true);
          expect(
            hasKey(messages, `notifications.${byMode[mode].bodyKey}`),
            `${type}.${mode}.body`,
          ).toBe(true);
        }
      }
    });

    it("quiz_live resolves assessment copy only when payload.mode says so", () => {
      const assessment = copyFor("quiz_live", { mode: "assessment" });
      const practice = copyFor("quiz_live", { mode: "practice" });
      const fallback = copyFor("quiz_live", {});
      expect(assessment.titleKey).toContain(".assessment.");
      expect(practice.titleKey).toContain(".practice.");
      // Missing/unknown mode falls back to practice-safe wording, never
      // alarm the student with "counts" language.
      expect(fallback.titleKey).toBe(practice.titleKey);
    });

    it(`[${locale}] resolves digest + panel chrome keys`, () => {
      for (const key of [...DIGEST_COPY_KEYS, ...PANEL_KEYS]) {
        expect(hasKey(messages, `notifications.${key}`), key).toBe(true);
      }
    });
  }

  it("digest keys cover exactly the DIGEST_TYPES set", () => {
    // Guard copy.ts vs types.ts drift: adding a new type to DIGEST_TYPES
    // without a digest.* key would render a raw key path at runtime for
    // grouped rows.
    expect(DIGEST_TYPES.size).toBe(DIGEST_COPY_KEYS.length);
    for (const type of DIGEST_TYPES) {
      expect(DIGEST_COPY_KEYS).toContain(`digest.${type}`);
    }
  });
});
