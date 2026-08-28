# Roadmap Plan — Class Management & Communication

> **Status:** PLANNED (roadmap) — see `docs/roadmap/README.md` for the mandatory
> pre-implementation workflow. Items here are NOT current spec.
>
> Domain: roster operations beyond display, teaching collaboration, and the
> lecturer→student broadcast channel. Builds on join/enrollment machinery
> (migration 0002-era RLS, archiving 0018), notifications infra (0022 triggers +
> bell island read path), roster reads (`lib/classes/roster.ts` which ALREADY
> returns matric_no — UI just drops it today, see CM-1 evidence).

---

## CM-1 · Roster operations: removal, matric display, CSV, join-code rotation (MEDIUM-HIGH)

**Problem:** Roster is display-only (`class-detail-client.tsx:544–558`): no
remove action ("no app endpoint performs lecturer-removal yet" —
PLAN_NOTIFICATIONS §3.5 despite `removed_from_class` notification type being
designed), matric fetched but never rendered (RosterEntry type omits it,
roster.ts supplies it), no roster export, static join codes.

**Design sketch**
- Removal: definer RPC `remove_student(class_id, student_id)` — ownership
  guard, refuses archiving-state races, cascades are REAL decisions: keep
  historical sessions (integrity record!) but mark enrollment deleted →
  drives existing welcome/removed notification ladder + future not-attempted
  group logic. Sessions stay visible in results dashboards flagged as removed?
  DECIDE: recommend results rows persist (they did sit the exam).
- Display matric next to name (data already flowing; RosterEntry widening).
- Roster CSV download via tiny route reusing roster query (join date optional).
- Rotation: `regenerate_join_code` definer RPC (collision-retry loop precedent
  exists in createClassWithRetry); optional — low priority within item.

**Tests:** RPC harness probes (removal preserves sessions+audit trail,
notifications fired, enrollment row state, re-join allowed afterwards?),
route/UI tests, E2E remove-and-rejoin journey.

---

## CM-2 · Face-enrollment hold review surface (HIGH — integrity-blocker owned here because UX surface is roster-adjacent; coordination note inside INTEGRITY_OPS plan IO-3)

**Problem:** `pending_review` students stuck indefinitely; notification points
to classes page where NO review UI exists; `reject_face_enrollment` RPC exists
(database.ts:1340) but no approve path, no UI either way. Resolution requires
developer intervention today.

**Design sketch (coordination contract with IO-3)** — THIS item owns the
lecturer-facing review CARD on class detail; IO owns the underlying
approve/re-enroll RPC design + CompreFace subject hygiene. Split the doc work
at pre-flight so migrations live in one place.

---

## CM-3 · Class announcements (MED-HIGH — explicitly deferred "v2" in PLAN_NOTIFICATIONS §0)

**Problem:** Only way lecturer reaches students = changing quiz state.
No "exam moved to Lab 3" channel.

**Design sketch**
- Reuse `notifications` table wholesale (payload jsonb already free-form):
  new type `'class_announcement'`; authoring = definer RPC inserting one
  notification PER enrolled student recipient (retention dedupe still applies)
  — compose UI minimal: title ≤80 + body ≤500 on class detail page; readable
  in existing bell island unchanged (payload-driven rendering may need one
  branch in resolve/render map).
- NOT a comment thread system; one-way broadcast only.
- Dedupe key includes lecturer-supplied nonce/timestamp (allow repeat
  announcements same content intentionally).
- Cap broadcasts/hour/class via rate-limit standard preamble.

**Tests:** RPC ownership probes, bell render regression, i18n keys,
E2E send-and-receive journey.

---

## CM-4 · Co-teaching / TA access (LOW-MED, largest in domain — schedule last)

**Problem:** Every guard hardcodes `.eq("lecturer_id", user.id)` pattern; TAs
cannot see anything despite practical need during exams.

**Design sketch**
- `class_collaborators (class_id, profile_id, role='ta', added_by)` — RLS +
  helper SQL function `is_class_staff(class_id)` used BY guards (both policy
  side and definer RPCs) so 404-semantics remain uniform.
- TA permissions v1: READ-ONLY everything lecturer sees EXCEPT privacy-red
  zones decide at pre-flight: signed incident URLs? (recommend deny v1),
  unlock/exempt/reset actions (recommend allow, audited as themselves —
  audit_events actor_id already records distinct actors).
- Adding/removing collaborators = class-owner-only routes + audited.
- Blast radius honest estimate: EVERY requireClassOwner-style guard touchpoint
  inventoried in ARCHITECTURE §3 guards list — this is a sweeping-but-shallow
  refactor guarded by harness probes.

**Tests:** staff-vs-owner-vs-outsider matrix across every touched guard;
regression proves plain lecturers unaffected.

---

## Pre-flight log

<!-- Required before ANY item above is implemented. See roadmap README Step 1. -->

- (none yet)

## Implementation log

<!-- Filled at move-out per roadmap README Step 3. -->
