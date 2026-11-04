-- Run in the Supabase SQL Editor after applying the connection migration.
-- Raises an error if anonymous access or missing RLS/grants are detected.
do $$
declare
    v_table_count integer;
    v_rls_enabled boolean;
    v_anon_select boolean;
    v_auth_select boolean;
    v_anon_policies integer;
    v_private_realtime_policies integer;
    v_profile_uuid_policies integer;
begin
    select count(*), bool_and(c.relrowsecurity)
      into v_table_count, v_rls_enabled
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and c.relname in ('patient_profiles', 'meal_sessions', 'anomaly_logs');

    if v_table_count <> 3 or not coalesce(v_rls_enabled, false) then
        raise exception 'FAIL: application tables missing or RLS disabled';
    end if;

    select bool_or(has_table_privilege('anon', c.oid, 'select'))
      into v_anon_select
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and c.relname in ('patient_profiles', 'meal_sessions', 'anomaly_logs');

    if coalesce(v_anon_select, false) then
        raise exception 'FAIL: anon role can select application rows';
    end if;

    select bool_and(has_table_privilege('authenticated', c.oid, 'select'))
      into v_auth_select
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and c.relname in ('patient_profiles', 'meal_sessions', 'anomaly_logs');

    if not coalesce(v_auth_select, false) then
        raise exception 'FAIL: authenticated role lacks table grants';
    end if;

    select count(*) into v_anon_policies
      from pg_policies
     where (schemaname = 'public' and tablename in ('patient_profiles', 'meal_sessions', 'anomaly_logs')
            or schemaname = 'realtime' and tablename = 'messages')
       and 'anon' = any(roles);

    if v_anon_policies <> 0 then
        raise exception 'FAIL: anonymous RLS policies were found';
    end if;

    select count(*) into v_private_realtime_policies
      from pg_policies
     where schemaname = 'realtime'
       and tablename = 'messages'
       and policyname in ('anti_choke_private_channel_read', 'anti_choke_private_channel_send');

    if v_private_realtime_policies <> 2 then
        raise exception 'FAIL: private Realtime read/send policies are missing';
    end if;

    select count(*) into v_profile_uuid_policies
      from pg_policies
     where schemaname = 'realtime'
       and tablename = 'messages'
       and policyname in ('anti_choke_private_channel_read', 'anti_choke_private_channel_send')
       and position('p.id' in coalesce(qual, '') || coalesce(with_check, '')) > 0
       and position('patient_code' in coalesce(qual, '') || coalesce(with_check, '')) = 0;

    if v_profile_uuid_policies <> 2 then
        raise exception 'FAIL: Realtime policies are not scoped to unique profile UUIDs';
    end if;

    raise notice 'PASS: 3 tables use RLS; anon is denied; authenticated grants and private profile-UUID Realtime policies are present.';
end $$;
