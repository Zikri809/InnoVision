-- ═══════════════════════════════════════════════════════════════════════
-- 0046 — audit-2 hardening (docs/audit/audit-2.md)
--
-- Fixes landed here (each keyed to its audit finding ID):
--   H-03  join_class: the throttle row is deleted ONLY on a successful
--         enroll insert. Previously any VALID code (own class, archived,
--         already-enrolled) wiped fail_count before the remaining checks,
--         so 4 bad guesses + 1 known-good code reset the brute-force
--         budget forever.
--   H-11  join_class: NULL-matric students are refused with a typed
--         'matric_required' error — the /matric-capture gate was
--         layout-only and /join (outside the student layout) enrolled
--         SSO students with no matric.
--   L-02  join_class: the RPC normalizes the code with the SAME rule as
--         the app (strip spaces/dashes) — previously only upper(trim),
--         so direct-RPC callers burned fail_count on inputs the app
--         accepts.
--   M-24  save_quiz_questions_web: the multi_select branch (0037's
--         6-arg fn) is ported verbatim — the 0041 rewrite dropped it, so
--         every allowMultiSelect generation emitting a multi row 422'd
--         AFTER the full LLM spend.
--   M-25  save_quiz_questions_web + clone_quiz move to the unified
--         'quiz_write:' advisory-lock namespace (0045 unified append/
--         reorder/save but missed the 0041 web fn and the 0037 clone).
--   M-07  reset_session refuses to delete a 'completed' assessment —
--         terminal evidence must be append-only; deleting one also
--         silently restored the retake budget. Flagged/active/paused
--         stay resettable (lecturer remedy flows).
--   M-06  pause_session on an ALREADY-paused session no longer touches
--         last_activity_at — pause spam kept the session "fresh",
--         hostage-holding the 2h auto-reveal and the sweeper forever.
--   C-02  quiz_sessions.face_verify_attempted_at + the silence cron's
--         outage-claim exemption now requires CORROBORATION: a fresh
--         face_unavailable_at only suppresses the flag while verify
--         attempts actually reach the server (any face_checks row, or
--         the route's attempt touch). A tampered client that blocks
--         verify POSTs while re-arming the claim every 5 min is no
--         longer exempt forever.
--   C-01  face_checks.frame_poses + attach_frame_poses(): the verify
--         route records the sidecar's per-frame yaw/pitch/roll for
--         lecturer audit (the audit's "at minimum" server-side fix —
--         full liveness gating needs sidecar spoof-model support).
--   C-03  questions/student_quiz_questions.image_path: anchored shape
--         CHECK (NOT VALID — legacy rows keep working, NEW writes are
--         blocked) + an ownership trigger that refuses a self-service
--         write of an image_path outside auth.uid()'s own folder. This
--         kills the direct-PostgREST poison vector behind the
--         cross-tenant remove()/copy() finding (route-side validation
--         also added in code).
--   M-12  profiles: an authenticated caller can no longer CHANGE a
--         non-null matric_no (extend protect_profile_restricted_columns)
--         and the 99xxxx system namespace is CHECK-enforced (NOT VALID)
--         — previously only app-level + INSERT triggers guarded it, so
--         a direct PATCH could squat the reserved range.
--   L-07  student_results: deterministic tiebreak (started_at DESC,
--         id DESC) so equal-started_at attempts can't flip across reads.
--   M-22  prune_expired_notifications: session_unlocked joins the 365d
--         urgent tier (PINNED_TYPES) instead of being pruned at 180d.
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- 1. join_class (H-03 + H-11 + L-02)
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.join_class(code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_id    uuid;
  v_title       text;
  v_archived_at timestamptz;
  v_rows        int;
  v_norm_code   text;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'student'
  ) then
    return jsonb_build_object('error', 'not_student');
  end if;

  -- H-11 (audit-2): the matric-capture gate is layout-only; /join sits
  -- OUTSIDE the student layout and the old body checked role only, so a
  -- NULL-matric SSO student could enroll with no captured identity. The
  -- authority gate lives HERE: the caller must already have a matric.
  if exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.matric_no is null
  ) then
    return jsonb_build_object('error', 'matric_required');
  end if;

  -- Throttle bookkeeping: create/refresh the attempt row first.
  insert into public.class_join_attempts as a (student_id)
  values (auth.uid())
  on conflict (student_id) do nothing;

  update public.class_join_attempts a
     set fail_count        = case when a.window_started_at < clock_timestamp() - interval '10 minutes'
                                then 0 else a.fail_count end,
         window_started_at = case when a.window_started_at < clock_timestamp() - interval '10 minutes'
                                  then clock_timestamp() else a.window_started_at end
   where a.student_id = auth.uid();

  if exists (
    select 1 from public.class_join_attempts
     where student_id = auth.uid()
       and locked_until is not null
       and locked_until > clock_timestamp()
  ) then
    return jsonb_build_object('error', 'join_locked');
  end if;

  -- L-02 (audit-2): canonicalize EXACTLY like the app's normalizeJoinCode
  -- (strip spaces/dashes, then upcase) so direct-RPC callers are judged on
  -- the same inputs the UI accepts instead of burning fail_count on them.
  v_norm_code := upper(regexp_replace(trim(code), '[\s-]', '', 'g'));

  select c.id, c.title, c.archived_at
    into v_class_id, v_title, v_archived_at
   from public.classes c
  where c.join_code = v_norm_code;

  if v_class_id is null then
    update public.class_join_attempts a
       set fail_count   = a.fail_count + 1,
           locked_until = case when a.fail_count + 1 >= 5
                               then clock_timestamp() + interval '15 minutes'
                               else a.locked_until end
     where a.student_id = auth.uid();
    return jsonb_build_object('error', 'invalid_code');
  end if;

  -- H-03 (audit-2): the counter is NO LONGER cleared merely because the
  -- code exists. archived/already-enrolled outcomes leave the failure
  -- state alone; only a REAL enrollment (v_rows = 1) proves code
  -- knowledge worth resetting the budget. (The old position — delete
  -- right after the lookup — let "4 wrong + 1 known-good" loop forever.)

  if v_archived_at is not null then
    return jsonb_build_object('error', 'class_archived');
  end if;

  insert into public.class_enrollments (class_id, student_id)
  values (v_class_id, auth.uid())
  on conflict (class_id, student_id) do nothing;

  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return jsonb_build_object('error', 'already_enrolled');
  end if;

  -- Success: clear any failure state.
  delete from public.class_join_attempts where student_id = auth.uid();

  return jsonb_build_object('class', jsonb_build_object(
    'id', v_class_id,
    'title', v_title
  ));
end;
$$;

revoke execute on function public.join_class(text) from public, anon;
grant execute on function public.join_class(text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 2. save_quiz_questions_web (M-24 + M-25)
--    0041 body verbatim EXCEPT: the 0037 multi_select branch is restored
--    and the lock joins the unified 'quiz_write:' namespace.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.save_quiz_questions_web(
  p_quiz_id         uuid,
  p_title           text,
  p_source_file_url text,
  p_source_text     text,
  p_questions       jsonb,
  p_mode            text default 'replace',
  p_web_sources     jsonb default null,
  p_source_paths    jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count          int;
  v_i              int;
  v_q              jsonb;
  v_type           text;
  v_prompt         text;
  v_options        text[];
  v_correct        int;
  v_correct_set    int[];
  v_expl           text;
  v_source_entry   jsonb;
  v_existing_count int;
  v_start_index    int;
  v_max_quiz_cap   int := 30;
  v_web_entries    jsonb := '[]'::jsonb;
  v_w              jsonb;
  v_web_url        text;
  v_file_entries   jsonb := '[]'::jsonb;
  v_path           text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  if not public.is_lecturer_of_quiz(p_quiz_id) then
    raise exception 'not_quiz_owner' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.quizzes q
    where q.id = p_quiz_id and q.status = 'draft'
  ) then
    raise exception 'quiz_not_draft' using errcode = 'P0001';
  end if;

  if p_mode not in ('replace', 'append') then
    raise exception 'invalid_mode' using errcode = 'P0001';
  end if;

  -- Bounded source_text cap to prevent storage bloat
  if p_source_text is not null and char_length(p_source_text) > 400000 then
    raise exception 'source_text_too_large' using errcode = 'P0001';
  end if;

  if p_questions is null or jsonb_typeof(p_questions) <> 'array' then
    raise exception 'invalid_questions_json' using errcode = 'P0001';
  end if;
  v_count := jsonb_array_length(p_questions);
  if (p_mode = 'replace' and v_count < 3) or (p_mode = 'append' and v_count < 1) or v_count > 30 then
    raise exception 'invalid_questions_json' using errcode = 'P0001';
  end if;

  if p_title is not null and (char_length(trim(p_title)) < 1 or char_length(p_title) > 200) then
    raise exception 'invalid_title' using errcode = 'P0001';
  end if;

  -- ─── Web-source validation (in-body; skip-invalid, never fatal) ────────
  if p_web_sources is not null then
    if jsonb_typeof(p_web_sources) <> 'array' then
      raise exception 'invalid_web_sources_json' using errcode = 'P0001';
    end if;
    for v_w in select * from jsonb_array_elements(p_web_sources) loop
      if jsonb_typeof(v_w) <> 'object' then
        continue;
      end if;
      v_web_url := coalesce(v_w ->> 'url', '');
      if v_web_url !~* '^https?://[^[:space:]]+$' or char_length(v_web_url) > 2048 then
        continue;
      end if;
      v_web_entries := v_web_entries || jsonb_build_object(
        'id', gen_random_uuid(),
        'kind', 'web',
        'url', v_web_url,
        'title', coalesce(left(v_w ->> 'title', 200), ''),
        'retrieved_at', coalesce(v_w ->> 'retrieved_at', clock_timestamp()::text),
        'query', coalesce(left(v_w ->> 'query', 200), '')
      );
    end loop;
  end if;

  -- ─── Source-path-list validation (0041; route pre-validates tenants) ───
  if p_source_paths is not null then
    if jsonb_typeof(p_source_paths) <> 'array' then
      raise exception 'invalid_source_paths_json' using errcode = 'P0001';
    end if;
    for v_w in select * from jsonb_array_elements(p_source_paths) loop
      if jsonb_typeof(v_w) <> 'string' then
        continue;
      end if;
      v_path := v_w #>> '{}';
      if v_path is null or char_length(trim(v_path)) = 0 then
        continue;
      end if;
      v_file_entries := v_file_entries || jsonb_build_object(
        'id', gen_random_uuid(),
        'filename', substring(v_path from '[^/]+$'),
        'storage_path', v_path,
        'added_at', clock_timestamp()
      );
    end loop;
  end if;

  -- Fallback: no explicit path list but a primary URL — the 0040 single-
  -- entry shape (import flows / any caller that only sends the URL).
  if v_file_entries = '[]'::jsonb and p_source_file_url is not null
     and p_source_file_url <> '' then
    v_file_entries := jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid(),
      'filename', substring(p_source_file_url from '[^/]+$'),
      'storage_path', p_source_file_url,
      'added_at', clock_timestamp(),
      'mode', p_mode
    ));
  end if;

  -- M-25 (audit-2): unified 'quiz_write:' namespace — this fn was the last
  -- 'quiz_replace:' holdout besides clone_quiz, so an AI generate could
  -- interleave with a manual add/reorder on the same quiz.
  perform pg_advisory_xact_lock(hashtext('quiz_write:' || p_quiz_id::text));

  if p_mode = 'replace' then
    delete from public.questions where quiz_id = p_quiz_id;
    v_start_index := 0;
  else
    select count(*), coalesce(max(order_index), -1) + 1
      into v_existing_count, v_start_index
      from public.questions
     where quiz_id = p_quiz_id;

    if (v_existing_count + v_count) > v_max_quiz_cap then
      raise exception 'quiz_question_limit_exceeded' using errcode = 'P0001';
    end if;
  end if;

  for v_i in 0 .. v_count - 1 loop
    v_q := p_questions -> v_i;
    if jsonb_typeof(v_q) <> 'object' then
      raise exception 'invalid_questions_json' using errcode = 'P0001';
    end if;

    v_type    := v_q ->> 'type';
    v_prompt  := v_q ->> 'prompt';
    v_options := coalesce((
      select array_agg(elem::text)
      from jsonb_array_elements_text(v_q -> 'options') as elem
    ), '{}'::text[]);
    v_correct := (v_q ->> 'correct_index')::int;
    v_expl    := v_q ->> 'explanation';

    if v_type is null or v_prompt is null
       or (v_q -> 'options') is null or jsonb_typeof(v_q -> 'options') <> 'array' then
      raise exception 'invalid_question_fields' using errcode = 'P0001';
    end if;

    -- M-24 (audit-2): the multi_select branch, ported verbatim from the
    -- 0037 6-arg fn (the 0041 rewrite dropped it — every allowMultiSelect
    -- generation emitting a multi row failed here AFTER the LLM spend).
    if v_type = 'multi_select' then
      -- Multi rows carry the correct SET; the scalar must be absent (the
      -- insert nulls it). Normalized sorted+distinct to match the trigger's
      -- canonical form.
      -- A jsonb `null` key is NOT SQL NULL (so `is not null` passes); test
      -- the TYPE, and reject null/non-numeric elements BEFORE the int cast
      -- (a bare 22P02 would surface as an unmapped 500 for direct callers).
      if jsonb_typeof(v_q -> 'correct_indices') <> 'array'
         or v_correct is not null
         or exists (
           select 1 from jsonb_array_elements(v_q -> 'correct_indices') elem
           where elem is not distinct from 'null'::jsonb
              or (elem::text) !~ '^[0-9]+$'
         ) then
        raise exception 'invalid_question_fields' using errcode = 'P0001';
      end if;
      v_correct_set := coalesce((
        select array_agg(distinct e order by e)
        from (select (elem::text)::int as e
              from jsonb_array_elements_text(v_q -> 'correct_indices') elem) s
      ), '{}'::int[]);
      if cardinality(v_correct_set) < 1
         or cardinality(v_correct_set) > cardinality(v_options)
         or exists (
           select 1 from unnest(v_correct_set) e
           where e < 0 or e >= cardinality(v_options)
         ) then
        raise exception 'invalid_question_fields' using errcode = 'P0001';
      end if;
      v_correct := null;
    else
      -- jsonb null ≠ SQL null: `jsonb_typeof(...)` on a jsonb null is 'null',
      -- so only a REAL array means "set present" on a scalar row.
      if v_correct is null or v_correct < 0
         or jsonb_typeof(v_q -> 'correct_indices') = 'array' then
        raise exception 'invalid_question_fields' using errcode = 'P0001';
      end if;
      v_correct_set := null;
    end if;

    insert into public.questions (
      quiz_id,
      order_index,
      type,
      prompt,
      options,
      correct_index,
      correct_indices,
      explanation
    )
    values (
      p_quiz_id,
      v_start_index + v_i,
      v_type::public.question_type,
      trim(v_prompt),
      v_options,
      v_correct,
      v_correct_set,
      case when v_expl is null or length(trim(v_expl)) = 0 then null else trim(v_expl) end
    );
  end loop;

  -- ─── Additive sources assembly (0041) ──────────────────────────────────
  -- File entries and web entries COMBINE (the 0040 CASE was either/or and
  -- silently dropped web citations whenever a file entry existed).
  if p_mode = 'replace' then
    update public.quizzes
       set title = coalesce(p_title, title),
           source_file_url = p_source_file_url,
           source_text = p_source_text,
           sources = v_file_entries || v_web_entries
     where id = p_quiz_id;
  else
    update public.quizzes
       set title = coalesce(title, p_title),
           source_file_url = coalesce(p_source_file_url, source_file_url),
           source_text = case
             when source_text is null or source_text = '' then p_source_text
             when p_source_text is null or p_source_text = '' then source_text
             else source_text || E'\n\n--- [Additional Source Material] ---\n\n' || p_source_text
           end,
           sources = coalesce(sources, '[]'::jsonb) || v_file_entries || v_web_entries
      where id = p_quiz_id;
   end if;
end;
$$;

revoke execute on function public.save_quiz_questions_web(uuid, text, text, text, jsonb, text, jsonb, jsonb) from public, anon;
grant execute on function public.save_quiz_questions_web(uuid, text, text, text, jsonb, text, jsonb, jsonb) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 3. clone_quiz (M-25): lock namespace quiz_replace: → quiz_write:
--    0037 body verbatim except the lock line.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.clone_quiz(
  p_src_quiz_id   uuid,
  p_dest_class_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src         public.quizzes%rowtype;
  v_dest        public.classes%rowtype;
  v_new_quiz_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  -- Source: class-ownership gate first (covers missing + foreign alike).
  if not public.is_lecturer_of_quiz(p_src_quiz_id) then
    raise exception 'not_quiz_owner' using errcode = 'P0001';
  end if;

  -- Destination: owned class, not archived (quiz-create precedent:
  -- classes/[id]/quizzes/route.ts refuses archived classes).
  if not public.is_lecturer_of_class(p_dest_class_id) then
    raise exception 'not_class_owner' using errcode = 'P0001';
  end if;

  select c.* into v_dest from public.classes c where c.id = p_dest_class_id;
  if v_dest.archived_at is not null then
    raise exception 'class_archived' using errcode = 'P0001';
  end if;

  -- Serialize against save/save_web/reorder/append on the source under the
  -- SAME unified 'quiz_write:' key (M-25: was quiz_replace:).
  perform pg_advisory_xact_lock(hashtext('quiz_write:' || p_src_quiz_id::text));

  select q.* into v_src from public.quizzes q where q.id = p_src_quiz_id;
  if not found then
    -- Unreachable for a verified owner; kept for drift safety.
    raise exception 'quiz_not_found' using errcode = 'P0001';
  end if;

  insert into public.quizzes (
    class_id,
    created_by,
    title,
    mode,
    status,
    time_limit_sec,
    source_text,
    allow_retake,
    max_attempts,
    shuffle_questions,
    auto_reveal_on_complete
  )
  values (
    p_dest_class_id,
    auth.uid(),
    left(trim(v_src.title), 200 - length(' (copy)')) || ' (copy)',
    v_src.mode,
    'draft',
    v_src.time_limit_sec,
    v_src.source_text,
    v_src.allow_retake,
    v_src.max_attempts,
    v_src.shuffle_questions,
    v_src.auto_reveal_on_complete
  )
  returning id into v_new_quiz_id;

  insert into public.questions (
    quiz_id,
    order_index,
    type,
    prompt,
    options,
    correct_index,
    correct_indices,
    explanation,
    image_path
  )
  select
    v_new_quiz_id,
    q.order_index,
    q.type,
    q.prompt,
    q.options,
    q.correct_index,
    q.correct_indices,
    q.explanation,
    q.image_path
  from public.questions q
  where q.quiz_id = p_src_quiz_id
  order by q.order_index;

  return v_new_quiz_id;
end;
$$;

revoke execute on function public.clone_quiz(uuid, uuid) from public, anon;
grant execute on function public.clone_quiz(uuid, uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 4. reset_session (M-07): refuse to delete terminal 'completed' evidence
--    0022 body verbatim except the status gate + richer audit metadata.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.reset_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'lecturer'
  ) then
    return jsonb_build_object('error', 'not_lecturer');
  end if;

  -- Lock + lecturer-ownership in ONE query (0011 pattern). Non-existent and
  -- not-owned fold into the same `not_owner` (no oracle).
  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id
     and public.is_lecturer_of_quiz(s.quiz_id)
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  if v_session.mode <> 'assessment' then
    return jsonb_build_object('error', 'not_assessment');
  end if;

  -- M-07 (audit-2): a 'completed' session is a graded academic record.
  -- Deleting one permanently destroyed the score evidence AND silently
  -- restored the retake budget (budget counts completed attempts only).
  -- Flagged/active/paused remain resettable — that is the lecturer remedy
  -- flow this RPC exists for.
  if v_session.status = 'completed' then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  delete from public.quiz_sessions where id = v_session.id;

  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    auth.uid(),
    v_session.student_id,
    'session_reset',
    jsonb_build_object(
      'session_id', v_session.id,
      'quiz_id', v_session.quiz_id,
      'prior_status', v_session.status,
      'answered_count', (
        select count(*) from public.session_answers sa where sa.session_id = v_session.id
      )
    )
  );

  -- Notification (D4: inline in the RPC). Double-reset race is already safe:
  -- the second caller's lock re-check finds nothing and returns not_owner
  -- before reaching this insert.
  begin
    insert into public.notifications (recipient_id, type, payload, dedupe_key)
    values (
      v_session.student_id,
      'session_reset',
      jsonb_build_object(
        'quiz_id', v_session.quiz_id,
        'quiz_title', (select q.title from public.quizzes q where q.id = v_session.quiz_id),
        'session_id', v_session.id
      ),
      'session_reset:' || v_session.id::text
    )
    on conflict (recipient_id, dedupe_key) do nothing;
  exception
    when unique_violation then null;
    when foreign_key_violation then null;
  end;

  return jsonb_build_object(
    'ok', true,
    'deleted_session_id', v_session.id,
    'student_id', v_session.student_id,
    'quiz_id', v_session.quiz_id
  );
end;
$$;

revoke execute on function public.reset_session(uuid) from public, anon;
grant execute on function public.reset_session(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 5. pause_session (M-06): no last_activity_at touch on already-paused
--    0044 body verbatim except the else-branch UPDATE.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.pause_session(p_session_id uuid, p_reason text default 'hand_loss')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_flag    boolean := false;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  if p_reason not in ('focus_lost', 'hard_blur', 'fullscreen_exit', 'hand_loss') then
    return jsonb_build_object('error', 'invalid_reason');
  end if;

  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id
     and s.student_id = auth.uid()
     and s.mode = 'assessment'
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  if v_session.status not in ('active', 'paused') then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  -- Pause counting (0043/0044):
  if p_reason = 'focus_lost' then
    v_session.focus_pause_count := coalesce(v_session.focus_pause_count, 0) + 1;
    v_flag := v_session.focus_pause_count >= 3;
  elsif p_reason = 'fullscreen_exit' then
    v_session.fullscreen_pause_count := coalesce(v_session.fullscreen_pause_count, 0) + 1;
  else
    -- hand_loss (0044): previously a plain pause — pause/recover cycling on
    -- it was an INVISIBLE time source. Counted now, flagged at 3.
    v_session.hand_pause_count := coalesce(v_session.hand_pause_count, 0) + 1;
    v_flag := v_session.hand_pause_count >= 3;
  end if;

  if v_flag then
    -- R1 (0021): a flag from `paused` must NOT preserve paused_at — unlock
    -- would otherwise credit the flagged idle period as exam time.
    update public.quiz_sessions
       set status = 'flagged',
           paused_at = null,
           focus_pause_count = v_session.focus_pause_count,
           fullscreen_pause_count = v_session.fullscreen_pause_count,
           hand_pause_count = v_session.hand_pause_count,
           last_pause_reason = p_reason,
           last_activity_at = clock_timestamp()
     where id = v_session.id;

    -- R3 (0021): quiz_id/session_id in metadata so lecturer_audit_view
    -- surfaces the row on the session timeline; reason now included so a
    -- future counted reason is correctly labeled.
    insert into public.audit_events (actor_id, subject_id, action, metadata)
    values (
      auth.uid(),
      auth.uid(),
      'auto_flag_focus_loss',
      jsonb_build_object(
        'focus_pause_count', v_session.focus_pause_count,
        'reason', p_reason,
        'quiz_id', v_session.quiz_id,
        'session_id', v_session.id
      )
    );
    return jsonb_build_object('sessionStatus', 'flagged');
  end if;

  if v_session.status = 'active' then
    update public.quiz_sessions
       set status = 'paused',
           paused_at = coalesce(paused_at, clock_timestamp()),
           focus_pause_count = v_session.focus_pause_count,
           fullscreen_pause_count = v_session.fullscreen_pause_count,
           hand_pause_count = v_session.hand_pause_count,
           last_pause_reason = p_reason,
           last_activity_at = clock_timestamp()
     where id = v_session.id;
  else
    -- Already paused (e.g. a second blur while recovering): persist the new
    -- count WITHOUT touching last_activity_at — M-06 (audit-2): the recount
    -- used to refresh the freshness signal, so pause→recover→pause spam held
    -- the 2h auto-reveal gate and the sweeper's "no fresh activity" check
    -- open forever (20/min route budget made the loop trivial).
    update public.quiz_sessions
       set focus_pause_count = v_session.focus_pause_count,
           fullscreen_pause_count = v_session.fullscreen_pause_count,
           hand_pause_count = v_session.hand_pause_count,
           last_pause_reason = p_reason
     where id = v_session.id;
  end if;

  return jsonb_build_object('sessionStatus', 'paused');
end;
$$;

revoke execute on function public.pause_session(uuid, text) from public, anon;
grant execute on function public.pause_session(uuid, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 6. C-01 minimum: per-frame pose audit trail
-- ─────────────────────────────────────────────────────────────────────
alter table public.face_checks
  add column if not exists frame_poses jsonb;

comment on column public.face_checks.frame_poses is
  'audit-2 C-01: sidecar-reported [{yaw,pitch,roll}] per non-empty frame, attached by the verify route. Lecturer-audit signal; full server-side liveness gating needs sidecar spoof-model support.';

create or replace function public.attach_frame_poses(
  p_session_id uuid,
  p_nonce      uuid,
  p_poses      jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;
  if p_poses is null or jsonb_typeof(p_poses) <> 'array' then
    raise exception 'invalid_poses_json' using errcode = 'P0001';
  end if;

  update public.face_checks fc
     set frame_poses = p_poses
   where fc.id = (
     select c.id
       from public.face_checks c
      where c.session_id = p_session_id
        and c.nonce = p_nonce
        and c.frame_poses is null
      order by c.checked_at desc
      limit 1
   )
     and exists (
       select 1 from public.quiz_sessions s
        where s.id = fc.session_id
          and s.student_id = auth.uid()
     );
end;
$$;

revoke execute on function public.attach_frame_poses(uuid, uuid, jsonb) from public, anon;
grant execute on function public.attach_frame_poses(uuid, uuid, jsonb) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 7. C-02: verify-attempt corroboration for outage claims
-- ─────────────────────────────────────────────────────────────────────
alter table public.quiz_sessions
  add column if not exists face_verify_attempted_at timestamptz;

comment on column public.quiz_sessions.face_verify_attempted_at is
  'audit-2 C-02: last time a verify POST reached the route (any outcome). Lets the silence cron distinguish a tampered client that BLOCKS verify POSTs (no attempts) from an honest outage where attempts flow but produce no face_checks row.';

-- The full 0045 body verbatim except: BOTH the cursor predicate and the
-- guarded UPDATE re-state the outage-claim exemption with a corroboration
-- disjunct — a fresh face_unavailable_at only suppresses the flag while
-- verify attempts keep arriving (any face_checks row, or the route touch).
create or replace function public.flag_verify_silent_sessions()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flagged int := 0;
  v_row public.quiz_sessions;
  v_seconds_since_check int;
begin
  -- Recency is keyed to session_answers.answered_at (the true answering
  -- signal), NOT last_activity_at: report_session_advisory also touches
  -- last_activity_at (0021), and advisories fire while faceStatus==='ready'
  -- with NO phase gating — a slow reader dwelling on feedback who leans back
  -- (looked_away advisory) would otherwise satisfy freshness while the
  -- suspended verify cadence produces no rows. False-flag vector, R1 review.
  for v_row in
    select s.*
      from public.quiz_sessions s
     where s.status = 'active'
       and s.mode = 'assessment'
       and s.face_exempt = false
       and (
         s.face_unavailable_at is null
         or s.face_unavailable_at < clock_timestamp() - interval '10 minutes'
         -- 0046 C-02 (audit-2) corroboration: a FRESH outage claim exempts
         -- the cron only while verify attempts actually reach the server.
         -- The re-arm (report_face_unavailable, 5-min window) used to renew
         -- the stamp forever, so blocking /api/face/verify + re-arming the
         -- claim every few minutes suppressed this flag for a whole exam.
         -- Corroboration = any face_checks row in the last 10 min (honest
         -- broken camera still records FAIL votes) OR the route's attempt
         -- touch (sidecar 503s record no row but DO touch the column).
         or exists (
           select 1 from public.face_checks fc
            where fc.session_id = s.id
              and fc.checked_at > clock_timestamp() - interval '10 minutes'
         )
         or s.face_verify_attempted_at > clock_timestamp() - interval '10 minutes'
       )
       and (
         select max(sa.answered_at)
           from public.session_answers sa
          where sa.session_id = s.id
       ) > clock_timestamp() - interval '90 seconds'
       and (
         -- COALESCE with started_at: a session with ZERO face_checks rows
         -- (tampered client that suppressed verifies from the very start)
         -- has max(checked_at) = NULL, and NULL < anything is NULL — without
         -- the coalesce the headline bypass case escapes the flag entirely.
         select coalesce(max(fc.checked_at), s.started_at)
           from public.face_checks fc
          where fc.session_id = s.id
       ) < clock_timestamp() - interval '300 seconds'
       -- 0044 return-from-hide grace (answer-count form). A tab-return
       -- catch-up verify takes a few seconds (capture + two spaced
       -- secondaries), so an honest returner has answered AT MOST once
       -- since her last check when the cron tick lands mid-capture — the
       -- grace SKIPS those (count <= 1 is NOT a candidate). A session whose
       -- verification is suppressed accumulates a SECOND post-check answer
       -- within the 300s silence window and is flagged from that moment;
       -- the count RESETS only when a real face_checks row commits (a
       -- verify), so a bot can pace answers but never clear the count.
       -- 0045 §4: the 0044 baseline shipped this term INVERTED (`<= 1`),
       -- which flagged the honest one-answer returner and excluded the
       -- suppressed session after its second answer — the exact opposite
       -- of the design comment. Fixed to `>= 2` (cursor + guarded UPDATE).
       and (
         select count(*) from public.session_answers sa
          where sa.session_id = s.id
            and sa.answered_at > coalesce(
              (select max(fc.checked_at) from public.face_checks fc
                where fc.session_id = s.id),
              s.started_at
            )
       ) >= 2
       -- Pause-resume guard: self_recover/unlock write NO face_checks row,
       -- the post-resume cadence fires its first verify only 30-45s later,
       -- and a quick answer lands within seconds — a session that paused
       -- >300s (its last check predates the pause) then answered would be
       -- flagged before its honest verify. Exempt sessions paused within the
       -- silence window. NOT an evasion loop: status='paused' blocks
       -- answering entirely (answer_question status gate), so entering pause
       -- buys a cheater nothing — only genuine recover/unlock flows reach
       -- this exemption, and the focus/hand 3-strike already polices pause
       -- cycling (0044).
       and (s.paused_at is null or s.paused_at > clock_timestamp() - interval '300 seconds')
       and exists (
         select 1
           from public.quizzes q
           join public.classes c on c.id = q.class_id
           join public.class_enrollments ce on ce.class_id = q.class_id
          where q.id = s.quiz_id
            and ce.student_id = s.student_id
            and q.status = 'live'
            and c.archived_at is null
       )
     order by s.last_activity_at desc
     limit 100
  loop
    v_seconds_since_check := extract(epoch from (
      clock_timestamp() - coalesce(
        (select max(fc.checked_at) from public.face_checks fc where fc.session_id = v_row.id),
        v_row.started_at
      )
    ))::int;

    -- The WHERE re-states EVERY freshness + exemption predicate (not just
    -- status): under READ COMMITTED a record_face_check that commits between
    -- the cursor snapshot and this UPDATE re-evaluates here, so a student
    -- whose verify just LANDED is never flagged on stale data.
    update public.quiz_sessions
       set status = 'flagged',
           paused_at = null,
           last_activity_at = clock_timestamp()
     where id = v_row.id
       and status = 'active'
       and mode = 'assessment'
       and face_exempt = false
       and (
         quiz_sessions.face_unavailable_at is null
         or quiz_sessions.face_unavailable_at < clock_timestamp() - interval '10 minutes'
         -- 0046 C-02 corroboration, cursor parity.
         or exists (
           select 1 from public.face_checks fc
            where fc.session_id = quiz_sessions.id
              and fc.checked_at > clock_timestamp() - interval '10 minutes'
         )
         or quiz_sessions.face_verify_attempted_at > clock_timestamp() - interval '10 minutes'
       )
       and (
         select max(sa.answered_at)
           from public.session_answers sa
          where sa.session_id = quiz_sessions.id
       ) > clock_timestamp() - interval '90 seconds'
       and (
         -- COALESCE parity with the cursor predicate (zero-check sessions).
         select coalesce(max(fc.checked_at), quiz_sessions.started_at)
           from public.face_checks fc
          where fc.session_id = quiz_sessions.id
       ) < clock_timestamp() - interval '300 seconds'
       -- 0044 grace (answer-count form), cursor parity (0045 inversion fix:
       -- flag only when the grace is exhausted, count >= 2).
       and (
         select count(*) from public.session_answers sa
          where sa.session_id = quiz_sessions.id
            and sa.answered_at > coalesce(
              (select max(fc.checked_at) from public.face_checks fc
                where fc.session_id = quiz_sessions.id),
              quiz_sessions.started_at
            )
       ) >= 2
       -- Pause-resume guard, cursor parity.
       and (quiz_sessions.paused_at is null
            or quiz_sessions.paused_at > clock_timestamp() - interval '300 seconds')
       -- Quiz-liveness restated too (a quiz that closed mid-scan is never
       -- flagged) — see header for why this is inlined, not can_student_view_quiz.
       and exists (
         select 1
           from public.quizzes q
           join public.classes c on c.id = q.class_id
           join public.class_enrollments ce on ce.class_id = q.class_id
          where q.id = quiz_sessions.quiz_id
            and ce.student_id = quiz_sessions.student_id
            and q.status = 'live'
            and c.archived_at is null
       );

    if found then
      v_flagged := v_flagged + 1;
      -- No actor_id (system flag; auth.uid() is null under cron) — subject_id
      -- carries the student; metadata carries quiz+session (R3: rows without
      -- them never surface on the session integrity timeline).
      insert into public.audit_events (actor_id, subject_id, action, metadata)
      values (
        null,
        v_row.student_id,
        'auto_flag_verify_silence',
        jsonb_build_object(
          'quiz_id', v_row.quiz_id,
          'session_id', v_row.id,
          'seconds_since_check', v_seconds_since_check
        )
      );
    end if;
  end loop;
  return v_flagged;
end;
$$;

revoke execute on function public.flag_verify_silent_sessions() from public, anon;
grant execute on function public.flag_verify_silent_sessions() to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 8. C-03 backstop: image_path shape + ownership at the DB layer
-- ─────────────────────────────────────────────────────────────────────
-- The route-side checks (src/lib/media/validation.ts helpers applied at
-- every privileged remove()/copy()) are the primary fix; these constraints
-- kill the DIRECT-PostgREST poison vector: RLS lets a row owner write its
-- own image_path, and the poisoned path then flows into service-role
-- storage.remove() from the delete/replace routes.

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'questions_image_path_shape'
  ) then
    alter table public.questions
      add constraint questions_image_path_shape
      check (image_path is null or image_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp)$')
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'sq_questions_image_path_shape'
  ) then
    alter table public.student_quiz_questions
      add constraint sq_questions_image_path_shape
      check (image_path is null or image_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp)$')
      not valid;
  end if;
end $$;

-- Ownership pin: an authenticated self-service write may only point the
-- column at the CALLER's own storage folder. Service-role callers (seeds,
-- backfills) have auth.uid() = null and are unaffected; the duplicate RPC
-- copies paths within one lecturer's own quiz set (same uid) so it passes.
create or replace function public.enforce_image_path_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.image_path is not null
     and auth.role() = 'authenticated'
     and auth.uid() is not null
     -- uid is a UUID (hex + dashes), safe to embed in the regex.
     and new.image_path !~ ('^' || auth.uid()::text || '/') then
    raise exception 'cannot_reference_foreign_image_path' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists tr_questions_image_path_ownership on public.questions;
create trigger tr_questions_image_path_ownership
  before insert or update of image_path on public.questions
  for each row
  execute function public.enforce_image_path_ownership();

drop trigger if exists tr_sq_questions_image_path_ownership on public.student_quiz_questions;
create trigger tr_sq_questions_image_path_ownership
  before insert or update of image_path on public.student_quiz_questions
  for each row
  execute function public.enforce_image_path_ownership();

-- ─────────────────────────────────────────────────────────────────────
-- 9. M-12: matric immutability + reserved namespace at the DB layer
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.protect_profile_restricted_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Sanctioned consent flows opt in by setting app.consent_write='on'
  -- in-transaction (grant_face_consent / revoke_face_consent). Everyone else
  -- is blocked — including SECURITY DEFINER callers that did not opt in,
  -- because auth.role() reads the JWT claim, not the function owner.
  if auth.role() = 'authenticated'
     and coalesce(current_setting('app.consent_write', true), '') <> 'on' then
    if NEW.role is distinct from OLD.role then
      raise exception 'cannot_change_role_directly' using errcode = '42501';
    end if;
    if NEW.consent_given_at is distinct from OLD.consent_given_at then
      raise exception 'cannot_change_consent_directly' using errcode = '42501';
    end if;
    -- M-12 (audit-2): a captured matric is immutable via self-service.
    -- The capture route enforces set-once in code; this closes the direct
    -- PATCH path (overwrite churn + reserved-range squatting via 99xxxx,
    -- which the format CHECK alone still allowed).
    if OLD.matric_no is not null
       and NEW.matric_no is distinct from OLD.matric_no then
      raise exception 'cannot_change_matric_directly' using errcode = '42501';
    end if;
  end if;
  return NEW;
end;
$$;

-- Reserved 99xxxx namespace as a CHECK (app + signup trigger already
-- refuse it; this closes the raw-PATCH hole). NOT VALID: the 0027 backfill
-- legitimately holds 99-matric rows and rewriting history is out of scope —
-- new/updated values are enforced regardless.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_matric_no_not_reserved'
  ) then
    alter table public.profiles
      add constraint profiles_matric_no_not_reserved
      check (matric_no is null or matric_no !~ '^99')
      not valid;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- 10. L-07: student_results deterministic tiebreak
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.student_results(p_quiz_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_score   int;
  v_total   int;
  v_questions jsonb;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'student'
  ) then
    return jsonb_build_object('error', 'not_student');
  end if;

  -- Single no-oracle gate: not enrolled / quiz gone / not revealed → same error.
  if not public.is_student_reveal_allowed(p_quiz_id) then
    return jsonb_build_object('error', 'not_revealed');
  end if;

  -- L-07 (audit-2): `, id desc` tiebreak — equal started_at attempts must
  -- not flip which attempt surfaces across reads (export/gradebook feeds
  -- already order started_at DESC, id DESC).
  select s.* into v_session
    from public.quiz_sessions s
   where s.quiz_id = p_quiz_id and s.student_id = auth.uid() and s.status = 'completed'
   order by s.started_at desc, s.id desc
   limit 1;

  if not found then
    return jsonb_build_object('error', 'not_revealed');
  end if;

  select count(*) into v_total
    from public.questions q
   where q.quiz_id = p_quiz_id;

  if v_session.mode = 'assessment' then
    v_score := coalesce(v_session.score, 0);
  else
    select count(*) into v_score
      from public.session_answers sa
     where sa.session_id = v_session.id and sa.is_correct;
  end if;

  select coalesce(jsonb_agg(js order by (js->>'order_index')::int), '[]'::jsonb) into v_questions
  from (
    select jsonb_build_object(
      'question_id', q.id,
      'order_index', q.order_index,
      'type', q.type,
      'prompt', q.prompt,
      'options', q.options,
      'selected_index', sa.selected_index,
      'selected_indices', sa.selected_indices,
      'is_correct', sa.is_correct,
      'correct_index', q.correct_index,
      'correct_indices', q.correct_indices,
      'explanation', q.explanation,
      'has_image', (q.image_path is not null)
    ) as js
    from public.questions q
    left join public.session_answers sa
      on sa.question_id = q.id and sa.session_id = v_session.id
    where q.quiz_id = p_quiz_id
  ) t;

  return jsonb_build_object(
    'score', v_score,
    'total', v_total,
    'questions', v_questions
  );
end;
$$;

revoke execute on function public.student_results(uuid) from public, anon;
grant execute on function public.student_results(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 11. M-22 (partial): session_unlocked joins the 365d urgent prune tier
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.prune_expired_notifications()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_read     bigint;
  v_unread   bigint;
  v_urgent   bigint;
  v_capped   bigint;
  v_urgent_const public.notification_type[] :=
    array['session_flagged','session_reset','removed_from_class',
          'results_revealed','face_unavailable_reported',
          'face_enrollment_held','session_unlocked']::public.notification_type[];
begin
  delete from public.notifications
   where read_at is not null
     and created_at < clock_timestamp() - interval '30 days';
  get diagnostics v_read = row_count;

  delete from public.notifications
   where read_at is null
     and created_at < clock_timestamp() - interval '180 days'
     and type <> all (v_urgent_const);
  get diagnostics v_unread = row_count;

  delete from public.notifications
   where read_at is null
     and created_at < clock_timestamp() - interval '365 days'
     and type = any (v_urgent_const);
  get diagnostics v_urgent = row_count;

  -- Hard cap: 500 READ rows per user (unread volume is bounded by real event
  -- rate; scoping the cap to read rows means retention can NEVER destroy an
  -- unseen integrity alert — D11).
  delete from public.notifications n
   where n.read_at is not null
     and n.seq <= (
       select x.seq from public.notifications x
        where x.recipient_id = n.recipient_id
          and x.read_at is not null
        order by x.seq desc
        offset 500 limit 1
     );
  get diagnostics v_capped = row_count;

  return jsonb_build_object(
    'pruned_read', v_read,
    'pruned_unread', v_unread,
    'pruned_unread_urgent', v_urgent,
    'pruned_over_cap', v_capped
  );
end;
$$;

revoke all on function public.prune_expired_notifications() from public, anon;
grant execute on function public.prune_expired_notifications() to service_role;
