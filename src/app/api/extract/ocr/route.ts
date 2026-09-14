import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireLecturer } from "@/lib/classes/guards";
import { rateLimit } from "@/lib/classes/rate-limit";
import { httpChatCompletions, httpLayoutParsing, probeGlmModel } from "@/lib/ai/http-compat";
import {
  LOCAL_MAX_DATAURL_CHARS,
  REMOTE_MAX_DATAURL_CHARS,
  glmProviderMisconfig,
  resolveGlmProvider,
} from "@/lib/ai/glm-provider";
import type { GlmProviderConfig } from "@/lib/ai/glm-provider";
import { checkGlmSpend, glmCostUsd, recordGlmSpend } from "@/lib/ai/glm-spend";
import { glmHealth, glmHealthCached } from "@/lib/ai/glm-health";
import { checkSameOrigin, invalidJson, payloadTooLarge, readCappedJson } from "@/lib/http";
import { sniffImageType } from "@/lib/media/validation";

export const dynamic = "force-dynamic";

/**
 * POST/GET /api/extract/ocr — server-side proxy to the GLM-OCR provider.
 *
 * TWO LEGS, ONE ROUTE (env `GLM_PROVIDER`, fail-closed — see
 * `lib/ai/glm-provider.ts`):
 *  - `local` (default) — the loopback vLLM/Docker container
 *    (`GLM_BASE_URL`, optional `VLLM_API_KEY`). ONE rasterized page per call
 *    (`{image}` → `{text}`), OpenAI-compatible chat shape, `GET /v1/models`
 *    probe, `MAX_OCR_PAGES=200`. Free.
 *  - `remote` — the Z.ai PaaS API (`ZAI_BASE_URL` root ALREADY carries
 *    `/api/paas/v4`; never append `/v1`). WHOLE document per call
 *    (`{file,kind}` → `{text,pages,numPages,degraded,blank}`),
 *    `POST /layout_parsing`, billed per token, capped by `GLM_REMOTE_MAX_PAGES`
 *    and the durable spend governor. Auth failure → 503
 *    `glm_model_unavailable`, NEVER `glm_error` (a dead key is not a read error).
 *
 * WHOLE-DOCUMENT SHAPE IS MANDATORY ON THE REMOTE LEG (contract §4.5,
 * revised). The remote leg used to also accept `{image}` as a convenience; that
 * was proven to be a 10–200× overspend vector (the client's per-page loop can
 * drive N billed calls against the metered leg, and the route's page cap is
 * skipped for that shape). A remote body carrying `image` — or carrying no
 * valid `file`+`kind` pair — is now a 400 `glm_error`, logged server-side. The
 * LOCAL leg still accepts `{image}` unchanged (one rasterized page per call).
 *
 * WHY SERVER-SIDE: the GLM-OCR container is loopback-bound (127.0.0.1:11434),
 * so a browser on ANOTHER machine (e.g. a teammate via a tunnel) cannot reach
 * it, and the remote key must never reach the browser. Proxying through this
 * route keeps the feature usable remotely while the container itself never
 * leaves loopback and the key stays server-side.
 *
 * SSRF guards (S8 / gate G5, both legs):
 *  - the target URL comes ONLY from server env (`GLM_BASE_URL` / `ZAI_BASE_URL`)
 *    — never from the request body, so the client cannot aim this proxy at an
 *    arbitrary host;
 *  - the remote `file` value must be a `data:` URL carrying validated base64
 *    BYTES. An `http(s)://` URL is BANNED outright: forwarding one would let a
 *    client aim Z.ai's fetcher at an attacker-chosen host, launder the response
 *    into the quiz pipeline, and bill our key for it (SSRF-by-proxy). The
 *    declared MIME must be in the image allowlist or `application/pdf`, the
 *    decoded bytes must be non-empty, images must pass `sniffImageType()` and
 *    PDFs must start with `%PDF`.
 *
 * audit-2 H-12 hardening (both legs):
 *  - per-user rate limit (every sibling media route is budgeted; this one
 *    held N concurrent 90s GPU inferences on one lecturer account);
 *  - streaming-capped body read (the header-only check let a chunked POST
 *    fully materialize before any cap ran) — the cap is provider-aware, since
 *    the remote leg accepts a whole PDF;
 *  - the `data:image/` prefix check is now a REAL allowlist: must carry
 *    `;base64,`, must be png/jpeg/webp, and the DECODED bytes must sniff to a
 *    raster type (magic-byte check — `data:image/svg+xml` payloads and
 *    mislabeled junk are rejected before the GPU hold / the billed call).
 *
 * audit-3 F-F4 correction: H-12 landed the LIMITER only — the route had no
 * in-flight guard, so the sliding window admitted a second batch of 20 at
 * t≈60s while the first batch (90s timeout each) was still running → up to 40
 * concurrent GPU holds per user. The per-user in-flight guard below is the
 * real concurrency bound; the limiter is a budget, not a concurrency control.
 *
 * SPEND GOVERNOR (gate G8, remote only): a per-user daily token cap persisted
 * in a JSON ledger (`lib/ai/glm-spend.ts`) plus the `GLM_SPEND_DISABLED=1`
 * operator kill switch. The remote leg refuses to spend BEFORE the upstream
 * call (429 `glm_spend_cap` / 503 `glm_model_unavailable`) and records the real
 * `usage.total_tokens` after it, logging a redacted usage line (never the key).
 *
 * Contract:
 *  - GET  → 200 `GlmHealth` (`{available,reason,checkedAt,provider,maxPages,
 *    maxImageBytes,maxPdfBytes}`). Cached server-side (gate G7): the remote
 *    probe is a BILLED tiny `layout_parsing` POST, so the verdict is cached
 *    (positive 300s / negative 30s) and this GET has its own tighter budget.
 *    The cache is keyed on a provider/baseUrl/model/caps/key-fingerprint
 *    identity tuple, so an env flip or key rotation is a MISS, never a stale
 *    hit. The probe is also booked through the spend governor (defect #5).
 *  - POST `{ image: dataUrl }` (ONE rasterized page) → `{ text }` (local only)
 *  - POST `{ file: dataUrl, kind: "pdf"|"image" }` → `{ text, pages, numPages,
 *    degraded, blank }` (remote ONLY; `{image}` is rejected on this leg)
 *    Typed failures: `glm_model_unavailable` / `glm_timeout` / `glm_error` /
 *    `glm_rate_limited` (audit-3 F-F10: our per-user budget or an upstream
 *    429 is distinct from "the model could not read this page", so the client
 *    says "rate limited, retry" instead of provoking blind retries) /
 *    `glm_busy` (F-F4: too many concurrent page inferences for this user) /
 *    `glm_pages_exceeded` (413, remote PDF over the page cap) /
 *    `glm_spend_cap` (429, remote daily token cap reached) /
 *    `payload_too_large` (413, over the provider-aware byte cap).
 */

// A single canvas-rasterized page as base64 — generous ceiling, but bounded.
const MAX_IMAGE_DATAURL_CHARS = LOCAL_MAX_DATAURL_CHARS;
// JSON slack on top of the data URL (`{"image":"…"}` / `{"file":"…","kind":"pdf"}`).
const OCR_BODY_SLACK_BYTES = 4096;
const PAGE_TIMEOUT_MS = 90_000;
// The remote leg parses a WHOLE document in one call (~16s of silence for a
// mid-size deck, more for a large one) — the per-page 90s bound is not enough.
const REMOTE_TIMEOUT_MS = 120_000;

// Classroom scale, not DoS scale: one page per click, a 60-page deck at a
// sane pace stays far below this; a scripted 32MB×N loop does not.
//
// audit-3 F-F2/F-F4 budget note: a single-user 40-page deck at the documented
// GLM throughput (~0.46 s/page, docs/GLM_OCR_SETUP.md) burns 20 pages in ~9 s
// and 40 in ~18 s — i.e. an honest long deck TRIPS this window mid-run. The
// limiter is therefore a burst guard, NOT the long-deck budget: the in-flight
// guard below caps actual concurrent GPU holds, and the client classifies a
// 429 as `glm_rate_limited` (retryable) rather than a read failure. Kept at
// 20/min deliberately — raising it widens the GPU-hold surface without fixing
// the client's ability to see and retry the loss.
const OCR_RATE = { limit: 20, windowMs: 60 * 1000 };

// Gate G7: the health GET is no longer a free probe on the remote leg (it may
// run a BILLED tiny layout_parsing POST on a cold/stale cache), so it gets its
// own, tighter bucket instead of sharing the 20/min POST budget. The verdict is
// cached (300s/30s), so 6/min is far more than a picker needs.
const OCR_HEALTH_RATE = { limit: 6, windowMs: 60 * 1000 };

// audit-3 F-F4: per-user in-flight counter. The sliding window above admits a
// second batch of 20 at t≈60s while the first batch may still be running
// (90s page timeout) → up to 40 concurrent 90s GPU holds per user. Two
// overlapping pages per user is the honest ceiling (one dialog extracts one
// page at a time); a third gets a typed retryable code instead of queueing
// another 90s inference. In-process only (same single-instance caveat as
// generate-quiz/regenerate-question).
const MAX_IN_FLIGHT_PER_USER = 2;
const inFlight = new Map<string, number>();

const GLM_TRANSCRIBE_PROMPT =
  "You are an OCR engine. Transcribe ALL visible text from this page image " +
  "faithfully, preserving structure (headings, bullets, tables as text). " +
  "Output ONLY the transcribed text, no commentary.";

const ALLOWED_IMAGE_PREFIXES = [
  "data:image/png;base64,",
  "data:image/jpeg;base64,",
  "data:image/webp;base64,",
] as const;
const PDF_PREFIX = "data:application/pdf;base64,";

/** The PDF magic bytes every accepted document must start with. */
const PDF_MAGIC = "%PDF";

/**
 * The request shape after validation: which provider path to take and the
 * decoded bytes. `kind` is the CLIENT's declared kind, already reconciled with
 * the provider (`{image}` on the remote leg is a single-image run).
 */
type OcrRequest = {
  providerConfig: GlmProviderConfig;
  kind: "image" | "pdf";
  dataUrl: string;
  bytes: Buffer;
};

/**
 * Cheap, dependency-free PDF page LOWER BOUND: count `/Type /Page` objects in
 * the raw bytes.
 *
 * READ THIS BEFORE TRUSTING IT (defect #12). This is a LOWER BOUND that
 * catches only UNCOMPRESSED PDFs. It is proven defeated by ordinary files:
 *  - a 300-page PDF whose page objects live in a compressed `/ObjStm`
 *    (standard output of every modern producer) counts **0**;
 *  - a legal comment between the tokens (`/Type % note\n /Page`) counts 0;
 *  - `/T#79pe` (a hex-escaped name, legal PDF) counts 0.
 * So an over-cap deck can and does reach a BILLED call, where only the
 * post-response check can refuse it. The reliable page-count gate is the
 * CLIENT's pdf.js `numPages` pre-flight (`src/lib/extract/glm-ocr.ts`); this
 * function is a free early exit for the easy cases and the post-check below is
 * the backstop.
 *
 * Deliberately NOT refusing a document whose lower bound is 0: a lower bound
 * of 0 means "no uncompressed page objects found", which is the normal shape of
 * a valid compressed PDF. Refusing it would reject valid documents.
 *
 * `/Pages` does NOT match (`\bPage\b` cannot match `Pages` because `s` is a
 * word character), which is what makes this a lower bound rather than an
 * over-count. An exact count needs pdf.js.
 *
 * Module-private on purpose: Next validates the exports of a `route.ts`, so
 * this is exercised through the route (the `glm_pages_exceeded` pre-flight
 * test crafts a PDF with more `/Type /Page` objects than the cap).
 */
function countPdfPageObjects(bytes: Buffer): number {
  const text = bytes.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 0;
}

function bodyLimitBytes(cfg: GlmProviderConfig): number {
  return (cfg.metered ? REMOTE_MAX_DATAURL_CHARS : MAX_IMAGE_DATAURL_CHARS) +
    OCR_BODY_SLACK_BYTES;
}

/** 400 `glm_error` — the shared "this body is not usable" answer. */
function badRequest(): NextResponse {
  return NextResponse.json({ error: "glm_error" }, { status: 400 });
}

export async function GET() {
  const supabase = await createClient();
  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;

  // audit-3 H3-AUTHZ-F3 + gate G7: this GET ran an unbudgeted real fetch
  // (probeGlmModel hits the container's /v1/models with a 2 s bound), while its
  // POST sibling was budgeted and the analogous face/health GET is budgeted
  // too. On the remote leg the probe is a BILLED POST, so it gets its own
  // tighter bucket rather than sharing the 20/min page budget.
  if (!rateLimit(`ocr-health:${auth.userId}`, OCR_HEALTH_RATE)) {
    return NextResponse.json({ error: "glm_rate_limited" }, { status: 429 });
  }

  // Defect #5: the userId lets a BILLED remote probe be counted against this
  // user's daily cap (and always under the reserved probe pseudo-user).
  const health = await glmHealth({ userId: auth.userId });
  return NextResponse.json(health);
}

export async function POST(request: Request) {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const supabase = await createClient();
  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;

  // audit-2 H-12: authenticated cost guard (sign 60/min, IMAGE_RATE 20/h
  // precedents). A page OCR is one user click; 20/min is generous.
  if (!rateLimit(`ocr:${auth.userId}`, OCR_RATE)) {
    // audit-3 F-F10: a spent per-user budget is NOT a read failure. The
    // distinct code keeps the dialog from telling the user the scanner
    // "could not read this file" (which invites retries into the same window).
    return NextResponse.json({ error: "glm_rate_limited" }, { status: 429 });
  }

  // audit-3 F-F4: concurrency bound — the limiter is a budget, not a cap on
  // simultaneous GPU holds.
  const inFlightKey = `ocr:${auth.userId}`;
  if ((inFlight.get(inFlightKey) ?? 0) >= MAX_IN_FLIGHT_PER_USER) {
    return NextResponse.json({ error: "glm_busy" }, { status: 429 });
  }
  inFlight.set(inFlightKey, (inFlight.get(inFlightKey) ?? 0) + 1);
  try {
    return await handleOcr(request, auth.userId);
  } finally {
    const next = (inFlight.get(inFlightKey) ?? 0) - 1;
    if (next <= 0) inFlight.delete(inFlightKey);
    else inFlight.set(inFlightKey, next);
  }
}

/**
 * Read + validate the body for the ACTIVE provider, or return the typed failure
 * response. Split out so `handleOcr` stays a linear description of the flow.
 */
async function readOcrRequest(
  request: Request,
  cfg: GlmProviderConfig,
): Promise<{ ok: true; req: OcrRequest } | { ok: false; response: NextResponse }> {
  // Streaming-capped read: rejects over-cap bodies (header OR stream) before
  // they materialize. The old flow only checked the content-length header
  // and then parsed unbounded.
  const body = await readCappedJson(request, bodyLimitBytes(cfg));
  if (!body.ok) {
    return {
      ok: false,
      response:
        body.response.status === 413
          ? payloadTooLarge(
              cfg.metered ? "Document too large." : "Page image too large.",
            )
          : invalidJson(),
    };
  }

  const data = typeof body.data === "object" && body.data !== null
    ? (body.data as Record<string, unknown>)
    : null;
  if (data === null) return { ok: false, response: badRequest() };

  const hasFile = "file" in data;
  const hasImage = "image" in data;

  // Defect #11: a body carrying BOTH `image` and `file` is a 400 on BOTH legs.
  // The baseline local leg read `image` and ignored `file` (200); rejecting is
  // deliberate, not an accident: silently picking one of two conflicting
  // payloads is exactly how a client bug turns into "we transcribed the wrong
  // thing" with no signal. One request carries exactly one document.
  if (hasFile && hasImage) {
    console.warn(
      "[glm-ocr] Rejected an OCR body carrying BOTH `file` and `image` " +
        `(provider=${cfg.provider}); one request must carry exactly one document.`,
    );
    return { ok: false, response: badRequest() };
  }

  // Shape resolution. The LOCAL leg is one rasterized page — a `{file,kind}`
  // body is a client bug and must not silently fall through.
  let kind: "image" | "pdf";
  let dataUrl: unknown;
  if (hasFile) {
    if (!cfg.metered) return { ok: false, response: badRequest() };
    const declaredKind = data.kind;
    if (declaredKind !== "pdf" && declaredKind !== "image") {
      return { ok: false, response: badRequest() };
    }
    kind = declaredKind;
    dataUrl = data.file;
  } else if (hasImage) {
    // Defect #9 (contract §4.5 revision): the REMOTE leg is whole-document
    // ONLY. Accepting `{image}` there let the client's per-page loop drive N
    // billed calls against the metered leg while skipping the page cap — the
    // exact 10–200× overspend vector gate G3 exists to prevent.
    if (cfg.metered) {
      console.warn(
        "[glm-ocr] Rejected an `{image}` body on the REMOTE leg: the metered " +
          "leg requires the whole-document shape `{file, kind}` so the page " +
          "cap and the one-call-per-document billing hold.",
      );
      return { ok: false, response: badRequest() };
    }
    kind = "image";
    dataUrl = data.image;
  } else {
    return { ok: false, response: badRequest() };
  }

  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    return { ok: false, response: badRequest() };
  }
  // Declared-string cap: the body cap normally catches this first, but a
  // header-lying chunked request must not reach the decoder. Contract §4.5's
  // table says 413 `payload_too_large` for an over-cap payload (defect #10a) —
  // this used to answer 400 `glm_error`, which the client would read as a
  // malformed request rather than an oversized one.
  if (dataUrl.length > cfg.maxDataUrlChars) {
    return {
      ok: false,
      response: payloadTooLarge(
        cfg.metered ? "Document too large." : "Page image too large.",
      ),
    };
  }

  // MIME allowlist + `data:` prefix. A bare `http(s)://` URL is banned (G5).
  const isPdf = kind === "pdf";
  const prefixOk = isPdf
    ? dataUrl.startsWith(PDF_PREFIX)
    : ALLOWED_IMAGE_PREFIXES.some((p) => dataUrl.startsWith(p));
  if (!prefixOk) return { ok: false, response: badRequest() };

  const base64 = dataUrl.slice(dataUrl.indexOf(";base64,") + ";base64,".length);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return { ok: false, response: badRequest() };
  }
  if (bytes.length === 0) return { ok: false, response: badRequest() };

  // Magic-byte check: the declared MIME is advisory only.
  if (isPdf) {
    if (bytes.subarray(0, PDF_MAGIC.length).toString("latin1") !== PDF_MAGIC) {
      return { ok: false, response: badRequest() };
    }
  } else if (!sniffImageType(bytes)) {
    return { ok: false, response: badRequest() };
  }

  // Provider byte caps (decoded).
  const cap = isPdf ? cfg.maxPdfBytes : cfg.maxImageBytes;
  if (cap <= 0 || bytes.length > cap) {
    return {
      ok: false,
      response: payloadTooLarge(
        isPdf ? "Document too large." : "Page image too large.",
      ),
    };
  }

  return { ok: true, req: { providerConfig: cfg, kind, dataUrl, bytes } };
}

/** The OCR work, run under the in-flight guard. */
async function handleOcr(request: Request, userId: string): Promise<NextResponse> {
  const cfg = resolveGlmProvider();
  const parsed = await readOcrRequest(request, cfg);
  if (!parsed.ok) return parsed.response;
  const { kind, dataUrl, bytes } = parsed.req;

  // ── Remote-only gates, BEFORE any spend ────────────────────────────────
  if (cfg.metered) {
    // Remote + missing ZAI_API_KEY is a misconfiguration, never a fallback to
    // the local container (that would silently change what the operator
    // configured) and never an unauthenticated upstream call.
    if (glmProviderMisconfig() === "missing_key") {
      return NextResponse.json({ error: "glm_model_unavailable" }, { status: 503 });
    }

    // Gate G8: the spend governor. `disabled` is the operator kill switch (the
    // leg is configured but must not spend); `cap` is this user's daily budget.
    const spend = checkGlmSpend(userId);
    if (!spend.allowed) {
      return spend.reason === "disabled"
        ? NextResponse.json({ error: "glm_model_unavailable" }, { status: 503 })
        : NextResponse.json({ error: "glm_spend_cap" }, { status: 429 });
    }

    // Gate G7: use a FRESH cached verdict to short-circuit a known-bad
    // configuration without paying for a probe. A cold cache is NOT a reason to
    // probe here — the real POST below is its own liveness proof.
    const cached = glmHealthCached();
    if (cached && !cached.available) {
      return cached.reason === "rate_limited"
        ? NextResponse.json({ error: "glm_rate_limited" }, { status: 429 })
        : NextResponse.json({ error: "glm_model_unavailable" }, { status: 503 });
    }

    // Pre-flight page lower bound: refuse an oversized PDF WITHOUT spending.
    if (kind === "pdf") {
      const lowerBound = countPdfPageObjects(bytes);
      if (lowerBound > cfg.maxPages) {
        return NextResponse.json({ error: "glm_pages_exceeded" }, { status: 413 });
      }
    }
  }

  if (!cfg.metered) {
    return await transcribeLocalPage(cfg, dataUrl);
  }
  return await parseRemoteDocument(cfg, kind, dataUrl, userId);
}

/** LOCAL leg: one rasterized page through the OpenAI-compatible chat shape. */
async function transcribeLocalPage(
  cfg: GlmProviderConfig,
  image: string,
): Promise<NextResponse> {
  const { baseUrl, model, apiKey } = cfg;

  // Cheap availability gate first: an unreachable container must surface as
  // `glm_model_unavailable` (picker-level problem), not a generic page error.
  const available = await probeGlmModel({ baseUrl, model, apiKey });
  if (!available) {
    return NextResponse.json({ error: "glm_model_unavailable" }, { status: 503 });
  }

  const res = await httpChatCompletions({
    baseUrl,
    model,
    apiKey,
    messages: [
      { role: "system", content: GLM_TRANSCRIBE_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe this page:" },
          { type: "image_url", image_url: { url: image } },
        ],
      },
    ],
    maxTokens: 2000,
    timeoutMs: PAGE_TIMEOUT_MS,
  });

  if (!res.ok) {
    // audit-3 F-F10: capacity (upstream 429) is retryable and must not read
    // as a page-read failure; a timeout keeps its own code.
    if (res.error === "rate_limited") {
      return NextResponse.json({ error: "glm_rate_limited" }, { status: 429 });
    }
    const status = res.error === "timeout" ? 504 : 502;
    return NextResponse.json(
      { error: res.error === "timeout" ? "glm_timeout" : "glm_error" },
      { status },
    );
  }
  return NextResponse.json({ text: res.text });
}

/**
 * Emit the per-user ops line for an upstream business code (defect #6).
 *
 * The plan requires "log `code/message` + `usage{…}` per-user server-side
 * (redacted)". The empty `ZAI_*_CODES` extension point is worthless if an
 * operator cannot see WHICH unknown code is firing, so every degraded/error
 * path names the (already-redacted) code and message. Never the key.
 */
function logUpstreamCode(opts: {
  userId: string;
  requestId: string;
  outcome: string;
  code?: string;
  message?: string;
  usagePresent: boolean;
  totalTokens: number;
}): void {
  console.warn(
    "[glm-ocr-code] " +
      JSON.stringify({
        userId: opts.userId,
        requestId: opts.requestId,
        provider: "remote",
        outcome: opts.outcome,
        code: opts.code ?? null,
        message: opts.message ?? null,
        usagePresent: opts.usagePresent,
        totalTokens: opts.totalTokens,
      }),
  );
}

/** REMOTE leg: the whole document in one billed `layout_parsing` call. */
async function parseRemoteDocument(
  cfg: GlmProviderConfig,
  kind: "image" | "pdf",
  dataUrl: string,
  userId: string,
): Promise<NextResponse> {
  // G10: a fresh request id per attempt (no reuse until idempotency is
  // verified). It correlates the upstream call with our redacted usage line.
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  const res = await httpLayoutParsing({
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
    fileDataUrl: dataUrl,
    timeoutMs: REMOTE_TIMEOUT_MS,
    requestId,
  });
  const ms = Date.now() - startedAt;

  // Defect #4(a): record usage whenever the response CARRIES it, regardless of
  // ok/degraded. The money was spent — an HTTP-200 error envelope carrying
  // `usage.total_tokens: 999999` used to record nothing at all, and that is
  // exactly the G9 shape where upstream may well have done the work. Nothing is
  // invented: `usagePresent:false` marks a billed attempt whose count upstream
  // never reported (defect #4(b)/(c)) so an operator can see the gap.
  const record = (): void => {
    recordGlmSpend({
      userId,
      requestId,
      totalTokens: res.usage.totalTokens,
      pages: res.ok ? res.numPages : null,
      provider: cfg.provider,
      model: cfg.model,
      promptTokens: res.usage.promptTokens,
      completionTokens: res.usage.completionTokens,
      ms,
      usagePresent: res.usagePresent,
    });
  };

  if (!res.ok) {
    // The attempt reached upstream and the body reported usage → it was billed.
    // Only a transport-level failure (nothing parsed) is skipped, and even then
    // the missing accounting is logged.
    if (res.usagePresent) {
      record();
    } else {
      console.warn(
        "[glm-ocr] Remote attempt produced no usage data " +
          `(requestId=${requestId}, userId=${userId}, error=${res.error}); ` +
          "any upstream token spend for it is NOT accounted.",
      );
    }
    logUpstreamCode({
      userId,
      requestId,
      outcome: `error:${res.error}`,
      code: res.code,
      message: res.message,
      usagePresent: res.usagePresent,
      totalTokens: res.usage.totalTokens,
    });

    // Gate G4: an auth failure is a CONFIGURATION problem (dead key / no
    // entitlement), not a read failure — the picker must hide the engine, and
    // the client must not blind-retry it. NEVER `glm_error` for auth.
    if (res.error === "auth") {
      return NextResponse.json({ error: "glm_model_unavailable" }, { status: 503 });
    }
    if (res.error === "rate_limited") {
      return NextResponse.json({ error: "glm_rate_limited" }, { status: 429 });
    }
    if (res.error === "timeout") {
      return NextResponse.json({ error: "glm_timeout" }, { status: 504 });
    }
    return NextResponse.json({ error: "glm_error" }, { status: 502 });
  }

  // Gate G8 / contract §3.5: the call SUCCEEDED (and was therefore billed),
  // even when degraded or blank — record the real usage before returning. The
  // ledger write is synchronous and a failure only warns (never fails the
  // request), so a disk problem cannot lose a paid-for extraction.
  record();
  if (res.degraded || res.code !== undefined) {
    // Defect #6: the degraded path must name the code/message.
    logUpstreamCode({
      userId,
      requestId,
      outcome: res.degraded ? "degraded" : "ok-with-code",
      code: res.code,
      message: res.degradedReason,
      usagePresent: res.usagePresent,
      totalTokens: res.usage.totalTokens,
    });
  }

  // Post-check the REAL page count. Already paid for, so this is a typed
  // failure (the ledger above recorded the spend) rather than a silent success.
  //
  // Defect #12(b): this is the BACKSTOP, and it must be loud — the cheap
  // pre-flight only catches uncompressed PDFs, so reaching here with an
  // over-cap deck is the expected path for a modern producer's output. The log
  // carries the real spend and the real page count.
  if (res.numPages !== null && res.numPages > cfg.maxPages) {
    console.warn(
      "[glm-ocr] OVER-CAP PAID CALL: remote run returned " +
        `${res.numPages} pages, over the ${cfg.maxPages}-page cap ` +
        `(requestId=${requestId}, userId=${userId}, ` +
        `totalTokens=${res.usage.totalTokens}, usagePresent=${res.usagePresent}, ` +
        `costUsd≈${glmCostUsd(res.usage.totalTokens).toFixed(6)}). The call was ` +
        "BILLED; the client must split the document.",
    );
    return NextResponse.json({ error: "glm_error" }, { status: 502 });
  }

  return NextResponse.json({
    text: res.markdown,
    // Defect #10(c): `pages` is retained for the current client, which reads
    // `numPages ?? pages ?? 1`. When the page count is genuinely unknown this
    // reports `pages: null` rather than FABRICATING 1 — the client's density
    // heuristic divided by a fabricated 1 for a 300-page document.
    pages: res.numPages,
    numPages: res.numPages,
    degraded: res.degraded,
    blank: res.blank,
  });
}
