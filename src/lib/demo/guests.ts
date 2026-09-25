import "server-only";

import { randomBytes, randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  DEMO_JOIN_CODE,
  DEMO_GUEST_EMAIL_DOMAIN,
  isGuestEmail,
} from "@/lib/demo/gate";

export { DEMO_GUEST_EMAIL_DOMAIN, isGuestEmail };

/**
 * Demo-mode guest provisioning (docs/plans/PLAN_DEMO_MODE.md, D2/D5/D6).
 *
 * Server-only: every export here uses the service-role client, so it must never
 * be imported into a client component. The POST /api/demo/guest route is the
 * only caller in the request path; scripts/demo-reset and tests reuse the
 * helpers via their own service-role client.
 *
 * INVARIANTS this module owns:
 *  - Guest email domain is `demo.innovision.test` (the reset script's selector).
 *  - Guest matric is drawn from the `98xxxx` range. `99xxxx` is REFUSED by both
 *    the `handle_new_user` trigger (0050:105) and the
 *    `profiles_matric_no_not_reserved` CHECK (0046:1118), and a NULL matric
 *    wedges the guest behind /matric-capture and makes join_class refuse with
 *    `matric_required` (0046:92). `98xxxx` passes `^[0-9]{6}$` and `!~ '^99'`
 *    in both places.
 *  - Allocation is RANDOM + retry on 23505. A max-scan would race under a
 *    concurrent visitor burst (the unique index is enforced inside the trigger,
 *    so the second insert RAISES and the whole createUser aborts).
 */

/** Matric range reserved for demo guests: 980000–989999. */
const GUEST_MATRIC_MIN = 980_000;
const GUEST_MATRIC_MAX = 989_999;

/** Guest #N label cap — matches the profile full_name CHECK (120 chars). */
const GUEST_NAME_MAX = 120;

export interface GuestIdentity {
  email: string;
  password: string;
  matric: string;
}

export interface ProvisionedGuest {
  id: string;
  email: string;
  /** The generated password, used immediately to establish the SSR session. */
  password: string;
  fullName: string;
  matric: string;
}

/** A random 6-digit matric inside the 98xxxx guest range. */
export function randomGuestMatric(): string {
  return String(randomInt(GUEST_MATRIC_MIN, GUEST_MATRIC_MAX + 1));
}

/** A random 24-char password (never shown; the route signs in immediately). */
export function randomGuestPassword(): string {
  return randomBytes(18).toString("base64url");
}

/** A random, collision-resistant guest email local-part. */
export function randomGuestEmailLocalPart(): string {
  return `guest-${randomBytes(4).toString("hex")}`;
}

/**
 * Human label for the roster ("Guest #N (Visitor)"). N comes from the existing
 * guest count, which is approximate by design — it is a display label, not an
 * identity. Clamped to the profile CHECK bound.
 */
export function guestDisplayName(guestNumber: number): string {
  const name = `Guest #${guestNumber} (Visitor)`;
  return name.length > GUEST_NAME_MAX ? name.slice(0, GUEST_NAME_MAX) : name;
}

/**
 * Authoritative guest-account count for the CAP (not the display label): a
 * `head: true` COUNT on profiles' `98xxxx` matric range, which only guests use.
 * Cheap (no rows transferred) and accurate regardless of total user count —
 * unlike the bounded listUsers scan, which under-counts past 1000 users.
 */
export async function countGuestAccounts(
  admin: SupabaseClient<Database> = createAdminClient(),
): Promise<number> {
  const { count, error } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .gte("matric_no", "980000")
    .lte("matric_no", "989999");
  if (error) return 0;
  return count ?? 0;
}

/**
 * Count existing guest accounts (email LIKE `guest-%@demo.innovision.test`) to
 * derive the next roster label. Best-effort: a failure degrades the label, not
 * provisioning.
 */
export async function countExistingGuests(
  admin: SupabaseClient<Database> = createAdminClient(),
  maxPages = 2,
): Promise<number> {
  // listUsers has no server-side email filter. BOUNDED pagination keeps this
  // off the hot path's critical cost — the booth cap is 200 guests, so a couple
  // of pages (1000 users) is ample; an attacker cannot make the route scan the
  // whole user table. The count is approximate by design (a display label).
  let count = 0;
  for (let page = 1; page <= maxPages; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 500, page });
    if (error) return count;
    const users = data?.users ?? [];
    if (users.length === 0) break;
    count += users.filter((u) => u.email?.endsWith(`@${DEMO_GUEST_EMAIL_DOMAIN}`)).length;
    if (users.length < 500) break;
  }
  return count;
}

/**
 * Create one guest auth user with the signup trigger doing the profile work.
 * Retries on a matric unique-violation (23505) with a fresh matric AND email.
 *
 * Returns the created user. Throws on any other error (the route maps it to a
 * 503 — never a 500 with a raw message).
 */
export async function createGuestUser(
  admin: SupabaseClient<Database> = createAdminClient(),
  opts?: { guestNumber?: number },
): Promise<ProvisionedGuest> {
  const guestNumber = opts?.guestNumber ?? (await countExistingGuests(admin)) + 1;
  const fullName = guestDisplayName(guestNumber);

  // Up to 5 attempts. A collision is astronomically unlikely on a 10k-value
  // space, BUT a raw admin createUser collision surfaces as a GoTrue error
  // whose message may not contain "23505"/"matric_no_unique" (GoTrue wraps the
  // trigger failure), so ALSO retry once on any hard failure — losing a
  // 1-in-10k race must not hand a visitor a 503. Only the last attempt rethrows.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const email = `${randomGuestEmailLocalPart()}@${DEMO_GUEST_EMAIL_DOMAIN}`;
    const password = randomGuestPassword();
    const matric = randomGuestMatric();

    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, matric_no: matric },
    });

    if (!error && data?.user) {
      return { id: data.user.id, email, password, fullName, matric };
    }

    lastError = error;
    // A recognized unique violation is definitely retryable; any other failure
    // gets exactly one more attempt (attempt 0 → 1) in case it is an
    // unrecognized collision shape, then throws.
    if (!isUniqueViolation(error) && attempt >= 1) break;
  }

  throw lastError ?? new Error("guest provisioning failed");
}

/** Detect a Postgres unique-violation (matric or email) across error shapes. */
export function isUniqueViolation(error: unknown): boolean {
  if (!error) return false;
  const message = String((error as { message?: unknown }).message ?? error);
  const code = (error as { code?: unknown }).code;
  return code === "23505" || /duplicate key|matric_no_unique|already been registered|23505/i.test(message);
}

export interface GuestJoinResult {
  ok: boolean;
  /** Typed RPC error when ok=false (never a raw DB error). */
  error?: string;
}

/**
 * Enroll a guest into the demo class via the real `join_class` RPC, called with
 * the guest's own session (so `class_join_attempts` semantics are exercised and
 * RLS applies). `already_enrolled` is treated as success (idempotent re-runs).
 */
export async function joinDemoClass(
  userClient: SupabaseClient<Database>,
  joinCode: string = DEMO_JOIN_CODE,
): Promise<GuestJoinResult> {
  const { data, error } = await userClient.rpc("join_class", { code: joinCode });
  if (error) {
    // RPC transport/DB outage — surface as a typed failure, never a raw message.
    return { ok: false, error: "join_unavailable" };
  }
  const result = data as
    | { class: { id: string; title: string } }
    | { error: string }
    | null;
  if (!result || typeof result !== "object") {
    return { ok: false, error: "join_unavailable" };
  }
  if ("class" in result && result.class) return { ok: true };
  if ("error" in result && result.error === "already_enrolled") return { ok: true };
  return { ok: false, error: "error" in result ? result.error : "join_failed" };
}
