const test = require('node:test');
const assert = require('node:assert/strict');
const ConnectionCore = require('../mobile/connection-core.js');

test('profile UUID maps to a stable account-independent Realtime topic', () => {
  assert.equal(ConnectionCore.channelTopic('7a1e2b3c-4d5f-6071-8293-a4b5c6d7e8f9'), 'webrtc-7a1e2b3c-4d5f-6071-8293-a4b5c6d7e8f9');
});

test('only a profile UUID can become a Realtime topic', () => {
  assert.throws(() => ConnectionCore.channelTopic(''), /profile id/i);
  assert.throws(() => ConnectionCore.channelTopic('P001'), /profile id/i);
  assert.throws(() => ConnectionCore.channelTopic('7a1e2b3c-4d5f-6071-8293-a4b5c6d7e8f9/other'), /profile id/i);
});

test('candidate buffer preserves ICE candidates until a remote description is ready', () => {
  const buffer = ConnectionCore.createCandidateBuffer();
  const first = { id: 'candidate-1' };
  const second = { id: 'candidate-2' };
  buffer.enqueue(first);
  buffer.enqueue(second);
  assert.equal(buffer.size, 2);
  assert.deepEqual(buffer.drain(), [first, second]);
  assert.equal(buffer.size, 0);
});

test('candidate buffer discards candidates from stale negotiation/client pairs', () => {
  const buffer = ConnectionCore.createCandidateBuffer();
  const current = { negotiationId: 'neg-a', clientId: 'view-a', candidate: 'A' };
  const staleClient = { negotiationId: 'neg-a', clientId: 'view-b', candidate: 'B' };
  const staleNegotiation = { negotiationId: 'neg-b', clientId: 'view-a', candidate: 'C' };
  buffer.enqueue(current);
  buffer.enqueue(staleClient);
  buffer.enqueue(staleNegotiation);
  assert.deepEqual(ConnectionCore.takeMatchingCandidates(buffer, 'neg-a', 'view-a'), [current]);
  assert.equal(buffer.size, 0);
});

test('negotiation gate deduplicates concurrent duplicate offers', async () => {
  const gate = ConnectionCore.createNegotiationGate();
  let calls = 0;
  const work = async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 15));
    return 'answer';
  };
  const results = await Promise.all([gate.run('viewer-a:neg-a', work), gate.run('viewer-a:neg-a', work)]);
  assert.deepEqual(results, ['answer', 'answer']);
  assert.equal(calls, 1);
});

test('negotiation gate serializes different offers so they cannot replace a live connection concurrently', async () => {
  const gate = ConnectionCore.createNegotiationGate();
  let active = 0;
  let maxActive = 0;
  const work = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active -= 1;
  };
  await Promise.all([gate.run('viewer-a:neg-a', work), gate.run('viewer-b:neg-b', work)]);
  assert.equal(maxActive, 1);
});

test('partial camera startup cleanup stops every acquired track despite individual stop errors', () => {
  const stopped = [];
  const stream = {
    getTracks: () => [
      { stop() { stopped.push('video'); } },
      { stop() { stopped.push('audio'); throw new Error('already stopped'); } },
      { stop() { stopped.push('extra'); } }
    ]
  };
  ConnectionCore.stopMediaStream(stream);
  assert.deepEqual(stopped, ['video', 'audio', 'extra']);
});

test('meal finalization stops monitoring before waiting for its insert and updates that session ID', async () => {
  let resolveInsert;
  const pendingInsert = new Promise(resolve => { resolveInsert = resolve; });
  const events = [];
  const finalization = ConnectionCore.finalizeMealSession(
    pendingInsert,
    async () => { events.push('stopped'); },
    async sessionId => { events.push(`updated:${sessionId}`); }
  );
  await Promise.resolve();
  assert.deepEqual(events, ['stopped']);
  resolveInsert('session-for-this-meal');
  assert.equal(await finalization, 'session-for-this-meal');
  assert.deepEqual(events, ['stopped', 'updated:session-for-this-meal']);
});

test('start lock rejects a concurrent duplicate until the first start releases it', () => {
  const lock = ConnectionCore.createStartLock();
  assert.equal(lock.tryEnter(), true);
  assert.equal(lock.tryEnter(), false);
  assert.equal(lock.active, true);
  lock.release();
  assert.equal(lock.active, false);
  assert.equal(lock.tryEnter(), true);
});

test('failed new meal insert clears the previous session ID', async () => {
  const tracker = ConnectionCore.createMealSessionTracker();
  await tracker.begin(async () => 'previous-session-id');
  await assert.rejects(
    tracker.begin(async () => { throw new Error('insert failed'); }),
    /insert failed/
  );
  assert.equal(tracker.currentId, null);
});

test('latest session history keeps the newest seven in chronological chart order', () => {
  const sessions = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    created_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString()
  }));
  const latest = ConnectionCore.latestSessionsChronological(sessions, 7);
  assert.deepEqual(latest.map(session => session.id), [4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(sessions.map(session => session.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('Realtime channel options require private authorization', () => {
  assert.deepEqual(ConnectionCore.privateChannelOptions(), { config: { private: true } });
});
