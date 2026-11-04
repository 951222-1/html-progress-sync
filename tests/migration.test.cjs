const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261103120000_online_connection.sql'),
  'utf8'
).toLowerCase();
const realtimeMigration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261103130000_profile_uuid_channels.sql'),
  'utf8'
).toLowerCase();

test('application tables require an authenticated owner and deny anonymous access', () => {
  assert.match(migration, /owner_id\s+uuid\s+not null\s+default auth\.uid\(\)/);
  assert.match(migration, /revoke all on table[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete on table[\s\S]*to authenticated/);
  assert.match(migration, /alter table public\.patient_profiles enable row level security/);
  assert.match(migration, /owner_id = \(select auth\.uid\(\)\)/);
  assert.match(migration, /meal_sessions_owner_insert/);
  assert.equal(/\bdrop\s+(policy|table|schema)\b/i.test(migration), false, 'migration must not drop existing objects');
});

test('Realtime policies authorize only private topics owned by the signed-in account', () => {
  assert.match(migration, /create policy anti_choke_private_channel_read on realtime\.messages/);
  assert.match(migration, /create policy anti_choke_private_channel_send on realtime\.messages/);
  assert.match(migration, /\(select realtime\.topic\(\)\) = \('webrtc-' \|\| p\.id::text\)/);
  assert.match(migration, /extension = 'broadcast'/);
});

test('live policy update scopes Realtime topics to the exact profile UUID', () => {
  assert.match(realtimeMigration, /alter policy anti_choke_private_channel_read on realtime\.messages/);
  assert.match(realtimeMigration, /alter policy anti_choke_private_channel_send on realtime\.messages/);
  assert.match(realtimeMigration, /p\.id::text/);
  assert.doesNotMatch(realtimeMigration, /p\.patient_code/);
});

test('meal session schema preserves half-chew counts from the browser', () => {
  assert.match(migration, /total_chew_count numeric\(10,1\)/);
});
