-- Additive fields for caregiver history classification and swallow-pause trends.
-- Existing meal rows remain version 1 and are intentionally marked as not fully classifiable.

alter table public.meal_sessions
    add column if not exists avg_swallow_pause double precision;

alter table public.meal_sessions
    add column if not exists event_schema_version smallint not null default 1;
