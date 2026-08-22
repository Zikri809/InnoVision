"use client";

import { useEffect, useRef } from "react";
import type { IFaceTracker, LivePose } from "@/lib/face/types";
import { AttentionMonitor, type AdvisoryType } from "@/lib/face/attention";
import {
  VoiceActivityMonitor,
  looksLikeHeadsetInput,
} from "@/lib/audio/vad";
import {
  ADVISORY_THROTTLE_MS,
  VOICE_SAMPLE_INTERVAL_MS,
} from "@/lib/face/constants";

/**
 * useIntegrityAdvisories — lecturer-visible integrity hints (NEVER status
 * changes). Four advisory sources feed ONE throttled reporter:
 *
 *  - `second_face` / `looked_away`: the tracker's pose stream through the
 *    pure AttentionMonitor (sustained 2-face presence / accumulated
 *    off-axis time).
 *  - `voice_activity`: a dedicated mic stream (requested lazily on first
 *    arm — the permission prompt lands after Begin) through an AnalyserNode
 *    RMS meter + the pure VoiceActivityMonitor.
 *  - `headset_active`: one-shot device-label check once the mic is granted
 *    (Bluetooth/wired headset as INPUT is an earbud hint).
 *
 * Mic denial degrades to "no voice advisories" silently — mirroring the
 * risk-7 camera-off acceptance. All reporting failures are swallowed (an
 * advisory must never disturb the exam).
 */
export function useIntegrityAdvisories(opts: {
  sessionId: string;
  enabled: boolean;
  /** Advisories only mean something while the student is verified+active. */
  armed: boolean;
  tracker: IFaceTracker | null;
}) {
  const { sessionId, enabled, armed, tracker } = opts;

  // Latest-ref mirrors (React Compiler-safe — refs sync in effects). The
  // effect body intentionally does NOT close over `sessionId`/`armed` so
  // their changes never tear down the mic graph.
  const sessionIdRef = useRef(sessionId);
  const armedRef = useRef(armed);
  const lastReportAtRef = useRef<Record<AdvisoryType, number>>({
    second_face: 0,
    looked_away: 0,
    voice_activity: 0,
    headset_active: 0,
  });

  useEffect(() => {
    sessionIdRef.current = sessionId;
    armedRef.current = armed;
  });

  /** The active mic stream — shared with the incident recorder (audio track). */
  const micStreamRef = useRef<MediaStream | null>(null);
  // Set by the main effect; the armed effect kicks the mic request when the
  // student first reaches 'ready' (the effect itself must not re-run on
  // armed flips).
  const kickMicRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (enabled && armed) kickMicRef.current?.();
  }, [enabled, armed]);

  useEffect(() => {
    if (!enabled) return;

    const attention = new AttentionMonitor();
    const voice = new VoiceActivityMonitor();

    let poseUnsubscribe: (() => void) | null = null;
    let audioInterval: ReturnType<typeof setInterval> | null = null;
    let audioCtx: AudioContext | null = null;
    let disposed = false;
    let headsetChecked = false;
    let micRequested = false;

    async function report(type: AdvisoryType): Promise<void> {
      const now = Date.now();
      if (now - (lastReportAtRef.current[type] ?? 0) < ADVISORY_THROTTLE_MS) return;
      try {
        await fetch(`/api/sessions/${sessionIdRef.current}/advisory`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type }),
        });
        // Stamp only on a delivered request — a failed POST must not consume
        // the throttle slot (a later occurrence re-reports).
        lastReportAtRef.current[type] = now;
      } catch {
        // network — a later occurrence re-reports; never surface.
      }
    }

    function handleEvents(events: { type: AdvisoryType }[]) {
      if (!armedRef.current || disposed) return;
      for (const e of events) void report(e.type);
    }

    if (tracker && typeof tracker.onPoseChange === "function") {
      const onPose = (pose: LivePose) => {
        if (!armedRef.current || disposed) return;
        handleEvents(
          attention.feed(
            {
              yaw: pose.yaw,
              centered: pose.centered,
              faceDetected: pose.faceDetected,
              facesSeen: pose.facesSeen,
            },
            Date.now(),
          ),
        );
      };
      poseUnsubscribe = tracker.onPoseChange(onPose);
    }

    async function requestMic(): Promise<void> {
      if (micRequested || disposed) return;
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
      micRequested = true;
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        // Denied/unavailable → no voice/headset advisories; exam unaffected.
        return;
      }
      if (disposed) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      micStreamRef.current = stream;

      // Headset-as-input check (labels require the granted permission).
      if (!headsetChecked) {
        headsetChecked = true;
        try {
          const deviceId = stream.getAudioTracks()[0]?.getSettings().deviceId;
          const devices = await navigator.mediaDevices.enumerateDevices();
          if (disposed) {
            // Cleanup ran during the await — never build the audio graph.
            for (const t of stream.getTracks()) t.stop();
            return;
          }
          const active = devices.find((d) => d.kind === "audioinput" && d.deviceId === deviceId);
          if (armedRef.current && looksLikeHeadsetInput(active?.label ?? "")) {
            void report("headset_active");
          }
        } catch {
          // enumerateDevices failed — skip the hint.
        }
      }

      // ── RMS meter → VoiceActivityMonitor ────────────────────────
      try {
        if (disposed) return;
        audioCtx = new AudioContext();
        await audioCtx.resume().catch(() => {});
        if (disposed) {
          void audioCtx.close().catch(() => {});
          audioCtx = null;
          return;
        }
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        // Older engines lack float time-domain data — fall back to the byte
        // domain (centered at 128) rather than throwing every 250ms.
        const useFloat = typeof analyser.getFloatTimeDomainData === "function";
        const floatBuf = new Float32Array(analyser.fftSize);
        const byteBuf = new Uint8Array(analyser.fftSize);
        audioInterval = setInterval(() => {
          if (disposed || !analyser) return;
          let sum = 0;
          if (useFloat) {
            analyser.getFloatTimeDomainData(floatBuf);
            for (let i = 0; i < floatBuf.length; i++) sum += floatBuf[i] * floatBuf[i];
          } else {
            analyser.getByteTimeDomainData(byteBuf);
            for (let i = 0; i < byteBuf.length; i++) {
              const v = (byteBuf[i] - 128) / 128;
              sum += v * v;
            }
          }
          const rms = Math.sqrt(sum / (useFloat ? floatBuf.length : byteBuf.length));
          handleEvents(voice.feed(rms, Date.now()));
        }, VOICE_SAMPLE_INTERVAL_MS);
      } catch {
        // WebAudio unavailable — voice advisories degrade off.
      }
    }

    // Request the mic when first ARMED (post-gate) so the prompt lands in a
    // natural moment rather than over the consent screen.
    if (armedRef.current) void requestMic();

    // The armed flip (Begin → 'ready') does NOT re-run this effect (armed is
    // ref-only by design — re-running would tear down the pose subscription
    // and audio graph on every status flap). Expose the trigger through a
    // ref so the armed effect below can kick the mic request.
    kickMicRef.current = () => void requestMic();

    return () => {
      disposed = true;
      poseUnsubscribe?.();
      if (audioInterval) clearInterval(audioInterval);
      if (audioCtx) void audioCtx.close().catch(() => {});
      const mic = micStreamRef.current;
      micStreamRef.current = null;
      if (mic) for (const t of mic.getTracks()) t.stop();
    };
    // Re-runs when a NEW tracker instance boots (subscription swap); the
    // StrictMode double-mount costs one extra mic prompt in dev only.
  }, [enabled, tracker]);

  return { micStreamRef };
}
