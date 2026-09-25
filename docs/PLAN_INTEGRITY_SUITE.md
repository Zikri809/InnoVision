# Integrity Suite — migration 0020 + 0021 (authoritative)

> **Last verified against migrations through 0067** (answer-face commit era).
> This document is the **current source of truth** for the face/integrity
> pipeline's verify semantics, focus-loss pause, advisories, and incident
> recording. It supersedes the contradicting parts of
> `PLAN_PHASE7.md`, `PLAN_PHASE7_COMPREFACE_MIGRATION.md`, and `HANDOFF.md`
> §3–§5 (those are kept as historical records).

## 1. Verify: 1:1-by-lookup + multi-frame majority voting

**One check = up to 3 frames → ONE `face_checks` row decided by strict
majority.** (The ANSWER-COMMIT path — migration 0067 — requires exactly
3/3 frames and 3 similarities; only the standalone verify route tolerates
the 1..3 omit-on-flake semantics.)

- The client captures a best-frame (centered, open eyes, ≤1.5s window) plus
  two quick secondary frames ~500 ms apart (`VERIFY_FRAMES_PER_CHECK = 3`).
  A failed secondary capture is OMITTED — majority runs over the frames
  actually submitted (capture flakiness is not a fail vote). Total capture
  failure POSTs the `[""]` sentinel → guaranteed fail row (unchanged
  integrity-conservative semantics).
- The verify route runs the InsightFace sidecar `/extract` per non-empty
  frame and compares the resulting 512-d embedding against the caller's OWN
  stored samples (`compare_face_baseline` — max cosine over the student's
  baseline, 1:1-by-baseline; no gallery search is callable by students; the
  CompreFace-era subject-registry wording below predates migration 0039).
  Any nonzero similarity is by construction a
  SELF-similarity: **a lookalike classmate ranking top-1 in the gallery can
  no longer fail the check.** The old top1−top2 margin rule
  (`FACE_MARGIN_MIN`) is DELETED — no SQL constant, no client mirror.
- `record_face_check(p_session_id, p_similarities real[], p_trigger,
  p_nonce, p_frames text[], p_proof text default null, p_poses jsonb
  default null)` (introduced 0020/0021; the `p_subject` parameter was
  DROPPED in the 0039/0047 era — the baseline compare is internal now;
  `p_proof` is the route-minted HMAC per 0045; `p_poses` is the per-frame
  pose/spoof trail per 0047; the redefined function in 0067 also persists
  `nonce` + `frame_poses` columns on every `face_checks` row):
  - verdict: `v_matched = v_hits * 2 > cardinality(p_similarities)` —
    the caller's OWN subject only (1:1 by baseline lookup upstream; no
    gallery search is callable by students) — where hits = count of
    `similarity ≥ 0.5` (SQL constant `FACE_SIMILARITY_MIN`);
  - `distance = 1 − max(similarity)` — the lecturer timeline shows the BEST
    frame's reading;
  - `frame_hash = sha256(concat(frames))` feeds the unchanged
    `suspected_replay` / `too_frequent` advisories;
  - validation: array length 1..3, equal `p_frames` cardinality,
    per-element range gate (NaN/±Inf rejected — `'NaN'::real > 1`),
    `array_ndims(...) = 1` (multidimensional JSON arrays cannot 500),
    per-frame ≤ 200k chars;
  - paused_at cleared on ANY transition to `flagged` (unlock must never
    convert flagged idle time into exam time).
- Threshold 0.5 (cosine against the stored pgvector baseline since 0039).
  Tune empirically with
  `npm run face:report` (reads real `face_checks` distributions, suggests
  the ROC elbow) — update BOTH mirrors (`src/lib/face/constants.ts` and the
  SQL constant) together.

### Client pacing

- 8 s floor between verify POSTs (latest-wins deferral timer) so fast
  Q-transitions + periodic + catch-up never spend the route's
  **60/min-per-user** budget into a bricking 429 (`VERIFY_RATE` in the
  verify route; `minClientVerifyGapMs` in `cadence.ts`, unit-pinned;
  the E2E fake seam relaxes it to the 2 s advisory mirror so fast-cadence
  specs keep their timing).
- SQL-side attempt throttle (defense in depth): `app_private.face_verify_attempts`
  allows **600 attempts per 10 min per session** (raised from 60 in the
  0045→0067 era), counted AFTER the nonce gate and BEFORE the proof check so
  a forgery loop pays even though it never inserts a `face_checks` row.
- A 429 maps to *stay `ready` + re-arm cadence* — a busy server is not an
  outage and must not brick proctoring. But a SUSTAINED streak of ≥4 429s
  (or 4 consecutive transport failures, `VERIFY_TRANSPORT_FAIL_LIMIT`)
  degrades the client to `unavailable` + arms the outage claim
  (`reportUnavailable`) — the silence-cron backstop: the limiter records NO
  `face_checks` rows while answers keep flowing, so the honest degradation
  must fire before the verify-silence cron flags on silence (the route
  stamps `face_verify_attempted_at`, so the claim stays corroborated).
- Bad lighting defers a check (bounded to 2 retries × 4 s, phase re-checked
  at fire time) instead of sending a doomed dark frame; the gate (`start`)
  always proceeds.

### 1b. Session ladder (what a check does to the session)

The FLAT last-5 window lives INSIDE `record_face_check` (server-authoritative;
`src/lib/face/streak.ts` is a JS mirror for unit tests only):

- **1 fail → `paused`** (blink-recoverable; input blocked, timer compensated).
- **≥3 fails within the last 5 checks (flat, passes never truncate) → `flagged`**
  (lecturer-only unlock; submits rejected while flagged).
- **A pass never flags the current check** and resets the streak, but does NOT
  launder standing fails (F,P,F,P,F ⇒ flagged).
- Triggers are the enum `start | question | periodic`. The standalone
  verify route carries only `'start'` (gate) and `'periodic'` (jittered
  30–45 s timer; tab-return catch-up and the flagged-poll/unavailable
  probes reuse `periodic`) — the client no longer POSTs a per-question
  verify. The `'question'` row is now produced by `commit_answer`
  (migration 0067) calling `record_face_check` atomically INSIDE the
  answer commit, so a fresh identity check gates every answer on
  gesture-enabled assessments.
- Advisory-only columns on `face_checks` — `suspected_replay` (identical
  concatenated-frame hash as the previous row) and `too_frequent` (<2 s since
  the previous row) — are written by the same RPC and are
  UNRELATED to the `session_advisories` table in §3. They still never flag on
  their own, BUT replay has a status consequence now (0045 P0-2): a MATCHED
  verdict whose frame hash equals BOTH previous rows' hashes (frozen-frame
  replay, 3× identical — impossible for honest captures, JPEG noise
  guarantees drift) lands as **`paused`**, not `active` (E2E mock marker
  frames and the nonce-retry resend pair are carved out).

## 2. Focus-loss pause

A **debounced (900 ms) window blur while the document stays visible**
(clicked into another app / an app on a second monitor — tab-hide remains
owned by `visibilitychange`) POSTs `/api/sessions/[id]/pause` with
`{reason:'focus_lost'}`:

- `pause_session(p_session_id, p_reason)` increments the cumulative
  `quiz_sessions.focus_pause_count`; the **3rd confirmed loss FLAGS the
  session** (audited as `auto_flag_focus_loss` WITH quiz/session attribution
  so it lands on the lecturer's integrity timeline).
- Recovery reuses blink recovery (clicking "Return to the exam" naturally
  refocuses the window); `unlock_session` resets `focus_pause_count`.
- Sub-threshold counts are lecturer-visible via `lecturer_session_view`
  ("Focus loss pauses" line on the results dashboard).
- Policy decisions (user-ratified): second monitors are ALLOWED and not
  enumerated; only focus matters. "No face" stays identical to "wrong face"
  (integrity-first, unchanged from Phase 7).

## 2b. Every other way a session pauses (and why focus is special)

| Source | Mechanism | Counter | Can flag? |
|---|---|---|---|
| **Face fail** (wrong face / no-face sentinel / rejected frame) | `record_face_check` fail row | `face_fail_streak` (last-5 window) + `face_fail_count` (lifetime, 0044 — never reset; the export column) | Yes (3-in-5) |
| **Focus loss** (debounced visible blur) | `pause_session(reason:'focus_lost')` | `focus_pause_count` (cumulative) | Yes (3rd strike) |
| **Fullscreen exit** (hardening, Feature C) | `pause_session(reason:'fullscreen_exit')` | `fullscreen_pause_count` (cumulative, 0043) | No — counted and lecturer-visible ("Fullscreen exit pauses" line + workbook column), but never auto-flags: Escape/window gestures are honest, so the escalation decision stays with the lecturer |
| **Hand loss** (hand absent >10 s in assessment) | `pause_session(reason:'hand_loss')` — server-side since Phase 7 | `hand_pause_count` (cumulative, 0044) | Yes (3rd strike — previously a PLAIN pause, which made pause/recover cycling an invisible time source) |
| **Tab-hide** (`visibilitychange` → hidden) | NO pause/violation: cadence pauses, catch-up verify on return | — | — |
| **Local pause on failed pause-POST** | client overlay only; next periodic verify reconciles | — | — |

`focus_lost` increments `focus_pause_count`; `hand_loss` increments
`hand_pause_count` (both flag at 3); `fullscreen_exit` counts but never flags.
Blink self-recovery recovers all of the above EXCEPT `flagged`
(lecturer-only) and resets `face_fail_streak` — it deliberately does NOT
reset the pause counters (only `unlock_session`/`exempt_face_session` do).

**Timer-credit cap (0044, extended 0045):** `self_recover_session` credits the paused
duration back into `started_at` capped at **120 s** per recovery
(`MAX_RECOVERY_CREDIT_SECONDS`). Honest pauses are always far shorter
(blur debounce 900 ms; face pause → blink recovery), so honest sessions are
unaffected; scripted pause/recover cycling is no longer a profitable time
source — and the hand/focus 3-strike flags it anyway. `unlock_session` (a
lecturer decision) caps its timer credit at the SAME **120 s** ceiling
(0045), resets `focus_pause_count`, `fullscreen_pause_count` AND
`hand_pause_count`, and returns the server's `remainingMs` so the client
countdown re-syncs instead of freezing through the pause.

## 2c. Timer semantics

The assessment deadline is anchored to `started_at`. While `paused`, time is
CREDITED BACK: `self_recover_session` / `unlock_session` extend `started_at`
by the paused duration capped at **120 s** (`paused_at`,
`MAX_RECOVERY_CREDIT_SECONDS` — migrations 0019/0021, capped 0044/0045).
Flagged idle time
is NOT credited (`paused_at` cleared on any transition to `flagged`), so a
lecturer unlock never converts flagged waiting into exam time. The client-side
countdown mirrors this by pausing on `paused`/`flagged` and adopts the
server's `remainingMs` on every recovery/unlock (D-F2).

## 3. Advisories (lecturer review hints — NEVER status changes)

`session_advisories(session_id, adv_type, first_seen_at, last_seen_at,
occurrences)` with `unique(session_id, adv_type)`; writes RPC-only via
`report_session_advisory` (owner, assessment, active/paused only;
occurrence increments throttled server-side to 1 per 55 s — direct
PostgREST spam returns ok without inflating); reads owner-or-lecturer
(mirrors `face_checks` RLS).

| Type | Source | Client throttle |
|---|---|---|
| `second_face` | client tracker runs MediaPipe `numFaces:2`, sustained ≥2 faces for 1 s; **SERVER-SIDE source too (integrity hardening): the verify route and the answer route fire `report_session_advisory('second_face')` fire-and-forget after a successful check, over the faces the server just judged — tamper-resistant where the client tracker is suppressible by a tampered browser** | 55 s |
| `looked_away` | off-axis/off-center accumulation ≥8 s inside rolling 60 s (consecutive away samples only) | 55 s |
| `voice_activity` | mic RMS (AnalyserNode) speech-level accumulation ≥2 s inside rolling 30 s | 55 s |
| `headset_active` | active input device label matches BT/headset patterns (one-shot after mic grant) | once |

> These four are the ONLY rows in `session_advisories`. The
> `suspected_replay` / `too_frequent` flags mentioned in §1 are an older,
> separate mechanism: columns on `face_checks` rows, also advisory-only.

Mic denial degrades silently (mirrors camera-off acceptance). Pure logic:
`src/lib/face/attention.ts`, `src/lib/audio/vad.ts` (unit-tested);
wiring: `use-integrity-advisories.ts`. Dashboard chips render per type with
occurrence counts.

## 4. Incident recording (ring buffer)

Privacy contract: **nothing is uploaded unless an incident happens.**

- `use-incident-recorder.ts` records camera (+mic when granted) via
  MediaRecorder in 5 s chunks held ONLY in memory, capped at ~5 min
  (250 kbps ≈ 9 MB vs the 30 MB cap).
- On `ready → paused | flagged | unavailable` (including via `recovering`)
  the buffer is flushed to `POST /api/sessions/[id]/incident` and recording
  continues into a fresh ring (subsequent incidents get their own clips).
  The flush predicate is the pure `shouldFlushIncident`
  (`lib/face/incident-transition.ts`, unit-pinned). **Bugfix (0044, audit
  2026-09):** the previous status lived in a ref the effect cleanup nulled on
  every dependency change, so the flush branch was UNREACHABLE dead code and
  no clip was ever uploaded. The reason stored on the clip is now the PAUSE
  CAUSE (`face`/`focus_lost`/`fullscreen_exit`), not the bare status token.
- Clean submit DISCARDS the buffer. Container type is trusted end-to-end
  (Safari mp4 vs WebM).
- Storage: private bucket `incident-footage` (NO client policies — access
  exclusively route-mediated via service role), metadata in
  `incident_clips`; lecturers play back signed URLs (1 h) in the expandable
  results rows. Retention: `prune_expired_incident_clips()` +
  `scripts/incident-cleanup.mjs` (30 days; deletes objects AND rows).
- Disabled under the E2E fake seam (headless runs never touch a real
  camera/recorder).
- If the tab dies BEFORE an incident flush, the in-memory ring is lost —
  accepted (footage exists only for incidents that surface while alive).
- Retention IS wired (migration 0042): pg_cron runs
  `innovision-incident-prune` daily at **04:23** calling
  `prune_expired_incident_clips()` (30-day default; deletes objects AND
  rows), alongside the every-minute silence-flag job; 0047 added
  `cron_health()` observability. `npm run incident:cleanup` is the
  FALLBACK for environments without pg_cron.

## 5. Test surface

- Unit: `vote.test.ts`, `attention.test.ts`, `vad.test.ts`,
  `incident-transition.test.ts` (0044 — the flush privacy contract as a pure
  predicate; the hook previously NEVER uploaded a clip — see §6),
  `cadence.test.ts` (incl. `minClientVerifyGapMs` = 8 s),
  `face-routes.test.ts` (I-vote block, focus-loss escalation, advisory
  block), `face-session-routes.test.ts` (incident upload block).
- SQL harness: `scripts/verify-face.mjs` — probes the REAL RPCs (the
  8-arg `record_face_check` signature; it MINTS the HMAC proofs via
  `mintProof`/`withProof`, since 0045 forged similarities die at the
  proof gate): I-vote (lookalike-top1 passes, 1-of-3
  fails, distance=max), numeric gates, focus escalation + attribution +
  unlock reset, fullscreen counter (0043), hand-loss counter + 3-strike +
  reset, recovery credit cap (120 s), lifetime face_fail_count, unlock/exempt
  audit session-attribution, advisory upsert/throttle, the 0045 proof/throttle/frozen-frame
  blocks. **~85 checks.**
- E2E: `e2e/e16-integrity.spec.ts` — debounced-blur pause copy, 3-strike
  flagging, and the full second-face advisory chain rendered as a dashboard
  chip. Fake tracker exposes `setFacePose` /
  `onPoseChange` / `getFaceHealth`.
- Dashboard: per-session integrity timeline (face checks with trigger/
  distance/replay hints + unavailable marker + attributed audit rows) renders
  inside the expanded row; `face_exempt` chip; hand-pause line; face-check
  truncation warning when the 500-row audit read is hit. Export carries the
  LIFETIME `face_fail_count` (not the resettable streak) + hand pauses +
  attempt ordinal — the workbook can no longer read "0 fails" for a student
  who was flagged and unlocked.

## 6. Known accepted limits

- Direct-RPC forgery is CLOSED (the old Phase 7 §7 residual risk):
  0045 shipped the server-minted HMAC verify proof —
  `app_private.verify_proof_secret`, the service-role-only getter, a
  route-computed `HMAC-SHA256(secret, session_id || ':' || nonce || ':' ||
  frame_concat)` over the EXACT frame bytes after the sidecar compare, a
  double-HMAC compare (constant-useful, no match-prefix timing leak), a
  per-session attempt ledger (`face_verify_attempts`, 600/10 min, counted
  after the nonce gate / before the proof), and the frozen-frame pause
  (P0-2). 0067 extends the same machinery to ANSWERS (`answer-proof` over
  canonical answer fields inside `commit_answer`) and revokes direct
  `answer_question` execution. **Remaining browser-boundary limit:** the
  route trusts client-captured frames — a tampered client can submit
  frames it likes through the route (the HMAC proves the ROUTE judged
  them, not that a camera produced them), but it cannot skip the sidecar
  compare or forge a direct RPC call.
- Blink replay is MITIGATED (integrity hardening, 2026-09): the assessment
  gate AND blink recovery append a randomized head-turn challenge
  (`lib/face/challenge.ts`) — the student must turn toward a randomly chosen
  side and hold it, which a pre-recorded blink video cannot match. The
  challenge is client-side deterrence layered on the server's 1:1 verify
  match; a bespoke real-time relay remains out of scope (browser boundary).
- Frozen-feed detection (2026-09): a camera track that ENDS or is MUTED
  (devtools `track.enabled = false` — freezing the last frame) fires the
  tracker's fatal-error channel → the pipeline degrades to `unavailable`
  (lecturer-visible) instead of re-verifying a static frame forever. The
  challenge still runs only at gate/recovery — a genuine relay attack remains
  the documented browser boundary.
- The verify-silence cron (`flag_verify_silent_sessions`, 0042, reshaped
  through 0067) fires every minute via pg_cron and runs ONLY for
  gesture-enabled quizzes (a `gestures_enabled = true` term; non-gesture
  assessments are never candidates). Freshness is keyed to
  `session_answers.answered_at` (NOT `last_activity_at`, which advisories
  touch): a candidate must have ≥2 answers AFTER its last face check
  (0044 grace — a tab-return catch-up capture takes seconds; the count
  resets only when a REAL verify commits), answered within the last 90 s,
  with the last check >300 s old (coalesced to `started_at` for
  zero-check sessions). The outage-claim exemption requires the claim to
  be FRESH (≤10 min) AND CORROBORATED — a `face_checks` row OR a
  `face_verify_attempted_at` stamp within 10 min — so the audit-2
  block-verify-and-re-arm attack produces a fresh claim with no
  corroboration → flagged, while an honest outage (attempts flowing) stays
  exempt. The pause-resume guard is the dedicated `resume_grace_until`
  trigger stamp (0047; the earlier `paused_at` form was a tautology). 0062
  added `session_verify_silent()` plus submit-time and
  autoclose-seal-time `auto_flag_verify_silence` evidence rows
  (`via: 'submit'` / `'autoclose_seal'`), closing the
  suppress-then-submit escape. The flag applies via a guarded UPDATE that
  RE-STATES every freshness + exemption predicate (under READ COMMITTED a
  verify committing between the cursor snapshot and the UPDATE
  re-evaluates there — a student whose verify just landed is never
  flagged on stale data). (0042's original plpgsql syntax bug — cursor
  loop closed with `end if` — was fixed in place in the 0042 file
  itself; a migration that never applied has no state to preserve.
  0044 also moved `report_session_advisory`'s activity touch inside its
  55 s occurrence throttle so advisory spam cannot blur freshness
  signals.)
- Phones/earbud-audio remain undetectable (browser boundary); advisories
  are review hints, not proof. Head PITCH now feeds the `looked_away`
  advisory in BOTH directions (`|pitch| > LOOK_AWAY_PITCH_DEG`) so moderate
  lap-glances (head down) and chin-up gazing inside the centered box still
  accumulate (deep laps already trip `!centered`).
- A local-pause on a failed pause POST is recovered by blink-recovery (the
  student clicks through); the next periodic verify reconciles state.
- Auto-reveal (PLAN_REVEAL_RESULTS) counts `paused`/`flagged` sessions as
  in-progress blockers — routine focus pauses delay auto-reveal only until
  recovered, but a FLAGGED session blocks it until a lecturer decides (or
  until the session goes >2 h stale, per 0032's "stale sessions read as done").
- The e5/e6/e7/e12 face-cycle specs were re-verified against the current
  helpers on 2026-09-11 (they drive the anti-replay head-turn via
  `triggerFaceLiveness` and assert streak/403/nonce-rotation server truth) —
  e16-integrity.spec.ts remains the compact green reference, but the older
  specs are NOT dead weight: e6/e7/e12 carry the only E2E proof of
  flagged-overlay copy, unlock-with-rotated-nonce, and the reload-bypass
  guard. Local runs without `LECTURER_INVITE_CODE` skip silently — check the
  skip count before trusting a green result.
