/**
 * Upstream HTTP helpers for BOTH GLM-OCR legs.
 *
 *  - `httpChatCompletions` / `probeGlmModel` — the LOCAL leg (Docker/vLLM,
 *    OpenAI-compatible `/v1/chat/completions` + `GET /v1/models`).
 *  - `httpLayoutParsing` — the REMOTE leg (Z.ai PaaS
 *    `POST {root}/layout_parsing`, whole-document, billed per token).
 *
 * Since the GLM-OCR container became loopback-bound and is reached through
 * `POST /api/extract/ocr` (server-side proxy), these helpers run in the ROUTE,
 * not the browser — the header comment here used to claim browser-only and
 * "carries no API key", which stopped being true when the proxy landed.
 *
 * SSRF guard (S8 / gate G5): the caller must NEVER derive `baseUrl` from a
 * request body, and must NEVER forward a client-supplied `http(s)://` URL as
 * the remote `file` value — that would let a client aim Z.ai's fetcher at an
 * arbitrary host and launder the response into the quiz pipeline, billed to
 * our key (SSRF-by-proxy). `httpLayoutParsing` takes validated base64 bytes
 * only; the route enforces the `data:` prefix + MIME + magic-byte checks.
 *
 * audit-3 R3-DEP-F2: `apiKey` sends `Authorization: Bearer …` so the compose
 * side can enable vLLM's `--api-key` (local) and so the remote leg presents
 * `ZAI_API_KEY`. It is optional because a loopback-bound container without a
 * key is the existing posture; when the compose service sets `VLLM_API_KEY`,
 * the same value must be present here or every OCR call 401s. Never log or
 * echo the key.
 */


/** A single multimodal content part (OpenAI vision-chat shape). */
export type HttpChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type HttpChatMessage = {
  role: "system" | "user" | "assistant";
  /** Plain text for system/assistant; multimodal parts for vision requests. */
  content: string | HttpChatContentPart[];
};

export type HttpChatResult =
  | { ok: true; text: string }
  | { ok: false; error: "timeout" | "rate_limited" | "http_error" | "ai_error"; message?: string };

/**
 * POST an OpenAI-compatible chat request and return the assistant's text.
 * Intended for GLM-OCR (vision-language transcription) against the local
 * vLLM/Docker endpoint.
 */
export async function httpChatCompletions(opts: {
  baseUrl: string; // ROOT URL, e.g. http://localhost:11434 (no /v1)
  model: string;
  messages: HttpChatMessage[];
  maxTokens?: number;
  timeoutMs?: number;
  /** audit-3 R3-DEP-F2: vLLM `--api-key` value, when the container sets one. */
  apiKey?: string;
}): Promise<HttpChatResult> {
  const { baseUrl, model, messages, maxTokens = 2000, timeoutMs = 60_000, apiKey } = opts;
  const endpoint = `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // audit-3 F-F10: an upstream 429 (vLLM concurrency/queue rejection) is a
      // RETRYABLE capacity signal, not a page-read failure — keep it distinct
      // so the OCR route can surface `glm_rate_limited` instead of `glm_error`.
      if (res.status === 429) {
        return {
          ok: false,
          error: "rate_limited",
          message: "GLM-OCR is at capacity (HTTP 429).",
        };
      }
      return {
        ok: false,
        error: "http_error",
        message: `GLM-OCR returned HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) return { ok: false, error: "ai_error", message: "Empty model response." };
    return { ok: true, text };
  } catch (err) {
    const aborted =
      controller.signal.aborted ||
      (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"));
    if (aborted) return { ok: false, error: "timeout" };
    const msg = err instanceof Error ? err.message : "Unknown HTTP error";
    return { ok: false, error: "http_error", message: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe whether the local GLM-OCR endpoint is reachable and serves the model.
 * Uses the OpenAI-compatible `GET {baseUrl}/v1/models` (works with vLLM and
 * Ollama alike). Returns true when the model id is listed. Short timeout so
 * the engine picker degrades instantly when the container is not running.
 */
export async function probeGlmModel(opts: {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  /** audit-3 R3-DEP-F2: required when the container runs with `--api-key`. */
  apiKey?: string;
}): Promise<boolean> {
  const { baseUrl, model, timeoutMs = 2000, apiKey } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { data?: { id?: string }[] };
    return (data.data ?? []).some(
      (m) => m.id === model || (m.id ?? "").startsWith(`${model}:`),
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Remote leg: Z.ai `layout_parsing` (billed, whole document) ─────────────

export type GlmUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type GlmLayoutResult =
  | {
      ok: true;
      /** Whole-document markdown (`md_results`). May be "" for a blank doc. */
      markdown: string;
      /** `data_info.num_pages` when it is a positive INTEGER, else null. */
      numPages: number | null;
      usage: GlmUsage;
      /** true when the upstream body carried recognisable `usage` numbers. */
      usagePresent: boolean;
      /** true when an upstream error code rode alongside usable text (G9). */
      degraded: boolean;
      /** Upstream code/message when degraded (redacted of any key material). */
      degradedReason?: string;
      /** Upstream business code when one was present (redacted). */
      code?: string;
      /** true when md_results was "" and num_pages confirmed a blank document. */
      blank: boolean;
    }
  | {
      ok: false;
      error: "timeout" | "rate_limited" | "http_error" | "ai_error" | "auth";
      message?: string;
      /** Upstream business code when one was present (redacted, for the ops log). */
      code?: string;
      /**
       * The upstream `usage` numbers when the body carried them, even though
       * the attempt is reported as a failure. A failed request that still
       * reports `usage.total_tokens` was still BILLED (defect #4: an HTTP-200
       * error envelope carrying 999999 tokens recorded nothing at all).
       * Zeros + `usagePresent: false` when the body never got far enough.
       */
      usage: GlmUsage;
      usagePresent: boolean;
    };

/**
 * Business codes that mean CAPACITY (retryable). PROVISIONAL: the live Z.ai
 * `code` list is owed (plan §4 — needs a key + live curl). Unknown codes are
 * non-retryable by design (gate G2/G9: a wrong guess burns billing by retrying
 * into a dead key). Add codes here ONLY from a measured upstream response, and
 * mirror the addition in the ops runbook.
 *
 * EXTENSION POINT — the HTTP-status mapping in `httpLayoutParsing` is the
 * load-bearing signal until the live list lands (429 → `rate_limited`,
 * 401/403 → `auth`).
 *
 * Kept DELIBERATELY EMPTY: a capacity code guessed wrong is a retry storm
 * against a dead key.
 */
export const ZAI_RETRYABLE_CODES: ReadonlySet<string> = new Set<string>([]);

/**
 * Business codes that mean AUTH/ENTITLEMENT (gate G4).
 *
 * PROVISIONAL but SEEDED with the two HTTP-standard auth codes, because the
 * empty set was a proven hole (defect #7): with `ZAI_AUTH_CODES` empty, a PaaS
 * envelope riding `{code:403, md_results:"text"}` on an HTTP **200** fell into
 * the unknown-code branch and returned `ok:true + degraded` — an entitlement
 * failure reported to the user as a SUCCESSFUL extraction. These two values are
 * not invented Z.ai-specific codes; 401/403 are the standard meanings, so
 * seeding them only closes the silent-success direction and can never turn a
 * healthy call into a failure. Any OTHER code stays unknown → fail-closed
 * (degraded with text, non-retryable error without).
 */
export const ZAI_AUTH_CODES: ReadonlySet<string> = new Set<string>(["401", "403"]);

/** HTTP statuses that mean auth/entitlement (gate G4) — never retryable. */
const AUTH_STATUSES = new Set([401, 403]);

/**
 * Defensive redaction for any upstream-provided string that we store or return.
 * A well-behaved PaaS never echoes the credential, but this helper is the cheap
 * insurance that makes the "never echo a secret" hard rule hold even if one
 * does: the configured key is masked wherever it appears.
 *
 * Defect #8: the old version skipped secrets shorter than 8 chars, so a
 * 6-char key echoed in `message` appeared in full. The length gate is GONE —
 * we only ever mask the EXACT configured value, so a false positive is
 * impossible by construction and there is no reason to spare short keys.
 */
function redactSecret(text: string | undefined, secret: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  // An empty secret would make `split("")` explode the string character by
  // character — there is nothing to redact in that case.
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * Normalise `usage` from either the flat or nested envelope.
 *
 * Defect #4(b): numeric STRINGS are accepted (`"3000"` used to be silently
 * coerced to 0 — a billed call recorded as free) and `usagePresent` reports
 * whether the body actually carried numbers, so "absent" is distinguishable
 * from "zero" in the ledger and the ops log. Missing/invalid numbers still
 * become 0 — the caller's spend accounting must never see NaN. `totalTokens`
 * falls back to `prompt + completion` only when BOTH are reported and the total
 * is not; that is arithmetic on reported numbers, never an invented count.
 */
function parseUsage(raw: unknown): { usage: GlmUsage; usagePresent: boolean } {
  const rec = asRecord(raw);
  const num = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  const prompt = rec === null ? null : num(rec.prompt_tokens);
  const completion = rec === null ? null : num(rec.completion_tokens);
  const total = rec === null ? null : num(rec.total_tokens);
  const usagePresent = prompt !== null || completion !== null || total !== null;
  const totalTokens =
    total ?? (prompt !== null && completion !== null ? prompt + completion : 0);
  return {
    usage: {
      promptTokens: prompt ?? 0,
      completionTokens: completion ?? 0,
      totalTokens,
    },
    usagePresent,
  };
}

/**
 * `data_info.num_pages` when it is a positive INTEGER, else null.
 *
 * Defect #10(b): a FRACTIONAL page count (`12.7`) used to pass straight
 * through into `numPages` and out to the client's density heuristic. A
 * fractional page count is meaningless, so only integers are accepted; a float
 * reads as "unknown" (null), which is the fail-closed direction (an
 * unconfirmed blank stays an error). A missing/garbage page count must NOT be
 * treated as 0 pages (which would make every blank-looking response look
 * legitimate).
 */
function parseNumPages(raw: unknown): number | null {
  const rec = asRecord(raw);
  const n = rec?.num_pages;
  if (typeof n === "number" && Number.isInteger(n) && n > 0) return n;
  if (typeof n === "string" && n.trim() !== "") {
    const parsed = Number(n);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * POST `{baseUrl}/layout_parsing` — Z.ai remote OCR (billed). NEVER pass a URL
 * as `fileDataUrl`; the caller must hand over validated base64 bytes (G5).
 *
 * Envelope precedence (gate G9) is implemented in the EXACT order of contract
 * §3.4 — read the numbered steps in the body before editing. The load-bearing
 * subtleties:
 *  - PaaS rides errors on HTTP 200, so the BODY is inspected even when
 *    `res.ok` is true;
 *  - `code` may be a number or a string, and may live flat (`body.code`) or
 *    nested (`body.error.code`) — both are accepted;
 *  - an UNKNOWN non-zero code with usable text is `ok:true` + `degraded:true`
 *    (never silent success, never a lost paid-for page), and without text is a
 *    NON-RETRYABLE `ai_error` (fail-closed: never retryable);
 *  - `md_results: ""` is a legitimate blank only when `data_info.num_pages`
 *    confirms it; otherwise it is `ai_error` (never `{text:""}`, which would
 *    poison the client's `failedPages` accounting).
 *
 * ACCOUNTING (defect #4): EVERY branch that got as far as parsing a body
 * reports whatever `usage` numbers that body carried, on BOTH the success and
 * the failure arm. The caller must be able to record spend for a billed call
 * even when the attempt is reported as a failure (an error envelope riding
 * HTTP 200 with `usage.total_tokens: 999999` is precisely the G9 shape where
 * upstream did the work). Nothing is invented: `usagePresent` distinguishes
 * "upstream reported zero" from "upstream reported nothing".
 *
 * Defect #6: every degraded/error branch also returns the (redacted) upstream
 * `code` + `message` so the route can emit a per-user ops log line naming the
 * unknown code — the empty extension point is useless if an operator cannot
 * see WHICH code is firing.
 */
export async function httpLayoutParsing(opts: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fileDataUrl: string;
  timeoutMs?: number;
  /** Injected for deterministic tests; defaults to crypto.randomUUID(). */
  requestId?: string;
  /** Test seam for fetch; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<GlmLayoutResult> {
  const {
    baseUrl,
    model,
    apiKey,
    fileDataUrl,
    timeoutMs = 120_000,
    requestId = crypto.randomUUID(),
    fetchImpl = fetch,
  } = opts;

  const endpoint = `${baseUrl.replace(/\/$/, "")}/layout_parsing`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  /** No body was read, so nothing is known about usage. */
  const NO_USAGE: GlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const noUsage = (): Pick<
    Extract<GlmLayoutResult, { ok: false }>,
    "usage" | "usagePresent"
  > => ({ usage: NO_USAGE, usagePresent: false });

  // G10: `start_page_id` / `end_page_id` are OMITTED (inclusivity unverified —
  // a wrong guess silently drops the last page while reporting success) and
  // `user_id` is OMITTED (a stable hash is a permanent third-party tracking id).
  // `request_id` is fresh per attempt until idempotency is verified live.
  const payload = { model, file: fileDataUrl, request_id: requestId };

  try {
    // 1. transport error (fetch reject / abort) → timeout | http_error
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    // 2. 429 → rate_limited (transport capacity signal)
    if (res.status === 429) {
      return {
        ok: false,
        error: "rate_limited",
        message: "Z.ai layout parsing is at capacity (HTTP 429).",
        ...noUsage(),
      };
    }

    // 3. 401/403 → auth (gate G4 — the route maps this to 503
    //    `glm_model_unavailable`, NEVER `glm_error`)
    if (AUTH_STATUSES.has(res.status)) {
      return {
        ok: false,
        error: "auth",
        message: `Z.ai rejected the API key (HTTP ${res.status}).`,
        ...noUsage(),
      };
    }

    // 4. any other non-ok → http_error with the status in `message`
    if (!res.ok) {
      return {
        ok: false,
        error: "http_error",
        message: `Z.ai layout parsing returned HTTP ${res.status}`,
        ...noUsage(),
      };
    }

    // 5. body not JSON → ai_error (non-retryable)
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        error: "ai_error",
        message: "Upstream returned a non-JSON body.",
        ...noUsage(),
      };
    }

    const flat = asRecord(body);
    if (flat === null) {
      return {
        ok: false,
        error: "ai_error",
        message: "Upstream returned a non-object JSON body.",
        ...noUsage(),
      };
    }
    const nested = asRecord(flat.error);

    // 6. code = flat body.code ?? nested body.error.code (number or string;
    //    compared via String(code)); hasText from md_results.
    //    Defect #8: the code is REDACTED too — an upstream echoing the key in
    //    `code` used to put it verbatim into the result and `degradedReason`.
    const rawCode = flat.code ?? nested?.code;
    const code =
      rawCode === undefined || rawCode === null
        ? undefined
        : redactSecret(String(rawCode), apiKey);
    const codePresent = code !== undefined && code !== "";
    const mdResults = flat.md_results;
    const hasText = typeof mdResults === "string" && mdResults.length > 0;
    const parsedUsage = parseUsage(flat.usage);
    const numPages = parseNumPages(flat.data_info);
    // Redacted: code + message only, with any echoed key masked. We never
    // interpolate the key into a message ourselves.
    const upstreamMessage = redactSecret(
      (typeof flat.message === "string" && flat.message) ||
        (typeof nested?.message === "string" && nested.message) ||
        undefined,
      apiKey,
    );
    /** The body's own usage — carried on EVERY branch from here on. */
    const usageFields = {
      usage: parsedUsage.usage,
      usagePresent: parsedUsage.usagePresent,
    };
    /** The upstream code/message, for the ops log (redacted). */
    const codeFields = {
      ...(code !== undefined ? { code } : {}),
      ...(upstreamMessage !== undefined ? { message: upstreamMessage } : {}),
    };

    // 7. a present, non-zero code is an error envelope even on HTTP 200.
    if (codePresent && code !== "0" && code !== "200") {
      if (ZAI_RETRYABLE_CODES.has(code)) {
        return hasText
          ? {
              ok: true,
              markdown: mdResults as string,
              numPages,
              ...usageFields,
              degraded: true,
              degradedReason: code,
              code,
              blank: false,
            }
          : {
              ok: false,
              error: "rate_limited",
              ...codeFields,
              ...usageFields,
            };
      }
      // Auth codes: NEVER a success, even when text is present. An entitlement
      // failure must not be dressed up as a degraded-but-usable read (defect #7).
      if (ZAI_AUTH_CODES.has(code)) {
        return { ok: false, error: "auth", ...codeFields, ...usageFields };
      }
      // Unknown code: fail-closed — usable text is surfaced as DEGRADED (never
      // silent success), and no text is a NON-RETRYABLE ai_error (never
      // retryable — retrying an unknown code can burn billing on a dead key).
      if (hasText) {
        return {
          ok: true,
          markdown: mdResults as string,
          numPages,
          ...usageFields,
          degraded: true,
          degradedReason: upstreamMessage
            ? `${code}: ${upstreamMessage}`
            : code,
          code,
          blank: false,
        };
      }
      return { ok: false, error: "ai_error", ...codeFields, ...usageFields };
    }

    // 8. no error code (absent or 0/200)
    if (hasText) {
      return {
        ok: true,
        markdown: mdResults as string,
        numPages,
        ...usageFields,
        degraded: false,
        blank: false,
      };
    }

    // md_results missing/null → ai_error (never {text:""})
    if (typeof mdResults !== "string") {
      return {
        ok: false,
        error: "ai_error",
        message: "Upstream response carried no md_results.",
        ...codeFields,
        ...usageFields,
      };
    }

    // md_results === "" → blank document ONLY with a confirming positive
    // num_pages; otherwise ai_error (a blank deck must not poison failedPages,
    // and an unconfirmed blank must not read as success).
    if (numPages === null) {
      return {
        ok: false,
        error: "ai_error",
        message: "Upstream returned empty md_results without a page count.",
        ...codeFields,
        ...usageFields,
      };
    }
    return {
      ok: true,
      markdown: "",
      numPages,
      ...usageFields,
      degraded: false,
      blank: true,
    };
  } catch (err) {
    // 1 (continued). transport error → timeout | http_error
    const aborted =
      controller.signal.aborted ||
      (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"));
    if (aborted) return { ok: false, error: "timeout", ...noUsage() };
    const msg = err instanceof Error ? err.message : "Unknown HTTP error";
    return { ok: false, error: "http_error", message: msg, ...noUsage() };
  } finally {
    clearTimeout(timer);
  }
}
