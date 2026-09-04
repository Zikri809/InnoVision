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
        "src/lib/gestures/**",
        "src/lib/face/**",
        "src/lib/results/**",
        "src/lib/quizzes/**",
        "src/lib/student-quizzes/**",
        "src/lib/media/**",
        "src/lib/format/**",
        // Report-only additions (no thresholds yet): auth wall, route guards,
        // shared HTTP primitives, middleware redirect matrix.
        "src/lib/classes/guards.ts",
        "src/lib/classes/roster.ts",
        "src/lib/auth/**",
        "src/lib/http.ts",
        "src/lib/supabase/middleware.ts",
        "src/lib/vision/camera.ts",
        "src/app/api/ai/**",
        "src/app/api/quizzes/**",
        "src/app/api/student-quizzes/**",
        "src/app/api/question-images/**",
        "src/app/api/profile/**",
        "src/app/api/sessions/**",
        "src/app/api/face/**",
      ],
      // Per-file gates. Browser-only files (tesseract/vision/glm-ocr render
      // loops, pdf.js worker load) are exercised by the E2E suite, not the
      // Node unit suite; the global threshold averages them in otherwise.
      thresholds: {
        perFile: true,
        "src/lib/quizzes/updates.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/quizzes/time-limit.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/quizzes/validation.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/quizzes/labels.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
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
        "src/app/api/ai/**/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        // P3 quiz routes are tested by P3's test suite (above); the P4 gate
        // is the AI/extraction/OCR surface, so exclude P3 routes from the gate
        // but keep them in the report.
        "src/app/api/quizzes/[id]/route.ts": { lines: 0, statements: 0, functions: 0, branches: 0 },
        "src/app/api/quizzes/[id]/publish/route.ts": { lines: 0, statements: 0, functions: 0, branches: 0 },
        // QC-1: the close route carries state-machine logic — session-route gate.
        "src/app/api/quizzes/[id]/close/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
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
        // QT-3: deterministic per-session shuffle (golden vectors + round-trip
        // + transforms, U-QT3-1..18). QuestionRow types are shared.
        "src/lib/sessions/shuffle.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        // QT-1: the export model / workbook assembly / import grammar are
        // Node-pure and multi-select touched all three — gate them like the
        // other lib-bar files so the multi-cell and grammar tests are forced.
        "src/lib/results/export.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/results/export-workbook.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/quizzes/import-parser.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        // P8: pure results derivation (Node-unit-tested, U-T4 + U-T4b/c/d).
        // constants.ts/types.ts have no meaningful executable surface (mirrors
        // the lib/face constants/types precedent — omitted from thresholds).
        "src/lib/results/derive.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        // P6: pure gesture logic (Node-unit-tested, U-G1..U-G7). The browser
        // MediaPipe glue (hand-tracker.ts) is E2E/manual-only — 0-key precedent
        // (mirrors tesseract/vision/glm-ocr). constants/types/fake-seam have no
        // meaningful executable surface (fake-seam is exercised by E2E only).
        "src/lib/gestures/finger-count.ts": { lines: 75, statements: 80, functions: 80, branches: 70 },
        "src/lib/gestures/hold-confirm.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/gestures/hand-loss.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/gestures/fake-seam.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/gestures/hand-tracker.ts": { lines: 0, statements: 0, functions: 0, branches: 0 },
        // P7: pure face logic (Node-unit-tested, U-F1..U-F7c + I22). The
        // browser MediaPipe glue (face-tracker.ts) is E2E/manual-only — 0-key
        // precedent (mirrors hand-tracker). constants/types have no meaningful
        // executable surface. The server-only InsightFace client is I/O glue
        // exercised via route tests (vi.mock) — 0-key.
        "src/lib/face/schemas.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/face/liveness.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/face/streak.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/face/recovery.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/face/cadence.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/face/outcome.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/face/rpc-mapping.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/face/fake-seam.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/face/face-tracker.ts": { lines: 0, statements: 0, functions: 0, branches: 0 },
        "src/lib/face/server/insightface-client.ts": { lines: 0, statements: 0, functions: 0, branches: 0 },
        "src/lib/vision/camera.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/app/api/face/**/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/sessions/[id]/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/sessions/[id]/pause/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/sessions/[id]/exempt-face/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/sessions/[id]/face-unavailable/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/sessions/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/sessions/[id]/answer/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/sessions/[id]/submit/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        // P8: session reset route (I21) — mirrors the sibling session routes.
        "src/app/api/sessions/[id]/reset/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        // SQ: student practice quizzes — pure helpers at the lib/quizzes bar;
        // routes mirror the sibling session-route gates.
        "src/lib/quizzes/question-draft.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        // QC-3: window format helpers (parse/format/conversion) at the lib bar.
        "src/lib/format/window.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/student-quizzes/share-code.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/student-quizzes/validation.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/student-quizzes/guards.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/app/api/student-quizzes/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/student-quizzes/[id]/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/student-quizzes/[id]/questions/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/student-quizzes/[id]/questions/[questionId]/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/student-quizzes/[id]/reorder/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/student-quizzes/shared/[code]/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/student-quizzes/shared/answer/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        // Media (plan MEDIA_AND_STUDENT_AI): pure validators at the lib bar;
        // new routes mirror the sibling route gates. Client glue
        // (use-question-image.ts, media components) is browser-only — E2E
        // owns it (hand-tracker/tesseract 0-key precedent). media/client.ts
        // is the pure pick-pre-validation gate (Node-unit-tested).
        "src/lib/media/validation.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/media/client.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
        "src/lib/media/server.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/lib/media/use-question-image.ts": { lines: 0, statements: 0, functions: 0, branches: 0 },
        "src/app/api/question-images/[qid]/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/profile/avatar/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/quizzes/[id]/questions/[questionId]/image/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/student-quizzes/[id]/questions/[questionId]/image/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
        "src/app/api/student-quizzes/[id]/generate/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 },
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
