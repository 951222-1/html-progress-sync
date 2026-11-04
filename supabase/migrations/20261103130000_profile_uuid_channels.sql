-- Replace the old, code-based Realtime channel scope with a profile UUID scope.
-- This prevents two accounts with the same patient_code (for example P001)
-- from ever sharing a broadcast topic.
alter policy anti_choke_private_channel_read on realtime.messages
using (
    extension = 'broadcast'
    and exists (
        select 1 from public.patient_profiles p
        where p.owner_id = (select auth.uid())
          and (select realtime.topic()) = ('webrtc-' || p.id::text)
    )
);

alter policy anti_choke_private_channel_send on realtime.messages
with check (
    extension = 'broadcast'
    and exists (
        select 1 from public.patient_profiles p
        where p.owner_id = (select auth.uid())
          and (select realtime.topic()) = ('webrtc-' || p.id::text)
    )
);
