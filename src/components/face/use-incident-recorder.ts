"use client";

import { useEffect, useRef } from "react";
import {
  acquireCameraStream,
  releaseCameraStream,
  resolveStream,
} from "@/lib/vision/camera";
import type { FaceStatus } from "@/lib/face/types";
import {
  INCIDENT_RING_MS,
  INCIDENT_TIMESTRICE_MS,
  MAX_INCIDENT_BYTES,
} from "@/lib/face/constants";
import {
  shouldFlushIncident,
  incidentClipReason,
  type IncidentFlushStatus,
} from "@/lib/face/incident-transition";

/**
 * useIncidentRecorder — privacy-first ring-buffer webcam/mic footage.
 *
 * While the student is verified (`armed`), a MediaRecorder captures the
 * camera (+ mic, when granted) in INCIDENT_TIMESTRICE_MS chunks held ONLY in
 * memory, capped at ~INCIDENT_RING_MS. Nothing is ever uploaded unless an
 * incident happens: when the face status leaves `ready` for
 * paused/flagged/unavailable, the last ~5 minutes are POSTed to
 * /api/sessions/[id]/incident and recording continues into a fresh buffer.
 * A clean submit stops and DISCARDS the buffer — no upload, no trace.
 *
 * KNOWN DEV LIMITATION: React StrictMode's double-mount sets the machine's
 * `stopping` flag on the unmount leg and nothing resets it on remount, so in
 * `next dev` the recorder is inert for the session — clips never upload in
 * dev. This is dev-only (production builds don't double-mount); smoke-testing
 * the upload path requires a production build.
 */
export function useIncidentRecorder(opts: {
  sessionId: string;
  enabled: boolean;
  /** Recording runs only while verified; transitions out trigger the flush. */
  status: FaceStatus;
  phase: "question" | "locked" | "feedback" | "submitting" | "submitted" | "timeUp" | "dead";
  /**
   * WHY the session left `ready` — stored on the clip so the lecturer can
   * tie footage to a cause (face fail / focus loss / fullscreen exit).
   * Captured via ref at flush time, not closure, so the reason that arrived
   * with the transition is the one recorded.
   */
  reason?: string;
  /** Latest mic stream from the advisories hook (optional audio track). */
  micStreamRef: React.RefObject<MediaStream | null>;
}) {
  const { sessionId, enabled, status, phase, reason, micStreamRef } = opts;

  const sessionIdRef = useRef(sessionId);
  const reasonRef = useRef(reason ?? "paused");
  useEffect(() => {
    sessionIdRef.current = sessionId;
    if (reason !== undefined) reasonRef.current = reason;
  });

  // Mutable recorder machinery lives outside React state entirely. The
  // transition driver treats the FIRST observed status as a transition
  // (prev starts null) so a resumed 'ready' session starts recording.
  const machineRef = useRef<{
    recorder: MediaRecorder | null;
    stream: MediaStream | null;
    cameraToken: number | null;
    chunks: { blob: Blob; durationMs: number }[];
    totalMs: number;
    startedAt: number;
    flushing: boolean;
    stopping: boolean;
    /** Last observed face status — lives ON the machine so the effect
     * cleanup cannot null it (a status change tears the effect down and
     * re-runs it; the PREVIOUS status must survive that cycle or the
     * ready→paused flush edge is unreachable). */
    prevStatus: FaceStatus | null;
  }>({
    recorder: null,
    stream: null,
    cameraToken: null,
    chunks: [],
    totalMs: 0,
    startedAt: 0,
    flushing: false,
    stopping: false,
    prevStatus: null,
  });

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof MediaRecorder === "undefined") return;
    let disposed = false;

    function pickMimeType(): string {
      const candidates = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
      ];
      for (const c of candidates) {
        if (MediaRecorder.isTypeSupported(c)) return c;
      }
      return "";
    }

    async function startRecording(): Promise<void> {
      const m = machineRef.current;
      if (disposed || m.recorder || m.stopping) return;
      try {
        const token = await acquireCameraStream();
        // Post-await revalidation: while this acquire was in flight a flush
        // may have started a recorder, or disposal happened. Overwriting
        // cameraToken/recorder here would leak the first token and spawn
        // dual recorders.
        if (disposed || m.recorder || m.stopping) {
          releaseCameraStream(token);
          return;
        }
        m.cameraToken = token;
        const videoTrack = resolveStream(m.cameraToken).getVideoTracks()[0];
        if (!videoTrack) {
          releaseCameraStream(m.cameraToken);
          m.cameraToken = null;
          return;
        }
        const tracks: MediaStreamTrack[] = [videoTrack];
        const mic = micStreamRef?.current ?? null;
        for (const t of mic?.getAudioTracks() ?? []) tracks.push(t);
        m.stream = new MediaStream(tracks);
        m.chunks = [];
        m.totalMs = 0;
        m.startedAt = Date.now();
        const mimeType = pickMimeType();
        m.recorder = new MediaRecorder(
          m.stream,
          mimeType ? { mimeType, videoBitsPerSecond: 250_000 } : { videoBitsPerSecond: 250_000 },
        );
        m.recorder.ondataavailable = (ev: BlobEvent) => {
          if (!ev.data || ev.data.size === 0) return;
          const mm = machineRef.current;
          // Chunk duration ≈ timeslice (the final chunk may be shorter; the
          // error is bounded by one timeslice).
          mm.chunks.push({ blob: ev.data, durationMs: INCIDENT_TIMESTRICE_MS });
          mm.totalMs += INCIDENT_TIMESTRICE_MS;
          while (mm.totalMs > INCIDENT_RING_MS && mm.chunks.length > 1) {
            const dropped = mm.chunks.shift();
            if (dropped) mm.totalMs -= dropped.durationMs;
          }
        };
        // An external error (camera unplug, OS revocation) forces the
        // recorder 'inactive' WITHOUT our drain/discard onstop installed —
        // without cleanup the machine keeps a truthy dead recorder: flush
        // uploads frozen footage forever, startRecording early-returns, and
        // the camera token leaks.
        const rec = m.recorder;
        rec.onerror = () => {
          if (machineRef.current.recorder !== rec) return; // superseded by drain/discard
          // audit-3 R2-INC-F10: the buffer used to be ZEROED here, so the very
          // incident that killed the recorder produced no clip. The error is
          // precisely when footage matters, so keep the chunks and hand them to
          // a best-effort upload — the recorder is dead either way, but the
          // evidence survives.
          const salvaged =
            machineRef.current.chunks.length > 0
              ? {
                  blob: concat(machineRef.current.chunks),
                  durationMs: machineRef.current.totalMs,
                  from: machineRef.current.startedAt,
                }
              : null;
          machineRef.current.recorder = null;
          machineRef.current.chunks = [];
          machineRef.current.totalMs = 0;
          stopTracksOnly();
          if (salvaged) void uploadClip(salvaged, "recorder_error");
        };
        m.recorder.start(INCIDENT_TIMESTRICE_MS);
      } catch {
        stopTracksOnly();
      }
    }

    function stopTracksOnly(): void {
      const m = machineRef.current;
      if (m.cameraToken !== null) {
        releaseCameraStream(m.cameraToken);
        m.cameraToken = null;
      }
      m.stream = null;
    }

    /** Stop the recorder and RESOLVE with the concatenated ring buffer. */
    function drain(): Promise<{ blob: Blob; durationMs: number; from: number } | null> {
      const m = machineRef.current;
      const rec = m.recorder;
      if (!rec || rec.state === "inactive") {
        // External stop/error already fired (or never started): still tear
        // the machine down — a truthy dead recorder would poison every
        // later flush/start cycle.
        const payload =
          m.chunks.length > 0
            ? { blob: concat(m.chunks), durationMs: m.totalMs, from: m.startedAt }
            : null;
        m.chunks = [];
        m.totalMs = 0;
        m.recorder = null;
        stopTracksOnly();
        return Promise.resolve(payload);
      }
      return new Promise((resolve) => {
        const onFinish = () => {
          rec.onstop = null;
          const payload =
            m.chunks.length > 0
              ? { blob: concat(m.chunks), durationMs: m.totalMs, from: m.startedAt }
              : null;
          m.chunks = [];
          m.totalMs = 0;
          stopTracksOnly();
          m.recorder = null;
          resolve(payload);
        };
        rec.onstop = onFinish;
        try {
          rec.stop();
        } catch {
          onFinish();
        }
      });
    }

    async function flush(reason: string): Promise<void> {
      const m = machineRef.current;
      if (m.flushing || m.stopping) return;
      m.flushing = true;
      try {
        const drained = await drain();
        if (drained) {
          // audit-3 R2-INC-F9: a stop that lands while the drain is in flight
          // (clean submit racing the flush) used to DROP the payload — the
          // stopping gate swallowed drained footage. A clip that reached this
          // point belongs to an incident that already happened and must still
          // be uploaded; `stopping` only means "stop capturing now".
          await uploadClip(drained, reason);
        }
      } finally {
        m.flushing = false;
        // Keep capturing so SUBSEQUENT incidents have footage too — unless a
        // stop is in progress (the terminal path must not re-acquire the
        // camera; audit-3 R2-INC-F2).
        if (!m.stopping) void startRecording();
      }
    }

    /**
     * Best-effort clip upload. audit-3 R2-INC-F1: the previous form only
     * `.catch(() => {})`-ed network throws and never checked `response.ok`, so
     * a resolved 429 (the route's 6/min incident limiter), 413, 400 or 500 was
     * silently discarded — losing evidence for exactly the incidents that
     * break uploads. Every failure now logs with the status and the clip size
     * so the loss is observable instead of invisible.
     */
    async function uploadClip(
      payload: { blob: Blob; durationMs: number; from: number },
      clipReason: string,
    ): Promise<void> {
      if (payload.blob.size > MAX_INCIDENT_BYTES) {
        console.warn(
          "[incident-recorder] ring buffer exceeds the upload cap — clip dropped:",
          payload.blob.size,
        );
        return;
      }
      // Trust the ACTUAL container (Safari defaults to mp4 when WebM is
      // unsupported — storing mp4 bytes as .webm breaks playback).
      const isMp4 = payload.blob.type.includes("mp4");
      const form = new FormData();
      form.append("clip", payload.blob, isMp4 ? "clip.mp4" : "clip.webm");
      form.append("reason", clipReason.slice(0, 40));
      form.append("durationMs", String(payload.durationMs));
      form.append("recordedFrom", new Date(payload.from).toISOString());
      try {
        const res = await fetch(`/api/sessions/${sessionIdRef.current}/incident`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          console.error(
            `[incident-recorder] clip upload rejected (${res.status}) — footage lost:`,
            { reason: clipReason, bytes: payload.blob.size },
          );
        }
      } catch (err) {
        console.error("[incident-recorder] clip upload failed (network) — footage lost:", {
          reason: clipReason,
          bytes: payload.blob.size,
          err,
        });
      }
    }

    function discard(): void {
      const m = machineRef.current;
      m.stopping = true;
      const rec = m.recorder;
      if (rec && rec.state !== "inactive") {
        // Chain — never overwrite a pending flush's onstop (that would hang
        // its awaited drain promise forever with flushing stuck true).
        const pendingOnStop = rec.onstop;
        rec.onstop = () => {
          rec.onstop = null;
          try {
            if (pendingOnStop) (pendingOnStop as (this: MediaRecorder) => void).call(rec);
          } catch {
            /* the superseded chain must not break discard */
          }
          m.chunks = [];
          m.totalMs = 0;
          stopTracksOnly();
        };
        try {
          rec.stop();
        } catch {
          /* already inactive */
        }
      } else {
        m.chunks = [];
        stopTracksOnly();
      }
    }

    // ── Status-transition driver ────────────────────────────────────
    // BUGFIX (audit 2026-09): the previous status lives on the MACHINE
    // (module-lifetime) — a ref the effect cleanup nulled on EVERY dependency
    // change made `prev` always null at effect entry, so the flush branch was
    // dead code and NO incident clip was ever uploaded. The predicate itself
    // is pure (`incident-transition.ts`) and unit-pinned.
    const prev = machineRef.current.prevStatus as IncidentFlushStatus | null;
    const next = status as IncidentFlushStatus;
    if (next === "ready") {
      // null prev (first run / post-cleanup) counts as a transition: a
      // RESUMED session seeds initialFaceStatus='ready' and must start
      // recording immediately.
      if (prev !== "ready") void startRecording();
    } else if (shouldFlushIncident(prev, next)) {
      // The clip reason is the PAUSE CAUSE (face/focus_lost/fullscreen_exit),
      // not the bare status token — a lecturer reading the dashboard must be
      // able to tell which cause produced the footage.
      void flush(incidentClipReason(next, reasonRef.current));
    }
    machineRef.current.prevStatus = status;

    if (phase === "submitted" || phase === "dead") {
      // Clean completion OR session death: stop and DROP the buffer (privacy
      // default). audit-3 R2-INC-F2: `dead` must be treated like submitted —
      // it used to leave the camera streaming with no upload path and no
      // discard, so a reset mid-flight kept the webcam light on indefinitely.
      discard();
    }

    return () => {
      disposed = true;
      // The machine's prevStatus deliberately SURVIVES this cleanup (a status
      // change tears the effect down and re-runs it mid-session — the flush
      // edge depends on the previous status surviving). Only a real
      // enabled-flip remount should treat the next status as fresh, so the
      // machine resets ONLY when the hook is being disabled entirely.
      if (!enabled) {
        machineRef.current.prevStatus = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, status, phase]);

  // audit-3 R2-INC-F2: the effect cleanup above deliberately does NOT stop the
  // recorder (a status change tears it down and re-runs it mid-session, and the
  // buffer must survive that). But when `enabled` itself goes false the hook is
  // being switched OFF for good — so the capture must actually stop and the
  // camera be released. Without this the only teardown was the unmount effect
  // below, and an `enabled`-flip (phase → submitted/dead) left the recorder and
  // the camera tracks alive: the webcam light stayed on with no upload path.
  // Runs on mount too, where `enabled` is already false — discard() is
  // idempotent, so that is a no-op.
  const enabledNow = enabled;
  useEffect(() => {
    const m = machineRef.current;
    if (enabledNow) {
      // Re-enabling (or the first enable): clear any stop flag left by a
      // previous disable so the capture can actually start. Without this the
      // machine would stay inert after a disable→enable cycle.
      m.stopping = false;
      return;
    }
    m.stopping = true;
    const rec = m.recorder;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* already inactive */
      }
    }
    m.recorder = null;
    m.chunks = [];
    m.totalMs = 0;
    if (m.cameraToken !== null) {
      releaseCameraStream(m.cameraToken);
      m.cameraToken = null;
    }
    m.stream = null;
  }, [enabledNow]);

  // Terminal unmount teardown. The machine object is module-lifetime (created
  // once in useRef's initializer), so reading it here is safe — but copy the
  // ref to a local to satisfy the exhaustive-deps lint rule.
  const machine = machineRef.current;
  useEffect(() => {
    return () => {
      machine.stopping = true;
      try {
        if (machine.recorder && machine.recorder.state !== "inactive") machine.recorder.stop();
      } catch {
        /* ignore */
      }
      if (machine.cameraToken !== null) {
        releaseCameraStream(machine.cameraToken);
        machine.cameraToken = null;
      }
      machine.stream = null;
      machine.chunks = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function concat(chunks: { blob: Blob }[]): Blob {
  return new Blob(chunks.map((c) => c.blob), { type: chunks[0]?.blob.type || "video/webm" });
}
