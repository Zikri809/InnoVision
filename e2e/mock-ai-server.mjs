// Tiny mock OpenAI-compatible server for E2E tests.
//
// The Phase 4 AI routes call the LLM via the `openai` SDK, which fetches
// AI_BASE_URL/v1/chat/completions SERVER-SIDE (inside the Next.js route). A
// Playwright page.route() cannot intercept server-side fetches, so we run this
// real local HTTP server and point AI_BASE_URL at it for the E2E Next.js
// process (see playwright.config.ts webServer env).
//
// It serves deterministic valid quiz JSON so CI never hits a real model
// (TESTING §1: "AI tests never hit a real model").
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

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");

  // Health check used by Playwright's webServer readiness probe.
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url?.endsWith("/v1/chat/completions") && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        /* ignore */
      }
      const messages = (body.messages ?? []) as { role: string; content: string }[];
      const userMsg = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

      // A regenerate request asks for ONE question; a generate asks for a quiz.
      // Heuristic: the regenerate prompt contains "Rewrite the following question".
      const isRegenerate = userMsg.includes("Rewrite the following question");
      const content = isRegenerate ? JSON.stringify(VALID_QUESTION) : JSON.stringify(VALID_QUIZ);

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
