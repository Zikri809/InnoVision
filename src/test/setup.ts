import { vi } from "vitest";

/**
 * Vitest setup:
 *  - mock `server-only` so modules guarded by `import "server-only"` (e.g.
 *    lib/ai/client.ts with the API key) can be imported in unit tests.
 *  - set the AI/OCR env vars the routes read (AI_BASE_URL / AI_API_KEY /
 *    AI_MODEL / OCR_VISION_MODEL) so route-handler tests can construct the
 *    OpenAI client without a real key.
 */
vi.mock("server-only", () => ({}));

process.env.AI_BASE_URL = process.env.AI_BASE_URL ?? "https://api.openai.com/v1";
process.env.AI_API_KEY = process.env.AI_API_KEY ?? "test-key";
process.env.AI_MODEL = process.env.AI_MODEL ?? "gpt-4o-mini";
process.env.OCR_VISION_MODEL = process.env.OCR_VISION_MODEL ?? "gpt-4o-mini";
process.env.OCR_DEFAULT_ENGINE = process.env.OCR_DEFAULT_ENGINE ?? "tesseract";
process.env.OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
process.env.OCR_GLM_MODEL = process.env.OCR_GLM_MODEL ?? "glm-ocr";
