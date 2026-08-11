# InnoVision — Session Handoff (Phase 4 DONE, at a44db05)

> Purpose: give a fresh session full context without re-reading the large PLAN docs.
> Read this file first. `docs/PLAN_PHASE4.md` has the full implementation + audit-fix log (§8); `docs/TESTING.md` has the test plan.

---

## 1. Where we are

**Phase 4 (Extraction + AI generation) is COMPLETE and fully audited.** All work is committed on `main` at `a44db05`. The audit→fix→re-graphify loop ran **2 full iterations** and converged clean (no remaining Critical/High findings).

Phases done: **1 Scaffold → 2 Classes → 3 Manual builder → 4 Extraction + AI generation** (this phase).

**Next phase (per PLAN.md §6): Phase 5 — Play screen (click-first).** Do NOT start P5 until this handoff is validated.

## 2. Verified green baseline (run these to confirm)

```bash
npm run lint          # 0 errors, 0 warnings
npm run typecheck     # clean
npx vitest run        # 210/210 (16 files)
npx vitest run --coverage   # per-file thresholds pass (~70% lines / 64% branches / 77% funcs)
node scripts/verify-security.mjs   # 3/3
node scripts/verify-classes.mjs    # 21/21
node scripts/verify-quizzes.mjs    # 42/42
node scripts/verify-ai.mjs         # 16/16
npx playwright test    # 7/7 E2E
npm run build          # succeeds
```

Prereqs for the harnesses/E2E: **Docker Desktop running** + local Supabase up (`npx supabase start`), `.env.local` populated (gitignored; see `.env.local.example`). `.env.local` currently has the local Supabase keys; `AI_API_KEY` is blank (use a dummy `test-key` for CI; E2E uses the mock AI server).

## 3. What Phase 4 delivered

- **Migration `supabase/migrations/0007_ai_generation.sql`** — `quizzes.source_text` column; `quiz_status_transition` edit-lock extended to source fields; security-definer **`replace_quiz_questions(p_quiz_id, p_title, p_source_file_url, p_source_text, p_questions jsonb)`** RPC (atomic replace, advisory lock, 3–30 bound, draft-only, single `not_owner` no-oracle); storage bucket `file_size_limit` + `allowed_mime_types` + lecturer-only upload policy.
- **`src/lib/ai/`** — `client.ts` (OpenAI-compatible, `server-only`, 45s timeout, `jsonMode` option), `http-compat.ts` (browser GLM-Ollama + probe), `quiz-schema.ts` (AiQuizSchema + `normalizeOptions`), `quiz-prompt.ts` (system prompt hardening, one retry, shared deadline), `validation.ts` (Zod route schemas incl. strict `sourcePath`).
- **`src/lib/extract/`** — `native.ts` (pdfjs/mammoth/jszip, 15s parse timeout option, zip-bomb preflight for DOCX+PPTX), `tesseract.ts` (single worker, `MAX_OCR_PAGES`), `glm-ocr.ts`, `vision.ts`, `pipeline.ts` (native→OCR cascade, image fall-through), `pdf.ts` (shared pdfjs loader), `types.ts`.
- **Routes** — `POST /api/ai/generate-quiz`, `POST /api/ai/regenerate-question`, `POST /api/ocr/vision` (all: `requireLecturer`, rate-limit, CSRF `checkSameOrigin`, typed errors, `maxDuration=60`).
- **Builder UI** — `src/components/extract/` (UploadDropzone, EnginePicker, OcrProgress, SourceTextPreview, GenerateFromFileDialog) wired into the P3 builder.
- **Tests** — `src/app/api/ai/__tests__/ai-routes.test.ts` (35 tests: I14–I19, I-A1–A14, I-A7 real in-flight, I-A10 timeout, RPC error mapping, I-A4b trigger seam), `src/lib/ai/*.test.ts`, `src/lib/extract/*.test.ts`, `scripts/verify-ai.mjs` (D34–D40 + anon-revoke), `e2e/e2-ai-generate.spec.ts` + `e2e/e2b-regenerate.spec.ts` + `e2e/mock-ai-server.mjs`, `@vitest/coverage-v8` per-file thresholds.

## 4. Key security/robustness invariants (do not regress)

- **`sourcePath`** validated by strict regex (multi-dot filenames OK, `..`/`//`/`.` segments rejected) + `normalizePath(p) === p` + route `startsWith(uid + "/")`.
- **`replace_quiz_questions`** is the only atomic replace path; route never inserts on invalid AI output (422, zero rows); RPC re-validates ownership (no oracle).
- **AI output is Zod-validated + DB-trigger-validated only** — never reaches SQL/auth. Prompt-injection hardened via system prompt + sanitized retry feedback.
- **Server-side parse** is time-boxed (15s `Promise.race` → 503) and size-boxed (25 MB upload cap, ≤50 pages, zip preflight).
- **`source_text`/`source_file_url`** are owner-only (never in `student_quiz_view`); frozen once quiz leaves draft.
- **CSRF**: `checkSameOrigin()` on all AI routes. **Rate-limit** per-user + in-flight `Set<quizId>` guard (process-local — documented multi-instance caveat).
- **Tesseract** default OCR: single worker (`logger: () => {}` — a `undefined` logger crashes v7), `MAX_OCR_PAGES = 50`.

## 5. Known remaining / accepted (documented in PLAN_PHASE4 §8.5)

- In-flight guard + rate limiter are **per-process** — fine at demo scale; DB-backed is post-demo.
- Browser-only OCR modules (`tesseract/glm/vision` render loops) are 0% unit-covered (Node can't canvas) — E2E covers native; jsdom+mocked-worker is the future test path.
- `verify-*.mjs` create real users on `.env.local` Supabase — keep pointed at local; add a `localhost` guard before any shared-project run.
- Self-host MediaPipe + Tesseract/pdf.js assets under `/public` is a **P9** task (venue Wi-Fi blocks CDNs).

## 6. How to start Phase 5 (Play screen, click-first)

1. Confirm the baseline above is green (docker + supabase up).
2. `docs/PLAN_PHASE4.md` §8.4 shows the exact verification matrix to re-run.
3. `docs/PLAN.md` §6 (P5 row) + `docs/TESTING.md` §9 (P5 gates: U-T1–U-T3, D1/D1b/D2–D4/D7/D9, I7–I13, E4/E5/E10/E11) define the deliverable.
4. Follow the same pattern as `docs/PLAN_PHASE3.md` / `PLAN_PHASE4.md`: write a `PLAN_PHASE5.md`, get it reviewed, execute, then run the audit→fix→graphify loop.
5. **P5 prerequisite note from P3:** the quiz-DELETE route must gain a "block when sessions exist" guard (P3 plan §5 tracked it).
6. Graphify is installed (`graphify-out/.graphify_python`); run `graphify update .` after changes.

## 7. Commit history (P4)

```
a44db05  Phase 4 audit iter 2 final (CSRF, parseQuestionJson, typed RPC args, coverage tests, plan log)
8f76448  Phase 4 audit iter 2 (AI deadline, page caps, DOCX preflight, updateError seam, coverage-v8)
1950f57  Phase 4 audit iter 2 (Tesseract logger, normalizePath, sourcePath multi-dot, parse timeout, I-A7/I-A10 tests)
c698e9f  Phase 4 audit iter 1 (security/efficiency/tests/style fixes)
eed8f1c  fix E2 publish submitLock
9475ca7  verify-ai harness + E2E + mock AI server + CI + TESTING.md
bcffc70  AI routes + builder UI
1b07444  Phase 4 core (migration, lib/ai, lib/extract, routes, tests)
```
