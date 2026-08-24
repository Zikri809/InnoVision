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
 */
export function useIncidentRecorder(opts: {
  sessionId: string;
  enabled: boolean;
  /** Recording runs only while verified; transitions out trigger the flush. */
  status: FaceStatus;
  phase: "question" | "locked" | "feedback" | "submitting" | "submitted" | "timeUp" | "dead";
  /** Latest mic stream from the advisories hook (optional audio track). */
  micStreamRef: React.RefObject<MediaStream | null>;
}) {
  const { sessionId, enabled, status, phase, micStreamRef } = opts;

  const sessionIdRef = useRef(sessionId);
  const statusRef = useRef(status);
  const phaseRef = useRef(phase);
  useEffect(() => {
    sessionIdRef.current = sessionId;
    statusRef.current = status;
    phaseRef.current = phase;
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
  }>({
    recorder: null,
    stream: null,
    cameraToken: null,
    chunks: [],
    totalMs: 0,
    startedAt: 0,
    flushing: false,
    stopping: false,
  });
  const prevStatusRef = useRef<FaceStatus | null>(null);

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
          machineRef.current.recorder = null;
          machineRef.current.chunks = [];
          machineRef.current.totalMs = 0;
          stopTracksOnly();
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
        // Gate on the MACHINE-level stop flag, not this effect run's
        // `disposed`: a status transition (paused→recovering on unlock) tears
        // the effect down mid-upload, but the drained clip belongs to the
        // incident that just happened and must still be uploaded. Only a real
        // stop (discard / terminal unmount) drops it.
        if (m.stopping) return;
        if (drained) {
          if (drained.blob.size <= MAX_INCIDENT_BYTES) {
            // Trust the ACTUAL container (Safari defaults to mp4 when WebM
            // is unsupported — storing mp4 bytes as .webm breaks playback).
            const isMp4 = drained.blob.type.includes("mp4");
            const form = new FormData();
            form.append("clip", drained.blob, isMp4 ? "clip.mp4" : "clip.webm");
            form.append("reason", reason.slice(0, 40));
            form.append("durationMs", String(drained.durationMs));
            form.append("recordedFrom", new Date(drained.from).toISOString());
            await fetch(`/api/sessions/${sessionIdRef.current}/incident`, {
              method: "POST",
              body: form,
            }).catch(() => {});
          } else {
            console.warn(
              "[incident-recorder] ring buffer exceeds the upload cap — clip dropped:",
              drained.blob.size,
            );
          }
        }
      } finally {
        m.flushing = false;
        // Keep capturing so SUBSEQUENT incidents have footage too.
        void startRecording();
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
    const prev = prevStatusRef.current;
    if (status === "ready") {
      // null prev (first run / post-cleanup) counts as a transition: a
      // RESUMED session seeds initialFaceStatus='ready' and must start
      // recording immediately.
      if (prev !== "ready") void startRecording();
    } else if (
      (prev === "ready" || prev === "recovering") &&
      (status === "paused" || status === "flagged" || status === "unavailable")
    ) {
      // 'recovering' origins count too — the unlock re-verify path routes
      // flagged→recovering→paused; those incidents deserve footage as well.
      void flush(status);
    }
    prevStatusRef.current = status;

    if (phase === "submitted") {
      // Clean completion: stop and DROP the buffer (privacy default).
      discard();
    }

    return () => {
      disposed = true;
      // Reset so a remount (StrictMode / enabled flip) treats whatever
      // status it boots with as a fresh transition — otherwise a resumed
      // 'ready' session would never start recording after remount.
      prevStatusRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, status, phase]);

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
