# Plan: Agentic Quiz Generation Experience

> Status: Phases 0/1/1.5/2 SHIPPED and critic-gated (3 rounds × 2 subagent
> critics on the implementation; final verdicts SHIP-WITH-NOTES /
> GATE-READY-WITH-NOTES; every blocker+major resolved and verified).
> Pre-demo gate: `node scripts/smoke-real-provider.mjs` (§F) — 0 failures
> against Kenari on 2026-09-05 (deepseek-v4-flash emits no reasoning_content
> at these prompt sizes → Deep-mode drawer will use its documented degrade
> until the GLM swap). Remaining phases: 3 (student drawer console), 4 (Deep
> mode UI), 5 (calc tool), 6 (question cards), 7 (TinyFish topic mode).

## Demo-day escape hatches (documented degradation switches)

1. Streaming is OPT-IN — a client that omits `Accept: application/x-ndjson`
   gets the legacy JSON path (all ~28 pinned route tests + student surface
   run there).
2. To force in-dialog (legacy) generation for the lecturer, the handoff write
   failing (sessionStorage quota/private mode) falls back automatically.
3. `AI_STREAM_IDLE_TIMEOUT_MS` env tunes the inter-chunk abort (default 90s;
   the e2e harness sets 3s for the stall scenario).

## Contract revision (critique round 1, implementation)

The plan originally locked ALL parse-phase error branches into the pre-stream
JSON segment. Implementation (and its pinned tests) instead run the parse
phase INSIDE the stream and convert its failures to `error` events with the
same codes — so parse failures surface through the same localized console
path as every other failure (a 120s parse cannot produce an HTTP status the
client could still act on). Note the parse stage events are emitted when the
phase COMPLETES (or fails), not streamed live during pdf.js work — the rail
may sit on "pending" with pings during a long parse; wiring pdfjs
`onProgress` into live parse events is deferred to the Deep-mode phase.
Pre-stream guards (auth/CSRF/limits/in-flight/validation) remain JSON-status.
Rationale: a parse error at HTTP 200 is indistinguishable-from-nothing only
for non-console clients, and the only stream-mode client is the console,
which maps events to the same localized copy. This supersedes the
"parse branches stay pre-stream" line above; ARCHITECTURE.md's event-contract
section must carry the same statement.

## Goal

Replace the single blocking POST (spinner for up to 20 minutes) with a visible,
**truthful** agentic experience: an NDJSON event stream from the generate routes
powering a cognition console (phase rail, reasoning drawer, live question cards,
tool-call lines, completion payoff). Guiding rule, enforced by critique:
**every console line must be true.** No fake progress, no invented stages, no
theater that a stage event didn't cause.

Design constraints (binding): clay design system (`design-system/innovision/MASTER.md`)
— warm-only colors (no pure black consoles), Lucide SVG icons only (no emoji),
chunky borders/radii, `motion-reduce` + JS `matchMedia` gating for all motion,
e2e-relied accessible names are a contract. i18n en+ms parity is enforced by
`scripts/check-i18n.mjs` — all user-visible copy localizes.

## Phase 0 — Spikes (no app code; gates everything)

- **K1** Kenari + GLM: does `reasoning_content` stream through in SSE deltas, at
  what cadence (must be < 30s between bytes, else the dead-stream detector
  false-trips mid-thinking)? Acceptance includes cadence, not just presence.
- **K2** Kenari: does a thinking-effort/"max effort" param survive the proxy?
- **K3** Kenari: do function tools + thinking + `response_format: json_object`
  coexist in one request?
- **K4/K5** TinyFish Search + Fetch API: response shapes, latency, free-tier reality.
- **K6** Local: does `next start` (Next 16.3.0) buffer `application/x-ndjson`
  responses? Heartbeat flush behavior under compression. Proxy.ts already
  excludes `/api/` (verified `proxy.ts:20`).

## Phase 1 — Event spine (routes)

Opt-in streaming: route emits NDJSON only when the client sends
`Accept: application/x-ndjson`; default stays legacy JSON (preserves the ~25
JSON-pinned tests in `ai-routes.test.ts` byte-for-byte).

**Two-segment error contract.** Everything before the first stream byte keeps the
exact current JSON responses + statuses: same-origin, body limit, auth, ownership,
draft check, rate limit, in-flight add, append-capacity pre-check, and ALL
parse-phase branches (413/422 `use_browser_ocr`/`unsupported_file_type`/
`parse_error`/`empty_text`/503 parse timeout — explicitly enumerated, not
"covered by the general clause"). After the stream opens: errors are
`{"type":"error","code","message"}` events with clean close; client maps codes to
the same localized copy (incl. the student `codeMap` path and a distinct
"already running" state for the in-flight 429 — never the generic error path).

Events: `stage`, `heartbeat` (`{"type":"ping"}`, 12s, silent phases only),
`reasoning`, `content_delta` (inert plain text only — never markdown/HTML,
visually distinct from server chrome), `question`, `tool_call`, `tool_result`,
`error`, `done`. `done` carries today's exact final payload per surface
(`{quiz,questions}` lecturer; `{questions,capped}` student).

**Lifecycle fixes baked in:** in-flight guard delete moves into stream
finally/cancel/error (today's `try/finally` releases at Response-return, before
the stream drains — `generate-quiz/route.ts:125-135`). `request.signal` wired
into `chatCompletions` (signal param already exists, `client.ts:74`) and a
`signal.aborted` check before the save RPC — cancelling must not stop tokens,
must not save anyway, and must not leave the guard blocking retry. Heartbeats
during parse are feasible (`nativeExtract` is await-based; `pdfjs` `onProgress`
can power a real Parse progress event). Wrapper starts the stream before
awaiting the handler (stream-executor pattern).

**Lib plumbing:** `generateQuiz` gains optional `onEvent` (default = byte-identical
behavior; add a mirror test asserting identical prompt + outcome with/without).
Both routes get the wrapper (student included). OCR route
(`/api/extract/ocr`) is explicitly exempt — document in ARCHITECTURE.md.

Post-save refetch failure (lecturer route `route.ts:390-399` — save committed,
quiz refetch failed): new `saved_refresh_failed` event class → client shows
success-with-refresh-hint, retry CTA suppressed (a "retry" would wipe and
re-bill a successful save).

## Phase 1.5 — Upstream streaming client (prereq for 3/4/5, named work item)

`chatStream` sibling to `chatCompletions`: SSE parsing, `reasoning_content`
passthrough (type augmentation — openai@7.4.0 doesn't type it), tool_call delta
accumulation (index-keyed merge), `finish_reason` from stream tail,
deadline sharing across tool-loop iterations, abort-reason propagation
(cancel vs timeout distinguished). Truncation policy: `finish_reason=length`
mid-stream → `ai_truncated` error event, reasoning display preserved, no
auto-retry; the reasoning-ate-the-budget/empty-content signature gets its own
code + copy.

## Phase 2 — Lecturer console (full-page route)

`/lecturer/quizzes/[id]/generating`. Replicates builder server guards
(auth/lecturer-role/ownership). Dialog keeps steps 1–2; submit → navigate.

- **State transport:** sessionStorage handoff of `{extractedText, config}`,
  **clamped to `MAX_AGGREGATE_CHARS`** (client text is currently unclamped;
  server truncates to the same value anyway so outcome is byte-identical) and
  `setItem` wrapped in try/catch with fallback to in-dialog generation
  (Safari/private-mode throws on any write). Key cleared on consume; multi-tab
  same-quiz is safe (server in-flight guard → "already running" state).
- **Fetch ownership:** page POSTs on mount; strict-mode dedupe via component-scope
  ref on the same fiber (NOT module-scope) + single silent 429-retry after ~1.5s
  (dev-only annoyance otherwise). Cold load with no session key → neutral
  "no active generation" empty state, never auto-POST. bfcache `pageshow`
  persisted → "generation finished" neutral state.
- **Console:** four TRUE stages — Parse → Draft (attempt_start→first delta) →
  Refine (renders ONLY when a retry/tool-loop actually occurs; skipped stages
  dimmed; no parse event received → Parse renders skipped) → Save. Stage-derived
  varied copy (4–6 variants each), fully localized en+ms. Zero fake lines — the
  whimsy rotator from v1 was cut by unanimous critic verdict.
- **a11y:** single throttled `aria-live` polite summary (≤1 update/5s); console
  region `aria-hidden`; all JS motion behind `matchMedia('(prefers-reduced-motion:
  no-preference)')` (bot-avatar.tsx precedent) + `motion-reduce:` CSS variants.
- **Endings:** error → transcript retained, failed stage marked, "Try again"
  preserves config. Success → stamp payoff (Lucide Sparkles, localized) →
  "Review questions" `router.push` (never `router.back()`) to
  `/lecturer/quizzes/[id]/builder` (verified universal target). No auto-close.
  Fast completions (<8s, t=0 = stream open) skip animation with a settle beat.
  Cancel: explicit button, aborts fetch, transcript marked cancelled. Rate-limit
  quota burn on cancel: accepted + documented. Parse-phase cancel stickiness
  (unabortable parse holds the guard ≤120s): documented.
- Mobile: explicitly stacked/vertical rail spec (lecturers generate on phones).

## Phase 3 — Student console (in-dialog)

Collapsible single panel above the footer; step-2 controls collapse into a
compact "generating view" (88–94dvh vertical budget is the real constraint).
Merge happens at the `done` event, NOT at CTA click (drawer can be dismissed
via handle — CTA-time merge produces invisible success after a paid generation).
Fast default effort (no Deep on student side — asymmetry accepted and
documented: students get speed, lecturers get the opt-in spectacle).

## Phase 4 — Deep mode (lecturer-only, opt-in)

Radio-group toggle enabling max effort + reasoning drawer (K1/K2 gated; graceful
degrade to stage copy if reasoning absent). Reasoning deltas = inert text,
auto-scroll while streaming, focus-managed collapse. Append-only quality block
on the system prompt (byte-locked base untouched). `AI_MAX_OUTPUT_TOKENS` raise
gated on K2. One-sentence cost hint on the toggle. `regenerate-question`
intentionally stays legacy/fast — stated, not silent.

## Phase 5 — Calc tool

Function-calling `calc` (K3 gated; two-phase placeholder fallback budgeted as
its own item). Safe evaluator spec: finite-check every result (reject
Infinity/NaN with a tool error back to the model), 12 significant digits,
expression ≤200 chars, nesting ≤20, decimal+exponent literals only (no
hex/underscores/BigInt), fixed operator + function list (sqrt pow log ln exp
abs sin cos tan floor ceil round min max — arity pinned, factorial n≤170), no
property access/strings/identifiers. Cap 15 calls/generation, per-iteration
deadline recomputation. `tool_call`/`tool_result` events animate
expression→result. "Computed" badge (Lucide Check chip): lecturer-builder-only,
**session-ephemeral** (no schema change; vanishes on refresh — documented).

## Phase 6 — Live question cards

String-state-aware incremental JSON scanner (unit-tested on braces-in-strings
and escaped quotes), per-question `AiQuestionSchema` validation BEFORE emission,
dedupe by index. `attempt_retry` clears emitted cards → "second pass" state →
re-emit from index 1. Progress labeled "estimate", capped at 100%. Own work item.

## Phase 7 — TinyFish topic mode (lecturer-only)

New input contract (topic text) on its own surface; file flow untouched.
Orchestrate: generate queries → TinyFish Search → score snippets → fetch top ~3
via TinyFish Fetch → per-source 12k char cap, aggregate reusing
`MAX_AGGREGATE_CHARS` (align docs/COSTS.md §3.3) → skip-too-thin events → fenced
untrusted-context injection (S7 envelope; content treated exactly like PDF text).
Sources: append `{kind:"web", url, title, retrieved_at, query}` jsonb entries;
legacy `{file_url,...}` entries tolerated forever (freeze trigger makes live
quizzes permanently mixed-shape — verified `0016`/`0025`); `save_quiz_questions`
RPC gains a url-less-entry branch. Citation chips: lecturer-builder-only.
Student-facing citations deferred (needs its own trust design). SSRF mitigated
by TinyFish-side fetch. Every citation is a URL we actually fetched —
fabrication impossible by construction.

## Phase 8 — Parked

CLI/code-execution sandbox. Revisit with real numbers; calculator + evaluator
covers the STEM-verification itch meanwhile.

## Test strategy

Coverage goal, stated honestly: every **event type × terminal state × surface
(lecturer page / student drawer) × fault injection** is exercised somewhere in
the layers below. Mocks prove the contract; the real-provider smoke (F) proves
the provider — never confuse the two.

### A. Unit — `src/lib/ai` (vitest, pure functions)

- `chatStream` SSE parser: chunk boundaries splitting an event mid-line, mid-JSON
  argument, and mid-UTF8 character; reasoning_content passthrough; tool_call
  delta accumulation with out-of-order and fragmented indexes; finish_reason
  from stream tail; abort-reason propagation (cancel vs deadline distinct);
  deadline sharing across tool-loop iterations; `finish_reason=length` →
  `ai_truncated`; reasoning-ate-budget/empty-content → its own signature.
- Safe evaluator: finite-check rejections (1e999 → Infinity, Inf−Inf → NaN),
  12-sig-digit rounding, length/nesting caps, rejected literal forms
  (hex/underscore/BigInt), full operator + function list incl. min/max arity,
  factorial 170 ok / 171 rejected, DoS probes (deep parens, huge exponents),
  non-numeric garbage in.
- Incremental JSON scanner: braces/`}` inside prompt strings, escaped quotes,
  `\uXXXX` escapes, a question object split across three chunks, malformed
  trailing fragment dropped, dedupe by index, per-question Zod rejection before
  emission.
- `generateQuiz` onEvent mirror test: same fixture with/without onEvent →
  identical prompt string + result (pins the "byte-identical default" claim).
- Session handoff: clamp at `MAX_AGGREGATE_CHARS`, `QuotaExceededError`
  fallback path, consume-clears-key.

### B. Route integration (vitest, FakeSupabase + mock upstream)

- Two-segment contract, both routes: EVERY pre-stream exit returns its exact
  legacy JSON status (enumerated: same-origin, body limit, auth, ownership,
  draft, rate limit, in-flight, append pre-check, all five parse branches) —
  with AND without the `Accept: application/x-ndjson` header.
- Stream mode ordered sequences (collectStream): happy lecturer
  (`stage→…→done{quiz,questions}`), happy student (`done{questions,capped}`),
  parse-phase error event, AI failure event, RPC-failure event,
  `saved_refresh_failed` (save committed, refetch failed → no retry CTA semantics).
- Lifecycle: in-flight guard released on success/error/cancel (assert a second
  POST succeeds after each); `request.signal` abort → no save RPC call observed
  (FakeSupabase spy) + guard released; heartbeat pings present during silent
  phases and absent during delta flow; retry pass emits `attempt_retry` →
  client contract is reset+re-emit.
- Pre-stream error tests keep the existing ~25 JSON pins untouched — CI failure
  if any pin changes.

### C. E2E (Playwright + upgraded mock, per-worker ports)

- Lecturer happy path (e2 rewrite): generate → console stages → question cards →
  stamp → "Review questions" → builder shows rows (inserts the CTA click;
  accessible names preserved verbatim; LECTURER_INVITE_CODE gate carried).
- Student happy path (e19 rewrite): drawer console → merge happens at `done`
  (assert editor shows questions even though payoff was dismissed via handle).
- Cancel: mid-stream cancel → transcript marked cancelled → immediate regenerate
  works (guard released) → mock confirms no upstream completion drain.
- Mid-stream error: transcript retained, failed stage marked, "Try again"
  preserves config (mock scenario: mid-stream-error).
- Already-running: second generate → distinct "already running" state, not
  generic error.
- Cold load `/generating` with no session key → empty state, never auto-POST.
  bfcache back-nav → neutral "generation finished" state.
- Fast-path (<8s mock) → settle animation, no broken-looking rail flash.
- Deep mode on: reasoning drawer streams, collapses on completion, focus lands
  on footer CTA (mock reasoning fixture).
- Calc tool: calc lines animate expression→result; "computed" chip appears on
  affected question in builder; cap-15 respected (mock emits 16 → 15th honored,
  16th denied).
- Topic mode (Phase 7): topic → search/source events → chips in builder;
  skip-too-thin event rendered.

### D. Fault-injection matrix (mock scenarios — the chaos suite)

| Scenario injected by mock | Expected behavior |
|---|---|
| Malformed NDJSON line mid-stream | skip line, continue, no crash |
| Stream ends with no `done` event | dead-stream/EOF → error state, transcript kept |
| No bytes for 30s (stall) | dead-stream detector fires (Playwright `page.clock`, not real waiting) |
| Upstream 500 mid-generation | `error` event, retry preserves config |
| Truncation (`finish_reason=length`) | `ai_truncated` copy, reasoning preserved |
| Reasoning deltas interleaved with content | drawer + cards both work, no cross-contamination |
| Duplicate question index | dedupe, single card |
| Invalid question object mid-stream | dropped before display, Zod wall holds |
| Empty content after reasoning | distinct code + copy, retry guidance |
| 16 tool calls | 15 executed, loop aborted cleanly |
| Quota-exceeded sessionStorage | fallback path, generation still runs |

### E. Non-functional matrix

- i18n: `ms` locale renders every console string (stage variants, stamp, error
  copy) — `check-i18n.mjs` parity is CI-enforced; manual smoke on the console.
- Reduced motion (`page.emulateMedia`): rotator/stamp/auto-scroll skip, flow
  still completes; console copy still updates.
- Viewports: student drawer console at 360×640 (compact generating view fits,
  no below-fold surprise); lecturer `/generating` stacked rail on mobile width.
- Keyboard: Cancel reachable, focus never trapped by drawer collapse
  (focus-visible per MASTER.md).

### F. Real-provider smoke (NOT mockable — this is demo insurance)

A `scripts/` smoke harness (pattern exists: scenario seed+screenshot scripts):
real Kenari, tiny deck, 3 generations asserting end-to-end success + captured
event log; run before every demo. Covers exactly what mocks can't: K1–K3
behavior on the live proxy, reasoning cadence vs the 30s detector, real latency
shape. Failures here are the ones that would embarrass you — make this script
the pre-demo gate, and keep the degrade switches (Deep off → fast mode; stream
header omitted → legacy JSON) as documented demo-day escape hatches.

## Docs

COSTS.md (Deep-mode token math — reasoning tokens bill as output; topic-mode
search costs; free tier caveats), ARCHITECTURE.md (event contract + OCR
exemption), AGENTS.md (new e2e names), SECURITY_AUDIT (S7 extension to streamed
deltas + TinyFish envelope).

## Accepted tradeoffs (decided, not open)

1. Spectacle asymmetry: students get fast+light console, lecturers get Deep.
2. Rate-limit quota burns on cancel.
3. "Computed" badge is session-ephemeral (no persistence migration).
4. Regenerate-question stays fast/legacy.
5. English "tech-babble" avoided entirely — all console copy localized (the
   fake-English whimsy idea died in critique round 1).
6. Topic mode ships lecturer-only; student citations are a future feature.
