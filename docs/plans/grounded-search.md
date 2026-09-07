# Plan: Grounded Web Search for Quiz Generation (TinyFish topic mode)

> Status: CRITIQUED — 3 subagent critics (plan, AI-eval, e2e) returned
> findings; all BLOCKER/MAJOR resolutions are folded into this revision
> (see "Critique revisions" at the bottom). Implements Phase 7 of
> docs/plans/agentic-generation.md, adapted to the current in-dialog
> generation flow (the /generating console page is retired; Phase 3's
> GenerateProgress owns generation inside GenerateFromFileDialog).

## Error codes (pinned up front)

| Code | Meaning | Legacy status | Stream event |
|---|---|---|---|
| `search_unavailable` | key unset (route reached anyway) / TinyFish 401/402/403 / fetch request-level failure | 503 | `{type:"error", code:"search_unavailable"}` |
| `search_failed` | search/fetch network failure after retry, 5xx, 429-after-retry, OR all fetched URLs failed | 502 | error event, same code |
| `search_corpus_thin` | search+fetch SUCCEEDED but corpus < 200 chars | 422 | error event, same code |

GenerationProgress maps these codes to localized strip copy (errorCode→key
map, generic fallback for unknown codes) instead of raw server messages.

## Critique revisions (folded in)

1. **[BLOCKER] extractedText gates made mode-aware** — `handleGenerate`
   gate (`!extractedText`), step-2 render gates, and the step-1 footer CTA
   all learn `webMode` (topic ≥3 chars substitutes for extractedText). Step
   1 web mode shows a "Generate quiz" primary CTA (no extraction step).
2. **[MAJOR] Builder sources plumbing added as explicit work items** —
   builder `page.tsx` select gains `sources`; `QuizRow` type + prop
   drilling to `quiz-builder-client`; `SourceChips` component; unit + e2e
   coverage. (The plan's original premise that the builder already fetches
   `sources` was FALSE — route refetch only.)
3. **[MAJOR] Wire ordering pinned** — topic mode emits `stage parse skip`
   BEFORE the search stage runs (route branches before `prepareSource`);
   route integration tests pin event ORDER, not just membership. e2d
   structural trace assertions verified compatible (search lines land
   between parse-skip and draft).
4. **[MAJOR] RPC migration** — 0040 creates **`save_quiz_questions_web`** (a
   SIBLING function carrying `p_web_sources`, NOT a 7-arg overload — the
   implementation found PostgREST cannot resolve NAMED-ARGUMENT calls across
   same-name overloads, so the overload would have broken every 6-arg caller
   at the wire layer; the sibling keeps them byte-identical). The body is the
   0025 body VERBATIM (auth check, advisory lock, source_text cap, grants) +
   web-source branches; the route calls the 6-arg function for file flows and
   `_web` only when web sources exist. Live-DB smoke:
   `node scripts/verify-web-sources.mjs` (grants, URL-skip, replace/append
   matrix). URL validation happens in the FUNCTION BODY (no DDL CHECK
   possible on jsonb entries): `url ~* '^https?://[^[:space:]]+$'` and length
   ≤2048, entry skipped (not fatal) when invalid.
5. **[MAJOR] generationBody omits** `extractedText`/`sourcePaths` keys
   entirely in web mode (empty string ≠ absent to Zod); XOR rules test
   `.optional()` absence; `topic` requires `useWebSearch` too (pair rule).
   Web+append is ALLOWED and offered as usual (mode radios unchanged).
6. **[MINOR] batch fixes** — fetch timeout 150s; all-URLs-failed →
   `search_failed` (thin is only for successful fetches with <200 chars);
   web-variant payoff copy ("N web sources" instead of "0 characters");
   `import "server-only"` in tinyfish.ts (+ grep guard in its test);
   `planSearchQueries` try/catch wraps the `createAiClient()` throw too;
   fetched text scrubbed of the literal `=== WEB SOURCE` envelope prefix
   (anti-spoofing).
7. **[BLOCKER] e2e marker echo contract** — marker lives ONLY in the topic;
   mock-ai gains a `tf_*` case in the NON-STREAM branch that echoes the
   marker into planned queries (`["[MOCK:tf_ok] photosynthesis light
   reactions", ...]`); mock-tinyfish sniffs the `query` param statelessly;
   unit test pins `planSearchQueries` embedding the topic verbatim;
   fallback `[topic.slice(0,120)]` documented as the safety net; `tf_`
   namespace avoids colliding with mock-ai's draft scenarios.
8. **[BLOCKER] flag-off testing** — third playwright webServer entry (same
   build, port 3002, `TINYFISH_API_KEY: ""` explicitly, no mock URLs) +
   `chromium-nowebsearch` project running one flags spec. Harness ALWAYS
   sets `TINYFISH_API_KEY`/`TINYFISH_SEARCH_URL`/`TINYFISH_FETCH_URL`
   explicitly (never inherits `.env.local`); `isWebSearchEnabled()` treats
   `""` as absent (`Boolean(key?.trim())`).
9. **[BLOCKER] mobile test** uses `test.use({ viewport: {width:360,
   height:640} })` inside e2f (desktop project would run it vacuously at
   1280px otherwise).
10. **Fixture/scoring coupling** — tf_ok fixture: 3 URLs on 3 DISTINCT
    hostnames, titles/snippets containing the topic tokens (scorer would
    legitimately drop them otherwise); documented in the mock header.
11. **e2e mechanics** — no `page.clock` (multi-process pipeline); mock-
    tinyfish serves `GET /__requests` (in-memory log) for `expect.poll`
    assertions; `[MOCK:tf_slow]` delayed search gives cancel a deterministic
    window; chips contract: `role="link"`, `data-testid="web-source-chip"`,
    accessible name = visible truncated text, `toHaveHref` exact fixture
    URLs; reduced-motion test introduces `page.emulateMedia` as a NEW
    pattern (none exists today); dark-mode tints stay a review concern.
12. **AI eval rebuilt per the eval critic's spec** (§D below): 6 purpose-
    assigned topics + decoy contamination arm, automated checks 2.1–2.6
    (thresholds calibrated once via `--calibrate`), per-quiz LLM judge with
    MECHANICAL quote verification (grounded verdicts without a verbatim
    ≥8-word corpus quote auto-downgrade to unsupported), 3-run aggregate
    gates, exit 1 (gate) vs 2 (infra).

## Goal

Lecturers can generate a quiz from a **topic** instead of uploaded material:
the server plans search queries from the topic (via the existing AI client),
runs **TinyFish Search** (free) to rank web results, fetches the top pages as
clean markdown via **TinyFish Fetch** (free), and grounds the quiz in that
fetched text — with every citation being a URL we actually fetched
(fabrication impossible by construction). File/paste flows are untouched and
remain the default.

TinyFish API facts (verified from docs.tinyfish.ai, 2026-09):
- Search: `GET https://api.search.tinyfish.ai` — `X-API-Key` header; params
  `query` (required), `purpose`, `language`, `location`, `domain_type`;
  response `{query, results: [{position, site_name, title, snippet, url,
  date?}], total_results, page}`; no result-count param (paginate instead);
  30 req/min free; HTTP 429 on burst.
- Fetch: `POST https://api.fetch.tinyfish.ai` — body `{urls (1–10),
  format: "markdown", links: false, image_links: false,
  per_url_timeout_ms}`; response `{results: [{url, final_url, title, text,
  ...}], errors: [{url, error, status?}]}`; per-URL failures are NOT HTTP
  errors; private IPs/localhost/metadata endpoints rejected server-side
  (SSRF handled by TinyFish); 150 URLs/min free; set client timeout ≥150s.
- Both free at any wallet balance. Search+Fetch only need `X-API-Key`.

## Non-goals

- Student-facing citations (needs its own trust design — Phase 7 accepted
  tradeoff). Topic mode is **lecturer-only**.
- TinyFish Agent/Browser APIs (wallet-metered — out of scope, we use free
  Search+Fetch only).
- Caching of fetched pages (each generation fetches live; free tier
  throughput is ample at demo scale). Revisit if rate limits bite.

## Demo-day escape hatches (consistent with the agentic plan)

1. `TINYFISH_API_KEY` unset → topic mode UI hidden (builder passes
   `hasWebSearch=false`), route rejects with `search_unavailable`. The file
   flow never touches TinyFish — feature flag is inert for it.
2. Search/fetch failure or too-thin corpus → distinct `search_failed` /
   `search_unavailable` error events with Try again (file flow untouched;
   in-flight guard released like any error).
3. Legacy JSON (non-stream) clients get the identical topic-mode result via
   the same lib, minus events.

## Architecture

### 1. `src/lib/ai/tinyfish.ts` (NEW, server-only)

- `TINYFISH_SEARCH_URL` (default `https://api.search.tinyfish.ai/search`),
  `TINYFISH_FETCH_URL` (default `https://api.fetch.tinyfish.ai`),
  `TINYFISH_API_KEY`. `isWebSearchEnabled()` = key present.
  NOTE: the docs index says the search host root is the endpoint; the
  implementation spike (`scripts/spike-tinyfish.mjs`, run first) confirms the
  exact URL (root vs `/search`) and response shape; constants are
  env-overridable so the spike can fix the default without code churn.
- Zod schemas tolerate optional/missing metadata fields (never trust the
  wire): `TinyfishSearchResponse`, `TinyfishFetchResponse`.
- `tinyfishSearch({query, purpose, language, signal, timeoutMs=20s})`:
  single retry on 429/5xx/abortable-network with 1s backoff; returns
  `{ok:true, results}` or `{ok:false, error:"rate_limited"|"unavailable"|"failed"}`.
- `tinyfishFetch({urls, signal, timeoutMs=110s})`: one batch (≤3 URLs so we
  never hit the 10-URL cap), maps per-URL `errors[]` to skipped sources.
- **Query planning**: `planSearchQueries(topic, questionCount, opts)` — one
  small `chatCompletions` call (temperature 0.2, jsonMode, max_tokens 300)
  asking for 2–3 distinct search queries for the topic; Zod-validated
  (`array(string).min(1).max(3)`, each trimmed 3–120 chars); any failure
  falls back to `[topic.slice(0,120)]` so the feature degrades to a direct
  search, never an error.
- **Scoring/diversity** (`selectSources(results, topic, max=3)`): score =
  case-insensitive term overlap between snippet+title and topic tokens
  (tokens ≥3 chars, tiny EN stopword list), +position decay; dedupe by URL,
  cap 2 per hostname for diversity; returns top N. Unit-pure, no network.
- **Corpus assembly** (`buildWebCorpus(fetchResults, capPerSource=12_000,
  capAggregate=MAX_AGGREGATE_CHARS)`): fenced per-source blocks
  `=== WEB SOURCE [i/N]: <title> (<host>) — retrieved <ISO date>, query:
  <q> ===` followed by markdown text with ``` → ''' (same escape as
  buildQuizUserPrompt) and control chars stripped; per-source 12k cap,
  aggregate cap, then **too-thin check** (<200 chars total → error).
- **Envelope hardening (S7)**: fetched markdown may contain prompt injection
  ("ignore previous instructions"). Defenses: links/images disabled at the
  API call; fence + escape; the system prompt (below) names web sources as
  untrusted; the model's output remains Zod-walled exactly like PDF text.
- **`runGroundedSearch({topic, questionCount, language, ai, deadlineMs,
  signal, onEvent})`**: orchestrates plan → search (one `tool_call` event per
  query) → select → fetch → corpus; emits
  `tool_call {tool:"web_search", query}` / `tool_result {tool:"web_search",
  query, resultCount, skipped?, reason?}` and returns
  `{ok:true, text: corpus, sources: WebSourceEntry[]}` or
  `{ok:false, error:"search_failed"|"search_unavailable", message}`.
  `WebSourceEntry = {kind:"web", url, title, retrieved_at, query}`.

### 2. Events + stage (`src/lib/ai/events.ts`)

- `GenerationStage` gains `"search"` (between parse and draft).
- New events: `tool_call {tool, query}` / `tool_result {tool, query,
  resultCount, skipped?, reason?, top?: [{title,url}]}` (top ≤3 — small,
  no snippets). All rendered as server-chrome trace lines, never model text.

### 3. Validation (`src/lib/ai/validation.ts`)

`GenerateQuizSchema` gains:
- `topic: z.string().trim().min(3).max(500).optional()`
- `useWebSearch: z.boolean().optional().default(false)`
- superRefine XOR rules: `useWebSearch` requires `topic`; topic mode
  requires `extractedText`, `sourcePath`, `sourcePaths` all absent
  (`"Web search mode cannot be combined with file or text sources."`).
  `GenerateStudentQuizSchema` unchanged (students never get topic mode).

### 4. Route (`/api/ai/generate-quiz`)

- After validation, if `useWebSearch`: `prepareSource` takes the search
  branch — emits `stage search start` (truth rule: only when it actually
  runs; parse emits `skip`), runs `runGroundedSearch`, converts failures to
  the SAME two-segment contract (`search_unavailable` → 503-style event with
  code; legacy JSON keeps its status). Result text flows into the existing
  draft → save pipeline unchanged.
- `saveGeneration` passes `p_web_sources` (jsonb) when sources exist; null
  otherwise. Quiz refetch already selects `sources`.

### 5. Migration `0040_web_sources.sql`

- New RPC signature `save_quiz_questions(uuid, text, text, text, jsonb,
  text, jsonb)` — 7th arg `p_web_sources jsonb DEFAULT NULL` (Postgres
  overload keeps the 6-arg call sites working; grant on the new signature).
- Sources assembly: legacy storage-path entry (when `p_source_file_url`)
  exactly as 0025; additionally `p_web_sources` entries appended in replace
  mode (`sources = web_entries` when present, else 0025 behavior) and
  appended in append mode (`sources = coalesce(sources,'[]') ||
  web_entries`). Web entry shape: `{id, kind:"web", url, title,
  retrieved_at, query}` with url length-checked (≤2048) and
  `kind='web'` enforced via a CHECK on a jsonb IS NOT NULL guard (validate
  in SQL: url starts with http(s) — lightweight jsonb validation, full
  validation is server-side).
- Mixed-shape sources rows are permanent (freeze trigger precedent from
  0016/0025 verified).

### 6. UI — `GenerateFromFileDialog` (lecturer surface only)

- New prop `hasWebSearch: boolean` (builder page: `isWebSearchEnabled()`).
- Step 1 gains a two-button source-mode chooser (clay radio pattern, exactly
  like difficulty buttons): **"My material"** (default → current flow) /
  **"Web topic"** (hidden when `!hasWebSearch`).
- Web topic mode hides dropzone/paste/engine/OCR; shows:
  - topic Input (id `web-topic`, maxLength 500, labeled, localized
    placeholder),
  - info note (Searches the web via TinyFish; pages are fetched and grounded;
    citations appear in the builder), warm info tone per MASTER.md,
  - steering prompt + difficulty + type mix + count + language + mode
    controls all still apply (web mode is just another source).
- "Generate quiz" with web mode goes straight to `step 2` generating view
  (no extraction). `generationBody` becomes mode-aware (topic+
  useWebSearch vs extractedText/sourcePaths) — clamp topic to 500.
- `GenerationProgress` + `use-generation-stream`:
  - `STAGE_ORDER` gains `search`; localized label/active copy
    (`stageSearchLabel`, `stageSearchActive`).
  - `tool_call`/`tool_result` events → stage-kind trace lines
    ("Searching the web: <query>" / "<n> results — fetched top 3" /
    "Skipped <host>: <reason>") — server chrome, localized via component.
  - Everything else (dead-stream watchdog, cancel, retry) reused as-is.
- Mobile: chooser + topic input stack full-width (same 3px border clay
  cards); trace/search lines wrap (`break-words` already enforced); no
  horizontal overflow at 360px. Dark mode: amber/info tints use the
  established `dark:*` pairs (class-detail-client pattern).

### 7. Builder chips (lecturer builder only)

- Builder page already fetches `sources`; parse jsonb into typed
  `QuizSourceRow[]` (`kind:"web"` entries + legacy storage entries
  tolerated). New `SourceChips` section in the sidebar under the existing
  source summary: web entries render as link chips (Lucide `ExternalLink`,
  truncated title/hostname, `href=url`, `target="_blank"`,
  `rel="noopener noreferrer nofollow"`); legacy entries keep their filename
  text (unchanged). Hidden entirely when `sources` empty.
- Students: no citations anywhere (Phase 7 tradeoff).

### 8. i18n (en + ms parity — CI-enforced)

All new copy under `extract.*` (dialog, stage, tool lines, errors,
web-note) + `builder.*` (chips section title). `npm run check:i18n` gates.

### 9. Testing

**A. Unit (vitest)**
- `tinyfish.test.ts`: response parsing (missing/malformed fields, per-URL
  errors), scoring/diversity (domain cap, position decay, dedupe), corpus
  building (12k/aggregate caps, ``` escaping, fence shape, too-thin
  rejection), query-plan validation + fallback on garbage, retry-on-429
  with fake timers.
- `validation.test.ts`: XOR rules (topic+text rejected; useWebSearch w/o
  topic rejected; missing key unaffected).
- `quiz-prompt.test.ts`: audit pattern extension (`according to the
  website/article/page` flagged).
- Mirror test: legacy topic-mode generation identical with/without onEvent
  (search result nondeterminism acknowledged — assert envelope STRUCTURE,
  not bytes: same fences count, same source URLs ordering rule).

**B. Route integration (FakeSupabase + stubbed tinyfish module)**
- Topic mode happy path (legacy JSON + stream sequences:
  `stage search start→done` + tool events → `done`).
- `search_unavailable` / `search_failed` in both protocols.
- Topic+text XOR → 400 with exact legacy code; student schema rejects topic.
- Save asserts `p_web_sources` passed to the RPC; null for file flows.

**C. E2E (Playwright)** — new `e2e/mock-tinyfish-server.mjs` (http server
sniffed by env `TINYFISH_SEARCH_URL`/`TINYFISH_FETCH_URL` override in
playwright webServer env; stateless scenario markers in the topic string,
same pattern as mock-ai):
- `e2f-web-generate.spec.ts`:
  1. Happy path: topic "photosynthesis basics" (+`[MOCK:tf_ok]` marker) →
     search stage lines visible → payoff → builder shows 3 web chips with
     correct hrefs (fixture URLs).
  2. Too-thin corpus (`[MOCK:tf_thin]`) → distinct localized error strip +
     Try again preserved topic.
  3. Key absent (project without TINYFISH env) → Web topic option hidden
     (file flow only). [covered by a dedicated tiny project or env flip]
  4. Mobile viewport 360×640 happy path (no overflow: `scrollWidth <=
     clientWidth` assertion on the dialog body).
  5. Reduced-motion pass (existing pattern).
- mock-tinyfish fixtures: 3 search results + 3 markdown pages (one page
  containing an injection attempt "IGNORE PREVIOUS INSTRUCTIONS" to assert
  the Zod wall + quiz still valid); thin fixture (empty text).

**D. AI eval — grounding quality (real provider, pre-demo gate)** —
`scripts/eval-grounded-quiz.mjs` (new; real Kenari + real TinyFish):
- Scenario: 6 topics × questionCount 5, across en/ms/auto + difficulty mix.
- Automated checks per run:
  1. **Retrieval sanity**: ≥1 query planned; ≥1 source fetched; corpus
     ≥200 chars; every source URL http(s); no duplicate URLs.
  2. **Grounding**: for each question, keyword-overlap score vs the corpus
     (≥ threshold on prompt+correct-option terms) — catches pure-hallucination.
  3. **LLM judge** (second Kenari call per quiz, JSON-forced, temperature 0):
     verdict per question — `grounded` / `unsupported` / `wrong` — against
     the exact corpus text with a strict rubric ("answer must be entailed by
     the corpus; answer must not cite the corpus as an external document").
     Gate: ≥80% grounded per run, 0 `wrong`.
  4. **No fabrication**: quiz JSON contains no URLs beyond fetched set.
- Failure output: per-question verdict table + corpus snippet; exit 1 on
  gate miss. This is the "search used properly" gate — run before demo
  alongside smoke-real-provider.mjs.

**E. Docs**: COSTS.md §3.3 (Search 30 rpm free / Fetch 150 URLs/min free,
corpus caps), ARCHITECTURE.md (event contract + search stage + TinyFish
trust posture), SECURITY_AUDIT.md (S7 extension: web envelope), TESTING.md
(e2f + eval script), AGENTS.md (e2f name).

## Deliberate decisions (open to critique)

1. **Topic mode lives inside GenerateFromFileDialog as a source-mode
   chooser**, not a separate route/surface (deviation from Phase 7's "own
   surface" note, which predates the Phase 3 dialog console). Same dialog,
   same generating view, same retry semantics — one mental model.
2. **Query planning uses the existing AI client** rather than hand-rolled
   keyword extraction — better Malay/EN handling, one extra ~300-token call
   per generation (~free on local Kenari), and it degrades to direct-topic
   search on failure.
3. **Fetch top 3 only** (1 batch call) — corpus quality > quantity; 12k
   chars/source keeps prompt < ~50k tokens with the quiz instructions.
4. **`tool_call`/`tool_result` are new event types** (the plan doc reserved
   the names) — narrow payloads, rendered as server chrome.
5. **7th RPC arg (overload) instead of editing the 6-arg function in place**
   — existing route tests pin the 6-arg call; the overload keeps the
   migration additive and reversible.
6. **No caching** of search/fetch results (demo scale; free tier).
7. **Rate limits**: TinyFish 30 search req/min is per key, shared across
   users — acceptable at demo scale; `search_failed` surfaces 429 cleanly
   (and the generation rate limit already caps 10/h/user).

## Risks

- Exact search endpoint path unconfirmed (root vs `/search`) → spike script
  first; env-overridable URLs.
- Fetch markdown can be huge → hard caps + per-source truncation before the
  aggregate cap.
- Injection via fetched pages → same Zod wall as PDFs + envelope labeling;
  e2e fixture includes an injection attempt.
- Kenari query-plan call adds latency (~2–5s) → it's inside the search
  stage with pings; console truth rule keeps the rail honest.
