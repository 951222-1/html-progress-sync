-- Additive fields for caregiver per-meal swallow counts and event classification.
-- Existing meal rows remain version 1 and are intentionally marked as not fully classifiable.

alter table public.meal_sessions
    add column if not exists total_swallow_count integer;

alter table public.meal_sessions
    add column if not exists event_schema_version smallint not null default 1;
