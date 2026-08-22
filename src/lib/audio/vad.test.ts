import { describe, it, expect } from "vitest";
import { VoiceActivityMonitor, looksLikeHeadsetInput } from "./vad";

describe("VoiceActivityMonitor", () => {
  it("stays quiet below the speech threshold", () => {
    const m = new VoiceActivityMonitor();
    for (let t = 0; t < 60000; t += 250) {
      expect(m.feed(0.01, t)).toEqual([]);
    }
  });

  it("fires after sustained speech-level audio accumulates in the window", () => {
    const m = new VoiceActivityMonitor();
    let firedAt: number | null = null;
    for (let t = 0; t <= 30000; t += 250) {
      const events = m.feed(t < 5000 ? 0.2 : 0.0, t);
      if (events.length > 0) {
        firedAt = t;
        break;
      }
    }
    // 2s of continuous speech → fires at the sample crossing the threshold.
    expect(firedAt).toBe(2000);
  });

  it("scattered short bursts never accumulate to the threshold", () => {
    const m = new VoiceActivityMonitor();
    for (let t = 0; t <= 120000; t += 250) {
      // One loud sample every 5s — each burst decays before accumulating.
      const events = m.feed(t % 5000 === 0 ? 0.3 : 0.0, t);
      expect(events).toEqual([]);
    }
  });

  it("re-arms after firing (needs fresh accumulation)", () => {
    const m = new VoiceActivityMonitor();
    const fired: number[] = [];
    for (let t = 0; t <= 10000; t += 250) {
      if (m.feed(t < 3000 ? 0.25 : 0.0, t).length > 0) fired.push(t);
    }
    expect(fired).toEqual([2000]);
  });
});

describe("looksLikeHeadsetInput", () => {
  it("matches common BT/wired headset labels", () => {
    expect(looksLikeHeadsetInput("AirPods Pro")).toBe(true);
    expect(looksLikeHeadsetInput("Headset (Realtek Audio)")).toBe(true);
    expect(looksLikeHeadsetInput("Bluetooth Hands-Free Audio")).toBe(true);
    expect(looksLikeHeadsetInput("Wireless Headphones")).toBe(true);
    expect(looksLikeHeadsetInput("Microphone (USB PnP)")).toBe(false);
    expect(looksLikeHeadsetInput("Stereo Mix (Realtek)")).toBe(false);
  });

  it("never matches an empty label (permission not granted)", () => {
    expect(looksLikeHeadsetInput("")).toBe(false);
  });
});
