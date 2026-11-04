-- Online anti-choking application schema for the existing Supabase project.
-- Browser clients use only the publishable key; never use a service-role key here.

create table if not exists public.patient_profiles (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null default auth.uid()
        references auth.users(id) on delete cascade,
    patient_code text not null check (patient_code ~ '^[A-Za-z0-9_-]{1,32}$'),
    full_name text not null,
    gender text,
    age integer,
    diet_type text not null default 'regular'
        check (diet_type in ('regular', 'soft', 'pureed')),
    baseline_chew_duration double precision not null default 0.85,
    baseline_swallow_pause double precision not null default 1.05,
    created_at timestamptz not null default now(),
    constraint patient_profiles_owner_code_key unique (owner_id, patient_code)
);

create table if not exists public.meal_sessions (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null default auth.uid()
        references auth.users(id) on delete cascade,
    patient_id uuid not null references public.patient_profiles(id) on delete cascade,
    diet_type text not null default 'regular'
        check (diet_type in ('regular', 'soft', 'pureed')),
    start_time timestamptz not null default now(),
    end_time timestamptz,
    total_duration_sec integer,
    -- The browser counts half-chews, so preserve one decimal place.
    total_chew_count numeric(10,1) not null default 0,
    avg_chew_duration double precision not null default 0,
    cough_count_l1 integer not null default 0,
    cough_count_l2 integer not null default 0,
    choking_events_l3 integer not null default 0,
    pouching_events integer not null default 0,
    risk_level text not null default 'NORMAL'
        check (risk_level in ('NORMAL', 'ATTENTION', 'HIGH_RISK')),
    created_at timestamptz not null default now()
);

create table if not exists public.anomaly_logs (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null default auth.uid()
        references auth.users(id) on delete cascade,
    session_id uuid not null references public.meal_sessions(id) on delete cascade,
    event_type text not null,
    jaw_velocity double precision,
    audio_energy double precision,
    hands_on_neck boolean not null default false,
    snapshot_url text,
    details text,
    triggered_at timestamptz not null default now()
);

create index if not exists patient_profiles_owner_code_idx
    on public.patient_profiles (owner_id, patient_code);
create index if not exists meal_sessions_owner_patient_created_idx
    on public.meal_sessions (owner_id, patient_id, created_at desc);
create index if not exists anomaly_logs_owner_session_triggered_idx
    on public.anomaly_logs (owner_id, session_id, triggered_at desc);

alter table public.patient_profiles enable row level security;
alter table public.meal_sessions enable row level security;
alter table public.anomaly_logs enable row level security;

revoke all on table public.patient_profiles, public.meal_sessions, public.anomaly_logs
    from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select, insert, update, delete on table
    public.patient_profiles, public.meal_sessions, public.anomaly_logs
    to authenticated;

-- Profiles: each signed-in account manages only its own patients.
create policy patient_profiles_owner_select on public.patient_profiles
    for select to authenticated using (owner_id = (select auth.uid()));
create policy patient_profiles_owner_insert on public.patient_profiles
    for insert to authenticated with check (owner_id = (select auth.uid()));
create policy patient_profiles_owner_update on public.patient_profiles
    for update to authenticated
    using (owner_id = (select auth.uid()))
    with check (owner_id = (select auth.uid()));
create policy patient_profiles_owner_delete on public.patient_profiles
    for delete to authenticated using (owner_id = (select auth.uid()));

-- Meal sessions must belong to the account and one of its patient profiles.
create policy meal_sessions_owner_select on public.meal_sessions
    for select to authenticated using (owner_id = (select auth.uid()));
create policy meal_sessions_owner_insert on public.meal_sessions
    for insert to authenticated with check (
        owner_id = (select auth.uid())
        and exists (
            select 1 from public.patient_profiles p
            where p.id = patient_id and p.owner_id = (select auth.uid())
        )
    );
create policy meal_sessions_owner_update on public.meal_sessions
    for update to authenticated
    using (owner_id = (select auth.uid()))
    with check (
        owner_id = (select auth.uid())
        and exists (
            select 1 from public.patient_profiles p
            where p.id = patient_id and p.owner_id = (select auth.uid())
        )
    );
create policy meal_sessions_owner_delete on public.meal_sessions
    for delete to authenticated using (owner_id = (select auth.uid()));

-- Anomaly logs can be accessed only through a session owned by the same account.
create policy anomaly_logs_owner_select on public.anomaly_logs
    for select to authenticated using (
        owner_id = (select auth.uid())
        and exists (
            select 1 from public.meal_sessions s
            where s.id = session_id and s.owner_id = (select auth.uid())
        )
    );
create policy anomaly_logs_owner_insert on public.anomaly_logs
    for insert to authenticated with check (
        owner_id = (select auth.uid())
        and exists (
            select 1 from public.meal_sessions s
            where s.id = session_id and s.owner_id = (select auth.uid())
        )
    );
create policy anomaly_logs_owner_update on public.anomaly_logs
    for update to authenticated
    using (
        owner_id = (select auth.uid())
        and exists (
            select 1 from public.meal_sessions s
            where s.id = session_id and s.owner_id = (select auth.uid())
        )
    )
    with check (
        owner_id = (select auth.uid())
        and exists (
            select 1 from public.meal_sessions s
            where s.id = session_id and s.owner_id = (select auth.uid())
        )
    );
create policy anomaly_logs_owner_delete on public.anomaly_logs
    for delete to authenticated using (
        owner_id = (select auth.uid())
        and exists (
            select 1 from public.meal_sessions s
            where s.id = session_id and s.owner_id = (select auth.uid())
        )
    );

-- Realtime broadcasts use a profile UUID topic so patient codes cannot collide across accounts.
create policy anti_choke_private_channel_read on realtime.messages
    for select to authenticated using (
        extension = 'broadcast'
        and exists (
            select 1 from public.patient_profiles p
            where p.owner_id = (select auth.uid())
              and (select realtime.topic()) = ('webrtc-' || p.id::text)
        )
    );
create policy anti_choke_private_channel_send on realtime.messages
    for insert to authenticated with check (
        extension = 'broadcast'
        and exists (
            select 1 from public.patient_profiles p
            where p.owner_id = (select auth.uid())
              and (select realtime.topic()) = ('webrtc-' || p.id::text)
        )
    );
