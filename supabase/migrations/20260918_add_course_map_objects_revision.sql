-- A countable geometry revision for every course map.
--
-- The system already had a geometry "version": the newest of published_at/updated_at
-- (gd-course-package-shape.mjs objectsVersion). That answers "is mine older than yours",
-- which is all the staleness check ever needed, but it cannot be shown to a human as
-- "v1.4" and it cannot be stamped on a baked image. This column is the countable half.
--
-- Maintained by a TRIGGER, not by the callers, because four separate writers touch a
-- course's geometry - course-mapper-worker-background.mjs (resolved geometry, refined
-- shapes, collected objects: three distinct PATCHes) and functions/course-maps.mjs
-- (the Studio publish upsert) - and a version that any one of them can forget to bump
-- is worse than no version at all: it reads as authoritative and is silently wrong.
--
-- The trigger also PINS the value on every non-geometry update (new := old), so the
-- column cannot be set by hand from a PATCH body that happens to include it. Geometry
-- moving is the only thing that may move this number.

alter table public.course_maps
  add column if not exists objects_revision integer not null default 0;

-- Backfill BEFORE the trigger exists. Afterwards it would be a no-op: this is not a
-- geometry change, so the trigger would pin objects_revision straight back to 0.
-- Every course that already holds geometry starts life at revision 1; there is no
-- earlier history to reconstruct, and pretending otherwise would invent one.
update public.course_maps
   set objects_revision = 1
 where objects_revision = 0
   and (objects_json <> '{}'::jsonb or holes_json <> '{}'::jsonb);

create or replace function public.course_maps_bump_objects_revision()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    -- A row created with geometry already in it is revision 1, not 0. A row created
    -- empty (the Studio creates the shell before the mapper fills it) stays at 0 and
    -- gets its 1 from the mapper's first write, which IS a geometry change.
    if new.objects_json <> '{}'::jsonb or new.holes_json <> '{}'::jsonb then
      new.objects_revision := 1;
    else
      new.objects_revision := 0;
    end if;
    return new;
  end if;

  if new.objects_json is distinct from old.objects_json
     or new.holes_json is distinct from old.holes_json then
    new.objects_revision := coalesce(old.objects_revision, 0) + 1;
  else
    new.objects_revision := coalesce(old.objects_revision, 0);
  end if;
  return new;
end;
$$;

drop trigger if exists course_maps_objects_revision on public.course_maps;
create trigger course_maps_objects_revision
before insert or update on public.course_maps
for each row execute function public.course_maps_bump_objects_revision();
