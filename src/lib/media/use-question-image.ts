"use client";

import { useEffect, useState } from "react";

export type CachedImage = { url: string; expiresAt: number };

/**
 * Module-level signed-URL cache keyed by question id. Expiry-aware (plan D9):
 * a cached entry is only served while it has ≥30 s of life left, so long
 * proctored sessions and sleep/resume reconnects transparently refetch
 * instead of rendering a dead URL.
 */
const cache = new Map<string, CachedImage | Promise<CachedImage>>();

const STALE_MARGIN_MS = 30_000;

function isResolved(entry: CachedImage | Promise<CachedImage>): entry is CachedImage {
  return typeof (entry as CachedImage).url === "string";
}

function fresh(entry: CachedImage | undefined): string | null {
  if (!entry) return null;
  return entry.expiresAt - STALE_MARGIN_MS > Date.now() ? entry.url : null;
}

/**
 * Fetch-and-share: concurrent mounts for the same id await ONE request
 * (in-flight promise stored in the cache), so a results page bursting N
 * images issues N — not 2N — signing calls against the shared 60/min budget.
 */
function fetchEntry(
  questionId: string,
): Promise<CachedImage> {
  const existing = cache.get(questionId);
  if (existing) {
    // Resolved-but-STALE entries count as a miss (plan D9: refetch when stale)
    // so a dead URL is never re-served without hitting the API first.
    if (isResolved(existing)) {
      return fresh(existing)
        ? Promise.resolve(existing)
        : fetchEntryMiss(questionId);
    }
    return existing as Promise<CachedImage>;
  }
  return fetchEntryMiss(questionId);
}

function fetchEntryMiss(questionId: string): Promise<CachedImage> {
  const promise = fetch(`/api/question-images/${questionId}`).then(async (res): Promise<CachedImage> => {
    if (!res.ok) {
      cache.delete(questionId);
      throw new Error("sign_failed");
    }
    const body = (await res.json()) as { url?: string; expiresAt?: string };
    if (!body.url || !body.expiresAt) {
      cache.delete(questionId);
      throw new Error("sign_bad_body");
    }
    const entry = { url: body.url, expiresAt: new Date(body.expiresAt).getTime() };
    cache.set(questionId, entry);
    return entry;
  });
  // Store the in-flight promise so duplicates share it; rejection removes it.
  cache.set(questionId, promise);
  promise.catch(() => cache.delete(questionId));
  return promise;
}

type HookState = { qid: string | null; url: string | null; failed: boolean };

/**
 * Fetches `/api/question-images/[qid]` (the visibility boundary lives
 * server-side in resolve_question_image). On an <img>-level failure the
 * consumer can call `retry()` once to force a refetch (expired-URL recovery).
 *
 * All state transitions happen inside promise callbacks (never synchronously
 * in the effect body) per the React Compiler's cascading-render rule.
 */
export function useQuestionImage(
  questionId: string | null,
): { url: string | null; loading: boolean; failed: boolean; retry: () => void } {
  const [state, setState] = useState<HookState>(() => {
    const entry = questionId ? cache.get(questionId) : undefined;
    return {
      qid: questionId,
      url: entry && isResolved(entry) ? fresh(entry) : null,
      failed: false,
    };
  });
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    // Microtask deferral keeps every setState out of the synchronous effect
    // body (cascading-render rule) while preserving one-fetch-per-key.
    Promise.resolve().then(() => {
      if (!alive || !questionId) return;
      const entry = cache.get(questionId);
      const cachedUrl = entry && isResolved(entry) ? fresh(entry) : null;
      if (cachedUrl) {
        setState({ qid: questionId, url: cachedUrl, failed: false });
        return;
      }
      setLoading(true);
      fetchEntry(questionId)
        .then((entry2) => {
          if (!alive) return;
          setState({ qid: questionId, url: entry2.url, failed: false });
        })
        .catch(() => {
          if (!alive) return;
          setState({ qid: questionId, url: null, failed: true });
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    });
    return () => {
      alive = false;
    };
  }, [questionId, attempt]);

  function retry() {
    if (questionId) cache.delete(questionId);
    setAttempt((n) => n + 1);
  }

  return {
    url: state.qid === questionId ? state.url : null,
    loading,
    failed: state.qid === questionId ? state.failed : false,
    retry,
  };
}

/** Test seam: clear the module cache between tests/sessions. */
export function clearQuestionImageCache() {
  cache.clear();
}
