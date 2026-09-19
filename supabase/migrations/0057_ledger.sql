-- ═══════════════════════════════════════════════════════════════════════
-- 0057 — AI marking ledger + two-phase sweep (PLAN_GESTURE_OFF_RICH_TYPES)
--
-- D13 is the load-bearing decision: the sweep is TWO-PHASE, because
-- plpgsql cannot call HTTP and cannot COMMIT mid-body. A single SQL function
-- that held `FOR UPDATE SKIP LOCKED` rows across a 45s GLM call would stall
-- every student answer/submit (both take `quiz_sessions FOR UPDATE`).
--
--   Phase 1  sweep_ai_marks()      CLAIM: mark rows 'marking', mint a
--                                  claim_token, commit (locks released),
--                                  then net.http_post to the worker route.
--   Phase 1b escalate_stale_marks() SEPARATE RPC/txn (A6-1/A6-2): rows at
--                                  attempts >= 3 become needs_review.
--   Phase 2  marking-worker.ts     TS, server-only: the GLM HTTP call, no
--                                  open txn, no held locks.
--   Phase 3  finalize_ai_mark()    ONE short txn per batch: epoch- and
--                                  token-guarded writes + score recompute.
--
-- ── Global lock order (A6-2/A6-13/A7-6) ───────────────────────────────
--   quizzes → quiz_sessions → session_answers, with the LEDGER LAST.
-- Every writer here (claim, escalate, finalize) and override (0058) follows
-- it. The claim takes its quizzes locks BEFORE its ledger row locks, which
-- is what makes "ledger last" consistent across all four.
--
-- ── pg_net in its OWN guarded block (A6-6) ────────────────────────────
-- The cron block in 0059 schedules; THIS file creates pg_net. Bundling both
-- into one DO block would let an unavailable pg_net roll the schedule back
-- inside the EXCEPTION subtransaction while the notice blamed pg_cron — the
-- 0042:287-291 comment warns against exactly that.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. The ledger ────────────────────────────────────────────────────
-- RLS deny-all + service-role only, the `ai_generation_usage` precedent
-- (0028:148-157). This table carries answer text indirectly (via session/
-- question ids) and the spend record, so no user role may read it.
create table if not exists public.ai_marking_ledger (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  session_id uuid not null references public.quiz_sessions(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  attempt_version int not null default 1,
  idempotency_key text not null unique,
  tokens int not null default 0 check (tokens >= 0),
  usd numeric not null default 0 check (usd >= 0),
  -- attempts is capped at 3 by CHECK: the escalation path exists precisely
  -- because an unbounded retry loop is not representable here.
  attempts int not null default 0 check (attempts between 0 and 3),
  -- FS-3 lease: a crashed worker leaves a row in 'marking' forever without
  -- this, and the answer would stay pending — blocking v_all_done for the
  -- whole class. Re-claim after 5 minutes.
  claimed_at timestamptz,
  -- A5-1: the worker processes ONLY the rows its own claim handed it. A bare
  -- `status='marking'` read is not a claim — the 1-min cadence plus the
  -- 5-min lease would double-process a 45s-per-row batch.
  claim_token uuid,
  -- A6-11/A7-5: the CLAIM sets day = CURRENT_DATE (not just the insert
  -- default), so reconciliation and check_mark_spend book the claim's day.
  day date not null default current_date,
  status text not null default 'queued'
    check (status in ('queued', 'marking', 'marked', 'needs_review', 'failed')),
  created_at timestamptz not null default now()
);

-- A5-10/A6-3: the partial index must cover the LEASE arm too ('marking'),
-- or the claim's stale-worker re-scan degrades to a seq scan on the table it
-- is about to lock.
create index if not exists ai_marking_ledger_sweep_idx
  on public.ai_marking_ledger (status, created_at)
  where status in ('queued', 'failed', 'marking');

alter table public.ai_marking_ledger enable row level security;
revoke all on public.ai_marking_ledger from anon, authenticated;
-- C3: the GRANT lives HERE, not in 0054 — a privileges file cannot grant on
-- a relation that does not exist yet.
grant all on public.ai_marking_ledger to service_role;

-- ─── 2. pg_net (own guarded block — A6-6) ─────────────────────────────
-- Where this succeeds, sweep_ai_marks posts to the worker route after the
-- claim commits. Where it fails, the same route is OPERATOR-invoked (this
-- repo has no edge scheduler; see docs/DEPLOY_VPS.md).
do $do$ begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net unavailable; AI sweep falls back to operator-invoked route';
end $do$;

-- ─── 3. check_mark_spend ──────────────────────────────────────────────
-- C15/FS-9: a definer read of the ledger against the per-quiz daily caps.
--
-- HONESTY (S12/D2-15/FS-9): this is a BOUNDED-OVERRUN control, not an exact
-- one. Tokens/usd are known only AFTER the GLM call returns, so concurrent
-- claims can overshoot by up to (LIMIT 10) x per-call cost. What makes the
-- read race-free is that every caller holds the quiz row FOR UPDATE (the
-- claim phase and the finalize re-check), so the ledger read cannot
-- interleave with another claim for the same quiz.
--
-- Fail-closed: any exception returns mark_rate_limited rather than ok, so a
-- broken ledger read cannot spend money.
create or replace function public.check_mark_spend(p_quiz uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tokens bigint;
  v_usd    numeric;
begin
  select coalesce(sum(tokens), 0), coalesce(sum(usd), 0)
    into v_tokens, v_usd
    from public.ai_marking_ledger
   where quiz_id = p_quiz
     and day = current_date;

  if v_tokens >= 50000 or v_usd >= 5 then
    return jsonb_build_object('error', 'mark_rate_limited');
  end if;

  return jsonb_build_object('ok', true);
exception when others then
  return jsonb_build_object('error', 'mark_rate_limited');
end;
$$;

revoke execute on function public.check_mark_spend(uuid) from public, anon, authenticated;
grant execute on function public.check_mark_spend(uuid) to service_role;

-- ─── 4. sweep_ai_marks — phase 1, CLAIM only ──────────────────────────
-- A7-1: the invoker is PINNED (cron job `innovision-ai-mark-sweep`, 1-min,
-- plus the worker route's post-claim call). Returns the claimed batch, a
-- per-claim token, and the worker URL/key so the caller can POST.
--
-- The claim predicate has FIVE arms, and each exists to close a specific
-- unreachable-row hole:
--   queued AND attempts < 3                 — the normal path
--   failed AND attempts < 3                 — R3-M2: a transient failure
--                                             must RETRY, not finalize at 0
--   failed AND attempts >= 3                — A6-1: ESCALATION-ONLY. Without
--                                             it the row is unreachable, the
--                                             answer stays pending, and
--                                             v_all_done blocks the class.
--   marking AND stale AND attempts < 3      — FS-3: crashed-worker lease
--   marking AND stale AND attempts >= 3     — A6-1/A6-2: same hole for a
--                                             worker that crashed AT the cap
--
-- The two `attempts >= 3` arms set NO claim token and are NOT handed to the
-- worker: escalation is a separate RPC (§5) because plpgsql cannot COMMIT
-- mid-body, so an escalation write inside this transaction would share the
-- claim's locks and roll back with it.
create or replace function public.sweep_ai_marks()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token     uuid := gen_random_uuid();
  v_rows      jsonb := '[]'::jsonb;
  v_quiz_ids  uuid[];
  v_quiz      uuid;
  v_spend     jsonb;
  v_blocked   uuid[] := '{}';
  v_url       text;
  v_key       text;
begin
  -- D2-14: a NEW LEAF lock namespace. Disjoint from quiz_append:/quiz_write:/
  -- quiz_start:/quiz_publish:/quiz_reveal:/student_quiz_append:. The escalate
  -- job shares THIS lock, so the two are serialized and never concurrent.
  perform pg_advisory_xact_lock(hashtext('ai_mark_sweep'));

  -- A7-6/FINAL-audit ORDERING: take the per-quiz QUIZZES locks BEFORE the
  -- ledger rows, so the claim matches the pinned global order
  -- (quizzes → quiz_sessions → session_answers → ledger).
  select array_agg(distinct l.quiz_id) into v_quiz_ids
    from public.ai_marking_ledger l
   where (l.status = 'queued' and l.attempts < 3)
      or (l.status = 'failed' and l.attempts < 3)
      or (l.status = 'failed' and l.attempts >= 3)
      or (l.status = 'marking' and l.claimed_at < now() - interval '5 minutes' and l.attempts < 3)
      or (l.status = 'marking' and l.claimed_at < now() - interval '5 minutes' and l.attempts >= 3);

  if v_quiz_ids is not null then
    -- Deterministic order so two concurrent sweeps cannot deadlock on the
    -- quizzes locks (the leaf lock above already serializes them, but the
    -- ORDER BY keeps the lock sequence stable regardless).
    foreach v_quiz in array (select array_agg(q order by q) from unnest(v_quiz_ids) q) loop
      perform 1 from public.quizzes where id = v_quiz for update;

      -- D2-15: the quizzes row IS the serialization point for the spend
      -- read — the ledger already carries quiz_id, so no quiz_sessions
      -- correlation is needed (v4.2's was wrong).
      v_spend := public.check_mark_spend(v_quiz);
      if v_spend ? 'error' then
        v_blocked := v_blocked || v_quiz;
      end if;
    end loop;
  end if;

  -- Spend-exceeded rows: concrete mechanism (R3-MIN2), not "left queued".
  -- They become 'failed' + attempts+1 so the retry cap advances and the
  -- escalation path (§5) eventually resolves the answer as needs_review.
  -- The needs_review WRITE is deliberately NOT here (A6-2).
  update public.ai_marking_ledger l
     set status = 'failed',
         attempts = least(l.attempts + 1, 3),
         day = current_date,
         -- audit-4 D5: clear the token so an in-flight worker from a prior
         -- claim can no longer finalize this row (its token check would
         -- otherwise still pass and overwrite the spend-block).
         claim_token = null
   where l.quiz_id = any(v_blocked)
     and l.status in ('queued', 'failed', 'marking')
     and l.attempts < 3;

  -- The real claim. SKIP LOCKED lets a second sweeper (or the operator's
  -- manual invocation) take a different slice instead of blocking.
  --
  -- NOTE the shape: a bare `UPDATE ... RETURNING ... INTO v_rows` would keep
  -- only the FIRST row (plpgsql INTO takes one row and discards the rest),
  -- so the rows are aggregated in the outer SELECT. v_rows is therefore
  -- ALWAYS a jsonb array, which is what the POST body and the caller expect.
  with claimed as (
    select l.id
      from public.ai_marking_ledger l
     where ((l.status = 'queued' and l.attempts < 3)
         or (l.status = 'failed' and l.attempts < 3)
         or (l.status = 'marking' and l.claimed_at < now() - interval '5 minutes' and l.attempts < 3))
       and not (l.quiz_id = any(v_blocked))
     order by l.created_at
     for update skip locked
     limit 10
  ),
  upd as (
    update public.ai_marking_ledger l
       set status = 'marking',
           attempts = l.attempts + 1,
           claimed_at = now(),
           claim_token = v_token,
           day = current_date
      from claimed c
     where l.id = c.id
    returning jsonb_build_object(
      'ledger_id', l.id,
      'session_id', l.session_id,
      'question_id', l.question_id,
      'attempt_version', l.attempt_version,
      'quiz_id', l.quiz_id
    ) as j
  )
  select coalesce(jsonb_agg(j), '[]'::jsonb) into v_rows from upd;

  -- Worker key source (A5-4), in priority order, and NEVER a literal in a
  -- migration. A missing key simply omits the POST — the claim above has
  -- already committed, so attempts advanced and escalation stays reachable.
  --
  --  1. Vault secret `ai_mark_worker_key` (the encrypted-at-rest home; the
  --     deploy script writes it there — see deploy/sync-migrations.sh).
  --  2. `app.settings.ai_mark_worker_key` (a database-level GUC, for hosts
  --     where Vault is unavailable).
  --
  -- Both hold the SAME value the route accepts: AI_MARK_WORKER_KEY, or the
  -- service-role key when that named knob is unset (route-side fallback).
  begin
    select decrypted_secret into v_key
      from vault.decrypted_secrets
     where name = 'ai_mark_worker_key'
     limit 1;
  exception when others then
    v_key := null;
  end;

  if v_key is null then
    begin
      v_key := current_setting('app.settings.ai_mark_worker_key', true);
    exception when others then
      v_key := null;
    end;
  end if;

  -- Worker URL: prefer the GUC the deploy script provisions; fall back to the
  -- Vault secret of the same intent so either provisioning path works.
  v_url := current_setting('app.settings.ai_mark_worker_url', true);

  if v_url is null then
    begin
      select decrypted_secret into v_url
        from vault.decrypted_secrets
       where name = 'ai_mark_worker_url'
       limit 1;
    exception when others then
      v_url := null;
    end;
  end if;

  -- A5-3: the POST is enqueued after the claim's writes and wrapped in its
  -- OWN exception subtransaction. If pg_net is absent, the claim still
  -- commits — otherwise every tick would roll back and attempts would never
  -- advance. (The enqueue shares the claim's transaction — it is a
  -- millisecond queue insert, not the 45s model call, which the worker runs
  -- outside any transaction — so the advisory lock is held only briefly.)
  if v_url is not null and v_key is not null and jsonb_array_length(v_rows) > 0 then
    begin
      perform net.http_post(
        url := v_url,
        body := jsonb_build_object(
          'claim_token', v_token,
          'rows', v_rows
        ),
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || v_key
        )
      );
    exception when others then
      raise notice 'ai-mark worker POST failed; rows remain claimed until the lease expires';
    end;
  end if;

  return jsonb_build_object(
    'claim_token', v_token,
    'rows', v_rows,
    'count', jsonb_array_length(v_rows)
  );
end;
$$;

revoke execute on function public.sweep_ai_marks() from public, anon, authenticated;
grant execute on function public.sweep_ai_marks() to service_role;

-- ─── 5. escalate_stale_marks — phase 1b, own txn (A6-1/A6-2/A6-9) ─────
-- Rows that exhausted the retry cap (failed OR stale-marking at
-- attempts >= 3) get their ANSWER resolved as needs_review, so the pending
-- sentinel clears and v_all_done / the digest can fire.
--
-- Lock order: quiz_sessions → session_answers (the ledger is last and is
-- only UPDATEd, never locked FOR UPDATE here — the claim holds its rows).
create or replace function public.escalate_stale_marks()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_escalated int := 0;
  v_quiz_ids uuid[];
  v_quiz uuid;
begin
  -- Shares the sweep's leaf lock (A7-1): the escalate job is serialized
  -- against the sweep, never concurrent with it.
  perform pg_advisory_xact_lock(hashtext('ai_mark_sweep'));

  select array_agg(distinct l.quiz_id) into v_quiz_ids
    from public.ai_marking_ledger l
   where l.attempts >= 3
     and (l.status = 'failed'
          or (l.status = 'marking' and l.claimed_at < now() - interval '5 minutes'));

  if v_quiz_ids is null then
    return 0;
  end if;

  -- 1) Lock the SESSIONS that own the answers we are about to write (the
  --    pinned order: quiz_sessions before session_answers).
  perform 1
     from public.quiz_sessions s
    where s.id in (
      select l.session_id from public.ai_marking_ledger l
       where l.attempts >= 3
         and (l.status = 'failed'
              or (l.status = 'marking' and l.claimed_at < now() - interval '5 minutes'))
    )
    order by s.id
     for update;

  -- 2) Resolve the answers. Score 0 stands (mark_score stays NULL under
  --    pending_shape until this write); is_correct stays false.
  --    An answer already resolved (needs_review/marked by an override or an
  --    earlier escalation) is left alone — the guard is the same
  --    "only unresolved rows" rule the finalizer uses.
  update public.session_answers sa
     set mark_status = 'needs_review',
         marked_at = clock_timestamp()
    from public.ai_marking_ledger l
   where l.session_id = sa.session_id
     and l.question_id = sa.question_id
     and l.attempts >= 3
     and (l.status = 'failed'
          or (l.status = 'marking' and l.claimed_at < now() - interval '5 minutes'))
     and sa.mark_status in ('pending', 'failed');

  -- 3) Close the ledger rows so they stop matching the claim predicate.
  --    The RETURN value counts these — the function's job is resolving stale
  --    MARKING ROWS, and a row whose answer was already adjudicated still
  --    needs closing (otherwise it is re-examined on every tick forever).
  update public.ai_marking_ledger l
     set status = 'needs_review',
         claim_token = null
   where l.attempts >= 3
     and (l.status = 'failed'
          or (l.status = 'marking' and l.claimed_at < now() - interval '5 minutes'));
  get diagnostics v_escalated = row_count;

  -- 4) Recompute each affected session's score with the D10 arithmetic, then
  --    re-run the completion checks (A6-9). Without this step a
  --    pending-only-last-completion resolved by escalation would wait for the
  --    next 5-min autoclose tick before revealing.
  foreach v_quiz in array (select array_agg(q order by q) from unnest(v_quiz_ids) q) loop
    perform 1 from public.quizzes where id = v_quiz for update;

    update public.quiz_sessions s
       set score = (
         select coalesce(sum(coalesce(sa.mark_score,
                      case when sa.is_correct then 1 else 0 end)), 0)
           from public.session_answers sa
          where sa.session_id = s.id
            and sa.mark_status <> 'pending')
     where s.quiz_id = v_quiz
       and s.status = 'completed';

    perform public.recheck_quiz_completion(v_quiz);
  end loop;

  return v_escalated;
end;
$$;

revoke execute on function public.escalate_stale_marks() from public, anon, authenticated;
grant execute on function public.escalate_stale_marks() to service_role;

-- ─── 6. recheck_quiz_completion ───────────────────────────────────────
-- The shared "can this quiz now reveal / announce?" check, called by the
-- escalation and the finalizer after resolving marks (L5/X2-7/A6-9). It is
-- the SAME predicate pair as submit_session's v_all_done arm and
-- quiz_autoclose's digest arm, factored out so the three cannot drift.
create or replace function public.recheck_quiz_completion(p_quiz uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_id uuid;
  v_enrolled int;
  v_completed int;
begin
  -- Serialize against a concurrent submit's count-then-reveal.
  perform pg_advisory_xact_lock(hashtext('quiz_completed_all:' || p_quiz::text));

  -- (a) auto-reveal arm — mirrors submit_session's v_all_done.
  update public.quizzes q
     set results_revealed_at = clock_timestamp()
   where q.id = p_quiz
     and q.auto_reveal_on_complete
     and q.results_revealed_at is null
     and exists (
       select 1 from public.quiz_sessions done
        where done.quiz_id = q.id
          and done.mode = 'assessment'
          and done.status = 'completed'
     )
     and not exists (
       select 1 from public.quiz_sessions s2
        where s2.quiz_id = q.id
          and s2.mode = 'assessment'
          and s2.last_activity_at >= clock_timestamp() - interval '2 hours'
     )
     and not exists (
       select 1 from public.session_answers sa
        join public.quiz_sessions s3 on s3.id = sa.session_id
        where s3.quiz_id = q.id
          and sa.mark_status = 'pending'
     );

  -- (b) digest arm — mirrors quiz_autoclose's quiz_completed_all insert.
  select q.class_id into v_class_id from public.quizzes q where q.id = p_quiz;

  select count(*) into v_enrolled
    from public.class_enrollments ce
   where ce.class_id = v_class_id;

  select count(distinct x.student_id) into v_completed
    from public.quiz_sessions x
   where x.quiz_id = p_quiz
     and x.status = 'completed'
     and x.submitted_at is not null
     and x.mode = 'assessment'
     and not exists (
       select 1 from public.session_answers sa
        where sa.session_id = x.id
          and sa.mark_status = 'pending'
     );

  if v_enrolled > 0 and v_completed >= v_enrolled then
    insert into public.notifications (recipient_id, type, payload, dedupe_key)
    select c.lecturer_id,
           'quiz_completed_all',
           jsonb_build_object('quiz_id', q.id, 'quiz_title', q.title),
           'quiz_completed_all:' || q.id::text
      from public.quizzes q
      join public.classes c on c.id = q.class_id
     where q.id = p_quiz
    on conflict (recipient_id, dedupe_key) do nothing;
  end if;
end;
$$;

revoke execute on function public.recheck_quiz_completion(uuid) from public, anon, authenticated;
grant execute on function public.recheck_quiz_completion(uuid) to service_role;

-- ─── 7. finalize_ai_mark — phase 3 ────────────────────────────────────
-- ONE short transaction per batch. `p_rows` is the worker's result array:
--   [{ledger_id, session_id, question_id, attempt_version,
--     claim_token, ok: bool, score?, confidence?, rationale?, tokens?, usd?}]
--
-- D2-13 (epoch guard) + A6-4 (claim-token guard): the UPDATE writes ONLY if
-- the row is still pending/failed AND the attempt epoch is unchanged AND the
-- ledger row still carries THIS claim's token. 0 rows affected ⇒ discard
-- (a lecturer override or a superseding claim won; no retry).
--
-- A7-4: the SET list includes `is_correct = (score >= 0.5)`. Without it an
-- AI-correct answer would still render the red ✗ and count wrong in
-- insights/export even though mark_score scored it — the override RPC sets
-- it (§5 of 0058) and finalize must match.
--
-- R3-MIN3: a row whose epoch guard discards it is still closed as 'marked'
-- with a `discarded` note, so nothing lingers in 'marking'. Its tokens are
-- already booked by the spend accounting.
create or replace function public.finalize_ai_mark(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row       jsonb;
  v_ledger_id uuid;
  v_session   uuid;
  v_question  uuid;
  v_epoch     int;
  v_token     uuid;
  v_ok        boolean;
  v_score     numeric;
  v_conf      numeric;
  v_rationale text;
  v_tokens    int;
  v_usd       numeric;
  v_applied   int := 0;
  v_discarded int := 0;
  v_failed    int := 0;
  v_status    text;
  v_quiz_ids  uuid[] := '{}';
  v_quiz      uuid;
  v_affected  int;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('error', 'invalid_rows');
  end if;

  -- AB-BA DEADLOCK GUARD. This function's own write order is ledger →
  -- quizzes (the per-row loop closes ledger rows, then the trailing loop
  -- takes quizzes FOR UPDATE), while sweep_ai_marks takes quizzes BEFORE its
  -- ledger rows. Two concurrent calls therefore lock the same pair in
  -- opposite orders and Postgres kills one with a deadlock error —
  -- reproduced live: a sweep and a finalize over one quiz deadlock reliably.
  --
  -- Taking the sweep's own leaf lock serializes the two, exactly as the
  -- escalate job already does (A7-1: "the escalate job shares the
  -- ai_mark_sweep leaf lock, serialized against the sweep, never
  -- concurrent"). finalize_ai_mark is the third participant in that
  -- namespace and must join it.
  perform pg_advisory_xact_lock(hashtext('ai_mark_sweep'));

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_ledger_id := (v_row ->> 'ledger_id')::uuid;
    v_session   := (v_row ->> 'session_id')::uuid;
    v_question  := (v_row ->> 'question_id')::uuid;
    v_epoch     := coalesce((v_row ->> 'attempt_version')::int, 1);
    v_token     := (v_row ->> 'claim_token')::uuid;
    v_ok        := coalesce((v_row ->> 'ok')::boolean, false);
    v_tokens    := greatest(coalesce((v_row ->> 'tokens')::int, 0), 0);
    v_usd       := greatest(coalesce((v_row ->> 'usd')::numeric, 0), 0);
    v_score     := null;
    v_conf      := null;
    v_rationale := null;

    if v_ok then
      v_score := (v_row ->> 'score')::numeric;
      v_conf  := (v_row ->> 'confidence')::numeric;
      v_rationale := left(coalesce(v_row ->> 'rationale', ''), 300);
    end if;

    -- Lock order: quiz_sessions FIRST, then session_answers (D2-12).
    select s.quiz_id into v_quiz
      from public.quiz_sessions s
     where s.id = v_session
      for update;

    if v_quiz is null then
      -- Session vanished (cascade delete). Close the ledger row so it stops
      -- matching the claim predicate. Unreachable in practice (the ledger's
      -- session_id FK is ON DELETE CASCADE, so the row is gone with the
      -- session) — but if it ever runs, bump attempts to 3 as well so the
      -- row cannot be re-claimed forever (audit-4 n6).
      update public.ai_marking_ledger
         set status = 'failed',
             claim_token = null,
             attempts = 3
       where id = v_ledger_id;
      v_failed := v_failed + 1;
      continue;
    end if;

    if v_quiz <> all(v_quiz_ids) then
      v_quiz_ids := v_quiz_ids || v_quiz;
    end if;

    -- A6-4: verify the claim token before ANY write for this row.
    if not exists (
      select 1 from public.ai_marking_ledger l
       where l.id = v_ledger_id and l.claim_token = v_token
    ) then
      v_discarded := v_discarded + 1;
      continue;
    end if;

    if v_ok then
      if v_score is null or v_score not in (0, 0.5, 1) then
        -- A malformed score is a FAILED mark, never a silent 0 or 1.
        v_ok := false;
      end if;
    end if;

    if v_ok then
      -- confidence < 0.55 ⇒ needs_review, but the score STANDS (the model
      -- did produce a mark; a human should confirm it).
      if v_conf is not null and v_conf < 0.55 then
        v_status := 'needs_review';
      else
        v_status := 'marked';
      end if;

      update public.session_answers
         set mark_score = v_score,
             mark_status = v_status,
             is_correct = (v_score >= 0.5),
             marked_at = clock_timestamp(),
             mark_metadata = jsonb_build_object(
               'rationale', v_rationale,
               'confidence', v_conf,
               'model', 'glm'
             )
       where session_id = v_session
         and question_id = v_question
         and mark_status in ('pending', 'failed')
         and attempt_version = v_epoch;

      get diagnostics v_affected = row_count;

      if v_affected = 0 then
        -- Override or a newer epoch won. Close the ledger row as marked with
        -- a discarded note (R3-MIN3) — never leave it in 'marking'.
        update public.ai_marking_ledger
           set status = 'marked',
               claim_token = null,
               tokens = v_tokens,
               usd = v_usd,
               day = current_date
         where id = v_ledger_id;
        v_discarded := v_discarded + 1;
      else
        update public.ai_marking_ledger
           set status = v_status,
               claim_token = null,
               tokens = v_tokens,
               usd = v_usd,
               day = current_date
         where id = v_ledger_id;
        v_applied := v_applied + 1;
      end if;
    else
      -- Model/Zod/abort failure. The answer STAYS pending (scores stay 0 via
      -- pending_shape) so the R3-M2 claim predicate retries it until
      -- attempts >= 3, at which point escalation resolves it.
      update public.ai_marking_ledger
         set status = 'failed',
             claim_token = null,
             tokens = v_tokens,
             usd = v_usd,
             day = current_date
       where id = v_ledger_id;
      v_failed := v_failed + 1;
    end if;
  end loop;

  -- Recompute the affected sessions' scores with the D10 arithmetic, then
  -- re-run the completion checks (L2/L5/X2-7). Score recompute is skipped
  -- for sessions that still hold a pending answer — the SUM already ignores
  -- pending rows, so writing it is safe either way, but the reveal check
  -- below is what actually gates.
  foreach v_quiz in array (select array_agg(q order by q) from unnest(v_quiz_ids) q) loop
    perform 1 from public.quizzes where id = v_quiz for update;

    update public.quiz_sessions s
       set score = (
         select coalesce(sum(coalesce(sa.mark_score,
                      case when sa.is_correct then 1 else 0 end)), 0)
           from public.session_answers sa
          where sa.session_id = s.id
            and sa.mark_status <> 'pending')
     where s.quiz_id = v_quiz
       and s.status = 'completed';

    perform public.recheck_quiz_completion(v_quiz);
  end loop;

  return jsonb_build_object(
    'ok', true,
    'applied', v_applied,
    'discarded', v_discarded,
    'failed', v_failed
  );
end;
$$;

revoke execute on function public.finalize_ai_mark(jsonb) from public, anon, authenticated;
grant execute on function public.finalize_ai_mark(jsonb) to service_role;

-- ─── 8. student_pending_count ─────────────────────────────────────────
-- FS-4/FC-3: the EndScreen's pending banner needs a source that is NOT
-- reveal-gated (the only other one, student_results, returns not_revealed
-- pre-reveal, so the banner would always show "waiting for reveal").
--
-- It is a COUNT, not an oracle: pending_count reveals only how many of the
-- caller's OWN answers are unresolved — never which, never their marks.
-- No-oracle: a foreign session returns not_found, identical to a missing one.
create or replace function public.student_pending_count(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_pending int;
  v_failed  int;
  v_revealed boolean;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id and s.student_id = auth.uid();

  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  select count(*) filter (where sa.mark_status = 'pending'),
         count(*) filter (where sa.mark_status = 'failed')
    into v_pending, v_failed
    from public.session_answers sa
   where sa.session_id = p_session_id;

  v_revealed := public.is_student_reveal_allowed(v_session.quiz_id);

  return jsonb_build_object(
    'pending_count', v_pending,
    'failed_count', v_failed,
    'revealed', v_revealed
  );
end;
$$;

revoke execute on function public.student_pending_count(uuid) from public, anon;
grant execute on function public.student_pending_count(uuid) to authenticated;

-- audit-4 D11: republish the schema cache for the self-hosted (VPS) path —
-- the new ledger table, the six new RPCs and their arities are a 404 until
-- PostgREST reloads. Exactly one NOTIFY per file, at the end.
notify pgrst, 'reload schema';
