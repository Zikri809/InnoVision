# Notifications — in-app notification center (PROPOSED)

> **Status: PROPOSED — not yet executed.** This is the design of record for the
> notification system (migration 0022 + client). When shipped, flip the banner
> to EXECUTED and register in `docs/README.md`. Follows the authority rules in
> `docs/README.md`: where this doc and the code disagree, code + migrations win.

## 0. Scope

**Goal**: per-role in-app notifications (bell + panel + unread badge) for the
events that actually need a signal, delivered by Supabase Realtime with
polling as the consistency backbone. No email/push in v1.

**Non-goals (explicitly rejected / deferred)**:

- `quiz_closed` — **CUT**: no route writes `status='closed'` (verified against
  `0004` state machine + `publish/route.ts`); it is dead surface. Revisit only
  if an auto-close feature ships.
- Per-advisory notifications (`session_advisories`) — **rejected**: ambient
  review signals, already surfaced inline on the results dashboard
  (`focus_pause_count`, advisory counts). A notification per occurrence is
  noise even digested.
- `quiz_reminder` — **deferred**: needs a scheduler (pg_cron is best-effort in
  0019; no reminder job infra). Phase B.
- `face_enrollment_reviewed` — **deferred**: only `reject_face_enrollment`
  exists (0010); an approve path must land first.
- Email/push, announcements/broadcast — no authoring surface exists; v2.

## 1. Notification matrix

Urgency tiers: **Pinned** = renders in the panel's "Needs attention" section
while unread, survives panel close/reopen; any read action (per-row, link
visit, or mark-all-read) dismisses it from the section (the row remains in
the recent list — read state never hides rows); **Immediate** =
regular row, unread styling; **Digest** = grouped per entity in the UI
("12 new submissions"), badge still counts each event.

### Student

| Type | Trigger (exact write path) | Urgency | Link target (client-derived) |
|---|---|---|---|
| `quiz_live` | `quizzes.status` → `live` (publish route or direct SQL; same-value no-ops can't fire) | Immediate | `/student/quizzes` |
| `results_revealed` | `quizzes.results_revealed_at` NULL→set while `status='live'` (manual reveal route OR auto-reveal in `submit_session`) | Immediate | `/play/[sessionId]` if own completed session exists at render, else `/student/quizzes` |
| `session_reset` | inline insert in `reset_session` (after ownership + mode gates, after delete) | Pinned | `/student/quizzes` |
| `removed_from_class` | `class_enrollments` DELETE, discriminator ladder §4.4 | Pinned | `/student/classes` |
| `class_archived` | `classes.archived_at` NULL→set | Pinned | `/student/classes` |

### Lecturer

| Type | Trigger | Urgency | Link target |
|---|---|---|---|
| `student_joined` | `class_enrollments` INSERT (join_class; conflict path fires nothing by construction) | Digest | `/lecturer/classes/[id]` |
| `session_submitted` | `quiz_sessions.status` → `completed` AND `mode='assessment'` | Digest | `/lecturer/quizzes/[id]/results` |
| `session_flagged` | `quiz_sessions.status` → `flagged` AND `mode='assessment'` (covers all three writers: face-fail streak, `pause_session('focus_lost')` 3rd strike, and `revoke_face_consent` bulk-flagging mid-exam — a serious integrity event worth surfacing) | Pinned | `/lecturer/quizzes/[id]/results` (unlock/reset actions live here, not session detail) |
| `quiz_completed_all` | same trigger as `session_submitted`; fires when completed-session count ≥ enrollment count | Digest | `/lecturer/quizzes/[id]/results` |
| `incident_clip_recorded` | `incident_clips` INSERT (student client, rate-limited route) | Digest | `/lecturer/quizzes/[id]/results` |
| `face_unavailable_reported` | inline insert in `report_face_unavailable` RPC (student reports camera failure; lecturer decides exempt/unlock) | Pinned | `/lecturer/quizzes/[id]/results` |
| `face_enrollment_held` | `profiles.face_enrollment_status` → `'pending_review'` (duplicate detected at enroll) | Pinned | `/lecturer/classes` (no review UI yet — body copy directs to roster) |

## 2. Schema (migration 0022)

```sql
do $$ begin
  create type public.notification_type as enum (
    'quiz_live','results_revealed','session_reset','removed_from_class',
    'class_archived','student_joined','session_submitted','session_flagged',
    'quiz_completed_all','incident_clip_recorded','face_unavailable_reported',
    'face_enrollment_held'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  seq          bigint generated always as identity,   -- monotonic cursor; created_at ties are GUARANTEED in fan-outs
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  type         public.notification_type not null,
  payload      jsonb not null default '{}'::jsonb,    -- whitelisted keys ONLY (§3.1)
  read_at      timestamptz,
  created_at   timestamptz not null default now(),
  dedupe_key   text not null,
  constraint notifications_recipient_dedupe_key
    unique nulls not distinct (recipient_id, dedupe_key)
);

create index if not exists notifications_recipient_seq_idx
  on public.notifications (recipient_id, seq desc);
create index if not exists notifications_recipient_unread_idx
  on public.notifications (recipient_id, seq desc) where read_at is null;
```

**Deliberate design points**

- **No FKs to business tables.** Payload history survives quiz/class/session
  deletion (same philosophy as `audit_events.metadata` in 0011). Dead-link
  handling is a client concern (§5.3).
- **`recipient_id` is the only FK.** Account deletion cascades the inbox away.
- **`seq` identity, not `created_at`, orders and paginates.** Fan-out
  insert-selects share `now()`; uuid v4 is not monotonic.
- **No `pinned` column.** Pinning is presentation, derived from `type`
  client-side; retention exemptions are a type list in the prune function
  (§6). One source of truth.
- **No `link_url` column.** Links are derived client-side from payload ids per
  type with a fallback chain (§5.3) — routes stay in code, not in historical rows.

**RLS / grants / publication** (privilege layer = intent, RLS = backstop; 0008 pattern):

```sql
alter table public.notifications enable row level security;

create policy "Recipient reads own notifications"
  on public.notifications for select
  using (recipient_id = auth.uid());
-- NO insert/update/delete policies: writes are trigger/RPC-only.

revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;   -- own rows via RLS
grant all     on public.notifications to service_role;

-- Realtime: publication membership is REQUIRED for postgres_changes to deliver.
-- RLS — not the client's `filter=` — is the security boundary; the filter is
-- a perf predicate only.
do $$ begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime'
                    and schemaname = 'public' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
exception when undefined_object then
  -- Fresh self-host with no publication at all: notifications is the only
  -- realtime table in the app today, so a minimal publication is complete.
  create publication supabase_realtime for table public.notifications;
exception when insufficient_privilege then
  -- supabase_admin-owned publication on some topologies: do NOT abort the
  -- migration — notifications degrade to polling (the consistency backbone).
  raise notice 'cannot alter supabase_realtime; notifications fall back to polling';
end $$;
```

Keep the SELECT policy a bare `recipient_id = auth.uid()` — no helper-function
calls — so Realtime's per-subscriber RLS re-check stays O(1) and recursion-proof.
Leave replica identity DEFAULT (PK-only): DELETE events carry only `id`.

## 3. Population

### 3.0 Global rules (apply to every trigger function)

1. Every `notify_*` function is `language plpgsql security definer set
   search_path = public`. Recipients are derived from row data + joins —
   **never from `auth.uid()`** (NULL under service_role; the trap documented
   in 0009).
2. Bodies are **set-based** `insert … select … on conflict (recipient_id,
   dedupe_key) do nothing` — never per-row loops.
3. **Exception policy**: dedupe via `ON CONFLICT DO NOTHING`; narrow handlers
   only — `when unique_violation then null; when foreign_key_violation then
   null;` (recipient deleted in-flight). Any other exception is neither caught
   nor warned: it propagates and is observable in logs/business-op errors.
   **`WHEN OTHERS THEN NULL` is banned** — it silently zeroes the
   integrity-alert channel.
4. **Payload discipline (§3.1) is enforced by test, not convention.**

### 3.1 Payload whitelist

Payloads are built with explicit `jsonb_build_object(...)` only.
`to_jsonb(NEW/OLD)` / `row_to_json` are **banned** in `notify_*` functions —
one lazy `to_jsonb(NEW)` on `quiz_sessions` would leak `verify_nonce` (a
live capability token for face-check replay), pre-reveal `score`, and on
`quizzes` leak `source_file_url`/`created_by` (MED-1 secrecy, 0006).

| Type | Allowed payload keys |
|---|---|
| `quiz_live` | `quiz_id`, `quiz_title`, `class_id`, `class_title`, `mode` |
| `results_revealed` | `quiz_id`, `quiz_title`, `class_id` — **never `score`** |
| `session_reset` | `quiz_id`, `quiz_title`, `session_id` (deleted id, mirrors audit metadata) |
| `removed_from_class` | `class_id`, `class_title` |
| `class_archived` | `class_id`, `class_title`, `live_quiz_count` |
| `student_joined` | `class_id`, `class_title`, `student_id`, `student_name` (lecturer already sees the roster; cap `left(btrim(name),80)`) |
| `session_submitted` | `quiz_id`, `quiz_title`, `session_id`, `student_id` |
| `session_flagged` | `quiz_id`, `quiz_title`, `session_id`, `student_id`, `student_name` (capped `left(btrim(name),80)` — recipient is the lecturer-of-quiz, who already sees roster names via `student_roster_view`, 0006) — **no reason text, no face data, no nonce**; cause attribution stays in the dashboard timeline (0021 R3 made audit rows attributable) |
| `quiz_completed_all` | `quiz_id`, `quiz_title` |
| `incident_clip_recorded` | `quiz_id`, `quiz_title`, `session_id`, `clip_id` |
| `face_unavailable_reported` | `quiz_id`, `quiz_title`, `session_id`, `student_id` |
| `face_enrollment_held` | `student_id` (lecturer resolves via roster) |

Student-facing payloads carry **no lecturer names** — students cannot
attribute quizzes/classes to lecturers today (`student_class_view` /
`student_quiz_view` omit it, 0006 MED-1) and a notification must not regress
that. Titles (lecturer-authored content students already legitimately see)
are denormalized so rows render after source deletion.

### 3.2 Trigger inventory (exact WHEN clauses)

The WHEN clauses are load-bearing — `record_face_check` rewrites `status` on
**every verify cycle** (active↔paused↔flagged flapping, 0020 §(12)-(13)) and
`reveal-settings/route.ts` patches live quizzes **without touching status**.
A naive `NEW.status = 'live'` trigger fires on both.

```sql
-- quiz_live
create trigger notify_quiz_live after update of status on public.quizzes
  for each row
  when (old.status is distinct from new.status and new.status = 'live')
  execute function public.notify_quiz_live();
-- fan-out: insert…select from class_enrollments for new.id (snapshot at
-- publish time; later enrollees discover via /student/quizzes — accepted, D7).
-- The fan-out SELECT joins classes and skips rows where archived_at is not
-- null: the publish route does NOT gate on archived classes (unlike
-- start_quiz_session), so without this guard a publish-after-archive would
-- notify students whose student_quiz_view hides the quiz.

-- results_revealed (manual reveal route + submit_session auto-reveal both
-- land here; quiz_reveal_once already gates the direction, 0012 §3)
create trigger notify_results_revealed after update of results_revealed_at
  on public.quizzes for each row
  when (old.results_revealed_at is null and new.results_revealed_at is not null
        and new.status = 'live')
  execute function public.notify_results_revealed();
-- fan-out scoped to students with a COMPLETED session on this quiz:
-- a zero-submission manual reveal (route allows it) must not tell every
-- enrolled student "results ready" and then 404 them into not_revealed.
-- Late submitters see results inline on submit (submit returns score once
-- revealed) — no compensating notification (D8).
-- Over-delivery ≠ data access: payload carries no score; result fetches
-- re-check enrollment via is_student_reveal_allowed.

-- session_submitted + quiz_completed_all (one function, both duties)
create trigger notify_session_terminal after update of status
  on public.quiz_sessions for each row
  when (old.status is distinct from new.status
        and new.status in ('completed','flagged')
        and new.mode = 'assessment')
  execute function public.notify_session_terminal();
-- 'completed' → session_submitted, plus quiz_completed_all when the count of
-- COMPLETED ASSESSMENT sessions on the quiz >= CURRENT class_enrollments
-- count for the quiz's class (both counts pinned to assessment; practice is
-- excluded by the mode term);
-- 'flagged'   → session_flagged. The mode='assessment' term is what keeps
-- practice submits from spamming lecturers. Idempotent resubmit returns
-- early before any UPDATE (0012) → no trigger → no duplicate.

-- student_joined
create trigger notify_student_joined after insert on public.class_enrollments
  for each row execute function public.notify_student_joined();
-- join_class's ON CONFLICT DO NOTHING inserts no row on re-join → nothing fires.

-- removed_from_class (discriminator ladder, §4.4)
create trigger notify_enrollment_deleted after delete on public.class_enrollments
  for each row execute function public.notify_enrollment_deleted();

-- class_archived (unarchive→re-archive re-fires; epoch in dedupe key)
create trigger notify_class_archived after update of archived_at on public.classes
  for each row
  when (old.archived_at is null and new.archived_at is not null)
  execute function public.notify_class_archived();

-- face_enrollment_held (recipients = lecturers of classes the student is enrolled in)
create trigger notify_face_enrollment_held after update of face_enrollment_status
  on public.profiles for each row
  when (old.face_enrollment_status is distinct from new.face_enrollment_status
        and new.face_enrollment_status = 'pending_review')
  execute function public.notify_face_enrollment_held();

-- incident_clip_recorded (digest; volume bounded by the route's rate limit)
create trigger notify_incident_clip after insert on public.incident_clips
  for each row execute function public.notify_incident_clip();
```

### 3.3 Inline RPC inserts (never triggers)

- **`reset_session`** (0011): insert `session_reset` **after** the
  ownership lock, mode gate, and the `delete` — keyed on the deleted
  session id. A DELETE trigger on `quiz_sessions` is wrong: it would fire on
  quiz/class/profile delete cascades and practice prunes (0019), emitting
  fake resets. Double-reset race is already safe: the second caller's
  lock-and-ownership SELECT re-checks after the wait, finds nothing, returns
  `not_owner` before any insert.
- **`report_face_unavailable`** (0009): insert `face_unavailable_reported`
  keyed `{session_id}` — the RPC is set-if-null but re-called on every camera
  retry; the dedupe key collapses retries to one notification per session.

### 3.4 Dedupe keys (type-prefixed — a type-less key lets a later event be
silently swallowed by an earlier one for the same entity)

| Type | Key format | Rationale |
|---|---|---|
| `quiz_live` | `quiz_live:{quiz_id}` | state machine ⇒ ≤1 live-entry |
| `results_revealed` | `results_revealed:{quiz_id}` | one-way column ⇒ ≤1 |
| `session_reset` | `session_reset:{session_id}` | uuid unique per reset |
| `removed_from_class` | `removed_from_class:{class_id}:{student_id}:{extract(epoch from old.enrolled_at)}` | join→remove→rejoin re-notifies; student_id prevents same-second collisions (epoch ::bigint truncates sub-second) |
| `class_archived` | `class_archived:{class_id}:{extract(epoch from new.archived_at)}` | unarchive→re-archive re-notifies |
| `student_joined` | `student_joined:{class_id}:{student_id}:{extract(epoch from new.enrolled_at)}` | re-join cycles; student_id prevents same-second collisions |
| `session_submitted` | `session_submitted:{session_id}` | completed is terminal |
| `session_flagged` | `session_flagged:{session_id}:{to_char(now(),'YYYYMMDD')}` | flag→unlock→re-flag is a real repeat offense; day bucket tames same-day storms |
| `quiz_completed_all` | `quiz_completed_all:{quiz_id}` | reset+retake re-reaching 100% is suppressed — accepted (D9) |
| `incident_clip_recorded` | `incident_clip_recorded:{clip_id}` | each clip is a distinct event; UI groups per session |
| `face_unavailable_reported` | `face_unavailable_reported:{session_id}` | retry storm collapse |
| `face_enrollment_held` | `face_enrollment_held:{profile_id}:{extract(epoch from clock_timestamp())::bigint}` | per-transition key: every reject→retry cycle is a real event; volume is tiny (same-second double-transitions collapse — accepted) |

### 3.5 `class_enrollments` DELETE — four causes, one trigger

Direct PostgREST self-unenroll is reachable **today** (the 0002 DELETE policy
allows `student_id = auth.uid()`), and no app endpoint performs
lecturer-removal yet — but the ladder is required so both are correct now and
a future removal endpoint is correct on day one:

```sql
-- inside notify_enrollment_deleted (security definer):
select exists (select 1 from public.classes  c where c.id  = old.class_id),
       exists (select 1 from public.profiles p where p.id  = old.student_id)
  into v_class_alive, v_student_alive;

if not v_class_alive  then return null; end if;  -- class row already deleted ⇒ class_title payload unbuildable; students discover via their class list
if not v_student_alive then return null; end if; -- account deletion: recipient gone

-- both alive ⇒ deliberate removal
if auth.uid() = old.student_id then
  return null;                                   -- self-unenroll: never notify self
else
  -- lecturer-initiated or service-role removal → removed_from_class
end if;
-- FK cascades run child triggers at pg_trigger_depth() >= 2, so the liveness
-- probes above already absorbed them; no depth check needed for correctness.
```

## 4. Read path

### 4.1 RPCs (writes stay RPC-only, matching the house pattern)

```sql
create or replace function public.mark_notifications_read(p_ids uuid[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare v int;
begin
  if auth.uid() is null then return jsonb_build_object('error','not_authenticated'); end if;
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 200 then
    return jsonb_build_object('error','invalid_ids'); end if;
  update public.notifications set read_at = clock_timestamp()
   where id = any(p_ids) and recipient_id = auth.uid() and read_at is null;
  get diagnostics v = row_count;
  return jsonb_build_object('updated', v);
end $$;

-- mark-ALL takes the caller's highest seen seq so a notification arriving
-- mid-click is NOT silently marked read before being rendered:
create or replace function public.mark_notifications_read_before(p_seq bigint) …
  update … where recipient_id = auth.uid() and read_at is null and seq <= p_seq;
```

Ownership lives **inside the mutating WHERE** (0011 lock-and-predicate
pattern) — a definer RPC without it is an alert-suppression primitive against
lecturers' integrity alerts. Both functions: `revoke execute … from public,
anon; grant execute … to authenticated`.

### 4.2 Queries

- Badge: `select count(*) … where recipient_id = auth.uid() and read_at is null`
  → partial unread index, index-only scan.
- List: `order by seq desc limit 20`; next page keyset
  `where recipient_id = auth.uid() and seq < $cursor order by seq desc limit 20`.
  Never OFFSET — concurrent inserts shift windows.

### 4.3 Delivery — poll is the backbone, Realtime is the accelerator

postgres_changes has **no replay**: any socket gap loses INSERTs until the
next poll. Therefore:

- On mount: server-rendered badge + latest 20 (SSR fetch in the shell).
- One channel: `supabase.channel('notif:'+uid).on('postgres_changes',
  {event:'INSERT', schema:'public', table:'notifications',
  filter:'recipient_id=eq.'+uid})`. Subscribe to INSERT only — read_at
  UPDATEs are self-noise.
- Channel `SUBSCRIBED` → poll 60 s. `CHANNEL_ERROR`/`TIMED_OUT`/`CLOSED` →
  immediate refetch + poll 15–20 s until healthy.
- Refetch on `visibilitychange→visible` and window `focus` (laptop-lid resume:
  socket AND JWT both stale). On `onAuthStateChange TOKEN_REFRESHED`,
  re-subscribe (supabase-js forwards tokens, but a slept tab can attempt a
  join with an expired JWT — `jwt_expiry=3600`).
- **Hidden tab: unsubscribe the channel AND pause polling** (frees a
  free-tier connection seat; 200-connection project cap; fan-out bursts can
  also brush the 100 msg/s cap — reconnect + poll converge, badge correctness
  never depends on the socket).
- Merge reducer is a pure function (dedupe by id, sort by seq, cap list) —
  unit-testable without jsdom.
- StrictMode-safe effect: subscribe in effect, `removeChannel` in cleanup,
  never cache the channel in a module variable without resubscribe logic.
- **Test seam**: the poll state machine reads an optional
  `window.__INNOVISION_NOTIF_CONTROL__ = { setPollMs(n) }` global
  (same pattern as the fake-tracker seams in `e2e/helpers.ts`); E2E installs
  it via `addInitScript` and blocks Realtime with `context.routeWebSocket()`.
- `<NotificationBell/>` is a single client island rendered in
  `app-shell.tsx` immediately before `<AppUserMenu />` (visually adjacent to
  the language toggle, which lives inside the user menu). `/play/[sessionId]`
  opts out of the shell — keep it that way (mid-exam notifications are a
  distraction and an integrity surface).

### 4.4 Client API

- **SSR fetch site**: the role layouts (`src/app/(lecturer)/layout.tsx`,
  `src/app/(student)/layout.tsx`) already hold the RLS-scoped server client;
  they fetch badge count + latest 20 and pass props:
  `<NotificationBell initialCount={n} initialItems={rows} />`. Fetch failure
  degrades to badge 0 / no panel — never blocks shell rendering.
- `useNotifications()` (`src/lib/notifications/use-notifications.ts`) returns
  `{ items, unreadCount, healthy, markRead(ids), markAllRead(), refresh() }`;
  internally owns channel lifecycle + poll state machine.
- `mergeNotifications(prev, incoming, cap)` — pure reducer (dedupe by id,
  sort by seq desc, cap length).
- `resolveLink(type, payload, ctx)` — pure link resolver per §5.3; for
  `results_revealed`, one RLS-scoped `quiz_sessions` select
  (`quiz_id = payload.quiz_id and student_id = uid and status='completed'`,
  latest by seq) resolves the play link at render; miss falls back to
  `/student/quizzes`.

## 5. Client UX

### 5.1 Panel semantics

- **Read state ≠ visibility.** Rows stay in the recent list regardless of
  `read_at`; unread styling + badge derive from unread only.
- **Pinned "Needs attention"** section: rows of pinned types **while
  unread**. It survives panel close/reopen; any read action (per-row, link
  visit, mark-all-read) dismisses the row from the section — the row remains
  in the recent list. Digest rows never pin.
- Badge counts unread **events**, capped at `99+`; grouping is
  presentation-only (12 submissions = 12 toward the badge, one grouped row).
- **Mark all as read** marks every unread row read — including pinned ones,
  which then leave "Needs attention" (they stay visible, muted, in the list;
  the underlying integrity state remains on the results dashboard). Shows a
  confirm dialog when total unread > 20: *"Mark 247 notifications as read?"*
- Empty ("You're all caught up"), skeleton loading (clay cards, no
  spinner-only void per MASTER.md), inline error retry reusing
  `common.retry`/`common.errorGeneric`.
- Responsive: ≥640px anchored popover (~380px, internal scroll, z above the
  sticky header's z-50) — requires a new `src/components/ui/popover.tsx`
  wrapping `@base-ui/react/popover`, clay-styled to match `dialog.tsx`;
  <640px full-screen sheet reuses the existing Dialog primitive
  (account-menu pattern). Touch targets ≥44px.

### 5.2 Accessibility

- Bell: `aria-label` carries the count ("Notifications, 3 unread" — ICU
  plural); badge is `aria-hidden`; `aria-expanded`/`aria-haspopup`.
- `aria-live="polite"` region announces poll deltas only ("2 new
  notifications"), debounced, suppressed while the panel is open.
- Keyboard: Esc closes and returns focus to the bell; ↑/↓ roving focus;
  Enter opens link. Desktop popover is non-modal (no focus trap); mobile
  sheet is modal.

### 5.3 Deep links & dead targets

Client derives links from payload per type (fallback chain), e.g.
`results_revealed` → own completed session's `/play/[sessionId]` if
resolvable, else `/student/quizzes`. Quizzes are deletable while unattempted
(cascade), so any quiz link can 404. Next.js has no pre-navigation 404 hook,
so `resolveLink` **probes existence first**: one cheap RLS-scoped
`select id` on the target table before navigating. On miss: toast (*"This
quiz is no longer available."* — `play.toast.quizUnavailable` tone) →
redirect to role home → auto-mark the row read so the dead entry stops
drawing attention. Denormalized titles keep the row meaningful post-deletion.

### 5.4 Copy direction (trust)

- `session_reset`: remedy first, no blame — *"Your attempt for "{quizTitle}"
  was cleared. You can retake it whenever you're ready."* (Existing
  `play.toast.resetDead` copy reads as blame; do not copy it.)
- `removed_from_class` / `class_archived`: factual, no agent — *"Your access
  to "{className}" has ended."* Ban "kicked"/"removed you"/"revoked".
- `session_flagged`: normalizes false positives (lighting/camera/model
  hiccups are recorded as fails by design) — *""{studentName}"'s face checks
  kept mismatching on "{quizTitle}". This is often lighting or a camera
  hiccup — review before unlocking."* Amber "needs review" tone, never
  "suspected cheating".
- `results_revealed`: *"Your results for "{quizTitle}" are ready to view."*

## 6. Retention

Extend the `prune_expired_*` family (0019 `prune_expired_data()` best-effort
pg_cron + manual escape hatch; 0020 added
`prune_expired_incident_clips()`, hardened in 0021 R7). New function
`prune_expired_notifications()`:

```sql
delete from public.notifications
 where read_at is not null
   and created_at < clock_timestamp() - interval '30 days';

delete from public.notifications
 where read_at is null
   and created_at < clock_timestamp() - interval '180 days'
   and type not in ('session_flagged','session_reset','removed_from_class',
                    'results_revealed','face_unavailable_reported',
                    'face_enrollment_held');
-- second statement, same shape, '365 days', for the high-urgency list above

-- hard cap 500 READ rows per user (unread volume is bounded by real event
-- rate; scoping the cap to read rows means retention can NEVER destroy an
-- unseen integrity alert):
delete from public.notifications n
 where n.read_at is not null
   and n.seq <= (select x.seq from public.notifications x
                  where x.recipient_id = n.recipient_id and x.read_at is not null
                  order by x.seq desc offset 500 limit 1);
```

Grant to `service_role` only; schedule best-effort like 0019 (raise notice on
missing pg_cron; `npm run` escape hatch). Cap runs weekly, age-prune daily.

## 7. Rollout

1. Migration `0022_notifications.sql`, idempotent in repo style:
   `create table if not exists` (with `seq` inline; a standalone
   `add column if not exists seq` is only needed when re-running against a
   table created by an earlier draft); enum via `do $$ … duplicate_object`
   guard; the `UNIQUE NULLS NOT DISTINCT` constraint has **no
   `IF NOT EXISTS`** — guard via `pg_constraint` catalog check; indexes
   `if not exists`; policies `drop policy if exists` + create; functions
   `create or replace` + revoke/grant; triggers `drop trigger if exists` +
   create; publication guard (§2). CI already gates this: `db reset` +
   `gen:types` + drift check.
2. `npm run gen:types` — `Database` gains the table (CI enforces no drift).
3. **Backfill** (prod-only concern; `db reset` hides it): run-once,
   idempotent, state-snapshot — for each `status='live'` quiz insert
   `quiz_live` for current enrollees; for each revealed quiz insert
   `results_revealed` for students with completed sessions. All
   `on conflict do nothing`. Skip enrollment/join backfill (stale, noisy).
   Ship as a guarded SQL function invoked manually, not in the migration chain.
4. Client: `src/lib/notifications/` (types, link resolution, merge reducer,
   poll state machine, `useNotifications`), `src/components/notifications/`
   (bell + panel), new `src/components/ui/popover.tsx`, i18n keys (§8),
   register doc in `docs/README.md`.
5. CI/script wiring: add `"verify:notifications"` to package.json and a
   `ci.yml` step running it after `verify:results`; M1's double-push check
   runs as its own CI step (`supabase db reset && supabase db push`, twice).
6. Seeding note: `scripts/seed-demo.mjs` inserts enrollments and flips
   quizzes live via service-role — first-run seeding will emit
   `student_joined` + `quiz_live` rows (benign; verify scripts should expect
   them). Direct session INSERTs in the seeder fire nothing (trigger is
   UPDATE-only) — already correct.

## 8. i18n

- New top-level `notifications.*` namespace in **both** `en.json` and
  `ms.json` in the same change (`npm run check:i18n` fails CI on asymmetry).
- **Both locales use ICU plurals** — ms.json already carries
  `{count, plural, …}` branches (e.g. vision advisories). Keep `=0`/`=1`/
  `other` coverage symmetric across en and ms.
- **No dynamic `t()` keys** (`t(\`items.${type}.title\`)` is invisible to the
  checker's literal-arg scanner and `getMessageFallback` renders raw key
  paths in prod). Use a typed `Record<NotificationType, {titleKey;
  bodyKey}>` map + a unit test asserting every enum value resolves in both
  locale files.
- Relative time via `useFormatter()` (next-intl), hydration-guarded or
  coarse units; never hand-rolled `Asia/Kuala_Literal` formatting.
- Payloads carry **data, not prose** — copy is rendered from keys +
  payload params at read time, so a locale change applies to old rows.

## 9. Test matrix

| ID | Layer | Scenario | Key assertions |
|---|---|---|---|
| T1 | `scripts/verify-notifications.mjs` | enrollment insert | exactly 1 row; payload keys ⊆ whitelist; dedupe_key shape |
| T2 | verify | re-publish / re-enroll / re-reveal / resubmit | row count unchanged (ON CONFLICT proven, not assumed) |
| T3 | verify | class of 3, publish | exactly 1 per student, distinct recipients |
| T4 | verify | reveal-settings toggle on live quiz | NO quiz_live re-fire (UPDATE OF + IS DISTINCT FROM) |
| T5 | verify | record_face_check fail→paused→pass cycles | NO flagged/submitted rows; genuine flag fires once **within the same UTC day** (day bucket is `to_char(now(),…)` = DB/UTC time; cross-day re-fire accepted-untested, like D9) |
| T6 | verify | RLS: cross-student select/update; anon | 0 rows / 0 updated / denied; foreign ids in mark-read ignored |
| T7 | verify | mark-read cap: 201 ids → typed error; 200 → ok | `updated` accurate via GET DIAGNOSTICS |
| T8 | verify | retention: backdated read/unread/high-urgency/over-500-read-cap | windows honored; high-urgency unread survives; cap touches READ rows only |
| T9 | verify | keyset: 25 rows w/ identical created_at | page 2 = exactly 5, no dupes (seq tiebreak) |
| T10 | verify | publication membership | pg_publication_tables row exists |
| T11 | verify | seq-cursor mark-all: insert A(seq1), B(seq2); `mark_notifications_read_before(seq1)` | A read, B still unread |
| T12 | verify | enrollment-delete ladder: self-delete / student-gone cascade / class-gone cascade / other-uid delete | 0 / 0 / 0 / 1 notification |
| U1 | vitest | merge reducer dedupe/order/cap | pure outputs |
| U2 | vitest | poll-interval state machine | SUBSCRIBED→60s; error→20s+immediate |
| U3 | vitest | i18n key map | every enum value resolves in en+ms |
| E-N1 | Playwright (e16 patterns) | mark-all-read + reload | badge cleared, stays cleared; pinned rows leave "Needs attention", remain in list |
| E-N2 | Playwright | dead-link click (deleted quiz, resolver probe misses) | graceful unavailable state, row auto-read |
| E-N3 | Playwright | live arrival, second browser context | badge increments without reload |
| E-N4 | Playwright | `__INNOVISION_NOTIF_CONTROL__` fast-poll + `routeWebSocket()` blocked | arrival via poll path |
| E-N5 | Playwright | 30 seeded unread → exact badge; 120 seeded → "99+" | cap logic; 20 rows + load-more past page 1 |
| E-N6 | Playwright | pinned row lifecycle | renders in Needs-attention while unread; mark-all dismisses from section (stays in list); link visit marks read |
| M1 | CI | `db reset` + double `db:push` | second push no-op; all guards hold |

## 10. Pinned decisions

- **D1** Payload whitelist enforced by test; `to_jsonb(NEW)` banned.
- **D2** RLS (not the client filter) is the Realtime boundary.
- **D3** `WHEN OTHERS THEN NULL` banned; narrow handlers only.
- **D4** Writes: triggers + two inline RPC inserts; everything else RPC-only
  (`mark_notifications_read[_before]`).
- **D5** `seq` identity for ordering/pagination; keyset only.
- **D6** No lecturer names in student payloads (MED-1).
- **D7** Fan-out snapshots enrollment at event time; late enrollees use the
  class page (accepted gap).
- **D8** `results_revealed` fans out to completed sessions only; late
  submitters see results inline on submit.
- **D9** `quiz_completed_all` suppressed across reset+retake cycles.
- **D10** `quiz_closed` cut (dead surface); advisories never notify.
- **D11** Pinning is client-derived from `type` and means "unread + high
  urgency"; any read action dismisses the pin (rows are never hidden by read
  state). Retention exempts a type list, and its hard cap touches READ rows
  only — retention can never destroy an unseen integrity alert.
- **D12** Poll is the consistency backbone; Realtime is a latency
  optimization; hidden tabs disconnect.
