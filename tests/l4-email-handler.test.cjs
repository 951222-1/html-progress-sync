const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const helperSource = fs.readFileSync(path.join(__dirname, '../supabase/functions/notify-l4-email/file2.ts'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(helperSource).toString('base64')}`);
const EVENT_ID = '7a1e2b3c-4d5f-6071-8293-a4b5c6d7e8f9';
const ORIGIN = 'https://951222-1.github.io';

function makeRequest(body, { method = 'POST', headers = {} } = {}) {
  return new Request('https://project.functions.supabase.co/notify-l4-email', {
    method,
    headers: {
      origin: ORIGIN,
      authorization: 'Bearer user-jwt',
      'content-type': 'application/json',
      ...headers
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined
  });
}

test('Resend sender passes the L4 event ID as an idempotency key', async () => {
  const { createResendSender } = await modulePromise;
  const requests = [];
  const fakeKey = 'unit-test-key';
  const sender = createResendSender({
    apiKey: fakeKey,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ id: 'resend-message-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  const result = await sender({
    from: 'alerts@example.test',
    to: 'caregiver@example.test',
    subject: 'L4 alert',
    text: 'Please check the patient.',
    idempotencyKey: EVENT_ID
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${fakeKey}`);
  assert.equal(requests[0].options.headers['Idempotency-Key'], EVENT_ID);
  assert.equal(JSON.parse(requests[0].options.body).to[0], 'caregiver@example.test');
  assert.equal(result.id, 'resend-message-1');
});

test('L4 email uses the verified owner email and event ID as its idempotency key', async () => {
  const { createL4EmailHandler } = await modulePromise;
  const sends = [];
  const handler = createL4EmailHandler({
    allowedOrigins: [ORIGIN],
    fromAddress: 'alerts@example.test',
    resolveAuthorizedL4Event: async (_request, eventId) => {
      assert.equal(eventId, EVENT_ID);
      return {
        user: { email: 'caregiver@example.test' },
        event: { id: EVENT_ID, event_type: 'L4', details: 'L4 warning details', triggered_at: '2026-11-10T10:00:00Z' },
        patient: { patient_code: 'P001', full_name: 'Test Patient' }
      };
    },
    sendEmail: async payload => {
      sends.push(payload);
      return { id: 'email-1' };
    }
  });

  const response = await handler(makeRequest({ eventId: EVENT_ID, email: 'attacker@example.test' }));
  const body = await response.json();
  assert.equal(response.status, 202);
  assert.equal(body.ok, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, 'caregiver@example.test');
  assert.equal(sends[0].from, 'alerts@example.test');
  assert.equal(sends[0].idempotencyKey, EVENT_ID);
  assert.match(sends[0].subject, /L4/);
  assert.doesNotMatch(sends[0].text, /2026-11-10T10:00:00Z/);
  assert.doesNotMatch(sends[0].subject, /P001|Test Patient/);
  assert.doesNotMatch(sends[0].text, /P001|Test Patient|L4 warning details/);
  assert.doesNotMatch(sends[0].text, /attacker@example\.test/);
});

test('L4 email refuses non-L4 event records without sending', async () => {
  const { createL4EmailHandler } = await modulePromise;
  let sendCount = 0;
  const handler = createL4EmailHandler({
    allowedOrigins: [ORIGIN],
    fromAddress: 'alerts@example.test',
    resolveAuthorizedL4Event: async () => ({ user: { email: 'owner@example.test' }, event: { id: EVENT_ID, event_type: 'COUGH' }, patient: {} }),
    sendEmail: async () => { sendCount += 1; }
  });
  const response = await handler(makeRequest({ eventId: EVENT_ID }));
  assert.equal(response.status, 422);
  assert.equal(sendCount, 0);
});

test('L4 email rejects unauthenticated requests before looking up event data', async () => {
  const { createL4EmailHandler } = await modulePromise;
  let lookupCount = 0;
  const handler = createL4EmailHandler({
    allowedOrigins: [ORIGIN],
    fromAddress: 'alerts@example.test',
    resolveAuthorizedL4Event: async () => { lookupCount += 1; return null; },
    sendEmail: async () => {}
  });
  const response = await handler(makeRequest({ eventId: EVENT_ID }, { headers: { authorization: '' } }));
  assert.equal(response.status, 401);
  assert.equal(lookupCount, 0);
});

test('L4 email handles CORS preflight without sending', async () => {
  const { createL4EmailHandler } = await modulePromise;
  let sendCount = 0;
  const handler = createL4EmailHandler({
    allowedOrigins: [ORIGIN],
    fromAddress: 'alerts@example.test',
    resolveAuthorizedL4Event: async () => null,
    sendEmail: async () => { sendCount += 1; }
  });
  const response = await handler(makeRequest(null, { method: 'OPTIONS' }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(sendCount, 0);
});
