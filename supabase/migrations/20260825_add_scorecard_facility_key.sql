-- Group distinct scorecard cards that belong to one facility.
--
-- course_scorecards has always been one row per course_key (the card's own name,
-- lowercased). That is still right for a single-course club, but a multi-course
-- facility - Te Arai Links, North and South - needs its North and South cards
-- findable together without knowing in advance which name-spelling either was
-- stored under. facility_key answers "which scan/site did this card come from",
-- the same question course_maps.facility_key already answers for geometry rows,
-- and reuses the same value: the pinned course's course_id.
--
-- course_key stays the primary key - each distinct card still gets its own row,
-- keyed by its own name. This column is purely an additional read/group axis.

alter table course_scorecards add column if not exists facility_key text;

create index if not exists course_scorecards_facility_key_idx
  on course_scorecards (facility_key) where facility_key is not null;

comment on column course_scorecards.facility_key is
  'Groups distinct scorecard cards from one facility/scan, same value as course_maps.facility_key (the pinned course''s course_id). Null when resolved for a single-course site.';
