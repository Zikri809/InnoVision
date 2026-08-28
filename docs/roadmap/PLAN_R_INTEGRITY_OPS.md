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

- (none yet)

## Implementation log

<!-- Filled at move-out per roadmap README Step 3. -->
