import "server-only";
import { z } from "zod";
import { MAX_AGGREGATE_CHARS } from "@/lib/extract/types";
import { chatCompletions, AI_MODEL, type ChatMessage } from "@/lib/ai/client";
import type { OpenAI } from "openai";

/**
 * TinyFish Search + Fetch client (grounded-search.md §1, SERVER-ONLY).
 *
 * Both APIs are FREE (docs.tinyfish.ai, 2026-09): Search 30 req/min, Fetch
 * 150 URLs/min per key; auth is the `X-API-Key` header. `import "server-only"`
 * mirrors src/lib/ai/client.ts (S8): TINYFISH_API_KEY must never reach the
 * client bundle.
 *
 * Trust posture (S7): fetched page markdown is UNTRUSTED DATA. Links/images
 * are disabled at the API level, the corpus is fenced + labeled as untrusted,
 * the envelope prefix is scrubbed from fetched text (anti-spoofing), and the
 * model's output remains Zod-walled exactly like PDF text.
 */

const SEARCH_URL_DEFAULT = "https://api.search.tinyfish.ai";
const FETCH_URL_DEFAULT = "https://api.fetch.tinyfish.ai";

/** Read lazily (not module-level) so tests and the e2e harness can override
 * via env at runtime — the values are consumed per call, never cached. */
export function tinyfishSearchUrl(): string {
  return process.env.TINYFISH_SEARCH_URL?.trim() || SEARCH_URL_DEFAULT;
}
export function tinyfishFetchUrl(): string {
  return process.env.TINYFISH_FETCH_URL?.trim() || FETCH_URL_DEFAULT;
}

/** Empty string counts as absent — the e2e harness OVERRIDES (not unsets) the
 * key with "" on its flag-off server instance, so a falsy-but-present key
 * must disable the feature, not enable it with an empty secret. */
export function isWebSearchEnabled(): boolean {
  return Boolean(process.env.TINYFISH_API_KEY?.trim());
}

function tinyfishKey(): string {
  const key = process.env.TINYFISH_API_KEY?.trim();
  if (!key) throw new Error("TINYFISH_API_KEY is not set.");
  return key;
}

// ─── Wire schemas (tolerate missing/optional metadata — never trust it) ─────

const SearchResultSchema = z.object({
  url: z.string(),
  title: z.string().optional().nullable(),
  snippet: z.string().optional().nullable(),
  site_name: z.string().optional().nullable(),
  position: z.number().optional(),
});
const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema).optional().default([]),
});

const FetchResultSchema = z.object({
  url: z.string(),
  final_url: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  text: z.string().optional().nullable(),
});
const FetchErrorSchema = z.object({
  url: z.string(),
  error: z.string().optional().nullable(),
  status: z.number().optional(),
});
const FetchResponseSchema = z.object({
  results: z.array(FetchResultSchema).optional().default([]),
  errors: z.array(FetchErrorSchema).optional().default([]),
});

export type TinyfishSearchHit = {
  url: string;
  title: string;
  snippet: string;
  /** The search query that produced this hit (corpus provenance). */
  query?: string;
};

export type TinyfishFetchedPage = {
  url: string;
  title: string;
  text: string;
};

export type TinyfishHttpError =
  | "unavailable" // 401/402/403 — key missing/invalid/no access (or key unset)
  | "failed"; // 429 after retry, 5xx after retry, 400, network error

// ─── Search ──────────────────────────────────────────────────────────────────

/**
 * One ranked search round-trip with a single retry on 429/5xx/network
 * (1s backoff). 429 is the shared-key rate limit (30 req/min free tier);
 * retrying once absorbs a burst without stalling the generation.
 */
export async function tinyfishSearch(opts: {
  query: string;
  purpose?: string;
  language?: "en" | "ms";
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<
  | { ok: true; results: TinyfishSearchHit[] }
  | { ok: false; error: TinyfishHttpError }
> {
  const params = new URLSearchParams({ query: opts.query });
  if (opts.purpose) params.set("purpose", opts.purpose.slice(0, 2000));
  if (opts.language) {
    params.set("language", opts.language);
    // Location pairs with the language (docs: location=MY → language=ms is
    // the natural pairing for Malay retrieval).
    if (opts.language === "ms") params.set("location", "MY");
  }

  let key: string;
  try {
    key = tinyfishKey();
  } catch {
    return { ok: false, error: "unavailable" };
  }

  const timeoutMs = opts.timeoutMs ?? 20_000;
  let lastError: TinyfishHttpError = "failed";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1_000));
      if (opts.signal?.aborted) return { ok: false, error: "failed" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onOuterAbort);
    try {
      const res = await fetch(`${tinyfishSearchUrl()}?${params.toString()}`, {
        headers: { "X-API-Key": key, accept: "application/json" },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        return { ok: false, error: "unavailable" };
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = "failed";
        continue;
      }
      if (!res.ok) return { ok: false, error: "failed" };
      const parsed = SearchResponseSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) return { ok: false, error: "failed" };
      const results: TinyfishSearchHit[] = [];
      for (const r of parsed.data.results) {
        const lower = r.url.toLowerCase();
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) continue;
        results.push({
          url: r.url,
          title: r.title?.trim() || r.site_name?.trim() || r.url,
          snippet: r.snippet?.trim() ?? "",
        });
      }
      return { ok: true, results };
    } catch {
      lastError = "failed";
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
  return { ok: false, error: lastError };
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

/**
 * One batched fetch round-trip (≤10 URLs per request per the API contract;
 * callers pass ≤3). Per-URL failures land in `errors[]` WITHOUT failing the
 * HTTP request — they are returned as skipped entries so the caller can
 * distinguish "this page failed" from "the whole fetch broke" (an HTTP-level
 * failure maps to `unavailable`/`failed`; all-URLs-failed is decided by the
 * caller, which knows how many it sent).
 */
export async function tinyfishFetch(opts: {
  urls: string[];
  purpose?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<
  | {
      ok: true;
      pages: TinyfishFetchedPage[];
      failedUrls: Array<{ url: string; error: string; status?: number }>;
    }
  | { ok: false; error: TinyfishHttpError }
> {
  let key: string;
  try {
    key = tinyfishKey();
  } catch {
    return { ok: false, error: "unavailable" };
  }

  const controller = new AbortController();
  // TinyFish docs: the batch CDN ceiling is 120s — set the client budget
  // ABOVE it (150s) so a slow-but-live batch is never cut off locally.
  // No 429/5xx retry here (deliberate, unlike search): fetches are one
  // batched call per generation and a shared-key burst surfaces cleanly as
  // search_failed — retrying a 150s batch would blow the stage budget.
  const timeoutMs = opts.timeoutMs ?? 150_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort);
  try {
    const res = await fetch(tinyfishFetchUrl(), {
      method: "POST",
      headers: { "X-API-Key": key, "content-type": "application/json" },
      body: JSON.stringify({
        urls: opts.urls.slice(0, 10),
        format: "markdown",
        links: false,
        image_links: false,
        ...(opts.purpose ? { purpose: opts.purpose.slice(0, 2000) } : {}),
      }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      return { ok: false, error: "unavailable" };
    }
    if (!res.ok) return { ok: false, error: "failed" };
    const parsed = FetchResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return { ok: false, error: "failed" };
    const pages: TinyfishFetchedPage[] = [];
    const failures: Array<{ url: string; error: string; status?: number }> = [];
    for (const r of parsed.data.results) {
      const text = (r.text ?? "").trim();
      // INJ-F2: normalize final_url to a real http(s) URL; an unparseable or
      // non-http value falls back to the requested (server-derived) URL.
      const finalUrl = safeHttpUrl(r.final_url);
      if (!text) {
        // An empty-body success is a fetch failure for grounding purposes —
        // counting it as such lets the caller distinguish "page had no
        // content" (thin) from "every page failed" (outage) correctly.
        failures.push({ url: finalUrl ?? r.url, error: "empty_content" });
        continue;
      }
      pages.push({
        url: finalUrl ?? r.url,
        title: r.title?.trim() || r.url,
        text,
      });
    }
    return {
      ok: true,
      pages,
      failedUrls: [
        ...failures,
        ...parsed.data.errors.map((e) => ({
          url: e.url,
          error: e.error ?? "unknown",
          status: e.status,
        })),
      ],
    };
  } catch {
    return { ok: false, error: "failed" };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

// ─── Query planning (AI call with graceful fallback) ─────────────────────────

const PlannedQueriesSchema = z.object({
  queries: z
    .array(z.string().trim())
    .min(1)
    // Clamp inside the transform — Zod validates .max() BEFORE transforming,
    // so a 7-element array must not fail before dedupe/trim shrinks it.
    .transform((qs) =>
      [...new Set(qs.map((q) => q.replace(/\s+/g, " ").trim()))]
        .filter((q) => q.length >= 3 && q.length <= 120)
        .slice(0, 3),
    )
    .refine((qs) => qs.length >= 1 && qs.length <= 3, "No usable queries."),
});

/**
 * Plan 1–3 distinct web-search queries for the topic via the existing AI
 * client. The topic string is embedded VERBATIM in the user message — the
 * e2e harness's scenario markers ride on this contract (pinned by a unit
 * test; paraphrasing would silently drop markers). ANY failure — including
 * createAiClient() throwing on missing env — degrades to a single
 * direct-topic query, never an error. `chat` is injectable for tests
 * (generateQuiz's pattern); production callers omit it.
 */
export async function planSearchQueries(opts: {
  client: OpenAI;
  topic: string;
  questionCount: number;
  language: "en" | "ms" | "auto";
  deadlineMs: number;
  signal?: AbortSignal;
  chat?: typeof chatCompletions;
}): Promise<string[]> {
  const chat = opts.chat ?? chatCompletions;
  try {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You plan web search queries for research. Respond with ONLY a JSON object of the form {\"queries\": string[]} with 2 to 3 SHORT (under 12 words), distinct, effective search queries. Never answer anything else.",
      },
      {
        role: "user",
        content: `Topic for a ${opts.questionCount}-question quiz${
          opts.language === "ms"
            ? " written in Bahasa Melayu"
            : opts.language === "en"
              ? " written in English"
              : ""
        }: ${opts.topic}\nPlan the search queries that will find factual, educational reference material for this topic.`,
      },
    ];
    const remaining = Math.max(1_000, opts.deadlineMs - Date.now());
    const res = await chat({
      client: opts.client,
      model: AI_MODEL,
      messages,
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 300,
      timeoutMs: Math.min(60_000, remaining),
      signal: opts.signal,
    });
    if (!res.ok) return fallbackQueries(opts.topic);
    // Tolerate the model wrapping its JSON in a fence.
    const stripped = res.text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
    const jsonParsed = JSON.parse(stripped) as unknown;
    const parsed = PlannedQueriesSchema.safeParse(
      (jsonParsed as { queries?: unknown })?.queries !== undefined
        ? jsonParsed
        : { queries: jsonParsed },
    );
    if (!parsed.success) return fallbackQueries(opts.topic);
    return parsed.data.queries;
  } catch {
    return fallbackQueries(opts.topic);
  }
}

function fallbackQueries(topic: string): string[] {
  const trimmed = topic.replace(/\s+/g, " ").trim().slice(0, 120);
  return trimmed.length >= 3 ? [trimmed] : [];
}

// ─── Scoring + diversity (pure functions) ────────────────────────────────────

const STOPWORDS = new Set([
  // EN
  "the", "and", "for", "with", "from", "that", "this", "what", "when", "how",
  "why", "who", "are", "was", "were", "has", "have", "had", "its", "his",
  "her", "their", "about", "into", "over", "under", "between", "which",
  "will", "would", "can", "could", "should", "does", "did", "done", "not",
  "but", "all", "any", "each", "per", "via", "use", "used", "using", "of",
  "in", "on", "at", "to", "by", "or", "as", "is", "it", "be", "an", "a",
  // MS
  "yang", "dan", "untuk", "dengan", "dari", "pada", "adalah", "ke", "di",
  "ini", "itu", "atau", "juga", "akan", "tidak", "boleh", "seperti",
]);

/** Topic/content tokens: lowercase alphanumerics, ≥3 chars, stopwords out.
 * No stemming (deliberate — stemming created false positives in calibration). */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= 3 && !STOPWORDS.has(t),
  );
}

/**
 * Parse + normalize an http(s) URL from the wire; null when it is not one.
 * INJ-F2: `final_url` is echoed back by the upstream and flows into the
 * untrusted-corpus envelope header, so it must be a REAL URL (or be dropped)
 * rather than an arbitrary attacker-shaped string.
 */
function safeHttpUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Sanitize a host label for the envelope header (INJ-F2). `hostnameOf`'s catch
 * path used to return the RAW URL — attacker-influenced and interpolated
 * UN-sanitized — so a forged `=== WEB SOURCE` line could be minted inside the
 * corpus the model is told to treat as fenced untrusted data. Strip control
 * chars, the forged envelope prefix, and fences; collapse to one line.
 */
function sanitizeHostLabel(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/===\s*WEB\s+SOURCE/gi, "===")
    .replace(/```/g, "'''")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function hostnameOf(url: string): string {
  try {
    return sanitizeHostLabel(new URL(url).hostname.toLowerCase());
  } catch {
    return sanitizeHostLabel(url).toLowerCase();
  }
}

/**
 * Score search hits against the topic (term overlap + position decay),
 * dedupe by URL, cap 2 per hostname for diversity, take the top `max`.
 */
export function selectSources(
  results: TinyfishSearchHit[],
  topic: string,
  max = 3,
): TinyfishSearchHit[] {
  const topicTokens = new Set(tokenize(topic));
  if (topicTokens.size === 0) return results.slice(0, max);
  const seenUrls = new Set<string>();
  const perHost = new Map<string, number>();
  const scored = results.map((r, i) => {
    const hitTokens = new Set(tokenize(`${r.title} ${r.snippet}`));
    let overlap = 0;
    for (const t of topicTokens) if (hitTokens.has(t)) overlap += 1;
    return { hit: r, score: overlap * 10 + 1 / (i + 1) };
  });
  scored.sort((a, b) => b.score - a.score);
  const out: TinyfishSearchHit[] = [];
  for (const { hit } of scored) {
    if (seenUrls.has(hit.url)) continue;
    const host = hostnameOf(hit.url);
    if ((perHost.get(host) ?? 0) >= 2) continue;
    seenUrls.add(hit.url);
    perHost.set(host, (perHost.get(host) ?? 0) + 1);
    out.push(hit);
    if (out.length >= max) break;
  }
  return out;
}

// ─── Corpus assembly ─────────────────────────────────────────────────────────

const CORPUS_PER_SOURCE_CAP = 12_000;
const CORPUS_MIN_CHARS = 200;

/** Sanitize a title/hostname for the envelope line (no fences, no newlines). */
function sanitizeEnvelopeText(text: string, max: number): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/```/g, "'''")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Build the fenced UNTRUSTED corpus from fetched pages (grounded-search.md
 * §1): per-source 12k cap, aggregate cap aligned with MAX_AGGREGATE_CHARS,
 * ``` → ''' escape (same convention as buildQuizUserPrompt), and the literal
 * envelope prefix scrubbed from fetched text so a page cannot forge source
 * attribution inside the corpus. Returns ok:false ("thin") when the corpus
 * is below the 200-char floor.
 */
export function buildWebCorpus(
  pages: Array<TinyfishFetchedPage & { query: string; retrievedAt: string }>,
  opts: { capPerSource?: number; capAggregate?: number } = {},
): { ok: true; text: string; usedPages: number } | { ok: false; reason: "thin" } {
  const capPerSource = opts.capPerSource ?? CORPUS_PER_SOURCE_CAP;
  const capAggregate = opts.capAggregate ?? MAX_AGGREGATE_CHARS;
  const blocks: string[] = [];
  let total = 0;
  // The thin floor counts BODY text only — envelope headers are ~250 chars
  // each, enough to mask an empty corpus on their own.
  let bodySum = 0;
  for (let i = 0; i < pages.length; i += 1) {
    const p = pages[i];
    const header = `=== WEB SOURCE [${i + 1}/${pages.length}]: ${sanitizeEnvelopeText(p.title, 120)} (${sanitizeEnvelopeText(hostnameOf(p.url), 120)}) — retrieved ${p.retrievedAt}, query: ${sanitizeEnvelopeText(p.query, 120)} ===`;
    // Scrub forged envelope prefixes + control chars, escape fences.
    const body = p.text
      .replace(/===\s*WEB\s+SOURCE/gi, "===")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
      .replace(/```/g, "'''")
      .slice(0, capPerSource)
      .trimEnd();
    bodySum += body.trim().length;
    const block = `${header}\n${body}`;
    if (total + block.length > capAggregate) {
      const spaceLeft = capAggregate - total;
      if (spaceLeft > 300) blocks.push(block.slice(0, spaceLeft));
      break;
    }
    blocks.push(block);
    total += block.length;
  }
  const text = blocks.join("\n\n");
  if (text.trim().length < CORPUS_MIN_CHARS || bodySum < CORPUS_MIN_CHARS) {
    return { ok: false, reason: "thin" };
  }
  return { ok: true, text, usedPages: pages.length };
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export type WebSourceEntry = {
  kind: "web";
  url: string;
  title: string;
  retrieved_at: string;
  query: string;
};

/** Search-phase lib events (mirrored to wire `tool_call`/`tool_result`). */
export type GroundedSearchLibEvent =
  | { type: "tool_call"; tool: "web_search"; query: string }
  | {
      type: "tool_result";
      tool: "web_search";
      query: string;
      resultCount: number;
      skipped?: number;
      reason?: string;
    };

export type GroundedSearchResult =
  | { ok: true; text: string; sources: WebSourceEntry[] }
  | {
      ok: false;
      error: "search_unavailable" | "search_failed" | "search_corpus_thin";
      message?: string;
    };

const SEARCH_MAX_SOURCES = 3;

/**
 * Plan → search → select → fetch → corpus (grounded-search.md §1). Every
 * citation in `sources` is a URL we actually fetched. Errors are typed for
 * the two-segment contract: `search_unavailable` (key/401-class),
 * `search_failed` (network/5xx/429-after-retry/ALL pages failed),
 * `search_corpus_thin` (fetches succeeded but <200 chars).
 */
export async function runGroundedSearch(opts: {
  topic: string;
  questionCount: number;
  language: "en" | "ms" | "auto";
  ai: OpenAI;
  deadlineMs: number;
  signal?: AbortSignal;
  /** Augmentation mode: a thin/no-result corpus is a NON-error (the caller's
   * material text still grounds the generation) — returns ok with empty
   * sources instead of `search_corpus_thin`. */
  allowThin?: boolean;
  onEvent?: (event: GroundedSearchLibEvent) => void;
}): Promise<GroundedSearchResult> {
  const { topic, ai, deadlineMs } = opts;

  if (!isWebSearchEnabled()) {
    return {
      ok: false,
      error: "search_unavailable",
      message: "Web search is not configured on this server.",
    };
  }

  // 1. Plan queries (any failure → direct-topic fallback; never throws).
  const queries = await planSearchQueries({
    client: ai,
    topic,
    questionCount: opts.questionCount,
    language: opts.language,
    deadlineMs,
    signal: opts.signal,
  });
  if (queries.length === 0) {
    return { ok: false, error: "search_failed", message: "The topic produced no usable search query." };
  }

  // 2. Search each query (sequential — free tier is 30 req/min/key shared).
  const hits = new Map<string, TinyfishSearchHit>();
  for (const query of queries) {
    if (opts.signal?.aborted) {
      return { ok: false, error: "search_failed", message: "cancelled" };
    }
    opts.onEvent?.({ type: "tool_call", tool: "web_search", query });
    const res = await tinyfishSearch({
      query,
      purpose: `Find factual educational reference material for creating a ${opts.questionCount}-question quiz.`,
      language: opts.language === "auto" ? undefined : opts.language,
      signal: opts.signal,
    });
    if (!res.ok) {
      const error =
        res.error === "unavailable" ? "search_unavailable" : "search_failed";
      opts.onEvent?.({
        type: "tool_result",
        tool: "web_search",
        query,
        resultCount: 0,
        reason: error,
      });
      return { ok: false, error, message: `Web search failed for "${query}".` };
    }
    opts.onEvent?.({
      type: "tool_result",
      tool: "web_search",
      query,
      resultCount: res.results.length,
    });
    for (const hit of res.results) {
      if (!hits.has(hit.url)) hits.set(hit.url, { ...hit, query });
    }
  }

  // 3. Score + select the top sources.
  const selected = selectSources([...hits.values()], topic, SEARCH_MAX_SOURCES);
  if (selected.length === 0) {
    if (opts.allowThin) return { ok: true, text: "", sources: [] };
    return {
      ok: false,
      error: "search_corpus_thin",
      message: "The web search returned no usable results for this topic.",
    };
  }

  // 4. Fetch the selected pages in ONE batch (≤3 URLs — under the 10 cap).
  // `purpose` carries the topic (marker included) — the e2e mock sniffs the
  // scenario from it, and the real API uses it for retrieval quality.
  if (opts.signal?.aborted) {
    return { ok: false, error: "search_failed", message: "cancelled" };
  }
  const fetched = await tinyfishFetch({
    urls: selected.map((s) => s.url),
    purpose: `Quiz research: ${topic}`.slice(0, 2000),
    signal: opts.signal,
  });
  if (!fetched.ok) {
    return {
      ok: false,
      error: fetched.error === "unavailable" ? "search_unavailable" : "search_failed",
      message: "Could not fetch the selected web pages.",
    };
  }
  const failedByHost = new Map<string, number>();
  for (const f of fetched.failedUrls) {
    const host = hostnameOf(f.url);
    failedByHost.set(host, (failedByHost.get(host) ?? 0) + 1);
    opts.onEvent?.({
      type: "tool_result",
      tool: "web_search",
      query: f.url,
      resultCount: 0,
      skipped: 1,
      reason: f.error,
    });
  }

  // NO usable page text at all — distinguish an OUTAGE (HTTP/transport
  // errors or bot-blocks: search_failed) from RETRIEVED-BUT-EMPTY pages
  // (a genuinely thin topic: search_corpus_thin).
  if (fetched.pages.length === 0) {
    if (opts.allowThin) return { ok: true, text: "", sources: [] };
    const emptyOnly =
      fetched.failedUrls.length > 0 &&
      fetched.failedUrls.every((f) => f.error === "empty_content");
    return emptyOnly
      ? {
          ok: false,
          error: "search_corpus_thin",
          message: "The web pages found for this topic contain too little text.",
        }
      : {
          ok: false,
          error: "search_failed",
          message: "Every selected web page failed to fetch. Try again later.",
        };
  }

  // 5. Assemble the corpus (matched back to the SEARCH query per page —
  // final_url may differ from the search-hit URL, so fall back to the topic).
  const retrievedAt = new Date().toISOString();
  const pageQuery = (url: string): string =>
    selected.find((s) => s.url === url)?.query ?? topic;
  const corpus = buildWebCorpus(
    fetched.pages.map((p) => ({
      ...p,
      query: pageQuery(p.url),
      retrievedAt,
    })),
  );
  if (!corpus.ok) {
    if (opts.allowThin) return { ok: true, text: "", sources: [] };
    return {
      ok: false,
      error: "search_corpus_thin",
      message: "The web pages found for this topic contain too little text.",
    };
  }

  const sources: WebSourceEntry[] = fetched.pages.map((p) => ({
    kind: "web" as const,
    url: p.url,
    title: sanitizeEnvelopeText(p.title, 200),
    retrieved_at: retrievedAt,
    query: pageQuery(p.url),
  }));

  return { ok: true, text: corpus.text, sources };
}
