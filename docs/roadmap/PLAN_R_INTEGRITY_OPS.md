# Roadmap Plan — Integrity Operations & Platform Hygiene

> **Status:** PLANNED (roadmap) — see `docs/roadmap/README.md` for the mandatory
> pre-implementation workflow. Items here are NOT current spec.
>
> Domain: operational side of the proctoring pipeline — remediation loops,
> retention automation, cost guardrails. Builds on PLAN_INTEGRITY_SUITE.md
> (face verify RPCs, incident clips ring-buffer uploads), PLAN_PHASE8
> (reset/exempt/unlock audits), notifications (0022), COSTS.md.

---

## IO-1 · Flagged-session student comms (HIGH, small — highest QoL-per-line in roadmap)

> **Pre-flight reconciled 2026-08-29 @ 99a06a3 (corrected by review):** RPC
> `unlock_session` — LIVE baseline is **0021_integrity_audit_fixes.sql:126**
> (R2), NOT 0009:609 (0021 superseded it with the paused-time crediting branch
> `started_at += clock_timestamp() - paused_at` + `paused_at = null` +
> `focus_pause_count = 0` reset — the timer-honesty behavior the plan's point
> (d) credits). Migration **0033** therefore rebases on 0021 and adds ONLY the
> notification insert; the initial draft's 0009-based rewrite was caught by
> review and fixed before commit. Flagged poll 8s confirmed
> (use-face-pipeline.ts:206, poll GETs `/api/sessions/[id]`); notification
> machinery 0022 (enum whitelist, dedupe
> `unique nulls not distinct (recipient_id, dedupe_key)`, typed client maps
> `src/lib/notifications/{types,copy,link}.ts` + U3 i18n-coverage test that
> auto-enforces copy for every enum value). CHANGES/REFINEMENTS: (a) migration
> **0033**: `ALTER TYPE notification_type ADD VALUE 'session_unlocked'` +
> `create or replace unlock_session` inserting the notification
> (recipient = session's student; payload `{session_id, quiz_id, quiz_title}`;
> dedupe `session_unlocked:<session_id>:<rotated nonce>` — nonce is fresh per
> unlock, so each flag→unlock cycle notifies once while accidental double-fire
> stays idempotent); follow 0022 house rules (on-conflict do nothing, no
> auth.uid() in recipient), with ONE documented deviation: a narrowed-then-
> catch-all exception handler around the best-effort insert (raise warning,
> never fails the unlock — the poll is the consistency backbone); (b) client:
> add `session_unlocked` to
> NOTIFICATION_TYPES + PINNED_TYPES + NOTIF_COPY + icon map; link resolution
> deep-links `/play/<session_id>` with a NEW `probe.quiz_sessions` branch
> (existing probe machinery is quizzes-only — extend `ResolvedLink.probe` to a
> union; bell's probe effect gains the quiz_sessions select; RLS own-sessions
> makes it self-scoping); (c) flagged wait ticker: transition-detected in
> face-verifier.tsx (flagged overlay at :133–150) — a ref records when status
> flips into `flagged` from anything else; minute ticker renders visually-only
> (aria-live off), no pipeline changes needed; (d) timer honesty: paused-time
> crediting lives in the 0021 unlock branch and is preserved by 0033 — e16
> unaffected.

**Problem:** Flagged = opaque indefinite waiting: manual "Check Again" polling
8s (`use-face-pipeline.ts startFlaggedPoll`), zero notification when unlocked,
elapsed-wait invisible.

**Design sketch**
- Unlock notification: extend the session-unlock RPC path to enqueue
  `session_unlocked` notification to the affected student (dedupe_key carries
  session id + unlock ordinal). Bell renders type-specific copy; deep link
  probes back into `/play/[sessionId]` (existing probe mechanism in
  notification-bell.tsx resolution map — add payload branch).
- Wait-time affordance on flagged overlay: elapsed-since-flaged minute ticker
  + copy setting expectation (alertdialog is focus-trapped; ticker text
  updates aria-live=off visually only — non-intrusive).
- Timer honesty: paused-time crediting EXISTS server-side (unlock credits
  paused time back) — after resume, remaining time reflects credit; no extra
  work needed, just verify E2E e16 unaffected.

**Tests:** route/RPC test emitting notification row, bell render branch,
E2E flagged→unlock→notification→return journey.

---

## IO-2 · Incident clip scheduling/retention automation (MEDIUM, ops)

**Problem:** `npm run incident:cleanup` script exists but nothing schedules
it (README admits "no scheduler wired"); biometric-adjacent video accumulates
silently against the 1GB COSTS assumption; consent-copy retention promises
unfalsifiable without automation.

**Design sketch**
- Wire pg_cron (0019 anticipated pattern; best-effort caveat documented there)
  OR hosted-cron hitting a guarded cleanup endpoint — decide at pre-flight
  based on deployment reality (self-hosted supabase local dev vs hosted).
- Retention window parameterized (default 30d matching script constant).
- Add last-run observability: cheap `audit_events` write or cron-log check
  script, surfaced nowhere fancy.
- While here: media-cleanup orphan sweeper gains same treatment.

---

## IO-3 · Enrollment approve path + CompreFace hygiene for holds (MEDIUM-HIGH; review UI partner = CM-2)

**Problem:** pending_review has reject-RPC only; approving = developer shells
into CompreFace + DB.

**Design sketch**
- Definer RPC `resolve_face_enrollment(student_id, verdict)`:
  - `reject` wraps existing reject_face_enrollment behavior (clears status,
    allows re-enrollment, audited).
  - `approve_overrides_duplicate`: clears hold + writes flag allowing NEXT
    enrollment attempt to bypass dup-subject refusal ONE TIME (safer than
    fabricating samples server-side); alternatively re-enroll directly if
    frames supplied. Decide mechanism at pre-flight — requires inspecting
    duplicate-refusal implementation in `api/face/enroll/route.ts` steps
    2–4 (dup scan threshold 0.45 documented ARCHITECTURE §7.6).
- Audited both ways; complements CM-2's UI card (that doc owns placement).

---

## IO-4 · Durable AI quotas for lecturers (MEDIUM growing with deployment)

**Problem:** Student generate-route pairs in-memory 5/h PLUS durable daily DB
counter (`ai_generation_usage`, service-role-only); lecturer generate route
has ONLY in-memory cap (restart/multi-instance weak per docs). Unbounded spend
risk per lecturer.

**Design sketch**
- Extend `ai_generation_usage` pattern: counter keyed (user_id, day, scope=
  'lecturer_generation'); pre-flight budget constant; friendly-quota error
  mapped like existing 429s (distinct i18n copy naming daily limit).
- Surface remaining-quota in GenerateFromFileDialog footer (cheap trust win).

**Tests:** route test crossing boundary; harness probe on counter upsert
atomicity (upsert increment race — follow student-counter SQL verbatim).

---

## IO-5 · Reset no longer destroys integrity evidence (MED)

**Problem:** `reset_session` cascades answers AND face_checks away; original
footage linkage survives only via thin audit row; lecturers granting retakes
after false flags lose the very evidence that justified them.

**Design sketch**
- Soft-archive: before cascade delete in reset RPC, copy face_check summary
  rows (+advisories metadata) into `archived_session_evidence` keyed by voided
  session uuid (storage paths on incident_clips rows are NOT deleted today —
  VERIFY at pre-flight whether reset touches clips at all; likely untouched →
  preserve linkage rows likewise).
- Lecturer timeline: expandable "prior attempt evidence" section reading
  archive (read-only; no reveal-gating concerns — lecturer-scoped).
- Migration NNNN + RPC surgery confined to reset path; no student-visible
  change.

**Tests:** harness probe: post-reset archive rows exist + originals purged;
timeline render test.

---

## IO-6 · Vision payload diet (MEDIUM — engineering hygiene with big perceived-speed payoff)

**Problem:** ~23 MB shipped vision assets (hand 7.6MB task + face 3.7MB task +
11.5MB wasm + apparently-redundant duplicate `-module_internal` wasm 11.5MB +
nosimd variants 10.7MB) against BOOT_TIMEOUT_MS=10000 (gestures)/20000 (face)
— school Wi-Fi silently degrades gestures off.

**Design sketch**
- Audit actual MediaPipe fileset resolution to confirm which wasm variants
  are loadable; DELETE provably-unused duplicates (vendor script
  `scripts/vendor-mediapipe.mjs` regeneration rules updated in same change).
- Long-cache headers for `/models/*` and `/mediapipe/*` (immutable content) —
  cross-session caching is the single biggest effective win.
- Dashboard-idle preload `<link rel="prefetch">` ahead of quiz-open.
- Boot progress affordance replaces black-frame wait (gesture-layer idle
  state): indeterminate spinner + localized "loading vision engine".

**Tests:** vendor-script unit; headers assertion in e2e/probe; manual perf
validation note.

---

## IO-7 · Online/offline resilience banner (SMALL — overlaps STUDENT_QOL SQ-10 last bullet)

Coordination note: implementation lands wherever SQ-10 batches it; recorded
here only for domain completeness. No separate design.

---

## Pre-flight log

<!-- Required before ANY item above is implemented. See roadmap README Step 1. -->

- 2026-08-29: IO-1 reconciled against 99a06a3; migration will be **0033**
  (enum add-value + unlock_session rewrite; no table changes); noted
  notifications client maps are enum-exhaustive (types.ts/copy.ts/link.ts +
  U3 test) so the new type must touch all four; probe union extension needed
  for quiz_sessions deep links; IO-2..IO-7 remain unverified (not in this
  batch).

## Implementation log

<!-- Filled at move-out per roadmap README Step 3. -->
