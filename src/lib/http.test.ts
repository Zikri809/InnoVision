import { describe, expect, it } from "vitest";
import {
  checkBodyLimit,
  checkSameOrigin,
  firstIssueMessage,
  invalidBody,
  jsonError,
  JSON_BODY_LIMIT_BYTES,
} from "@/lib/http";

function req(
  url: string,
  headers: Record<string, string> = {},
  method = "POST",
): Request {
  return new Request(url, { method, headers });
}

describe("jsonError shape", () => {
  it("returns the error code, optional message and status as JSON", async () => {
    const res = jsonError("some_error", "details here", 418);
    expect(res.status).toBe(418);
    expect(res.headers.get("content-type")).toBe("application/json");
    await expect(res.json()).resolves.toEqual({
      error: "some_error",
      message: "details here",
    });
  });

  it("omits the message field when undefined", async () => {
    const res = jsonError("no_message", undefined, 404);
    await expect(res.json()).resolves.toEqual({ error: "no_message" });
  });
});

describe("checkSameOrigin", () => {
  const url = "http://localhost:3000/api/example";

  it("allows requests without an Origin header (non-browser callers)", () => {
    expect(checkSameOrigin(req(url))).toBeNull();
  });

  it("allows same-origin requests regardless of case", () => {
    expect(
      checkSameOrigin(req(url, { origin: "HTTP://LOCALHOST:3000" })),
    ).toBeNull();
  });

  it("rejects cross-origin requests with a typed 403", async () => {
    const res = checkSameOrigin(req(url, { origin: "https://evil.com" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    await expect(res!.json()).resolves.toMatchObject({
      error: "invalid_origin",
    });
  });

  it("rejects malformed Origin values", () => {
    expect(checkSameOrigin(req(url, { origin: "::not-a-url" }))).not.toBeNull();
  });

  // audit-2 M-01: x-forwarded-host is NO LONGER trusted as "this app's
  // host" — it is caller-writable on direct-access deployments, so
  // `Origin: evil` + `x-forwarded-host: evil` used to pass on one header.
  // Proxies that rewrite Host are covered by TRUSTED_ORIGINS (next test).
  it("rejects an Origin that only matches a caller-supplied x-forwarded-host", () => {
    expect(
      checkSameOrigin(
        req(url, {
          origin: "https://app.example.com",
          "x-forwarded-host": "app.example.com",
        }),
      ),
    ).not.toBeNull();
  });

  it("rejects when only the first entry of a comma-separated x-forwarded-host matches", () => {
    expect(
      checkSameOrigin(
        req(url, {
          origin: "https://app.example.com",
          "x-forwarded-host": "app.example.com, inner.example.com",
        }),
      ),
    ).not.toBeNull();
  });

  it("allows Origins listed in TRUSTED_ORIGINS (host-blind proxy)", async () => {
    const prev = process.env.TRUSTED_ORIGINS;
    process.env.TRUSTED_ORIGINS = "https://tunnel.example.org, http://other.example.net";
    try {
      expect(
        checkSameOrigin(req(url, { origin: "https://tunnel.example.org" })),
      ).toBeNull();
      expect(
        checkSameOrigin(req(url, { origin: "http://other.example.net" })),
      ).toBeNull();
      // Scheme matters: the https variant of an http entry must NOT pass.
      const res = checkSameOrigin(req(url, { origin: "https://other.example.net" }));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.TRUSTED_ORIGINS;
      else process.env.TRUSTED_ORIGINS = prev;
    }
  });

  it("skips malformed TRUSTED_ORIGINS entries instead of crashing", () => {
    const prev = process.env.TRUSTED_ORIGINS;
    process.env.TRUSTED_ORIGINS = "::bad, https://good.example.org";
    try {
      expect(
        checkSameOrigin(req(url, { origin: "https://good.example.org" })),
      ).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.TRUSTED_ORIGINS;
      else process.env.TRUSTED_ORIGINS = prev;
    }
  });
});

describe("checkBodyLimit", () => {
  it("passes when no content-length header is present (chunked)", () => {
    expect(checkBodyLimit(req("http://localhost/api/x"))).toBeNull();
  });

  it("passes when content-length is within budget", () => {
    expect(
      checkBodyLimit(
        req("http://localhost/api/x", { "content-length": "64" }),
        JSON_BODY_LIMIT_BYTES,
      ),
    ).toBeNull();
  });

  it("rejects declared length over the default cap with a typed 413", async () => {
    const over = String(JSON_BODY_LIMIT_BYTES + 1);
    const res = checkBodyLimit(
      req("http://localhost/api/x", { "content-length": over }),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(413);
    await expect(res!.json()).resolves.toMatchObject({
      error: "payload_too_large",
    });
  });

  it("honors an explicit smaller cap", () => {
    const res = checkBodyLimit(
      req("http://localhost/api/x", { "content-length": "100" }),
      50,
    );
    expect(res?.status).toBe(413);
  });
});

describe("firstIssueMessage", () => {
  it("skips empty messages and returns the first non-empty one", () => {
    expect(firstIssueMessage([{ message: "" }, { message: "real" }], "fb")).toBe(
      "real",
    );
  });

  it("falls back when all messages are empty/missing", () => {
    expect(firstIssueMessage([{ message: "" }, {}], "fallback")).toBe(
      "fallback",
    );
    expect(firstIssueMessage([], "fallback")).toBe("fallback");
  });

  it("returns the first issue's own message when populated", () => {
    expect(firstIssueMessage([{ message: "a" }, { message: "b" }], "fb")).toBe(
      "a",
    );
  });
});

describe("typed builder sanity", () => {
  it("invalidBody carries the zod message with status 400", async () => {
    const res = invalidBody("field is bad");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_body" });
  });
});

// ── audit-1 P1-5: streaming-capped body readers ────────────────────────
import { readCappedFormData, readCappedJson, readCappedText } from "@/lib/http";

/** A genuinely CHUNKED request: stream body, no content-length header. */
function chunkedRequest(
  body: string,
  chunkSize = 7,
  headers: Record<string, string> = {},
): Request {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("readCappedJson (audit-1 P1-5)", () => {
  it("parses a body within the cap", async () => {
    const r = await readCappedJson(chunkedRequest('{"a":1}'), 1024);
    expect(r).toEqual({ ok: true, data: { a: 1 } });
  });

  it("413s a chunked body over the cap EVEN WITHOUT content-length (the bypass)", async () => {
    const big = JSON.stringify({ blob: "x".repeat(4096) });
    const r = await readCappedJson(chunkedRequest(big), 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(413);
  });

  it("413s a lying content-length header without reading the body", async () => {
    const r = await readCappedJson(
      req("http://localhost/api/x", { "content-length": "999999" }),
      1024,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(413);
  });

  it("accepts a body exactly AT the cap (boundary is inclusive)", async () => {
    const payload = JSON.stringify({ a: "x".repeat(1010) });
    const r = await readCappedJson(chunkedRequest(payload), payload.length);
    expect(r.ok).toBe(true);
  });

  it("400s malformed JSON within the cap", async () => {
    const r = await readCappedJson(chunkedRequest("{nope"), 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });

  it("400s a missing body", async () => {
    const r = await readCappedJson(req("http://localhost/api/x"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });
});

describe("readCappedText (audit-1 P1-5)", () => {
  it("returns text within the cap (pause optional-body path)", async () => {
    const r = await readCappedText(chunkedRequest('{"reason":"focus_lost"}'), 1024);
    expect(r).toEqual({ ok: true, text: '{"reason":"focus_lost"}' });
  });

  it("413s an unbounded text() attempt over the cap", async () => {
    const r = await readCappedText(chunkedRequest("x".repeat(4096)), 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(413);
  });
});

describe("readCappedFormData (audit-1 P1-5)", () => {
  function multipartRequest(parts: Record<string, string | Blob>): Request {
    const form = new FormData();
    for (const [k, v] of Object.entries(parts)) form.append(k, v);
    return new Request("http://localhost/api/x", { method: "POST", body: form });
  }

  it("parses a small multipart body", async () => {
    const r = await readCappedFormData(
      multipartRequest({ clip: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])]), reason: "focus_lost" }),
      64 * 1024,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.form.get("reason")).toBe("focus_lost");
      expect((r.form.get("clip") as Blob).size).toBe(4);
    }
  });

  it("413s a streamed multipart body over the cap (chunked, no header)", async () => {
    // Build the multipart ENVELOPE from a real form, then stream a body that
    // exceeds the cap mid-flight.
    const envelope = multipartRequest({ clip: "x" });
    const contentType = envelope.headers.get("content-type") ?? "";
    const big = new Uint8Array(128 * 1024).fill(0x78);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    const lying = new Request("http://localhost/api/x", {
      method: "POST",
      headers: { "content-type": contentType },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const r = await readCappedFormData(lying, 64 * 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(413);
  });
});
