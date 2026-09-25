import "server-only";

// Bound the burst from three parallel frame extracts per request across all
// in-process routes. A finite queue turns overload into an honest hold rather
// than letting camera work exhaust the server's request pool.
const MAX_ACTIVE = 12;
const MAX_QUEUED = 36;
let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_ACTIVE) {
    active += 1;
    return;
  }
  if (waiters.length >= MAX_QUEUED) throw new Error("face_inference_overloaded");
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active -= 1;
}

export async function withFaceInference<T>(work: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await work();
  } finally {
    release();
  }
}
