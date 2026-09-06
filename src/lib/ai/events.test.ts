import { describe, it, expect } from "vitest";
import { readGenerationEvents } from "@/lib/ai/events";
import type { GenerationEvent } from "@/lib/ai/events";

/**
 * U-EV (Phase 1) — readGenerationEvents, the only stream parsing we own
 * (the plan's parser promises migrated here). Coverage: line splitting
 * across chunk boundaries, blank-line tolerance, torn/corrupt lines →
 * stream_corrupt, multi-byte UTF-8 chars split across chunks (the decoder
 * flush), and the tail line without a trailing newline.
 */

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<GenerationEvent[]> {
  const out: GenerationEvent[] = [];
  for await (const ev of readGenerationEvents(stream)) out.push(ev);
  return out;
}

const line = (obj: unknown) => JSON.stringify(obj) + "\n";

describe("readGenerationEvents — happy paths", () => {
  it("U-EV1: parses one JSON object per line, skips blank lines", async () => {
    const events = await collect(
      streamOf([line({ type: "ping" }), "\n", line({ type: "error", code: "x" }), line({ type: "done", payload: {} })]),
    );
    expect(events.map((e) => e.type)).toEqual(["ping", "error", "done"]);
  });

  it("U-EV2: an event split across THREE chunks parses correctly", async () => {
    const full = line({ type: "stage", stage: "draft", status: "start" });
    const mid = Math.floor(full.length / 2);
    const events = await collect(streamOf([full.slice(0, mid), full.slice(mid, full.length - 3), full.slice(full.length - 3)]));
    expect(events).toEqual([{ type: "stage", stage: "draft", status: "start" }]);
  });

  it("U-EV3: multi-byte UTF-8 char split across chunk boundary survives (decoder flush)", async () => {
    // 'é' is 2 bytes in UTF-8 (0xC3 0xA9); the chunk boundary falls INSIDE it.
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('{"type":"error","code":"a","message":"caf'),
      0xc3,
      0xa9,
      ...new TextEncoder().encode(' x"}\n'),
    ]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 42)); // cuts inside 0xC3 0xA9
        controller.enqueue(bytes.slice(42));
        controller.close();
      },
    });
    const events = await collect(stream);
    expect(events).toHaveLength(1);
    const err = events[0] as Extract<GenerationEvent, { type: "error" }>;
    expect(err.code).toBe("a");
    expect(err.message).toBe("café x");
  });
});

describe("readGenerationEvents — corruption handling", () => {
  it("U-EV4: a torn (non-JSON) line yields stream_corrupt and the stream continues", async () => {
    const events = await collect(
      streamOf(["{torn line no json}\n", line({ type: "ping" })]),
    );
    expect(events.map((e) => e.type)).toEqual(["error", "ping"]);
    const corrupt = events[0] as Extract<GenerationEvent, { type: "error" }>;
    expect(corrupt.code).toBe("stream_corrupt");
  });

  it("U-EV5: a corrupt TAIL (no trailing newline) still yields stream_corrupt", async () => {
    const events = await collect(streamOf(["not json at all"]));
    expect(events).toHaveLength(1);
    expect((events[0] as Extract<GenerationEvent, { type: "error" }>).code).toBe("stream_corrupt");
  });

  it("U-EV6: a valid tail line without trailing newline still parses", async () => {
    const events = await collect(streamOf(['{"type":"ping"}']));
    expect(events).toEqual([{ type: "ping" }]);
  });
});
