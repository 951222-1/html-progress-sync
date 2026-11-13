const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const helperSource = fs.readFileSync(path.join(__dirname, '../supabase/functions/notify-l4-email/file2.ts'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(helperSource).toString('base64')}`);
const USER_ID = 'user-owner';
const EVENT_ID = '7a1e2b3c-4d5f-6071-8293-a4b5c6d7e8f9';
const SESSION_ID = '8b2f3c4d-5e6f-7081-9234-b5c6d7e8f9a0';
const PATIENT_ID = '9c3d4e5f-6071-8293-a4b5c6d7e8f9a0b1';

function makeResolver(overrides = {}) {
  const values = {
    user: { id: USER_ID, email: 'caregiver@example.test' },
    event: { id: EVENT_ID, event_type: 'L4', details: 'private details', triggered_at: '2026-11-10T10:00:00Z', session_id: SESSION_ID, owner_id: USER_ID },
    session: { patient_id: PATIENT_ID, owner_id: USER_ID },
    patient: { patient_code: 'P001', full_name: 'Test Patient', owner_id: USER_ID },
    ...overrides
  };
  const queries = [];
  const clients = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: values.user }, error: null }) },
    from(table) {
      const filters = {};
      let selected = '';
      return {
        select(columns) { selected = columns; return this; },
        eq(column, value) { filters[column] = value; return this; },
        async maybeSingle() {
          queries.push({ table, selected, filters: { ...filters } });
          const value = table === 'anomaly_logs' ? values.event
            : table === 'meal_sessions' ? values.session
              : values.patient;
          return { data: value, error: null };
        }
      };
    }
  };
  const createClient = (url, key, options) => {
    clients.push({ url, key, options });
    return client;
  };
  const resolver = (async () => {
    const { createL4EventResolver } = await modulePromise;
    return createL4EventResolver({
      supabaseUrl: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_test',
      createClient
    });
  })();
  return { values, queries, clients, resolver };
}

function authRequest(token = 'user-jwt') {
  return new Request('https://project.functions.supabase.co/notify-l4-email', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
}

test('L4 resolver validates the signed-in user and checks the event/session/patient owner chain', async () => {
  const { values, queries, clients, resolver: resolverPromise } = makeResolver();
  const resolver = await resolverPromise;
  const result = await resolver(authRequest(), EVENT_ID);
  assert.equal(result.user.email, 'caregiver@example.test');
  assert.equal(result.event.id, EVENT_ID);
  assert.equal(result.patient, undefined, 'resolver must not return patient identity to the email layer');
  assert.equal(clients[0].url, 'https://project.supabase.co');
  assert.equal(clients[0].key, 'sb_publishable_test');
  assert.equal(clients[0].options.global.headers.Authorization, 'Bearer user-jwt');
  assert.deepEqual(queries.map(query => query.table), ['anomaly_logs', 'meal_sessions', 'patient_profiles']);
  assert.equal(queries[0].filters.id, EVENT_ID);
  assert.equal(queries[1].filters.id, values.event.session_id);
  assert.equal(queries[2].filters.id, values.session.patient_id);
  assert.equal(queries[2].selected, 'owner_id', 'resolver must validate ownership without reading patient name or code');
});

test('L4 resolver rejects an event owned by another account before following references', async () => {
  const { queries, resolver: resolverPromise } = makeResolver({
    event: { id: EVENT_ID, event_type: 'L4', session_id: SESSION_ID, owner_id: 'other-owner' }
  });
  const resolver = await resolverPromise;
  assert.equal(await resolver(authRequest(), EVENT_ID), null);
  assert.deepEqual(queries.map(query => query.table), ['anomaly_logs']);
});

test('L4 resolver rejects a cross-owner session before reading the patient profile', async () => {
  const { queries, resolver: resolverPromise } = makeResolver({
    session: { patient_id: PATIENT_ID, owner_id: 'other-owner' }
  });
  const resolver = await resolverPromise;
  assert.equal(await resolver(authRequest(), EVENT_ID), null);
  assert.deepEqual(queries.map(query => query.table), ['anomaly_logs', 'meal_sessions']);
});

test('L4 resolver rejects a cross-owner patient profile', async () => {
  const { queries, resolver: resolverPromise } = makeResolver({
    patient: { patient_code: 'P001', full_name: 'Test Patient', owner_id: 'other-owner' }
  });
  const resolver = await resolverPromise;
  assert.equal(await resolver(authRequest(), EVENT_ID), null);
  assert.deepEqual(queries.map(query => query.table), ['anomaly_logs', 'meal_sessions', 'patient_profiles']);
});

test('L4 resolver rejects a missing authentication token before database access', async () => {
  const { queries, resolver: resolverPromise } = makeResolver();
  const resolver = await resolverPromise;
  assert.equal(await resolver(authRequest(''), EVENT_ID), null);
  assert.equal(queries.length, 0);
});
