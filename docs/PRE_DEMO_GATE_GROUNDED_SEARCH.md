# Pre-Demo Gate — Grounded Web Search (TinyFish topic mode)

> Run this the day BEFORE the demo and again ~1h before. Every step below is
> pass/fail; if the TinyFish-dependent steps fail, the documented fallback is
> to demo the file/paste flow (the feature flag hides "Web topic" cleanly —
> nothing else is affected).

## 0. Environment

| Var | Where | Demo value |
|---|---|---|
| `TINYFISH_API_KEY` | `.env.local` | real key (free: tinyfish.ai → API keys). **Absent key = feature hidden** — decide deliberately. |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | `.env.local` | Kenari, as today |
| Supabase | `npx supabase start` | local Docker (start Docker Desktop first) |
| Seeded accounts | `npm run seed:demo` | `lecturer@innovision.test` / `Password123!` |

`node scripts/spike-tinyfish.mjs` (once per new key) must print:
`[search] … → 200` with `total_results` and `[fetch] … → 200` with a
non-zero text length.

## 1. Automated gates (in order; stop on red)

1. `npm run check:i18n` — en/ms parity must be 1105/1105.
2. `npm run typecheck` && `npm run lint` — 0 errors.
3. `npm run test` — full unit suite green (includes `tinyfish.test.ts`,
   `web-generate.test.ts`: event ORDER, error codes, RPC provenance).
4. `node scripts/verify-ai.mjs` — 16/16 (RPC/grant layer healthy).
5. `npx playwright test e2f --project=chromium` — web-mode journeys on the
   mock (chips, thin/5xx/401 strips, cancel, partial fetch, mobile 360).
6. `npx playwright test e2f --project=chromium-nowebsearch` — flag-off:
   chooser hidden, paste flow intact.
7. **Real-provider + real-TinyFish grounding gate**:
   `node scripts/eval-grounded-quiz.mjs --runs 1 --topics t1,t3` (~5 min
   smoke; must PASS or INFRA-retry), then the full gate on demo eve:
   `node scripts/eval-grounded-quiz.mjs` (3 runs, ~20–40 min; exit 0).

## 2. Manual demo rehearsal (browser, seeded account)

1. `npm run build && npm run start` (or `npm run dev`) → login as
   `lecturer@innovision.test`.
2. Open a DRAFT quiz → "Generate from file" → the two-card source chooser
   ("My material" / "Web topic") shows. Switch both cards — layout must hold
   in light AND dark themes, and at ~360px width (mobile).
3. "Web topic" → topic input appears (no dropzone/paste/engine) → enter
   e.g. "causes of the 2008 global financial crisis" → Generate quiz.
4. Console: strip shows Search → Draft → Save dot trail; expanding
   "Thinking" shows real lines: `Searching the web: …`, `N results …` —
   never fabricated stages. Cancel button works mid-search.
5. Payoff reads "5 questions grounded in N web pages." → Review → builder.
6. Builder: "Sources used" chips — each opens the exact page fetched
   (target=_blank). No chip → no citations persisted (flagged).
7. Repeat one generation in Bahasa Melayu (shell language toggle → BM) and
   verify the search copy renders localized (`Mencari di web: …`).

## 3. Demo-day fallbacks (documented degradation switches)

- TinyFish down / key invalid mid-demo: the strip shows the localized
  `search_failed` / `search_unavailable` card with Try again; switch to the
  file/paste flow for that quiz (never shows a raw error).
- Search returns thin content: `search_corpus_thin` strip suggests another
  topic — have a backup topic with rich sources (e.g. photosynthesis).
- Rate-limit (shared 30 rpm key): wait ~1 min; per-user generation quota is
  10/hour and cancellations burn a hit.
