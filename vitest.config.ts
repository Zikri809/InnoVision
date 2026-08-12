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
        "src/lib/sessions/**",
        "src/app/api/ai/**",
        "src/app/api/ocr/**",
        "src/app/api/quizzes/**",
        "src/app/api/sessions/**",
      ],
      // Per-file gates. Browser-only files (tesseract/vision/glm-ocr render
      // loops, pdf.js worker load) are exercised by the E2E suite, not the
      // Node unit suite; the global threshold averages them in otherwise.
      thresholds: {
        perFile: true,
        "src/lib/ai/quiz-schema.ts": { lines: 80, statements: 80, functions: 80, branches: 80 },
        "src/lib/ai/quiz-prompt.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/ai/validation.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/ai/client.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/lib/ai/http-compat.ts": { lines: 60, statements: 60, functions: 60, branches: 40 },
        "src/lib/extract/native.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/extract/pipeline.ts": { lines: 60, statements: 60, functions: 40, branches: 50 },
        "src/lib/extract/types.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/extract/pdf.ts": { lines: 50, statements: 50, functions: 50, branches: 50 },
        "src/lib/extract/tesseract.ts": { lines: 0, statements: 0, functions: 0, branches: 0 },
        "src/lib/extract/glm-ocr.ts": { lines: 0, statements: 0, functions: 0, branches: 0 },
        "src/lib/extract/vision.ts": { lines: 0, statements: 0, functions: 0, branches: 0 },
        "src/app/api/ai/**/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/ocr/**/route.ts": { lines: 40, statements: 40, functions: 40, branches: 40 },
        // P3 quiz routes are tested by P3's test suite (above); the P4 gate
        // is the AI/extraction/OCR surface, so exclude P3 routes from the gate
        // but keep them in the report.
        "src/app/api/quizzes/[id]/route.ts": { lines: 0, statements: 0, functions: 0, branches: 0 },
        "src/app/api/quizzes/[id]/publish/route.ts": { lines: 0, statements: 0, functions: 0, branches: 0 },
        "src/app/api/quizzes/[id]/questions/route.ts": { lines: 0, statements: 0, functions: 0, branches: 0 },
        "src/app/api/quizzes/[id]/questions/[questionId]/route.ts": { lines: 0, statements: 0, functions: 0, branches: 0 },
        "src/app/api/quizzes/[id]/reorder/route.ts": { lines: 0, statements: 0, functions: 0, branches: 0 },
        "src/app/api/classes/join/route.ts": { lines: 0, statements: 0, functions: 0, branches: 0 },
        // P5: pure session helpers + session routes carry the timer/grading
        // integrity logic (unit + route-test covered). Browser-only UI
        // components (play-client, question-card, option-card, progress-hud,
        // end-screen, student-quizzes-client) are E2E-covered (P4 precedent)
        // and excluded from the report entirely — no 0-threshold keys needed.
        "src/lib/sessions/timer.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/sessions/validation.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/app/api/sessions/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/sessions/[id]/answer/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/sessions/[id]/submit/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
