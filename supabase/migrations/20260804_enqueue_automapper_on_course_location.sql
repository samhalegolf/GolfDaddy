-- Queue the server-side AutoMapper when Studio (or any trusted publisher) writes a
-- usable course centre into course_maps but no geometry exists yet.
--
-- The mapper worker already has a scheduled sweeper (every three minutes), so this
-- trigger only owns durable queue creation. It deliberately does not make an HTTP
-- call from Postgres. The existing worker owns execution, retries and persistence.

create or replace function public.enqueue_automapper_for_course_location()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  has_objects boolean;
  has_holes boolean;
begin
  has_objects := coalesce(jsonb_typeof(new.objects_json) = 'object' and jsonb_object_length(new.objects_json) > 0, false);
  has_holes := coalesce(jsonb_typeof(new.holes_json) = 'object' and jsonb_object_length(new.holes_json) > 0, false);

  -- A confirmed/published centre is the minimum input AutoMapper needs. Existing
  -- geometry is terminal for this trigger; mapper-version remaps remain owned by
  -- course-mapper-jobs.mjs rather than being silently started by an ordinary save.
  if new.published is distinct from true
    or new.course_lat is null
    or new.course_lng is null
    or has_objects
    or has_holes then
    return new;
  end if;

  -- On UPDATE, enqueue only when the location becomes usable or actually changes.
  -- This prevents unrelated metadata writes from repeatedly creating mapper jobs.
  if tg_op = 'UPDATE'
    and old.published is not distinct from new.published
    and old.course_lat is not distinct from new.course_lat
    and old.course_lng is not distinct from new.course_lng then
    return new;
  end if;

  -- Preserve the queue's one-live-job-per-course rule. A new location correction
  -- may enqueue after an older failed/completed run, but never beside queued/running work.
  if exists (
    select 1
    from public.course_mapper_jobs
    where course_id = new.course_id
      and kind = 'automap'
      and status in ('queued', 'running')
  ) then
    return new;
  end if;

  insert into public.course_mapper_jobs (
    course_id,
    kind,
    status,
    mapper_version,
    requested_by
  ) values (
    new.course_id,
    'automap',
    'queued',
    'v1',
    'course-location-trigger'
  );

  return new;
end;
$$;

drop trigger if exists course_maps_enqueue_automapper_on_location on public.course_maps;

create trigger course_maps_enqueue_automapper_on_location
after insert or update of published, course_lat, course_lng
on public.course_maps
for each row
execute function public.enqueue_automapper_for_course_location();

comment on function public.enqueue_automapper_for_course_location() is
'Queues AutoMapper when a published course gains a usable centre and has no geometry.';
