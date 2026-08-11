import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

/**
 * MSW server for AI route tests (I14–I19). Intercepts the OpenAI-compatible
 * chat-completions endpoint and serves canned valid/invalid JSON so CI never
 * hits a real model (TESTING §1: "AI tests never hit a real model").
 */

const CHAT_URL = "*/chat/completions";

export const validQuizJson = JSON.stringify({
  title: "AI Motion Quiz",
  questions: [
    { type: "mcq", prompt: "What is velocity?", options: ["Speed", "Distance"], correct_index: 0, explanation: "Velocity is speed with direction." },
    { type: "true_false", prompt: "Light travels faster than sound.", options: ["True", "False"], correct_index: 0 },
    { type: "mcq", prompt: "Unit of force?", options: ["Joule", "Newton", "Watt"], correct_index: 1 },
  ],
});

export const invalidJson = "this is not json";

export const aiHandlers = [
  http.post(CHAT_URL, () =>
    HttpResponse.json({
      choices: [{ message: { content: validQuizJson } }],
    }),
  ),
];

/** Server with a stub that always returns the given content. */
export function aiServerWith(content: string) {
  return setupServer(
    http.post(CHAT_URL, () =>
      HttpResponse.json({ choices: [{ message: { content } }] }),
    ),
  );
}

export const defaultAiServer = setupServer(...aiHandlers);
