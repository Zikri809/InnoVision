# InnoVision Production-Readiness Audit — Audit-2

**Date:** 2026-09-12 (UTC)
**Scope:** `src/app/api/**` (47 routes), `src/lib/**` (205 files), `src/components/**` (quiz/face/vision/gesture islands), `supabase/migrations/0001–0045`, `scripts/*.mjs`, `next.config.ts`, `src/proxy.ts`, i18n/messages.
**Method:** Orchestrated discovery-and-critique. Phase 0 scoping → Phase 1 Round 1 (8 chunk subagents, general) → Phase 1 Round 2 (5 second-eyes subagents, general) → Phase 2 Round 1 (V1–V3 validators + H1–H2 hunters) → Phase 2 Round 2 (V4–V6 validators + H3–H4 hunters) → Phase 2 Round 3 (V7 validator + H5 hunter) → Phase 2 Round 4 (V8–V9 validators + H6 hunter + V10 severity arbitration) → Phase 2 Round 5 (H7 convergence probe + V11 final arbitration). **Stopping condition MET** in Round 5 (zero newly Confirmed findings on the hunter probe; V11 severity finalization only, no new facts, no Confirmed↔Refuted flips); **6-round hard cap not hit**. See §5 Coverage.
**Ground rules enforced:** every finding cites file:line, states category + severity (blast radius + likelihood) + concrete trigger, proposes fix. Unverifiable marked Needs-more-info.

---

## 1. Executive summary

### Counts (deduplicated, post-validation; V10/V11 arbitration applied)

| Severity | Confirmed | Needs-more-info | Refuted / dropped |
|---|---|---|---|
| Critical | 3 | 0 | 0 |
| High | 8 | 0 | 0 |
| Medium | 28 | 1 | 0 |
| Low / Info | 14 | 8 | 4 |
| **Total** | **53** | **9** | **4** |

Severity moves since the interim draft: V10 downgraded H-05/H-06/H-07/H-08 High→Medium, H-10 High→Medium, C-02 Critical→High. V11 set H5/H6 severities (GLM partial = Medium; cancel-mislabel, palm double-fire, dead pause gate, 401-stash = Low; join null-shape = Info; lecturer meta-sync = Info-only dropped as vuln).

### Top 5 risks (fix first)

1. **Proctoring trust boundary is client-attested (C-01, C-02, M-28).** Photo/replay passes `verify` (Critical); `face-unavailable` self-assertion + 6-min re-arm exempts the silence cron for a full exam (High after V10 — hourly lecturer notice + 5-min re-arm effort keep it below Critical); `self-recover` needs no liveness (Medium after V10 — 3-in-5 fail history still forces `flagged`). Core product promise does not hold against a tampered client.
2. **Service-role confused deputy on storage paths (C-03).** 6 delete/copy sites pass a caller-writable `image_path`/`source_file_url` column straight to `admin.storage.remove()/copy()` with no shape or ownership check. Any authenticated owner who learns a victim object path (paths appear inside signed URLs) deletes/copies cross-tenant bytes.
3. **Sweeper deletes live media past 1 000 rows (C-04).** `scripts/media-cleanup.mjs` builds its referenced-set with uncapped PostgREST selects (default 1 000-row cap) then bulk-deletes everything else. First run on a >1 000-image corpus deletes production user data.
4. **Systemic request-body cap bypass (H-04).** `checkBodyLimit` is header-only (`src/lib/http.ts:66-75`); ~20 routes then call unbounded `request.json()`/`formData()`. Chunked/no-`content-length` bodies fully materialize before any Zod cap runs. OCR route (32 M chars + 90 s GPU hold) is the best amplifier.
5. **Grade integrity + silent data-shape bugs (H-09, M-17, M-22).** Newest-flagged (scoreless) hides a valid completed score; per-quiz global-window reads + 25-sheet cliff + Summary/detail scale divergence render plausible-but-wrong grades with no flag; GLM partial-page OCR silently builds quizzes from a subset of pages.

---

## 2. Confirmed findings

### 2.1 Critical

#### C-01 — Liveness is client-side only: static photo passes verify [security]
- **Citation:** `src/app/api/face/verify/route.ts:160-285` (extract → primary → `compare_face_baseline`, zero references to blink/liveness/yaw/spoof); `src/lib/face/server/insightface-client.ts:184-199` (parses embedding/bbox/yaw, no gate); `src/components/face/use-face-pipeline.ts:1136-1156` (`beginGate` blink+turn), `:862-925` (`runRecovery` blink+turn) — both client-only; `src/lib/face/challenge.ts:61-101` (challenge constructed client-side); proof binds only session:nonce:frames (`supabase/migrations/0045_integrity_p0_forgery_fraud.sql:335-365`, `src/lib/face/server/verify-proof.ts:6-22`). Enroll-only yaw gates (`src/app/api/face/enroll/route.ts:159-179`) do not apply to verify. Validators V2a CONFIRMED.
- **Category:** security. **Severity: Critical** — breaks the defining proctoring guarantee for every assessment; likelihood high (printed photo or curl POST, no marker needed).
- **Trigger:** enrolled student points camera at a printed photo (or POSTs photo frames directly, skipping `beginGate`); sidecar extracts the correct person's embedding, `matched = majority ≥ 0.5` passes with no liveness signal.
- **Fix:** bind server-verified liveness into the proof: require yaw-diversity across the 3 frames (or a sidecar spoof score) judged server-side before minting proof; record sidecar yaw per frame in `face_checks` for lecturer audit at minimum.

#### C-03 — Unchecked stored paths to service-role `remove()`/`copy()` = cross-tenant delete/copy [security]
- **Citation (6 sites, no validator):** `src/app/api/quizzes/[id]/questions/[questionId]/image/route.ts:84-88` (POST replace `oldPath`), `:134-139` (DELETE); `src/app/api/student-quizzes/[id]/questions/[questionId]/image/route.ts:76-79`, `:121-125`; `src/app/api/quizzes/[id]/questions/[questionId]/route.ts:175-181` (question DELETE via `RETURNING image_path`); `src/app/api/quizzes/[id]/route.ts:188-230` (quiz DELETE, `question-images` + `quiz-sources`). Positive controls that DO validate: `src/app/api/profile/avatar/route.ts:84,121` (`isValidAvatarPath`), `src/app/api/quizzes/[id]/duplicate/route.ts:179` (`isWellFormedQuestionImagePath`). Precondition: no format CHECK (`supabase/migrations/0028_media.sql:62-68` plain `text`) + table RLS allows self-row write (`supabase/migrations/0004_quizzes.sql:88-89,132-136`; `0023:134,168-172`). Validators V3g CONFIRMED; R2-storage widened to 6 sites. **Verified by orchestrator:** validator exists at `src/lib/media/validation.ts:137-144` but is unused on delete paths.
- **Category:** security. **Severity: Critical** — authenticated cross-user destruction/exfiltration via service-role deputy; likelihood low-medium (needs victim path, learnable from signed URLs per `src/app/api/question-images/[qid]/route.ts:22-23`).
- **Trigger:** attacker copies victim `question-images/<uid>/<uuid>.<ext>` from a shared/enrolled signed URL into own row via direct PostgREST PATCH, then invokes own DELETE/replace route (or poisons `copy()` source in duplicate, `duplicate/route.ts:179-188`, which checks shape but not `startsWith(userId+"/")` — R2-storage NEW-1, Medium confidentiality extension).
- **Fix:** gate EVERY privileged `remove()/copy()` with `isWellFormedQuestionImagePath()` + owner-prefix pin (`startsWith(auth.uid()+"/")`) on delete/copy; fail-closed skip+log; add DB `CHECK (image_path ~ …)` backstop.

#### C-04 — `media-cleanup.mjs` truncates reference set at 1 000 rows, then deletes “orphans” [correctness/edge-case]
- **Citation:** `scripts/media-cleanup.mjs:22` (`list(prefix,{limit:1000})` once per prefix, no offset), `:47` (questions reference select, no `.range()`), `:64` (profiles select, no `.range()`), `:56`/`:72` (`remove(orphans)` unbounded single call). Validators V3f CONFIRMED; R2-storage adds safe-direction truncation (folders >1 000 objects silently missed) + unbounded batch risk.
- **Category:** correctness/edge-case (data loss). **Severity: Critical** — fail-open delete of live user data on first large-corpus run; likelihood grows with product (certain past 1 000 imaged rows).
- **Trigger:** >1 000 rows with non-null `image_path`/`avatar_path`, run `node scripts/media-cleanup.mjs` without `--dry-run`.
- **Fix:** paginate both sides (`.range()` loop + `offset` loop on `list`), batch `remove()` (≤100–1 000/batch), fail-closed guard (abort delete unless listing+reference fetches completed without truncation).

### 2.2 High

*Note: C-02 retains its discovery ID; arbitrated High (not Critical) per V10 — see block.*

#### C-02 — Unverified outage claim + 6-min re-arm = silence-cron exemption [security]
- **Citation:** `supabase/migrations/0045_integrity_p0_forgery_fraud.sql:536-571` (`report_face_unavailable` gates: owner + active/paused + quiz-live only, empty body accepted), `:564-571` (refresh if >5 min old), `:636-637` + `:717-718` (cron exempts stamps fresher than 10 min); `src/components/face/use-face-pipeline.ts:383-424` (re-arm every 6 min while `unavailable`); `src/app/api/sessions/[id]/face-unavailable/route.ts:13,41-47` (10/min, no evidence). Validators V2c CONFIRMED; R2-face N1 independently re-derived. **V10 arbitrates High (not Critical):** full-session zero-check achievable but demands sustained re-arm every 5 min (`0045:521`), gated on live+enrolled+active/paused, auto-clears on 2 consecutive matches, and emits an hourly lecturer notice (`:573-594`) — too signaled for Critical, too total for Medium.
- **Category:** security. **Severity: High** — full-exam zero-`face_checks` with answers flowing; likelihood medium-high (1 call/5–10 min + suppress verify POSTs + ignore hourly notice).
- **Trigger:** working camera + block `/api/face/verify` only + `POST face-unavailable` every few minutes + normal answering. Cron exempt while stamp fresh; only signals are `face_unavailable_at` flag and hourly deduped notice (`0045:573-594`).
- **Fix:** cap exemption: answering-while-unavailable consumes a budget instead of renewing it (flag when fresh stamp + answers flowing + zero checks >N min); require corroboration (recent 503/`invalid_frame` receipt) to sustain claim; surface stamp age prominently.

#### H-01 — Password login server action has no rate limit [security]
- **Citation:** `src/lib/auth/login.ts:1-34` (whole file: `signInWithPassword`, no `rateLimit` import/call) vs `src/lib/auth/register.ts:110-137`, `src/lib/auth/reset.ts:48-63,108-116`, `src/lib/auth/sso.ts:44-52`, `src/lib/auth/matric-capture.ts:54-62`. Validators V1a CONFIRMED; `docs/audit/audit-1.md:191` admits “Login limiter (P1) DEFERRED”.
- **Category:** security. **Severity: High** — unlimited online password guessing on highest-value endpoint; likelihood high (only GoTrue platform throttle remains).
- **Trigger:** loop `login({email:victim, password:candidate})` from one IP — every sibling action 429s, this one never does.
- **Fix:** per-email (`login-email:${email}` ~5/min) + per-IP (`login-ip:${ip}` ~20–30/min, classroom-NAT aware) budgets mirroring `reset.ts`; keep generic error copy (`login.ts:27-30` already correct).

#### H-02 — Email/SSO redirect origins built from unvalidated Host/XFH [security]
- **Citation:** `src/lib/auth/reset.ts:71-82`, `src/lib/auth/register.ts:173-190`, `src/lib/auth/sso.ts:65-89` (all `origin = proto://(x-forwarded-host ?? host)`, no allowlist → `redirectTo`/`emailRedirectTo`/`callbackUrl`). `sanitizeRedirect` only sanitizes path. Validators V1b CONFIRMED.
- **Category:** security. **Severity: High** — account takeover via poisoned recovery/confirmation link if GoTrue redirect allowlist permissive, else failed-reset DoS + phishing; likelihood medium.
- **Trigger:** attacker calls `requestReset({email:victim})` with `Host: evil.test`; victim inbox gets `https://evil.test/auth/callback…` link carrying a valid code.
- **Fix:** never build email/OAuth origins from request headers; resolve from allowlisted site-URL env, fail closed when unset.

#### H-03 — `join_class` valid-code DELETE wipes brute-force counter before checks [security]
- **Citation:** `supabase/migrations/0019_robustness_fixes.sql:747-748` (`DELETE class_join_attempts`) before `:750-752` archived check and `:754-762` enroll insert/`already_enrolled`. Threshold `:738-743` (`fail_count>=5`). Validators V1c CONFIRMED; no later migration redefines `join_class`.
- **Category:** security. **Severity: High** — unbounded join-code guessing for anyone knowing one code; likelihood high (own code suffices; RPC is public to `authenticated`).
- **Trigger:** 4 fails + 1 known-good code (own class, leaked QR, archived code) → counter cleared → repeat forever; `locked_until` never set. Route `JOIN_RATE` (`src/app/api/classes/join/route.ts:14,37-42`) bypassed via direct PostgREST RPC.
- **Fix:** delete throttle row only on successful insert (`v_rows=1`); leave counter on `already_enrolled`/`class_archived`.

#### H-04 — Systemic body-cap bypass: header-only check + unbounded parse on ~20 routes [security/reliability]
- **Citation (verified by orchestrator):** `src/lib/http.ts:59-75` (`checkBodyLimit` inspects only `content-length`; `:61-65` admits chunked falls through) vs `:89-152` (`readCappedBytes/Json` aborts mid-stream — the real fix, used by only 8 routes). Header-only + `await request.json()`: `src/app/api/ai/generate-quiz/route.ts:116,128` (512 K), `src/app/api/ai/regenerate-question/route.ts:68,73`, `src/app/api/classes/route.ts:39,44`, `src/app/api/classes/[id]/route.ts:128,133`, `src/app/api/quizzes/[id]/route.ts:57,62`, `questions/route.ts:51,56`, `questions/[questionId]/route.ts:54,74`, `duplicate/route.ts:69,74`, `reorder/route.ts:58,63`, `import-questions/route.ts:84,89`, `student-quizzes/[id]/generate/route.ts:95,111`, plus inline header-only student-quiz routes (`student-quizzes/route.ts:78-81,93`, `[id]/route.ts:41-44,55`, `reorder:34-37,52`, `questions:35-38,53`, `shared/answer:46-52,65`). Bare `request.json()` with zero pre-check: `face/consent/route.ts:54`, `face/unlock/route.ts:38`, `face/self-recover/route.ts:37`, `sessions/[id]/exempt-face/route.ts:52`, `quizzes/[id]/reveal-settings/route.ts:48`. OCR: `src/app/api/extract/ocr/route.ts:59-62` (32 M header-only), `:70` unbounded parse, `:78-82` post-buffer cap. Multipart: `src/lib/media/validation.ts:84-101` (header-only; missing header → 413) then `src/lib/media/server.ts:27-35` unbounded `formData()`, real `file.size` check only at `:44-49` after buffering. Storage-download buffered-then-checked: `ai/generate-quiz/route.ts:1017-1020`, `student-quizzes/[id]/generate/route.ts:634-636` (`arrayBuffer()` then 25 M check). Validators V3h CONFIRMED; R2-body inventory + H2-1 agree.
- **Category:** security (DoS/memory exhaustion). **Severity: High** — single chunked POST forces full buffering + `JSON.parse` before Zod caps (`src/lib/ai/validation.ts:56-59` runs post-materialization); OCR 32 M + 90 s GLM hold is the best amplifier; likelihood low (needs malicious/buggy client) but trivially constructible.
- **Trigger:** chunked POST, no `content-length`, multi-MB JSON (or lied-small `content-length` on multipart) → header gate passes → full buffer.
- **Fix:** replace every `checkBodyLimit + request.json()` pair with `readCappedJson(request, LIMIT)` (same limits); route image uploads through `readCappedFormData` (incident-route pattern `sessions/[id]/incident/route.ts:75-78`); size-check storage `blob.size`/metadata before `arrayBuffer()`; add eslint ban on bare `request.json()` in `src/app/api`.

#### H-09 — Representative-session contracts disagree: newest flagged (scoreless) hides valid completed score [correctness]
- **Citation:** `src/lib/results/export.ts:253-272` (`isTerminal = completed‖flagged` at `:257-258`, newest terminal wins at `:265`), `src/lib/results/gradebook.ts:126-164` (reuses; nulls scoreless at `:156`, excludes from average at `:135-137`) vs `supabase/migrations/0037_multi_select_questions.sql:724-728` (`student_results`: newest `completed` only) vs `docs/ARCHITECTURE.md:502-504` (“LATEST completed”). Feed `started_at DESC,id DESC` (`export/route.ts:123-125`). Validators V3d CONFIRMED; R2-sessions R1-4 CONFIRMED.
- **Category:** correctness. **Severity: High** — grade-integrity display bug; likelihood medium (needs completed attempt + newer flagged retake; reachable per `0032:88-93`).
- **Trigger:** attempt 1 completed (scored), attempt 2 flagged (score NULL, newer) → gradebook/export show “—” from flagged while student EndScreen shows attempt-1 score; distribution runs on flagged partials.
- **Fix:** prefer newest `completed` over `flagged` in `selectRepresentativeSessions` (flagged only when no completed exists); pin with unit test; align `student_results` ordering.

#### H-11 — Matric gate is layout-only: NULL-matric SSO students enroll via `/join` + direct RPC [correctness]
- **Citation:** `src/app/(student)/layout.tsx:50-52` (only gate) vs `src/app/join/[code]/page.tsx:87-112` (top-level, outside layout; selects only `role`), `src/app/api/classes/join/route.ts:27-30` (`requireStudent` only), `src/lib/classes/guards.ts:20-54` (role only), `supabase/migrations/0019_robustness_fixes.sql:700-709` (`join_class` checks `role='student'` only). `PLAN_QR_CLASS_JOIN.md:116` admits “NO matric dependency”. Validators V1e CONFIRMED.
- **Category:** correctness/edge-case. **Severity: High** — full bypass of AU-2 matric identity (NULL-matric enrollments in rosters/gradebooks); likelihood high (normal first-day SSO QR-scan path hits `/join` before `/matric-capture`).
- **Trigger:** SSO student with `matric_no IS NULL` opens `/join/[code]` or POSTs join/RPC directly → enrolled, no matric.
- **Fix:** enforce at authority: `join_class` (+ join route, `/join` page) rejects `matric_no IS NULL` with typed `matric_required` routing to `/matric-capture`; keep layout as UX only.

#### H-12 — OCR proxy has no rate limit/concurrency guard; weak type check [security/reliability]
- **Citation:** `src/app/api/extract/ocr/route.ts:1-120` (no `rateLimit` import/call; GET probe + POST unbudgeted) vs every media route budgeted (sign 60/min, `IMAGE_RATE` 20/h, avatar 10/h); `:28-30` (32 M ceiling, 90 s `PAGE_TIMEOUT_MS`), `:78-84` (accepts any `data:image/` prefix, no MIME/base64/magic check; `base64ByteLength` in `src/lib/extract/types.ts:84-91` exists but unused), `:99-108` (forwards as `image_url`, `maxTokens:2000`). R2-storage R1-7 CONFIRMED; H2-3 extends.
- **Category:** security (authenticated DoS/cost). **Severity: High** — one lecturer account holds N concurrent 90 s GLM inferences, saturates loopback vLLM; likelihood medium.
- **Trigger:** loop 32 MB `POST /api/extract/ocr` (or `data:image/svg+xml` non-raster) calls.
- **Fix:** per-user rate limit (10–20/min) + in-flight guard; allowlist png/jpeg/webp, require `;base64,`, decode + cap + magic sniff before proxying.

### 2.3 Medium

*Note: M-24/M-25/M-26/M-27/M-28 were discovered as H-05/H-06/H-07/H-08/H-10; renumbered Medium per V10 arbitration — see blocks.*

#### M-24 — `save_quiz_questions_web` dropped the multi-select branch [correctness]
- **Citation:** `supabase/migrations/0037_multi_select_questions.sql:587-625` (6-arg fn handles `multi_select`) vs `supabase/migrations/0041_multi_file_source_provenance.sql:192-231` (8-arg web fn scalar-only: `:204` reads only `correct_index`, `:207-211` rejects null, `:213-230` INSERT omits `correct_indices`). Generate route always uses web fn (`src/app/api/ai/generate-quiz/route.ts:559-592`); `aiQuizToRows` emits multi rows with `correct_index:null` (`src/lib/ai/quiz-schema.ts:252-276`). Grep: no 0042–0045 redefinition — HEAD still broken. Validators V4a CONFIRMED; **V10 arbitrates Medium (not High):** `allowMultiSelect` default-off (`validation.ts:80`) narrows likelihood, failure is atomic/fail-closed (zero rows, typed 422 at `route.ts:636-651`) — wasted LLM spend on a draft, not corruption.
- **Category:** correctness/edge-case (migration drift). **Severity: Medium** — every `allowMultiSelect=true` generation emitting ≥1 multi row burns full LLM cost then 422s; fail-closed but feature deterministically broken when flag on.
- **Trigger:** `allowMultiSelect=true` + model returns any `multi_select` question.
- **Fix:** port `0037:587-625` branch verbatim into `save_quiz_questions_web` (both `replace` and `append` paths), incl. jsonb-null-safe checks and `correct_indices` in INSERT.

#### M-25 — Split-brain advisory locks: web-save + clone left on `quiz_replace:` [concurrency]
- **Citation:** HEAD keys: `0041:176` web=`quiz_replace:`, `0037:818` `clone_quiz`=`quiz_replace:` vs `0045:1512` `append_question`=`quiz_write:`, `0045:1618` 6-arg save=`quiz_write:`, `0045:1803` reorder=`quiz_write:`; `0045:69-70,1461,1615-1617` claims unification but omits web+clone; `0035:45-50` admits skew. Validators V4b CONFIRMED (H1-1 refined); **V10 arbitrates Medium:** draft-only, narrow concurrent-writer window, no constraint violation — stale-draft reads/ordering skew, not live corruption.
- **Category:** concurrency. **Severity: Medium** — AI-append vs manual-add/reorder interleave → duplicate `order_index` (no UNIQUE), 30-cap overshoot, torn clone copy; silent, no error.
- **Trigger:** AI append on Q + manual add/reorder on Q in overlapping windows (AI window minutes wide); or clone Q while editing Q.
- **Fix:** move web fn + clone to `hashtext('quiz_write:'||id)`; grep-kill remaining `quiz_replace:`/`quiz_append:`; unique index on `(quiz_id,order_index)`.

#### M-26 — Lecturer AI-append has no post-commit idempotency [concurrency/reliability]
- **Citation:** `src/app/api/ai/generate-quiz/route.ts:544-592` (no run key), `:931-939` (post-commit abort still commits then sends `cancelled`); `0041:42-51` (no `p_generation_id`) vs `0045:1938,1997-2014` (student `generation_id` dedupe). `inFlight` (`:71,151-158`) blocks only concurrent same-process POSTs; `finally :186,946` + `cancel() :960` release the slot so post-commit retry passes. Validators V4c CONFIRMED (append-only; replace unaffected); **V10 arbitrates Medium:** capped at 30 (`:165-171` + `0041:187-189`), draft-only, lecturer-visible/deletable.
- **Category:** concurrency. **Severity: Medium** — cancel/stream-death after commit shows `cancelled`; retry re-appends same batch → duplicates + 2× spend; cross-instance double-POST same.
- **Trigger:** cancel at save phase, stream drop, or retried POST after `already_running` cleared with `mode:'append'`.
- **Fix:** port student pattern: `questions.generation_id`, client-minted run UUID, under-lock `EXISTS(quiz,generation_id)` → return saved rows instead of appending.

#### M-27 — Gradebook global-window truncation is silent; export diverges from page [correctness]
- **Citation:** `src/app/(lecturer)/lecturer/classes/[id]/gradebook/page.tsx:85-113` (global `.limit(5000)`/`.limit(20000)`), `src/app/api/classes/[id]/gradebook-export/route.ts:27-33,94-112,208-214` (`:31-32` claims “truncation flagged via header note” — `:316-323` sets no such header; Summary `:169-205` has no note row), `:176-193` vs `:264-287` (Summary int vs detail fractions); `src/lib/results/gradebook.ts:98,122,213` (no `sessionsTruncated`). Validators V4d CONFIRMED (question-count caps unreachable at 50×30=1500; column `truncated` flag exists and works); **V10 arbitrates Medium:** 20 k-session precondition near-unreachable under `ROSTER_LIMIT=100` (≈200 attempts/student).
- **Category:** correctness (data integrity). **Severity: Medium** — oldest quiz columns render em-dash with plausible averages; 26-quiz class → Summary-only export indistinguishable from complete; fix is cheap.
- **Trigger:** 20 k newest sessions exhaust window; 26-quiz class export.
- **Fix:** per-quiz bounded reads (or `limit+1` per quiz + surfaced `sessionsTruncated` flag → page banner + workbook cover cell); replace sheet cliff with first-25 + “+N omitted”; align detail selection with representative policy.

#### M-28 — `self_recover_session` needs no liveness: camera-free resume of paused sessions [security]
- **Citation:** `src/app/api/face/self-recover/route.ts:35-49` (`SessionIdSchema` only → passthrough RPC); `supabase/migrations/0045_integrity_p0_forgery_fraud.sql:790-896` (gates: completed/flagged/active only; `:836-859` credits time, rotates nonce — no blink/turn proof); client-only enforcement `src/components/face/use-face-pipeline.ts:862-925` (blink `:872`, turn `:878`). Validators V2b CONFIRMED. **V10 arbitrates Medium (not High):** fail-history rows still force `flagged` at 3-in-5 (`0045:439-451`) and `flagged` blocks self-recover (`:828-830`) — at most ~2 liveness-free recoveries at ≤120 s credit before terminal flagging; deferral, not evasion.
- **Category:** security. **Severity: Medium** — every `paused` reduced to free instant retry with zero presence proof; likelihood high (one curl call); threshold still holds.
- **Trigger:** paused student → direct `POST /api/face/self-recover {sessionId}` → `active` + `nextNonce`, no camera, no 8 s blink wait.
- **Fix:** require fresh `matched` verify (same nonce chain) or proof-bound liveness attestation inside the RPC before `paused→active`; add SQL-side recover cooldown/ledger (today only in-memory route limit, bypassable via direct PostgREST).

#### M-15 — Duplicate image phase: crash → permanent source-sharing or silent strip, bare 201 [reliability]
- **Citation:** `src/app/api/quizzes/[id]/duplicate/route.ts:92-111` (RPC commits, then `await duplicateQuestionImages`; always bare `201 {quizId}` at `:109-111`), `:125-138` (catch-all NULLs all clone rows), `:152-155,:179-182,:190-193,:204-211` (per-arm `clearPath()` on failure; `console.error` only); `supabase/migrations/0037_multi_select_questions.sql:854-877` (verbatim `image_path` copy). Hunter H3-F1 NEW; Validators V7a CONFIRMED (with correction: default is silent strip, not permanent sharing — sharing only if the fail-closed UPDATE itself fails; same-owner sharing called benign at `:117-118`; render fail-closed via `question-images/[qid]/route.ts:68-71`).
- **Category:** crash-consistency / error-honesty. **Severity: Medium** — crash/freeze mid-phase leaves clone permanently pointing at SOURCE objects (no reconciler ever re-runs; `media-cleanup` can't fix sharing); later source DELETE breaks clone render; API hides per-image failures.
- **Trigger:** process crash/serverless freeze during the per-image loop; or source image DELETE in the window (copy fails → NULL).
- **Fix:** surface outcome in the 201 (`{quizId, images:{copied, failed}}`) + reconciler recopying clone paths still equal to source set; at minimum log per-image failures with counts.

#### M-16 — Same-email password→SSO linkage ungated on password path; azure-email fallback weakens domain gate [security]
- **Citation:** `src/lib/auth/register.ts:77-81` (format+length only, no domain gate — grep `institutional|domain` nil); `src/app/auth/callback/route.ts:71-91` (gates only `if(azureIdentity)`); `0027:46-81` + `0038:14-58` (`handle_new_user` always `student`, no squat check); fallback `callback:74-77` (`identity_data.email ?? user.email`) contradicts `institutional.ts:10-14,53-54` fail-closed. Hunter H4-F1/F2 NEW; Validators V7e (gates-missing Confirmed; auto-link Needs-more-info — no linking code in repo, depends on GoTrue dashboard `email-confirm/identity-linking/azure-tenant-lock`; attacker without inbox can't occupy since `register.ts:192-236` needs email confirm) + V7f (Confirmed, Low — bypass needs attacker-influenced `user.email`, unproven).
- **Category:** security (auth boundary). **Severity: Medium** — IF GoTrue same-email auto-link is ON, attacker password-signups `victim@uni.edu.my` first, victim SSO later links into attacker-known credential set; fallback attests GoTrue primary instead of the azure identity when IdP omits the claim.
- **Trigger:** `signUp(victim-institutional-email)` → victim SSO same email → one `user.id` with `identities=[password,azure]` (setting-dependent); or azure identity with `identity_data={}` + institutional `user.email`.
- **Fix:** reject password signup for `institutionalDomains()` (force SSO) or require verified-email + explicit link consent; `if(!idEmail) signOut+reject (sso-domain)`, never fallback; alert on multi-identity rows. Resolves NMI §3 item 3 partially — dashboard values still needed (now §3 item 8).

#### M-17 — GLM partial-page OCR silently truncates corpus, reports success [correctness]
- **Citation:** `src/lib/extract/glm-ocr.ts:113-121` (per-page `catch` → `warn` + keep parts; throws only if single-page), `:131-139` (`partial=successCount<images.length` → `{pages:successCount, lowConfidence:true}` — flagged at source) BUT `src/components/extract/GenerateFromFileDialog.tsx:229-232` (`totalPages+=result.pages` uses success count, deflating denominator → inflated avg words/page) + `:253` (`lowDensityDetected=hasOfficeFiles && (…)` — `hasOfficeFiles` is `.pptx/.docx` only at `:216-217`, so PDF/image GLM partials never warn; only surfacing is advisory `:687-701`). Hunter H5-F3 NEW; Validators V8c CONFIRMED (Medium — real integrity impact), V11c upheld.
- **Category:** correctness (silent failure). **Severity: Medium** — 10-page scan with 1 page 504 → quiz built from 9 pages, dialog advances with no warning for non-office files; lecturer ships incomplete assessment.
- **Trigger:** multi-page PDF via GLM, any single `ocrPage` rejects (90 s timeout, 504) → `partial=true`, UI shows success.
- **Fix:** return `{pagesAttempted, pagesSucceeded, failedPages[]}`; surface “N of M pages failed” warning for all types; use attempted count in density math.

#### M-18 — Callback code-exchange: no throttle/verifier-presence check; redirect honored but same-origin-only [security]
- **Citation:** `src/app/auth/callback/route.ts:1-53` (no `rateLimit` import vs `sso.ts:47`; no `code_verifier` cookie-presence / `state` check; `:17,:30` `sanitizeRedirect` then honored). Hunter H4-F3 NEW; Validators V7g (facts Confirmed; vuln overstated — PKCE verifier lives in `supabase-ssr` cookies/`exchangeCodeForSession`, needs-more-evidence for bypass; **open-redirect REFUTED**: `redirect.ts:14-43` same-origin local-path only).
- **Category:** security (session-fixation / login CSRF). **Severity: Medium** — attacker exchanges own `code` in victim browser → victim logged in as attacker; sanitizer still allows attacker-chosen local path (`/reset-password/confirm`, QR-join bounce). Brute-force Low (codes high-entropy single-use).
- **Trigger:** `GET /auth/callback?code=<attacker-own>&redirect=/student/classes` CSRF to victim.
- **Fix:** per-IP `rateLimit(exchange)`; require verifier-cookie for OAuth branch; one-time `state` nonce tied to starter; re-auth prompt if `redirect` outside `/dashboard`.

#### M-19 — Lecturer promotion unaudited, single-secret, no rotation [security/config]
- **Citation:** `src/lib/auth/register.ts:240-306` (admin upsert `role=lecturer`, only `console.error`, zero `audit_events` insert — grep `audit_events` in `lib/auth` nil); grep `LECTURER_INVITE_CODE_PREVIOUS` nil; `.env.local.example:31-32` single code; `invite-code.ts:13-26` single-secret constant-time compare. Hunter H4-F4 NEW; Validators V7h CONFIRMED (Low-Med — still needs secret + throttles at `register.ts:124-143`).
- **Category:** security (ops hygiene). **Severity: Medium** — privilege grant unattributable; rotation breaks in-flight `emailRedirectTo` confirmations (`promotionFailed`); leak window indefinite.
- **Trigger:** code leak → all uses invisible; rotate → pending email-confirm lecturers fail promotion.
- **Fix:** `insert audit_events(actor=userId, action='lecturer_promoted_via_invite')`; support `LECTURER_INVITE_CODE_PREVIOUS` grace + rotation runbook.

#### M-20 — Destructive cleanups `--remote` without confirm [reliability/ops]
- **Citation:** `scripts/media-cleanup.mjs:14` (`resolveEnv` only, no `confirmRemote`) + `scripts/incident-cleanup.mjs:44-51` (own `isLocal||REMOTE` check, no confirm) vs `scripts/seed-demo.mjs:34` + `scripts/lib/remote-env.mjs:70-83` (`confirmRemote` + project-ref gate). Hunter H4-F5 NEW; Validators V7i CONFIRMED (Low — requires local `.env.production.local` + explicit flag; operator-error only).
- **Category:** reliability (ops safety). **Severity: Medium** — `media-cleanup --remote` / `incident-cleanup --remote --days 0` wipes Storage + `incident_clips` on hosted with a single flag (compounds C-04: a remote cleanup past 1 000 rows deletes live data).
- **Trigger:** operator runs either cleanup with `--remote` (no interactive project-ref check).
- **Fix:** call `confirmRemote()` in both cleanups like seeds; default `--dry-run`.

#### M-21 — Legacy cancel misreported as AI timeout (503) [reliability]
- **Citation:** `src/lib/ai/client.ts:173-179` (legacy `chatCompletions`: any abort → `{error:"timeout"}`; outer cancel feeds same path via `:141-142`; pinned by `client.test.ts:114-135`) vs `client.ts:379-387` (`chatStream` distinguishes `cancelled`); `src/lib/ai/quiz-prompt.ts:373-375` (`GenerateQuizResult` has no `cancelled` variant, forcing the collapse); `generate-quiz/route.ts:521-524` (maps `timeout→timeout()`, no `cancelled` branch; `:555-557` checkpoint covers between-phase abort only). Same pattern `regenerate-question:194-197`, `student-quizzes/[id]/generate:325-328`. Hunter H5-F2 NEW; Validators V8b CONFIRMED, V11b upholds Low (fix needs type change; zombie-save already blocked at `:555`).
- **Category:** reliability (dishonest response). **Severity: Medium** — user-cancelled legacy generation returns 503 “AI timed out, try again” (retryable) instead of 409 `cancelled`; encourages instant retry burning LLM spend + hitting `already_running`/rate-limit. Stream path already distinguishes.
- **Trigger:** abort legacy (non-stream) POST mid-AI (navigate, dialog close, client timeout) → `onOuterAbort` → catch sees `aborted` → `timeout`.
- **Fix:** check `opts.signal?.aborted` in catch → `{error:"cancelled"}` (+ `GenerateQuizResult` union variant), map to 409 `cancelled` in `generationErrorResponse` like the save checkpoint.

#### M-22 — Gradebook/workbook artifact nits: scale divergence, silent sheet cliff, prune tier, limiter order [correctness]
- **Citation:** Summary int percents + `" *"` unrevealed marker (`gradebook-export:176-193`) vs detail fractions without marker (`:264-287`; per-quiz path `export-workbook.ts:178-194` fraction + `0%`); `SHEET_BUILD_LIMIT=25` cliff (`:208-210`, zero detail sheets, silent); per-quiz detail `.slice(0,200)` post-truncation (`:212-214`); `session_unlocked` omitted from prune urgent tier (`0022:726-746` 180 d vs 365 d; `0033:32`; contradicts `PINNED_TYPES` `notifications/types.ts:26-34`); export limiter before origin check (`gradebook-export:56-58`, `quizzes/[id]/export:95-100`) vs reveal origin-first (`reveal/route:44-50`); per-process disclaimer (`rate-limit.ts:1-13`). (Old L-07 split: tiebreak half moves to L-07; rest promoted here as a medium-integrity bundle.)
- **Category:** correctness. **Severity: Medium** — averaging a Summary column in Excel yields 100× the detail-sheet scale; forwarded workbooks lose unrevealed state; 26-quiz exports silently Summary-only; unread unlock notices pruned 185 days early; limiter-first burns budget on rejected probes; multi-instance budget ×N.
- **Trigger:** any ≤25-quiz export with ≥1 unrevealed quiz (scale/marker); >25 quizzes (cliff); unread unlock + weekly prune at 180 d; cross-origin export probes; scaled deploy.
- **Fix:** Summary fractions + `numFmt "0%"` + propagate `" *"` to detail title rows; first-25 + “+N omitted” note; add `session_unlocked` to `v_urgent_const`; move `checkSameOrigin` above `rateLimit` in exports; Redis limiter as scale-up requirement.

#### M-23 — Pause-input dead gates + gesture state-machine flaws (server-authoritative, client sloppy) [correctness]
- **Citation:** `sessionPaused`/`blockInput` dead gates: `gesture-layer.tsx:73,102-103,180,233` (assigned, never read in frame handler `:237-445`; `stateRef :235` omits both; `blockInput` only suppresses overlay at `:930`; real block is local `handLost` only at `:278-296`); `play-client.tsx:1007-1023` (`goNext` checks only `phase`, no pause) but server RPC authoritative (`:677-695` → 409 `session_not_active`). Palm double-fire: palm-next gate (`:303-329`) runs before re-arm gate (`:336-349`); commit sets `rearm=5` (`:368-373`) without resetting `nextHold`; sustained 5-palm 2.4 s skips feedback review. Hunter H6-F1/F2 NEW; Validators V9a/V9b CONFIRMED; V11e/V11f arbitrate **Low** (extra 1.2 s hold needed; no server bypass — wasted input / auto-advance only).
- **Category:** correctness. **Severity: Medium** — gestures fire behind server pause (answers fail safe 409, but `goNext` browses questions behind `BlockingOverlay`); sustained palm auto-advances past feedback review.
- **Trigger:** server-paused/flagged while holding gesture poses (gate dead); hold 5-palm 1.2 s to commit multi then sustain 1.2 s more (double-fire).
- **Fix:** mirror `sessionPaused`/`blockInput` into `stateRef` + early-return/reset holds at frame-handler top; move re-arm check above palm-next (or `nextHoldRef.reset()` on commit + require pose-break).

#### M-01 — `checkSameOrigin` trusts spoofable `x-forwarded-host`; absent Origin allowed [security]
- **Citation:** `src/lib/http.ts:264-279` (`:274-279` takes first `x-forwarded-host` entry verbatim as “this app's host”; `:265-266` allows absent `Origin`). Validators V1f CONFIRMED. Affects ~20 state-changing routes.
- **Severity: Medium** — single-header forgery defeats the only CSRF gate on direct-access deploys; tempered because browser `SameSite=Lax` still blocks cross-site cookie POSTs and simple forms can't set XFH (needs fetch/preflight or raw client).
- **Trigger:** `Origin: https://evil.com` + `x-forwarded-host: evil.com` → check returns allow.
- **Fix:** honor XFH only from known proxies (or drop it; compare against `Host` + `TRUSTED_ORIGINS` allowlist); log/reject XFH-vs-Host mismatch in prod.

#### M-02 — IP buckets keyed on spoofable leftmost XFF; `unknown` bucket shared [security]
- **Citation:** `src/lib/auth/register.ts:111-112`, `src/lib/auth/reset.ts:54,110`, `src/lib/auth/sso.ts:46`, `src/lib/auth/matric-capture.ts:56` (all leftmost `x-forwarded-for`); join/create correctly keyed on `userId` (`join/route.ts:37`, `classes/route.ts:35`). Validators (A F6, R2-auth F4) CONFIRMED.
- **Severity: Medium** — rotating one header per request silently disables invite/signup/reset/capture throttles; likelihood high (trivial to send).
- **Trigger:** brute-force invite codes or matric squatting while rotating `X-Forwarded-For: <random>`.
- **Fix:** resolve IP from platform-verified header / rightmost trusted entry; key authenticated paths on `userId` (+IP secondary).

#### M-03 — `E2E_RATE_LIMIT_DISABLED=1` kills every throttle with no prod guard [security/config]
- **Citation:** `src/lib/classes/rate-limit.ts:25,32` (`if (disabled) return true` short-circuits ALL `rateLimit()` callers); wired `playwright.config.ts:131-136`, documented `.env.local.example:63-65`. Validators V1g CONFIRMED. Contrast `hardening-gate.ts:43-52` (warns).
- **Severity: Medium** — one leaked env var (or promoted harness-built `.next`) deadens join/invite/AI-cost guards with zero signal; likelihood low (requires env leak) but blast radius total.
- **Trigger:** promote Playwright-built artifact or set flag in prod env.
- **Fix:** mirror hardening-gate (loud warn + metric; fail prod build unless explicit escape); CI assert flag absent from prod image; never promote harness builds.

#### M-04 — Join endpoint partitions failure reasons by status [security]
- **Citation:** `src/app/api/classes/join/route.ts:57-62` (400 malformed), `:106-111` (404 unknown, same string different status), `:94-105` (409 `already_enrolled` / 400 `class_archived`), `:89-93` (429 `join_locked` vs `:37-42` 429 `rate_limited`). QR display correctly folds copy (`src/app/join/[code]/join-errors.ts:18-45`) but HTTP status leaks. Validators V1d CONFIRMED (nuanced: `already_enrolled` self-only; 400-vs-404 trivial given public alphabet `src/lib/classes/join-code.ts:9-12`; `class_archived` is the true existence oracle; contradicts `route.ts:24` “no oracle” comment).
- **Severity: Medium** — archived-code harvesting + guess confirmation without enrolling; likelihood high (single POST).
- **Trigger:** probe codes: archived code → 400 `class_archived`; joined code → 409; unknown → 404; malformed → 400.
- **Fix:** single status + string for all non-success/non-lockout (e.g. always 404 `invalid_code`), or document `already_enrolled`/`class_archived` as intentional oracles.

#### M-05 — Unlock/exempt timer desync strands honest students after adjudication [correctness]
- **Citation:** client freezes while paused/flagged (`src/components/quiz/play-client.tsx:506-509`); flagged has `paused_at=NULL` (`0044:390-394`); unlock credits only if `paused_at` non-null (`0045:942-957`, else `:958-968` shifts nothing); exempt clears `paused_at` with no `started_at` shift (`0045:1078-1089`); unlock/exempt return only `{sessionStatus,nextNonce}` (`0045:1014`, `:1104`) vs self-recover returns `remainingMs` (`0045:886-891`, adopted `use-face-pipeline.ts:898-900` → `play-client.tsx:439-445`); flagged-poll adopts no time (`use-face-pipeline.ts:294-316`). Validators V3b CONFIRMED (server-authoritative; client overestimates; 120 s cap holds).
- **Severity: Medium** — timed quiz + dwell >120 s (or any flagged dwell) → resumed countdown inflated → spurious `time_expired` 403s forcing auto-submit; fail-closed but strands students right after lecturer adjudication.
- **Trigger:** timed assessment flagged (or paused long) → lecturer unlock/exempt after minutes → keep answering.
- **Fix:** return `creditedSeconds+remainingMs` from `unlock_session`/`exempt_face_session` (same formula as `0045:871-881`) and adopt in flagged-poll active arm (or don't freeze countdown while `flagged`).

#### M-06 — Pause spam on already-paused holds auto-reveal + sweeper hostage; staggered-completion livelock [correctness/liveness]
- **Citation:** every pause touches `last_activity_at`, incl. already-paused recount (`0044:421-439`); “all done” requires no fresh active/paused/flagged within 2 h (`0045:1377-1382`); sweeper shares signal (`0045:1903-1908`); `fullscreen_exit` never flags (`0044:352-355,380-382`; `0043:60-62`) so `pause→recover→pause` burns no strikes (20/min route limit — 1 pause/2 h trivial). Validators V3c CONFIRMED (bounded by 2 h + lecturer reset/unlock). Extension R2-sessions NEW-1: submit holds while *submitter's own* budget remains (`0045:1383-1391`) but sweeper holds while *any* assessment fresh (`0045:1903-1908`) → staggered cohort completing <2 h apart with budget left never reveals despite `0045:1859-1871` claiming otherwise.
- **Severity: Medium** — one non-submitter grief-holds class reveal (no score impact).
- **Trigger:** paused session + periodic pause re-POSTs past 2 h window; or cohort completing staggered with retake budget left.
- **Fix:** touch `last_activity_at` only on `active→paused` transition (or throttle like advisories `0044:989-994`); base reveal freshness on `answered_at`/`started_at`; sweeper should ignore `completed` freshness (only active/paused/flagged hold) or add absolute bound.

#### M-07 — `reset_session` deletes any assessment status incl. completed: evidence destruction + budget restore [correctness]
- **Citation:** `supabase/migrations/0022_notifications.sql:529-533` (mode-only gate, `DELETE` at `:533`); intent pinned `supabase/migrations/0011_results.sql:29-33` (“ANY status resets”); cascades wipe answers+checks (`0011:75-77`); residual trail audit row (`0022:535-541`) + `session_reset` notice (`:546-562`). Residuals: budget counts `completed` only (`0032:278-281`; `0045:1386-1390`) so delete restores an attempt; `quiz_completed_all` digest (`0045:1215-1219`) never re-fires after reset→re-complete; gradebook cell flips to em-dash with no reset marker (`gradebook.ts:156`). Validators V3a CONFIRMED; R2-sessions R1-1 downgrades headline to intentional, residuals Medium.
- **Severity: Medium** — single lecturer call (or compromised session) permanently destroys terminal record + silently grants extra attempt; likelihood low (lecturer-only) but terminal evidence must be append-only.
- **Trigger:** `DELETE /api/sessions/[id]/reset` on a `completed` assessment.
- **Fix:** reject `completed` (`session_not_active`) or require explicit `p_force_void` + snapshot (score/answers hash) into `audit_events.metadata`; document budget-restore as override or carry `reset_count`.

#### M-08 — Frozen-frame rule is exact-hash equality: 1-byte mutation defeats it [security]
- **Citation:** `0045:330-333` (`sha256("|f1|f2|…")`), `:432-436` (3rd consecutive identical hash on MATCHED pauses; fail rows excluded `:430-431`; single-repeat only advisory `:399`). Validators V2d CONFIRMED.
- **Severity: Medium** — matched photo replay with per-request mutation (1 base64 char/pixel, JPEG-Q tweak, A/B alternation) never triggers; honest re-encode noise never collides so rule catches only lazy attackers.
- **Trigger:** matched replay with per-check mutation; embeddings stay ≈1.0 while hash avalanches.
- **Fix:** perceptual check — sidecar embedding distance between consecutive frames below ε (or signed capture timestamps) instead of/in addition to byte equality.

#### M-09 — Verify discards pose: yaw extracted, never enforced (compounds C-01) [security]
- **Citation:** sidecar returns calibrated yaw/pitch/roll/det (`docker/insightface/app/main.py:148-178`); client parses (`insightface-client.ts:184-199`); verify discards all but embedding (`verify/route.ts:265-285`); `HEAD_TURN_*` thresholds live only in client (`constants.ts:46-52`); second-face arm advisory-only, evadable (<15% area / single-frame / out of 500 ms windows, `second-face.ts:28-78`, `VERIFY_FRAME_SPACING_MS`). R2-face N3 NEW.
- **Severity: Medium** (amplifier for C-01, not standalone bypass).
- **Trigger:** single best photo frame; helpers kept small/single-frame/out-of-window.
- **Fix:** enforce verify-side pose/liveness (yaw diversity across 3 frames or sidecar spoof score), bind into HMAC proof.

#### M-10 — Web-corpus envelope scrub is a single-pattern denylist [security]
- **Citation:** `src/lib/ai/tinyfish.ts:456-461` (only `=== WEB SOURCE` → `===` + fences), `:424-431` (header sanitize), `:441-477` (`buildWebCorpus` 12 k/source, aggregate cap; loop `break`s at `:464-468` but `sources` built from all `fetched.pages` at `:675-681` — over-claimed provenance); `src/lib/ai/quiz-prompt.ts:124-127` (“INERT DATA” soft instruction), `:188-208` (`safeText` escapes fences only; steering/source headers injected verbatim); merged `material + corpus` (`generate-quiz/route.ts:310-323`). Sinks safe from XSS (React text `GenerationProgress.tsx:421-429`; validated href `sources-card.tsx:90-101`) — residual is misinformation/phishing URLs in persisted questions. Hunter H2-2 NEW (refines Round-1C F6).
- **Severity: Medium** — attacker page ranking top-3 (`selectSources` at `tinyfish.ts:389-416`) steers persisted quiz content; likelihood depends on topic adversariality.
- **Trigger:** fetched page contains `=== LECTURER STEERING INSTRUCTIONS === …` or false facts/URLs carried into prompt/explanation/options.
- **Fix:** central `stripEnvelopeTokens()` on PDF text + fetched bodies (scrub all known headers, collapse `=` runs); derive `sources`/`usedPages` from actually-emitted blocks; post-generation URL-allowlist scan for lecturer approval.

#### M-11 — Signed-URL TTL outlives visibility (3600 s bearer + cacheable JSON) [security]
- **Citation:** RPC TTLs `supabase/migrations/0028_media.sql:121` (3600 owner/enrolled), `:133-138` (300 shared-non-creator vs 3600 creator, D13 by design); route clamp `src/app/api/question-images/[qid]/route.ts:61-62` (`300..3600`); client caches until `expiresAt-30 s` with no revalidation (`src/lib/media/use-question-image.ts:21-24,59-60`); signing JSON omits `Cache-Control: no-store` (`question-images/[qid]/route.ts:74-77`, `avatar/route.ts:167-170`) unlike exports. R2-storage R1-4 CONFIRMED (extends Round-1G).
- **Severity: Medium** — assessment imagery (can encode answers) viewable up to an hour past close/unenroll/archive; likelihood medium.
- **Trigger:** mint while `live`, quiz closes unrevealed (or student removed) within the hour — bearer + browser cache still render.
- **Fix:** 300 s for all non-owner grants (3600 owner-only); `Cache-Control: no-store` on signing responses; document residue; invalidate client cache on status transitions.

#### M-12 — Matric integrity trilogy: overwrite + 99xxxx direct-write + taken-oracle [security/correctness]
- **Citation:** overwrite: `src/lib/auth/matric-capture.ts:83-108` (selects only `role`; unconditional `update` at `:105-108`; page bounce `matric-capture/page.tsx:36` UI-only). 99xxxx: app blocks (`src/lib/auth/matric.ts:40` + INSERT triggers `0027:60-68`, `0038:29-37`) but `CHECK profiles_matric_no_format` (`0027:29-33`) allows any 6 digits, `protect_profile_restricted_columns` (`0019:360-382`) blocks only role/consent, RLS self-update allowed (`0019:354-357`) → direct `PATCH profiles {matric_no:"990001"}` passes (M8 probe `verify-matric.mjs:197-209` shows self-update path). Oracle: `register.ts:154-164` + `matric-capture.ts:95-103` (`matricTaken` vs success) with IP-only throttle (M-02) → XFF rotation enumerates 1 M space. Validators V1e + R2-auth F3b/F3c/N5 CONFIRMED.
- **Severity: Medium** — identity churn, reserved-namespace squatting, enumeration; likelihood medium (raw REST + header rotation).
- **Trigger:** call `captureOwnMatric` twice (reassignment, no audit); PATCH own `matric_no` to `99xxxx`; probe matrics observing `matricTaken`.
- **Fix:** conditional write (`.is("matric_no",null)` + `already_set` error) + DB trigger blocking authenticated change of non-null matric; tighten CHECK to exclude `^99`; key capture limit on `userId` + IP secondary.

#### M-13 — Roster + class lists truncate silently (100 / 200, no flag) [correctness/observability]
- **Citation:** `src/lib/classes/roster.ts:30,36-41` (`ROSTER_LIMIT=100`, no truncation signal) → `src/app/api/classes/[id]/route.ts:68-83` verbatim; `src/app/api/classes/route.ts:18,139,155` (`CLASS_LIST_LIMIT=200` both roles, no flag). Contrast `gradebook.ts:214` (`rosterTruncated`). R2-auth F11 CONFIRMED.
- **Severity: Medium** — lecturer certifies incomplete roster in grade dispute; dashboards drop classes past 200; likelihood certain at institutional scale.
- **Trigger:** 101 students → GET returns 100 rows, 200, no indicator.
- **Fix:** `{roster, truncated: len>=LIMIT}` (+ same for lists) with “showing first N” notice; or paginate; pin with test.

#### M-14 — CSP report-only + permissive + no collection; hardening kill-switch warn-only; E2E seam survives prod builds [security/config]
- **Citation:** `next.config.ts:9-39` (report-only; `script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:`; `connect-src … https:`; no `report-uri`), `src/lib/integrity/hardening-gate.ts:33-57` (env-only correct, but baked-off = one memoized `console.warn`, suppressed when `NEXT_PUBLIC_E2E_FAKE_SEAM=1` at `:54-57`; test codifies suppression `:115-124`), `src/lib/face/seam-gate.ts:18-29` (client fakes + `/dev/*` need only public flag; server correctly needs both `insightface-client.ts:58-69`), `playwright.config.ts:131-173` (harness sets all three flags). Chunk-H F5/F6/F7.
- **Severity: Medium** — any stored/reflected XSS executes inline + exfils to any HTTPS host with zero prod visibility; operator error baking kill-switch/seam flags into prod silently weakens integrity with no alert (promoted harness artifact hits doubly-silent path).
- **Trigger:** XSS payload (inline executes); deploy `.next` built under harness env → `/dev/bot` 200 in prod, hardening off, no warning.
- **Fix:** add `report-uri`, collect staging violations, enforce (nonces/hashes; pin AI/OCR/Supabase origins); fail prod build (or throw at startup) when kill-switch set without explicit escape + telemetry (not just `console.warn`); gate `/dev/*` on `NODE_ENV==="development"`; CI assert flags absent from prod build.

### 2.4 Low / Info

#### L-01 — Vote denominator attacker-controlled: 1-frame verifies halve the majority bar [security]
- **Citation:** `src/lib/face/schemas.ts:36-46` (frames min 1 max 3); `verify/route.ts:111` (slice, no minimum); `0045:280-285` (cardinality 1..3); verdict `0045:378-381` + mirror `src/lib/face/vote.ts:32-49` (strict majority over *submitted*). Honest 1-frame path load-bearing (flagged-poll sends 1, `use-face-pipeline.ts:303-310`). Validators V2e CONFIRMED.
- **Severity: Low** (amplifier for C-01, not standalone — 1-of-1 must still match).
- **Trigger:** POST single best frame → 1 hit needed instead of 2-of-3.
- **Fix:** require ≥2 frames for `question`/`periodic` triggers (`invalid_frame` otherwise); keep 1-frame legal only for `start`/flagged-poll via distinct trigger value.

#### L-02 — Normalization differential: API strips spaces/dashes, RPC only trims+upcases [correctness]
- **Citation:** `src/lib/classes/join-code.ts:54-57` (`replace(/[\s-]/g,"")`) vs `0019:735` (`upper(trim(code))`); call site `join/route.ts:54-66`; page `join/[code]/page.tsx:62`. (Matric path consistent — no issue.) R2-auth F9 CONFIRMED.
- **Severity: Low** — direct-PostgREST callers burn `fail_count` on inputs the app accepts; QR copies with spaces behave per-path.
- **Trigger:** direct `rpc("join_class",{code:"AB 3X-9K"})` → miss + increment; app path normalizes → may join.
- **Fix:** canonicalize in SQL (`upper(regexp_replace(trim(code),'[\s-]','','g'))`) + cross-layer test.

#### L-03 — Archived membership still SELECTable by owner post-archive (stale-own read) [security]
- **Citation:** `0002:108-111` (enrollments SELECT, no archived check) vs hiding logic `0017:22-30` (view filters `archived_at IS NULL`) + route `classes/[id]/route.ts:91-100` (→404 when archived). R2-auth F10 PARTIAL: stale-own-enrollment confirmed; no cross-user leak (unenrolled/non-owner still 404).
- **Severity: Low** — enrolled student retains direct-PostgREST oracle for own archived `class_id`s after app 404s.
- **Trigger:** student enrolled in C; lecturer archives C → views/routes hide, `.from("class_enrollments").eq("student_id",self)` still returns C.
- **Fix:** gate student side of policy on unarchived (`EXISTS … archived_at IS NULL`), keep lecturer audit reads; fold `class_archived` → `invalid_code` if existence hiding required.

#### L-04 — `stream_corrupt` reflects up to 200 chars of raw model text into client errors [robustness]
- **Citation:** `src/lib/ai/events.ts:107-124` (`message: line.slice(0,200)` where line can be partial `content_delta`/`reasoning`); surfaced `use-generation-stream.ts:223-230,316-319`. Sink is React text (no XSS) — confusing/phishable error string only. Round-1C F7.
- **Severity: Low** — needs proxy/server cut mid-line.
- **Trigger:** stream dies mid-write on a model-text line.
- **Fix:** static message (“Stream interrupted. Try again.”), log raw fragment server-side only.

#### L-05 — Publish/PATCH accept expired windows; windows editable on closed quizzes [correctness]
- **Citation:** `src/lib/quizzes/validation.ts:282-315` + DB `0030:43-53` (order/min-gap/horizon only, no past check); `publish/route.ts:51-71` (count only); `quizzes/[id]/route.ts:95-97` + `updates.ts:31-46` (window PATCH bypasses draft lock incl. `closed`). Read-time gates hold (`0030:184-189`, `0032:301-307` → `quiz_window_closed` until 5-min cron `0030:124-130`). Round-1C F8.
- **Severity: Low** — live-but-unstartable quizzes; meaningless post-close edits; no integrity violation.
- **Trigger:** publish with `closes_at <= now()` (or clock skew/cron lag); PATCH windows post-close.
- **Fix:** warn/block publish when `closes_at <= now()`; scope window-PATCH bypass to `live` only (or document closed edits as no-ops).

#### L-06 — Transient client display races: `already_answered` loser renders local pick; stale-seal bare `quiz_window_closed`; reset reload generic 404 [correctness]
- **Citation:** assessment replay returns no selection (`0037:294-299`; route drops payload `answer/route.ts:115-122`) but client renders in-flight pick (`play-client.tsx:647-661`; heals on reload via seeds `page.tsx:350-361`). Seal `v_row_count<>1` arm returns bare `quiz_window_closed` even when a concurrent submit just completed (`0032:250-271`). Missing/reset session → framework `notFound()` (`play/[sessionId]/page.tsx:131-142`); friendly dead UI only in SPA state (`play-client.tsx:1087-1106`); no `play/**//not-found.tsx`. Round-1D F4/F7/F8.
- **Severity: Low** — transient/confusing; evidence safe (`0045` §8 trigger scores the seal).
- **Trigger:** two tabs answering same question; start racing own submit past `closes_at`; reload after lecturer reset.
- **Fix:** return stored canonical selection on `already_answered` (owner's own answer, reveal-safe via `student_answers_view`); check `completed` first in seal fall-through (return `already_attempted` + id); add `play/[sessionId]/not-found.tsx` with `resetDead` copy (no-oracle-safe).

#### L-07 — Tiebreak determinism nits: `student_results` + resume pre-checks + column sort [correctness]
- **Citation:** `0037:724-728` (`ORDER BY started_at DESC` only) vs export feed `started_at DESC,id DESC` (`export/route.ts:123-125`; `gradebook page :110-111`) → equal-`started_at` attempts flip across surfaces (R2-sessions NEW-2; F F6). Related missing `id DESC`: budget-latest (`0032:294-295` `attempt desc, started_at desc`, no `id`), resume pre-checks (`0032:237,264,330-331` `started_at desc` only), gradebook column sort (`gradebook.ts:119-120` `created_at.localeCompare`, no `id` — bulk creates shuffle columns between reads).
- **Severity: Low** — student's breakdown shows attempt A while export/gradebook deterministically use B; view can flip across reads; columns shuffle on ties.
- **Trigger:** two completed attempts sharing identical `started_at` (seeded/bulk/clock-granularity ties).
- **Fix:** `ORDER BY started_at DESC, attempt DESC, id DESC` in `student_results` (all live redefinitions); append `, id DESC` to resume/budget/column sorts.

#### L-08 — Avatar/orphan + quiz-sources hygiene: same-ext pre-commit overwrite; student deletes never clean; sources quota-less [reliability]
- **Citation:** avatar upload→UPDATE→delete-old correct order, but failed UPDATE rolls back new object only when no previous (`profile/avatar/route.ts:54-87`, esp. `:74-80`); same-ext `upsert:true` mutates live bytes pre-commit (`:57-59`). Student question/quiz DELETEs drop `image_path` without `storage.remove` (`student-quizzes/[id]/questions/[questionId]/route.ts:109-139` selects only `id`; `student-quizzes/[id]/route.ts:167-190`) vs lecturer pattern (`questions/[questionId]/route.ts:155-181` RETURNING + remove; `quizzes/[id]/route.ts:184-231`). `0029:40-47` intentionally widens `quiz-sources` INSERT to owner-folder (deliberate per `0029:6-14`) but no per-user quota/count cap, direct `upsert:true` (`UploadDropzone.tsx:112-117`), no sweeper covers `quiz-sources` (`media-cleanup.mjs:41-75` only images/avatars), class/profile cascades leave objects (only lecturer quiz-DELETE cleans `:200-216`). R2-storage R1-3 (partial)/R1-5/R1-6.
- **Severity: Low** — orphan cost/bloat until (broken, C-04) sweep runs; same-ext crash window loses old avatar.
- **Trigger:** failed `profiles` UPDATE after storage write; student deletes imaged question/quiz; script fills own `quiz-sources` folder with 25 MB files.
- **Fix:** on update failure always `remove([path])` when `path !== previous` (temp-object + copy for same-ext); mirror lecturer RETURNING+remove on student deletes; per-user quota + extend sweep to `quiz-sources` (or signed route-issued uploads).

#### L-09 — Middleware `getUser` error treated as anonymous; server-component cookie-write loss unlogged [reliability]
- **Citation:** `src/lib/supabase/middleware.ts:57-81` (error ignored `:57-59`; bounce with pathname-only `redirect` at `:79`, dropping query); `src/lib/supabase/server.ts:16-26` (`setAll` empty `catch{}`, “middleware covers it”). R2-auth F5 downgrades to fail-closed Info (protected → `/login` 307 / API 401, no escalation); pinned by `middleware.test.ts:33-40`.
- **Severity: Low** — classroom-wide false-logout on transient Supabase/Kong blip + lost deep-link state; silently dropped token refresh → transient 401s with nothing in logs.
- **Trigger:** `getUser()` rejects/times out; token rotates inside RSC render (read-only cookies).
- **Fix:** distinguish transport error from anonymous (passthrough + retry/503 state; preserve `pathname+search`); counter/log on error branch; log dropped cookie writes.

#### L-10 — Incident clip same-ms filename collision; crash orphan + ignored cleanup errors [reliability]
- **Citation:** `${id}/${Date.now()}.${ext}` + `upsert:false` (`src/app/api/sessions/[id]/incident/route.ts:119,122-124`); crash between upload (`:122`) and insert (`:151`) leaves rowless object; `:147` ignores `remove` result, `:163-168` `.catch(ignoreRemoveFailure)` ignores `{error}` returns. Hunter H3-F2/F4 NEW; Validators V7b/V7d CONFIRMED with corrections (V7b: `upsert:false` turns 2nd into 503 retry, not corruption — availability glitch; V7d: SQL prune `0021:498-523` deletes `storage.objects>30d` regardless of row, so 30-day leak not permanent; JS script `incident-cleanup.mjs:53-83` row-driven, misses rowless orphans).
- **Category:** reliability (concurrency + rollback-fails). **Severity: Low** — double-submit in the same ms loses one forensic clip (500); rowless objects bloat ≤30 days.
- **Trigger:** two POSTs same session same millisecond same container; crash in put→insert window or transient storage failure during discard.
- **Fix:** `${id}/${Date.now()}-${crypto.randomUUID()}.${ext}`; check/log `remove` `{error}` with path; rowless-object reconciler on shorter cadence than 30 d.

#### L-11 — AI save post-commit readback failure returns misleading ok-with-[] [reliability]
- **Citation:** `src/app/api/ai/generate-quiz/route.ts:674-690` (readback error only `console.error`, then `questions: savedQuestions ?? []` inside `ok`) vs honest quiz-refetch arm `:656-668` (`saved_refresh_failed` → `:719-720,:738-740` 500). Hunter H3-F3 NEW; Validators V7c CONFIRMED.
- **Category:** reliability (partial-failure honesty). **Severity: Low** — save committed but client told success with 0 questions; self-heals on refresh, but lying count can provoke a retry duplicating an append batch (compounds M-26).
- **Trigger:** transient read failure after successful `save_quiz_questions_web` RPC.
- **Fix:** retry readback once; on failure return `saved_refresh_failed` (stream event / legacy 503) like the quiz-object arm.

#### L-12 — 401-stash restores keyless draft as graded Incorrect + strands question [correctness]
- **Citation:** stash write `play-client.tsx:758-765` (presented idx, no `seeded`); restore `:215-227` seeds `{selected*, isCorrect:false}` without `seeded:true` (vs server seed `:198-211` with `seeded:true`; type `:97-109`); `showCorrect = practice && answer && !seeded` (`question-card.tsx:134`) → `Incorrect` badge (`:92-107,139-140`) on ungraded draft (assessment renders neutral — practice-only Incorrect); strand: `answers[id]` truthy → `armed=false` (`:1256`), `pendingMulti=[]` (`:319`), `selectOption` early-return (`:580`), Confirm needs `!answered` (`:1128`), Next needs `feedback` (`:1159`, phase stuck at `question` `:230-231`) → `hasActionButtons=false`. Hunter H6-F3 NEW; Validators V9c CONFIRMED, V11g arbitrates Low (narrow 401-racing-commit trigger; reload heals — server never recorded).
- **Category:** correctness (state dead-end). **Severity: Low** — false feedback + no actionable button until reload.
- **Trigger:** practice 401 mid-answer → stash → login → remount restores draft as graded Incorrect with no Confirm/Next.
- **Fix:** add `seeded:true` to stashed restore (same shape as `already_answered` replay intent `:222-224`), or restore into `pendingByQuestion` not `answers`.

#### L-13 — Password hygiene + email-case asymmetry; auth-hygiene notes [maintainability]
- **Citation:** min 6 (`register.ts:81`, `reset.ts:104`), no strength/breach screen; `login.ts:21` passes raw `{email,password}` vs `register.ts:77`/`reset.ts:43` `trim().toLowerCase()` (GoTrue-side normalization unknown). R2-auth N8; Hunter H4-F6; Validators V7j CONFIRMED (Low).
- **Severity: Low (Info-grade)** — 6-char NIST-weak; `User@X.com `/trailing-space login friction/enumeration delta.
- **Trigger:** weak password accepted; case-variant login behaves inconsistently.
- **Fix:** centralize `normalizeEmail` (trim+lower in `login.ts`); minimum 10–12 + breach screening.

#### L-14 — Join RPC null-shape: unguarded `in` check vs typed-never-500 contract [robustness]
- **Citation:** `src/app/api/classes/join/route.ts:21-26` (typed, never-500 contract) vs `:79-87` (`const result = data as …; if("class" in result…)` — no null/non-object guard; `"class" in null` throws → Next 500). Hunter H5-F1 via H2 lens; Validators V8a (code gap Confirmed) + V11a arbitrate **Info**: unreachable on HEAD — `join_class` returns object on every branch (`0019:688-769`), transport errors handled (`:68-77`); null only if PostgREST/DB violates the RPC contract.
- **Severity: Info** — hardening-only, not a proven reachable 500.
- **Trigger:** `data === null` (or primitive) with `error === null` (requires DB/PostgREST contract violation).
- **Fix:** `if (!result || typeof result !== "object") return 503 internal;` before the `in` checks.

---

## 3. Needs-more-info (not dropped; what resolves each)

1. **Supabase Auth project throttling for login (H-01 modifier).** Need dashboard `GOTRUE_RATE_LIMIT_*` / Auth rate-limit values. If strict per-IP/per-account throttling is on, H-01 drops to Medium (defense-in-depth gap only).
2. **GoTrue URL configuration for H-02 exploitability.** Need Site URL + Redirect URLs allowlist. Strict allowlist → poisoned link rejected at click (downgrades to failed-reset DoS); wildcard → full takeover.
3. **Password↔SSO same-email auto-link — see item 8 (M-16).** Superseded: item 8 subsumes this with code citations + validator verdicts (V7e Needs-more-info on auto-link setting; V7f Confirmed-Low on the `?? user.email` fallback).
4. **PKCE/state on `/auth/callback` — see item 9 (M-18).** Superseded: item 9 subsumes this with the route analysis + V7g verdict (open-redirect refuted; throttle/verifier-presence gap confirmed).
5. **Sidecar deploy binding + token (face oracle).** Need prod compose: loopback bind + matching `FACE_SIDECAR_TOKEN`/`INSIGHTFACE_BASE_URL`. Client sends `x-sidecar-token` only if set (`insightface-client.ts:166-168`); sidecar enforces only if `TOKEN` set (`main.py:86-88`). If student-reachable without token, `/extract` is an unauthenticated embedding oracle. (R2-face N5.)
6. **Storage RLS live state + gradebook scale telemetry.** Re-run `npm run verify:media` MEDIA-D1 against target project (confirm zero `question-images`/`avatars` policies + RLS enabled on `storage.objects`, no dashboard-added policy). Confirm whether 20 k session window / 1 000-row cleanup thresholds have ever fired in prod (no telemetry in repo) to prioritize M-27/C-04. (R2-storage §4; R2-sessions NMI.)
7. **`readCappedFormData` 413→400 mapping under real multipart parse.** `http.ts:198-199` signals via `controller.error`, `:213-217` maps by message identity; Undici may wrap the error. Existing `http.test.ts:282-303` streams raw bytes, not a genuine over-cap multipart envelope. Needs a live over-cap multipart test. (R2-body F4.)
8. **GoTrue same-email linking / email-confirm / azure tenant lock (M-16 modifier).** Code-side missing gates confirmed (`register.ts:77-81` no domain check; `callback:71-91` azure-only gate; `handle_new_user` always student). Need dashboard: “Allow duplicate emails / auto-link identities / Confirm email” + Azure provider tenant restriction (single-tenant vs common) + Site-URL/redirect allowlist (host-poisoning in `reset.ts:73-76`/`sso.ts:68-70`, login-CSRF scope). If auto-link OFF + confirm ON + single-tenant, M-16 drops to Low hardening gap. (H4-F1; V7e.)
9. **PKCE verifier/state mechanics for `/auth/callback` (M-18 scope).** Route holds no verifier/state check (`callback:10-53`); PKCE verifier lives in `supabase-ssr` cookies/`exchangeCodeForSession` — need verifier-cookie flags + flow type to rule bypass vs login-CSRF-only. (V7g.)

---

## 4. Refuted / dropped findings (kept honest; do not re-file)

1. **“Closed-quiz reveal notifies nobody” — REFUTED on HEAD (fixed).** `0022:442-448` did require `status='live'`, but `0024:251-257` drops and recreates the trigger as `WHEN (old null → not-null)` with no status term (rationale `:32-38` F8a); grep shows no later redefinition; function body (`0022:159-174`) already status-agnostic; sweeper (`0045:1893-1908`) and submit flip (`0045:1397-1401`) fire on closed quizzes. One-time backfill remains live-only (`0022:820-835`) — historical, not a live bug. (Validators V3e.)
2. **“DB throttle check-then-act races past lockout” — DOWNGRADED, not a lockout bypass.** The window-reset `UPDATE class_join_attempts … WHERE student_id` (`0019:712-730`) holds the row lock to commit, so parallel bad-code POSTs serialize; increments don't lost-update under READ COMMITTED. Residual Low only: success-path DELETE vs in-flight increment ordering + archived-check→insert TOCTOU. (Hunter H1.)
3. **“Middleware error-as-anonymous is an auth hole” — DOWNGRADED to availability Info.** Effect is fail-closed (protected page → `/login`; API → 401). No escalation. Kept as L-09 for telemetry/UX only. (R2-auth F5.)
4. **“Lecturer metadata-sync failure breaks signup integrity” — DROPPED to Info-only.** Failure only logged (`register.ts:281-283`); profile row authoritative (`:271-273`); guards read `profiles` (`guards.ts:32-50`); promotion failure still errors (`:293-299`). Debug noise, no auth impact. (H5-F4; V8d; V11d.)

---

## 5. Coverage note

**Audited thoroughly (discovery + 5 critique rounds, citations re-derived):** auth/session bootstrap (incl. callback/PKCE-shape, SSO link/fallback, invite ops, promotion audit); classes/enrollment + `join_class` (incl. null-shape, soft-vs-hard delete); quiz authoring/lifecycle + AI generate/regenerate (legacy + stream, cancel/idempotency/readback honesty) + import/reorder/duplicate (image phase crash-consistency); assessment session loop (answer/submit/pause/advisory/reset/exempt/unlock/incident + filename/orphan handling) + retake/seal/auto-reveal/sweeper (incl. stale-paused wedge — none found); face enroll/verify/self-recover/unavailable + vote/nonce/proof/frozen-frame + gestures (palm state-machine, dead pause gates, 401-stash) + fullscreen/blur dedupe + incident recorder; results/reveal gating + gradebook/export (window/truncation/scale/marker/prune/limiter) + notifications triggers/prune; media/question-images/avatars/quiz-sources + `resolve_question_image` + signed-URL TTLs + cleanup scripts (incl. `--remote` confirm gap); cross-cutting HTTP guards/rate limits/CSRF/body caps/CSP/i18n/env parity/seams; GLM partial-page honesty; legacy-cancel error mapping.

**Thin but probed with explicit no-flaw verdicts (Hunter H7):** retake stale-paused wedge (resume path owns it — `0032:249-274`, no GC needed); class hard-delete cascade via route (DELETE is soft `archived_at` — `classes/[id]/route.ts:191,213-226`; FK cascades exist but unreachable via route); session GET envelope strike-timing oracle (no flaw — `faceFailStreak` already returned by verify RPCs; focus/`attempt` unexposed).

**Partially audited / not fully audited:**
- Stream-protocol edge cases beyond cancel/readback honesty (step-ECG of `stage/ping/reasoning/content_delta` interleavings, dead-stream detector 30 s vs 12 s heartbeat under proxy buffering) — skimmed, not hunted with a dedicated lens.
- MediaRecorder ring-buffer memory bounds on long exams; gesture calibration fallback paths; copy-prevention a11y interplay — skimmed only.
- Live-behavior probes (Supabase dashboard settings, prod compose binding, real multipart 413 mapping, 20 k-window telemetry) — **out of scope** (static audit only); captured as §3 Needs-more-info instead of guessed.
- E2E suite (`e2e/**`), `redesign-previews/`, `Sample Code/`, `.next/` build output — **explicitly out of scope**.

**Convergence statement:** the loop **converged in Phase 2 Round 5**. Round 2 added the H-06-remainder/H-07 findings (now M-25/M-26), M-15..M-20 + V4 severity challenges; Round 3 added H5-F1..F4 (V7/V8 confirmed, V11 arbitrated → M-17/M-21/L-10/L-11/L-14 + 1 drop); Round 4 added H6-F1..F3 (V9 confirmed, V11 arbitrated Low → folded into M-23/L-12) + V10 severity arbitration (M-24..M-28→Medium, C-02→High); Round 5 hunter probe (H7: stale-paused wedge, class-delete cascade, envelope oracle) produced **zero newly Confirmed findings**, and V11 produced **zero Confirmed↔Refuted flips** (severity finalization only: V11a Info, V11b Low, V11c Medium, V11d Info-only drop, V11e–g Low). Stopping condition met (full round, zero new Confirmed + zero flips); 6-round hard cap not hit (5 critique rounds used).

**Scoping map (Phase 0 → Phase 1 chunks):** A auth/session-bootstrap → R1-agent-A; B classes/enrollment → R1-agent-B; C authoring/lifecycle/AI/extract → R1-agent-C; D session core loop → R1-agent-D; E face/gesture/integrity → R1-agent-E; F results/reveal/gradebook/notify → R1-agent-F; G media/student-quizzes/uploads/OCR → R1-agent-G; H cross-cutting HTTP/rate/i18n/CSP/config → R1-agent-H. Round 2: body-cap inventory; face-trust re-derivation; sessions/reveal/gradebook re-derivation; storage/RLS re-derivation; auth/join re-derivation (different agents, same chunks). Phase 2: R1 (V1–V3 + H1–H2) → R2 (V4–V6 + H3–H4) → R3 (V7 + H5) → R4 (V8–V10 + H6) → R5 (V11 + H7).

---

## 6. Implementation status (2026-09-12, post-audit hardening pass)

**Verified first:** citations for all Critical/High findings and a sample of
Mediums were re-checked against HEAD before implementation — all accurate.
Migration `0046_audit2_hardening.sql` + app changes below; typecheck clean,
1660/1660 unit tests pass (tests updated only where they pinned the OLD,
pre-fix behavior). Each fix row carries the commit hash(es) that landed it
(migration bd4abd5 → code commits → docs this file).

### Fixed

| Finding | Fix | Commit(s) |
|---|---|---|
| C-01 | **Full fix.** The InsightFace sidecar bakes a MiniFASNet print/replay ensemble (`app/spoof.py`, Silent-Face-Anti-Spoofing ONNX, Apache-2.0, weights pinned by sha256 in the Dockerfile) and returns a per-frame P(real) verdict on `/extract`. The verify route records yaw/pitch/roll + the spoof score on `face_checks.frame_poses`, and when `FACE_SPOOF_ENFORCE=1` a majority-spoofed frame set forces the whole check to a FAIL vote (recorded - streak machinery + lecturer audit see it; `matched` can never be true for a photo/replay). Record-only without the env (dev sidecars without weights); prod warns when unset. Route gate + policy: `src/lib/face/spoof.ts` (+tests). | f29b779 + b87b347 + bd4abd5 |
| C-02 | `quiz_sessions.face_verify_attempted_at` + verify-route attempt touch; silence-cron outage-claim exemption now requires corroboration (recent face_checks row or recent attempt) in cursor + UPDATE predicates. | b87b347 + bd4abd5 |
| C-03 | `isOwnedQuestionImagePath()` (owner-pinned shape gate) applied at all 6 privileged remove()/copy() sites (fail-closed skip+log) + duplicate copy-source owner pin; DB backstop: anchored-shape CHECKs (NOT VALID) + `enforce_image_path_ownership()` trigger on questions/student_quiz_questions. | ed0455b + bd4abd5 |
| C-04 | media-cleanup rewritten: paginated reference fetches + offset-paginated storage walk, batched remove(), fail-closed on any fetch error, deletion behind explicit `--apply`. | 81050d6 |
| H-01 | login budgets: per-email 5/min + per-IP 30/min (`LOGIN_EMAIL_RATE_LIMIT`/`LOGIN_IP_RATE_LIMIT`), generic copy kept. | 2f4cecf |
| H-02 | `SITE_URL`/`NEXT_PUBLIC_SITE_URL` via `src/lib/auth/site-url.ts` — reset/register/SSO origins never derive from request headers in prod; unset degrades to relative paths (GoTrue Site-URL resolution). | 2f4cecf |
| H-03 | join_class deletes the throttle row only after a REAL enroll insert (v_rows=1); archived/already-enrolled keep the counter. | bd4abd5 |
| H-04 | ~24 routes migrated to `readCappedJson`; multipart intake via `readCappedFormData` (stream-capped, no honest-headerless 413); OCR body stream-capped. | c207a38 (+0b33ad7) |
| H-09 | `selectRepresentativeSessions` prefers newest COMPLETED over flagged; pinned by 2 unit tests. | fdfecc5 |
| H-11 | join_class refuses NULL-matric students (`matric_required`); /join page + confirm island route them to /matric-capture; layout stays UX-only. | bd4abd5 + 22ee129 |
| H-12 | OCR per-user 20/min limiter, stream-capped read, `;base64,` + png/jpeg/webp allowlist + magic-byte sniff before the GPU proxy. | e20e6fb |
| M-01 | `checkSameOrigin` no longer trusts `x-forwarded-host` (TRUSTED_ORIGINS covers rewriting proxies). | c207a38 |
| M-02 | `clientIpFromHeaders` — RIGHTMOST XFF entry (proxy-appended) keys all unauthenticated budgets. | 2f4cecf |
| M-03 | kill-switch in a prod runtime emits a loud warn (mirrors hardening-gate). | fdfecc5 |
| M-04 | archived-class join folds to 404 invalid_code (no existence oracle); `already_enrolled` kept (self-info). | 22ee129 |
| M-06 | pause on an ALREADY-paused session no longer touches `last_activity_at`. | bd4abd5 |
| M-07 | reset_session refuses `completed` (typed `session_not_active`); audit row gains prior_status + answered_count. | bd4abd5 |
| M-11 (part) | `Cache-Control: no-store` on both signing responses. TTL policy unchanged (see Deferred). | ed0455b |
| M-12 | capture write is set-once (`.is(matric_no,null)` + `matricAlreadySet` copy); DB: non-null matric immutable via restricted-columns trigger + `profiles_matric_no_not_reserved` CHECK (NOT VALID). | bd4abd5 + 2f4cecf |
| M-13 | roster + class lists fetch limit+1 and return additive `rosterTruncated`/`classesTruncated`. | 23de5aa |
| M-15 | duplicate 201 carries `{images:{copied,failed}}` (null = degraded); aggregate failure logged. | ed0455b |
| M-16 | password signup rejects institutional domains (`ssoRequired`); callback no longer falls back to `user.email` — missing azure claim rejects (sso-domain). | 2f4cecf |
| M-17 | GLM extraction returns `pagesAttempted`/`failedPages`; density math uses attempted; dialog warns "N of M pages failed" for ALL file types. | e20e6fb |
| M-18 | `/auth/callback` per-IP 30/min. | 2f4cecf |
| M-19 | promotion writes `audit_events(lecturer_promoted_via_invite)`; `LECTURER_INVITE_CODE_PREVIOUS` rotation grace. | 2f4cecf |
| M-20 | both cleanups call `confirmRemote()` for destructive hosted runs; media-cleanup defaults to dry-run. | 81050d6 |
| M-21 | legacy cancel maps to `cancelled` → 409 (client.ts, quiz-prompt unions, generate/regenerate/student routes). | 0b33ad7 |
| M-22 (part) | origin check above limiter in both exports; `session_unlocked` joins the 365d prune tier. | fdfecc5 + bd4abd5 |
| M-23 | server-pause/blockInput gates mirrored into the frame handler (early-return + hold resets); re-arm gate moved ABOVE palm-next + commit resets nextHold (no more sustained-palm double-fire). | d32b8dd |
| M-24 | multi_select branch ported verbatim into `save_quiz_questions_web`. | bd4abd5 |
| M-25 | web fn + clone_quiz moved to `quiz_write:` namespace. | bd4abd5 |
| L-02 | join_class canonicalizes with the app's rule (strip spaces/dashes). | bd4abd5 |
| L-04 | `stream_corrupt` sends static copy; raw fragment logged server-side only. | 0b33ad7 |
| L-07 (part) | `student_results` tiebreak `started_at DESC, id DESC`. | bd4abd5 |
| L-10 | incident clip filename gains a random suffix; failed discard/cleanup removes now log path+error. | fdfecc5 |
| L-11 | readback retries once, then honest `saved_refresh_failed` (no more ok-with-[]). | 0b33ad7 |
| L-12 | 401-stash restores into `pendingByQuestion` (multi re-arms Confirm; single re-clicks) — no graded-Incorrect ghost, no dead-end. | d32b8dd |
| L-13 (part) | login normalizes email (trim+lower). Password-strength policy unchanged (product decision). | 2f4cecf |
| L-14 | join route guards non-object RPC payloads → typed 503. | 22ee129 |

### Deferred (not implemented here)

- **M-09 (residual)**: yaw/pitch are recorded but not gated - the MiniFASNet
  spoof verdict is the server-judged liveness signal now; pose-diversity
  gating for challenge triggers stays out (false-flag risk on honest flows,
  and the spoof model supersedes it for the photo case).
- **M-05**: unlock/exempt return creditedSeconds/remainingMs + client adoption
  (flagged-poll time re-sync).
- **M-08 (residual)**: perceptual frozen-frame check (embedding-distance
  epsilon) - largely superseded by the spoof ensemble for photo replay; keep
  on the list only for matched-frame replay forensics.
- **M-10**: central envelope scrub + provenance from actually-emitted blocks.
- **M-11 (rest)**: 300s TTL for all non-owner grants (DB RPC change) + client
  cache invalidation on status transitions.
- **M-14**: CSP report-uri/enforcement, prod gating of `/dev/*` + seam flags,
  CI asserts on prod builds.
- **M-22 (rest)**: Summary/detail scale + `" *"` marker, 25-sheet cliff note,
  per-quiz detail slice, Redis limiter scale-up note.
- **M-26**: lecturer append idempotency (`generation_id` run key).
- **M-27**: gradebook per-quiz bounded reads + surfaced truncation + export
  sheet-count note.
- **M-28**: liveness-corroborated self_recover + SQL-side recover cooldown.
- **H-04 (tail)**: storage-download size-check before `arrayBuffer()` in the
  two AI generate routes (objects are server-written and route-capped upstream,
  so this is memory-peak hygiene only).
- **L-01, L-03, L-05, L-06, L-08, L-09, L-13 (strength policy)**: Low-grade
  UX/robustness items left for a follow-up pass.

### §3 Needs-more-info pointers that changed

- Item 7 (`readCappedFormData` 413 mapping): now pinned by a real over-cap
  multipart unit test (media-routes H-04 additions) — resolved.
- Item 5 (sidecar binding/token) and item 8 (GoTrue dashboard settings) remain
  operator inputs. M-16's code-side gates are now enforced regardless.

---

## Appendix — Reproduction pointers

- Body-cap bypass: `curl -H "Transfer-Encoding: chunked" -X POST $APP/api/ai/generate-quiz` with multi-MB `extractedText` and no `content-length` → passes `checkBodyLimit` (`http.ts:70-74` returns null), buffers in `request.json()`.
- Join counter reset: `SELECT` `join_class` body at `0019:747-762`; sequence 4× wrong + 1× own valid code, observe `fail_count` cleared.
- Photo verify: `POST /api/face/verify {sessionId, frames:[photo], trigger, nonce}` (nonce from owner-readable `GET /api/sessions/[id]`) → `matched:true` with no blink производители.
- Cleanup dry-run first: `node scripts/media-cleanup.mjs --dry-run` (inspect diff; do NOT run destructive sweep past 1 000 rows until paginated; never with `--remote` until `confirmRemote()` is wired — M-20).
- Web-save multi regression: enable `allowMultiSelect`, generate from any source, observe 422 `invalid_ai_output` on multi rows (or unit-test `save_quiz_questions_web` with a `correct_indices` payload vs 6-arg fn).
