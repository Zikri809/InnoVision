-- ═══════════════════════════════════════════════════════════════════════
-- 0026 — Fix notify_face_enrollment_held enum typing (bug from 0022)
--
-- The INSERT ... SELECT DISTINCT inside notify_face_enrollment_held used a
-- bare string literal ('face_enrollment_held') for the notifications.type
-- enum column. DISTINCT forces the select-list expressions to be typed
-- BEFORE insert-target coercion applies, so the unknown-type literal
-- resolves as text and Postgres rejects the statement:
--
--   ERROR: column "type" is of type notification_type but expression is of
--   type text (42804)
--
-- Net effect since 0022: any transition into face_enrollment_status =
-- 'pending_review' (duplicate detected at enroll) raised inside
-- enroll_face's UPDATE → the whole enroll RPC failed with a 500 instead of
-- recording pending_review + notifying the lecturers. Every other
-- notification path in 0022 uses plain SELECT/VALUES (assignment coercion
-- handles bare literals there) — verified live; this is the only broken
-- site.
--
-- Fix: recreate the function with an explicit ::public.notification_type
-- cast on the literal. Body otherwise identical to 0022.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.notify_face_enrollment_held()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Recipients = lecturers of classes the student is enrolled in (row-data
  -- traversal, never auth.uid()). Per-transition epoch key: every
  -- reject→retry cycle is a real event; same-second double-transitions
  -- collapse (accepted, tiny volume). A student in zero classes yields zero
  -- recipients (accepted).
  insert into public.notifications (recipient_id, type, payload, dedupe_key)
  select distinct c.lecturer_id,
         'face_enrollment_held'::public.notification_type,
         jsonb_build_object('student_id', new.id),
         'face_enrollment_held:' || new.id::text || ':'
           || extract(epoch from clock_timestamp())::bigint::text
    from public.class_enrollments ce
    join public.classes c on c.id = ce.class_id
   where ce.student_id = new.id
  on conflict (recipient_id, dedupe_key) do nothing;
  return null;
end;
$$;
