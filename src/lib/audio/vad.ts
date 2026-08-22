/**
 * Pure voice-activity monitor for the `voice_activity` advisory.
 *
 * Consumes RMS levels sampled from an AnalyserNode (the hook owns the mic +
 * audio graph) and fires when speech-level audio accumulates
 * VOICE_ACTIVITY_ACCUMULATE_MS inside a rolling VOICE_ACTIVITY_WINDOW_MS.
 *
 * DELIBERATELY NOT A BLOCKER: households are noisy — a door, a TV, a sibling
 * asking about dinner. This is a lecturer-review hint with timestamps, never
 * a status change.
 *
 * PURE and injectable-clock (`nowMs` per feed) — Node-unit-tested.
 */

import {
  VOICE_ACTIVITY_ACCUMULATE_MS,
  VOICE_ACTIVITY_WINDOW_MS,
  VOICE_RMS_THRESHOLD,
} from "@/lib/face/constants";

export type VoiceEvent = { type: "voice_activity"; atMs: number };

/** Max gap between samples before accumulation resets (ms). */
const SAMPLE_GAP_RESET_MS = 5000;

export class VoiceActivityMonitor {
  // Speech EPISODES — endMs advances only across CONSECUTIVE loud samples,
  // so isolated noise bursts never bridge into sustained-speech time.
  private episodes: { startMs: number; endMs: number }[] = [];
  private lastSampleMs: number | null = null;
  private prevSampleLoud = false;

  /**
   * Feed one RMS sample. Returns the `voice_activity` event when the
   * accumulation threshold crosses on THIS sample (caller throttles).
   */
  feed(rms: number, nowMs: number): VoiceEvent[] {
    if (this.lastSampleMs !== null && nowMs - this.lastSampleMs > SAMPLE_GAP_RESET_MS) {
      this.episodes = [];
      this.prevSampleLoud = false;
    }
    this.lastSampleMs = nowMs;

    const loud = rms >= VOICE_RMS_THRESHOLD;
    if (loud) {
      const last = this.episodes[this.episodes.length - 1];
      if (last && this.prevSampleLoud) {
        last.endMs = nowMs;
      } else {
        this.episodes.push({ startMs: nowMs, endMs: nowMs });
      }
    }
    this.prevSampleLoud = loud;

    // Prune outside the rolling window.
    this.episodes = this.episodes.filter((s) => nowMs - s.startMs <= VOICE_ACTIVITY_WINDOW_MS);
    let accumulated = 0;
    for (const s of this.episodes) {
      accumulated += Math.max(0, s.endMs - s.startMs);
    }
    if (accumulated >= VOICE_ACTIVITY_ACCUMULATE_MS) {
      this.episodes = [];
      this.prevSampleLoud = false;
      return [{ type: "voice_activity", atMs: nowMs }];
    }
    return [];
  }

  reset(): void {
    this.episodes = [];
    this.prevSampleLoud = false;
    this.lastSampleMs = null;
  }
}

/**
 * Headset-as-input heuristic: true when the ACTIVE audio input label matches
 * a Bluetooth/wired headset pattern — a strong (advisory-only) hint that
 * wireless earbuds are in play. Labels require mic permission; an empty
 * label (permission not granted) is never a match.
 */
export function looksLikeHeadsetInput(label: string): boolean {
  if (!label) return false;
  return /bluetooth|airpod|earbud|headset|headphone|wireless|hands-?free/i.test(label);
}
