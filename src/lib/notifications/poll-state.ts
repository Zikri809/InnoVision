/**
 * Poll-cadence state machine (U2). Realtime is a latency accelerator;
 * polling is the consistency backbone — postgres_changes has no replay,
 * so any socket gap is healed by the next poll.
 */
export type ChannelHealth = "subscribed" | "unhealthy";

export type HealthEvent =
  | "subscribed"
  | "channel_error"
  | "channel_closed";

export const HEALTHY_POLL_MS = 60_000;
export const UNHEALTHY_POLL_MS = 20_000;

export function pollIntervalMs(health: ChannelHealth): number {
  return health === "subscribed" ? HEALTHY_POLL_MS : UNHEALTHY_POLL_MS;
}

export function nextHealth(
  _current: ChannelHealth,
  event: HealthEvent,
): ChannelHealth {
  switch (event) {
    case "subscribed":
      return "subscribed";
    case "channel_error":
    case "channel_closed":
      return "unhealthy";
  }
}

/**
 * Test seam (E-N4): the poll state machine reads an optional override global
 * installed by Playwright via addInitScript — same pattern as the repo's
 * fake-tracker seams in e2e/helpers.ts.
 */
export interface NotificationTestControl {
  pollMs?: number;
}

declare global {
  interface Window {
    __INNOVISION_NOTIF_CONTROL__?: NotificationTestControl;
  }
}

export function effectivePollMs(health: ChannelHealth): number {
  if (typeof window !== "undefined" && window.__INNOVISION_NOTIF_CONTROL__?.pollMs) {
    return window.__INNOVISION_NOTIF_CONTROL__.pollMs;
  }
  return pollIntervalMs(health);
}
