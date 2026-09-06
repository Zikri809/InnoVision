// Tiny mock OpenAI-compatible server for E2E tests.
//
// The AI routes call the LLM via the `openai` SDK, which fetches
// AI_BASE_URL/v1/chat/completions SERVER-SIDE (inside the Next.js route). A
// Playwright page.route() cannot intercept server-side fetches, so we run this
// real local HTTP server and point AI_BASE_URL at it for the E2E Next.js
// process (see playwright.config.ts webServer env).
//
// TWO protocols are served (docs/plans/agentic-generation.md):
//  - non-streaming JSON (legacy; used when the route is called without the
//    stream opt-in) — the original behavior, byte-compatible;
//  - SSE streaming (`stream: true` in the upstream request body) — deltas for
//    reasoning/content plus tool_call fragments, so the chatStream client and
//    the console UI are exercised end-to-end.
//
// Scenario selection is STATELESS (per-request sniffing) so parallel Playwright
// workers can never cross-contaminate: a scenario marker embedded in the user
// message picks the fixture. E2E specs embed `[MOCK:scenario]` markers;
// everything else gets the happy path.
//
// Usage: node e2e/mock-ai-server.mjs   (defaults to port 8787)

import http from "node:http";

const PORT = Number(process.env.MOCK_AI_PORT ?? 8787);

const VALID_QUIZ = {
  title: "AI Motion Quiz",
  questions: [
    { type: "mcq", prompt: "What is velocity?", options: ["Speed in a direction", "Total distance", "Time taken"], correct_index: 0, explanation: "Velocity includes direction." },
    { type: "true_false", prompt: "Light travels faster than sound.", options: ["True", "False"], correct_index: 0, explanation: null },
    { type: "mcq", prompt: "Which unit is force measured in?", options: ["Joule", "Newton", "Watt"], correct_index: 1, explanation: null },
  ],
};

const VALID_QUESTION = {
  type: "mcq",
  prompt: "REPLACED: What is acceleration?",
  options: ["Change in velocity over time", "Total distance", "Mass"],
  correct_index: 0,
  explanation: null,
};

// A prompt containing brace characters INSIDE string values — the incremental
// scanner regression fixture (braces must not confuse question-boundary
// detection; scenario [MOCK:braces]).
const BRACES_QUIZ = {
  title: "Braces Quiz {not a boundary}",
  questions: [
    { type: "mcq", prompt: "What does {x} denote in set notation?", options: ["A set {…}", "A function", "A loop"], correct_index: 0, explanation: "The braces {…} enclose set members." },
    { type: "true_false", prompt: "JSON objects use { } braces.", options: ["True", "False"], correct_index: 0, explanation: null },
    { type: "mcq", prompt: "Which escape renders a literal brace in JSON?", options: ["\\{", "\\}", "{{", "Neither — braces need no escaping in strings"], correct_index: 3, explanation: null },
  ],
};

// Invalid twice → exercises the validation-retry path end-to-end.
const INVALID_JSON = "{not valid json";

function sse(res, chunks, { delayMs = 10 } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  let i = 0;
  const tick = () => {
    if (i >= chunks.length) {
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    const c = chunks[i++];
    if (c.__raw) {
      // Raw verbatim line (error injection) — not JSON-wrapped.
      res.write(c.__raw);
    } else {
      res.write(`data: ${JSON.stringify(c)}\n\n`);
    }
    setTimeout(tick, c.__delayMs ?? delayMs);
  };
  tick();
}

function chunk(delta, finish = null) {
  return { choices: [{ delta, finish_reason: finish, index: 0 }] };
}

/** Stream a JSON quiz as content deltas (one char-group per chunk) plus a few
 * reasoning deltas first — mirrors the real Kenari shape (spike-verified). */
function streamQuizContent(res, quizObj, { reasoning = true, delayMs = 5 } = {}) {
  const json = JSON.stringify(quizObj);
  const chunks = [];
  if (reasoning) {
    for (const piece of ["Analyzing ", "the source ", "material…"]) {
      chunks.push(chunk({ reasoning_content: piece, reasoning: piece }));
    }
  }
  chunks.push(chunk({ content: "", role: "assistant" }));
  const STEP = 24;
  for (let i = 0; i < json.length; i += STEP) {
    chunks.push(chunk({ content: json.slice(i, i + STEP) }));
  }
  chunks.push(chunk({}, "stop"));
  sse(res, chunks, { delayMs });
}

function streamRawContent(res, text, { delayMs = 5 } = {}) {
  streamQuizContent(res, text, { reasoning: false, delayMs });
}

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");

  // Health check used by Playwright's webServer readiness probe.
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url?.endsWith("/v1/chat/completions") && req.method === "POST") {
    // Insurance: a mid-stream client abort destroys the socket under us;
    // writes to a dead ServerResponse must never crash the shared mock
    // process (it serves every worker in the suite).
    res.on("error", () => {});
    req.on("error", () => {});
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        /* ignore */
      }
      const messages = body.messages ?? [];
      const userMsg = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      console.log(`[mock-ai] ${req.method} ${req.url} (${userMsg.length} chars)`);

      // A regenerate request asks for ONE question; a generate asks for a quiz.
      // Heuristic: the regenerate prompt contains "Rewrite the following question".
      const isRegenerate = userMsg.includes("Rewrite the following question");

      // Stateless scenario sniffing (parallel-worker safe).
      const scenario = userMsg.match(/\[MOCK:([a-z_]+)\]/)?.[1] ?? null;

      if (body.stream) {
        if (isRegenerate) {
          // Regenerate is legacy (non-streaming) today; still answer correctly.
          res.writeHead(200);
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(VALID_QUESTION) } }] }));
          return;
        }
        switch (scenario) {
          case "braces":
            streamQuizContent(res, BRACES_QUIZ);
            return;
          case "invalid":
            streamQuizContent(res, INVALID_JSON);
            return;
          case "midstream_error": {
            // A few content chunks, then the upstream dies with a 500 event
            // shape — the client must surface an error, keep the transcript.
            sse(res, [
              chunk({ reasoning_content: "Starting…" }),
              chunk({ content: '{"title":' }),
              { __raw: "data: " + JSON.stringify({ error: { code: "upstream_500" } }) + "\n\n", __delayMs: 20 },
            ]);
            return;
          }
          case "stall": {
            // Send one chunk then go SILENT — exercises the inter-chunk idle
            // abort (AI_STREAM_IDLE_TIMEOUT_MS) and the client dead-stream path.
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`data: ${JSON.stringify(chunk({ reasoning_content: "Thinking…" }))}\n\n`);
            // Never write again; never end. The route's idle timer owns cleanup.
            return;
          }
          case "truncated": {
            const json = JSON.stringify(VALID_QUIZ).slice(0, 60);
            const chunks = [chunk({ content: json }), chunk({}, "length")];
            sse(res, chunks);
            return;
          }
          case "no_reasoning": {
            streamQuizContent(res, VALID_QUIZ, { reasoning: false });
            return;
          }
          default:
            streamQuizContent(res, VALID_QUIZ);
            return;
        }
      }

      // ── Legacy non-streaming protocol (unchanged behavior) ──
      let content;
      switch (scenario) {
        case "invalid":
          content = INVALID_JSON;
          break;
        case "braces":
          content = JSON.stringify(BRACES_QUIZ);
          break;
        default:
          content = isRegenerate ? JSON.stringify(VALID_QUESTION) : JSON.stringify(VALID_QUIZ);
      }

      res.writeHead(200);
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, () => {
  console.log(`mock-ai-server listening on http://127.0.0.1:${PORT}`);
});
