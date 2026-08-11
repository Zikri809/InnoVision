import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/lib/ai/**",
        "src/lib/extract/**",
        "src/app/api/ai/**",
        "src/app/api/ocr/**",
        "src/app/api/quizzes/**",
      ],
      // Loose gates today (better than no measurement); tighten as the
      // suite grows. Focus on `lib/ai` and the AI routes — `lib/extract`'s
      // browser-only code paths are partly covered by harness + E2E.
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 55,
        statements: 70,
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
