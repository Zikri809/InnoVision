export type BotState =
  | "idle"
  | "thinking"
  | "scanning"
  | "success"
  | "fail"
  | "celebrate"
  | "paused"
  | "warn";

export const BOT_STATES: BotState[] = [
  "idle",
  "thinking",
  "scanning",
  "success",
  "fail",
  "celebrate",
  "paused",
  "warn",
];

export const BOT_MORPH_SEC = 0.52;

const TAU = Math.PI * 2;
const SAMPLES = 48;

type DecorKind = "none" | "ring" | "orbit" | "burst" | "burstLoop";

interface Params {
  sx: number;
  sy: number;
  tilt: number;
  rotAmp: number;
  rotHz: number;
  wobbleAmp: number;
  wobbleFreq: number;
  wobbleSpeed: number;
  breatheAmp: number;
  breatheHz: number;
  bounceAmp: number;
  bounceHz: number;
  cyOff: number;
  spikeAmp: number;
  spikeFreq: number;
  spikeHz: number;
  eyeSep: number;
  eyeCy: number;
  eyeRx: number;
  eyeRy: number;
  expr: BotExpr;
  decor: DecorKind;
}

export type BotExpr = "open" | "happy";

const STATE_PARAMS: Record<BotState, Params> = {
  idle: {
    sx: 1,
    sy: 1,
    tilt: 0,
    rotAmp: 0,
    rotHz: 0,
    wobbleAmp: 0.02,
    wobbleFreq: 5,
    wobbleSpeed: 0.11,
    breatheAmp: 0.016,
    breatheHz: 0.18,
    bounceAmp: 0,
    bounceHz: 0,
    cyOff: 0,
    spikeAmp: 0,
    spikeFreq: 0,
    spikeHz: 0,
    eyeSep: 0.34,
    eyeCy: -0.16,
    eyeRx: 0.105,
    eyeRy: 0.15,
    expr: "open",
    decor: "none",
  },
  thinking: {
    sx: 0.97,
    sy: 1.05,
    tilt: 0.05,
    rotAmp: 0.045,
    rotHz: 0.28,
    wobbleAmp: 0.045,
    wobbleFreq: 3,
    wobbleSpeed: 0.35,
    breatheAmp: 0.01,
    breatheHz: 0.22,
    bounceAmp: 0,
    bounceHz: 0,
    cyOff: -0.02,
    spikeAmp: 0,
    spikeFreq: 0,
    spikeHz: 0,
    eyeSep: 0.33,
    eyeCy: -0.2,
    eyeRx: 0.1,
    eyeRy: 0.145,
    expr: "open",
    decor: "orbit",
  },
  scanning: {
    sx: 1.06,
    sy: 0.96,
    tilt: 0,
    rotAmp: 0,
    rotHz: 0,
    wobbleAmp: 0.03,
    wobbleFreq: 6,
    wobbleSpeed: 0.8,
    breatheAmp: 0.012,
    breatheHz: 0.3,
    bounceAmp: 0,
    bounceHz: 0,
    cyOff: 0,
    spikeAmp: 0,
    spikeFreq: 0,
    spikeHz: 0,
    eyeSep: 0.36,
    eyeCy: -0.18,
    eyeRx: 0.105,
    eyeRy: 0.17,
    expr: "open",
    decor: "ring",
  },
  success: {
    sx: 1,
    sy: 1.07,
    tilt: 0,
    rotAmp: 0,
    rotHz: 0,
    wobbleAmp: 0.02,
    wobbleFreq: 4,
    wobbleSpeed: 0.2,
    breatheAmp: 0.014,
    breatheHz: 0.24,
    bounceAmp: 0,
    bounceHz: 0,
    cyOff: 0,
    spikeAmp: 0,
    spikeFreq: 0,
    spikeHz: 0,
    eyeSep: 0.34,
    eyeCy: -0.18,
    eyeRx: 0.115,
    eyeRy: 0.13,
    expr: "happy",
    decor: "burst",
  },
  fail: {
    sx: 1.02,
    sy: 0.93,
    tilt: 0,
    rotAmp: 0.03,
    rotHz: 0.22,
    wobbleAmp: 0.02,
    wobbleFreq: 2,
    wobbleSpeed: 0.15,
    breatheAmp: 0.012,
    breatheHz: 0.14,
    bounceAmp: 0,
    bounceHz: 0,
    cyOff: 0.07,
    spikeAmp: 0,
    spikeFreq: 0,
    spikeHz: 0,
    eyeSep: 0.32,
    eyeCy: -0.08,
    eyeRx: 0.1,
    eyeRy: 0.11,
    expr: "open",
    decor: "none",
  },
  celebrate: {
    sx: 1,
    sy: 1,
    tilt: 0,
    rotAmp: 0.07,
    rotHz: 0.5,
    wobbleAmp: 0.03,
    wobbleFreq: 8,
    wobbleSpeed: 0.5,
    breatheAmp: 0.02,
    breatheHz: 0.4,
    bounceAmp: 0,
    bounceHz: 0,
    cyOff: -0.03,
    spikeAmp: 0.1,
    spikeFreq: 8,
    spikeHz: 1.1,
    eyeSep: 0.35,
    eyeCy: -0.19,
    eyeRx: 0.115,
    eyeRy: 0.125,
    expr: "happy",
    decor: "burstLoop",
  },
  paused: {
    sx: 0.34,
    sy: 0.34,
    tilt: 0,
    rotAmp: 0,
    rotHz: 0,
    wobbleAmp: 0.02,
    wobbleFreq: 3,
    wobbleSpeed: 0.12,
    breatheAmp: 0.02,
    breatheHz: 0.35,
    bounceAmp: 0.13,
    bounceHz: 1.6,
    cyOff: 0.16,
    spikeAmp: 0,
    spikeFreq: 0,
    spikeHz: 0,
    eyeSep: 0.105,
    eyeCy: -0.05,
    eyeRx: 0.085,
    eyeRy: 0.02,
    expr: "open",
    decor: "none",
  },
  warn: {
    sx: 1.05,
    sy: 0.97,
    tilt: 0,
    rotAmp: 0.018,
    rotHz: 2.4,
    wobbleAmp: 0.03,
    wobbleFreq: 6,
    wobbleSpeed: 0.9,
    breatheAmp: 0.01,
    breatheHz: 0.5,
    bounceAmp: 0,
    bounceHz: 0,
    cyOff: 0,
    spikeAmp: 0,
    spikeFreq: 0,
    spikeHz: 0,
    eyeSep: 0.37,
    eyeCy: -0.15,
    eyeRx: 0.125,
    eyeRy: 0.23,
    expr: "open",
    decor: "none",
  },
};

const NUMERIC_KEYS = [
  "sx",
  "sy",
  "tilt",
  "rotAmp",
  "rotHz",
  "wobbleAmp",
  "wobbleFreq",
  "wobbleSpeed",
  "breatheAmp",
  "breatheHz",
  "bounceAmp",
  "bounceHz",
  "cyOff",
  "spikeAmp",
  "spikeFreq",
  "spikeHz",
  "eyeSep",
  "eyeCy",
  "eyeRx",
  "eyeRy",
] as const;

export interface BotVec {
  x: number;
  y: number;
}

export interface BotEyeFrame {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  expr: BotExpr;
}

export interface BotRingFrame {
  r: number;
  alpha: number;
}

export interface BotDot {
  x: number;
  y: number;
  r: number;
  alpha: number;
}

export interface BotFrame {
  points: BotVec[];
  leftEye: BotEyeFrame;
  rightEye: BotEyeFrame;
  ring: BotRingFrame | null;
  dots: BotDot[];
}

export interface BotMachine {
  current: BotState;
  prev: BotState | null;
  switchAt: number;
}

export function settledMachine(state: BotState): BotMachine {
  return { current: state, prev: null, switchAt: 0 };
}

function clamp01(x: number): number {
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

function easeOutExpo(x: number): number {
  return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
}

function easeOutCubic(x: number): number {
  const u = 1 - x;
  return 1 - u * u * u;
}

function blinkMul(t: number): number {
  const period = 3.6;
  const dur = 0.15;
  const ph = t % period;
  if (ph >= dur) return 1;
  const s = Math.sin((ph / dur) * Math.PI);
  return 1 - 0.92 * s;
}

function gazeFor(state: BotState, t: number): BotVec {
  switch (state) {
    case "idle":
      return { x: 0.03 * Math.sin(t * 0.53), y: 0.02 * Math.sin(t * 0.71 + 1.3) };
    case "thinking":
      return { x: 0.07 * Math.sin(t * 0.8), y: -0.09 + 0.03 * Math.sin(t * 1.1) };
    case "scanning":
      return {
        x: 0.1 * Math.sin(t * 6) * Math.sin(t * 0.9),
        y: 0.02 * Math.sin(t * 4.2),
      };
    case "fail":
      return { x: 0, y: 0.05 };
    case "warn":
      return { x: 0, y: -0.04 };
    default:
      return { x: 0, y: 0 };
  }
}

function emitDecor(
  kind: DecorKind,
  t: number,
  switchAt: number,
  hop: number,
): { ring: BotRingFrame | null; dots: BotDot[] } {
  if (kind === "ring") {
    const u = (t % 1.15) / 1.15;
    return { ring: { r: 0.55 + 0.9 * u, alpha: (1 - u) * 0.5 }, dots: [] };
  }
  if (kind === "orbit") {
    const period = 1.7;
    const base = -Math.PI / 2 + TAU * ((t % period) / period);
    const dots: BotDot[] = [
      {
        x: Math.cos(base) * 1.22,
        y: Math.sin(base) * 1.06,
        r: 0.06,
        alpha: 0.85,
      },
      {
        x: Math.cos(base - 0.6) * 1.22,
        y: Math.sin(base - 0.6) * 1.06,
        r: 0.04,
        alpha: 0.5,
      },
    ];
    return { ring: null, dots };
  }

  const makeBurst = (u: number, seed: number, scale: number, fade: number): BotDot[] => {
    if (u >= 1 || u < 0) return [];
    const e = easeOutCubic(u);
    const rad = 0.6 + 0.95 * e;
    const n = 10;
    const dots: BotDot[] = [];
    for (let i = 0; i < n; i++) {
      const ang = (i * TAU) / n + seed;
      dots.push({
        x: Math.cos(ang) * rad,
        y: Math.sin(ang) * rad + hop,
        r: 0.055 * (1 - u * 0.5) * scale,
        alpha: (1 - u) * 0.9 * fade,
      });
    }
    return dots;
  };

  if (kind === "burst") {
    const u = clamp01((t - switchAt) / 0.95);
    return { ring: null, dots: makeBurst(u, switchAt, 1, 1) };
  }
  if (kind === "burstLoop") {
    const period = 1.5;
    const u = (t % period) / period;
    const u2 = (((t + period / 2) % period) / period);
    return {
      ring: null,
      dots: [...makeBurst(u, 0.31, 1, 1), ...makeBurst(u2, 0.63, 0.7, 0.5)],
    };
  }
  return { ring: null, dots: [] };
}

export function sampleBot(
  t: number,
  m: BotMachine,
  gazeOverride?: BotVec,
  eyeSepScale = 1,
  eyeSizeScale = 1,
  wobbleScale = 1,
): BotFrame {
  const from = m.prev ?? m.current;
  const u = m.prev === null ? 1 : clamp01((t - m.switchAt) / BOT_MORPH_SEC);
  const k = m.prev === null ? 1 : easeOutExpo(u);
  const a = STATE_PARAMS[from];
  const b = STATE_PARAMS[m.current];
  const pickCurrent = m.prev !== null && u >= 0.5;
  const exprSource = pickCurrent ? b : a;
  const decorSource = pickCurrent ? b.decor : a.decor;

  const p: Record<(typeof NUMERIC_KEYS)[number], number> = {} as never;
  for (const key of NUMERIC_KEYS) {
    p[key] = k >= 1 ? b[key] : lerp(a[key], b[key], k);
  }

  const ts = t - m.switchAt;
  let squashX = 1;
  let squashY = 1;
  let hop = 0;
  if (m.current === "success" && m.prev !== null && ts >= 0) {
    const env = Math.exp(-4.5 * ts);
    const sq = Math.sin(ts * 13);
    squashY = 1 - 0.16 * env * sq;
    squashX = 1 + 0.16 * env * sq;
    hop = -0.14 * env * Math.max(0, Math.sin(ts * 9));
  }

  const breathe = 1 + p.breatheAmp * Math.sin(TAU * p.breatheHz * t);
  const bounce = p.bounceAmp * Math.sin(TAU * p.bounceHz * t);
  const lift = p.cyOff + hop + bounce;
  const sx = 1 + (p.sx - 1) * wobbleScale;
  const sy = 1 + (p.sy - 1) * wobbleScale;
  const rot = p.tilt + p.rotAmp * Math.sin(TAU * p.rotHz * t);
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  const spikeNow =
    p.spikeAmp > 0
      ? p.spikeAmp * wobbleScale * (0.55 + 0.45 * Math.sin(TAU * p.spikeHz * t))
      : 0;

  const points: BotVec[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const ang = (i / SAMPLES) * TAU;
    let r =
      1 +
      p.wobbleAmp * wobbleScale * Math.sin(p.wobbleFreq * ang + TAU * p.wobbleSpeed * t);
    if (spikeNow > 0) {
      r *= 1 + spikeNow * Math.cos(p.spikeFreq * ang);
    }
    const x0 = Math.cos(ang) * r * sx * squashX * breathe;
    const y0 =
      Math.sin(ang) * r * sy * squashY * breathe + lift;
    points.push({ x: x0 * cosR - y0 * sinR, y: x0 * sinR + y0 * cosR });
  }

  const gaze = gazeOverride ?? gazeFor(m.current, t);
  const bl = exprSource.expr === "open" ? blinkMul(t) : 1;
  const mkEye = (side: -1 | 1): BotEyeFrame => ({
    cx: side * p.eyeSep * eyeSepScale + gaze.x,
    cy: p.eyeCy + gaze.y + hop + bounce,
    rx: p.eyeRx * eyeSizeScale,
    ry: p.eyeRy * bl * eyeSizeScale,
    expr: exprSource.expr,
  });

  const decor = emitDecor(decorSource, t, m.switchAt, hop);

  return {
    points,
    leftEye: mkEye(-1),
    rightEye: mkEye(1),
    ring: decor.ring,
    dots: decor.dots,
  };
}
