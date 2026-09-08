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

  it("allows requests whose Origin matches x-forwarded-host (reverse proxy)", () => {
    expect(
      checkSameOrigin(
        req(url, {
          origin: "https://app.example.com",
          "x-forwarded-host": "app.example.com",
        }),
      ),
    ).toBeNull();
  });

  it("uses the first entry of a comma-separated x-forwarded-host", () => {
    expect(
      checkSameOrigin(
        req(url, {
          origin: "https://app.example.com",
          "x-forwarded-host": "app.example.com, inner.example.com",
        }),
      ),
    ).toBeNull();
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
