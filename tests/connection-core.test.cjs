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

test('alert priority prevents a visibility warning from replacing an active equal or higher alert', () => {
  assert.equal(ConnectionCore.canReplaceAlertLevel(null, 'L3'), true);
  assert.equal(ConnectionCore.canReplaceAlertLevel('L1', 'L3'), true);
  assert.equal(ConnectionCore.canReplaceAlertLevel('L3', 'L3'), false);
  assert.equal(ConnectionCore.canReplaceAlertLevel('L2', 'L3'), false);
  assert.equal(ConnectionCore.canReplaceAlertLevel('L4', 'L3'), false);
  assert.equal(ConnectionCore.canReplaceAlertLevel('L3', 'L4'), true);
});

test('visibility notice supplements active L2/L3/L4 without changing severity or confirmed metrics', () => {
  const visibility = '視覺遮蔽，請目視確認';
  for (const activeLevel of ['L2', 'L3', 'L4']) {
    const update = ConnectionCore.resolveVisibilityAlert(activeLevel, '既有警報', '既有警報', visibility);
    assert.equal(update.replacePrimary, false);
    assert.equal(update.level, activeLevel);
    assert.match(update.message, /既有警報/);
    assert.match(update.message, /視覺遮蔽/);
    assert.equal(update.countAsChoking, false);
    assert.equal(update.eventType, 'L3_VISIBILITY');
  }
});

test('visibility notice becomes L3 when no alert or only L1 is active', () => {
  const visibility = '視覺遮蔽，請目視確認';
  for (const activeLevel of [null, 'L1']) {
    const update = ConnectionCore.resolveVisibilityAlert(activeLevel, null, null, visibility);
    assert.equal(update.replacePrimary, true);
    assert.equal(update.level, 'L3');
    assert.equal(update.message, visibility);
    assert.equal(update.countAsChoking, false);
    assert.equal(update.eventType, 'L3_VISIBILITY');
  }
});

test('general face loss can use a distinct non-confirmed visibility event type', () => {
  const update = ConnectionCore.resolveVisibilityAlert(
    null, null, null, '進食中人臉消失，請確認', 'VISIBILITY_LOSS'
  );
  assert.equal(update.eventType, 'VISIBILITY_LOSS');
  assert.equal(update.countAsChoking, false);
});

test('visibility notice does not duplicate when the same face-loss episode is reported again', () => {
  const visibility = '視覺遮蔽，請目視確認';
  const first = ConnectionCore.resolveVisibilityAlert('L4', 'L4 urgent', 'L4 urgent', visibility);
  const repeated = ConnectionCore.resolveVisibilityAlert('L4', 'L4 urgent', first.message, visibility);
  assert.equal(repeated.message, first.message);
});

test('face-loss warning requires a recent L4 candidate, waits through grace, and fires once', () => {
  const guard = ConnectionCore.createFaceLossWarningGuard(0.6);
  assert.equal(guard.update(false, false, 1.0), false);
  assert.equal(guard.update(false, true, 2.0), false);
  assert.equal(guard.update(false, true, 2.61), false);
  assert.equal(guard.update(true, false, 3.0), false);
  assert.equal(guard.update(false, true, 4.0), false);
  assert.equal(guard.update(false, true, 4.61), true);
  assert.equal(guard.update(false, true, 5.0), false);
});

test('face-loss warning does not adopt a candidate that starts after visibility is lost', () => {
  const guard = ConnectionCore.createFaceLossWarningGuard(0.6);
  assert.equal(guard.update(false, false, 1.0), false);
  assert.equal(guard.update(false, true, 2.0), false);
  assert.equal(guard.update(false, true, 3.0), false);
});

test('body-motion reversal counts a turn after small deceleration samples', () => {
  const positions = [0, 6, 4.5, -2.5, 0, 1];
  assert.equal(ConnectionCore.countDirectionReversals(positions, 3), 2);
});

test('body-motion reversal ignores oscillations below the pixel deadband', () => {
  const positions = [0, 1, -1, 1, -1, 1];
  assert.equal(ConnectionCore.countDirectionReversals(positions, 3), 0);
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

test('meal event summary keeps cough, L1-L4 and visibility categories separate and marks legacy data', () => {
  const sessions = [
    { id: 'new-session', event_schema_version: 2 },
    { id: 'old-session' }
  ];
  const events = [
    { session_id: 'new-session', event_type: 'COUGH' },
    { session_id: 'new-session', event_type: 'L1' },
    { session_id: 'new-session', event_type: 'L3' },
    { session_id: 'new-session', event_type: 'L4' },
    { session_id: 'new-session', event_type: 'L3_VISIBILITY' },
    { session_id: 'new-session', event_type: 'VISIBILITY_LOSS' },
    { session_id: 'old-session', event_type: 'L4' }
  ];
  const [current, legacy] = ConnectionCore.summarizeMealEventsBySession(sessions, events);
  assert.deepEqual(current.eventCounts, {
    cough: 1, l1: 1, l2: 0, l3: 1, l4: 1, visibility: 2
  });
  assert.equal(current.alertBreakdownAvailable, true);
  assert.equal(legacy.alertBreakdownAvailable, false);
  assert.equal(legacy.eventCounts, null);
});

test('Realtime channel options require private authorization', () => {
  assert.deepEqual(ConnectionCore.privateChannelOptions(), { config: { private: true } });
});

test('leaky-bucket L4 accumulator survives motion-blur dropout and decays brief spoon passes', () => {
  const acc = ConnectionCore.createChokeDangerAccumulator({
    triggerSec: 3.0,
    graceSec: 0.6,
    decayRate: 0.5
  });

  // Accumulate 2.2s of active struggling + chest clutch
  acc.update({ active: true, rate: 1.0, reason: '身體掙扎晃動＋手部拍胸／抓喉' }, 10.0);
  acc.update({ active: true, rate: 1.0, reason: '身體掙扎晃動＋手部拍胸／抓喉' }, 12.2);
  // Motion blur drops hand detection for 1.0s (0.6s grace + 0.4s * 0.5 = 0.2s decay -> 2.0s kept)
  acc.update({ active: false }, 12.2);
  const afterBlur = acc.update({ active: false }, 13.2);
  assert.equal(afterBlur.active, true);
  assert.ok(Math.abs(afterBlur.duration - 2.0) < 1e-6);
  assert.equal(afterBlur.triggered, false);

  // Resume for 1.0s -> reaches 3.0s trigger!
  acc.update({ active: true, rate: 1.0 }, 13.2);
  const triggered = acc.update({ active: true, rate: 1.0 }, 14.2);
  assert.equal(triggered.triggered, true);
  assert.match(triggered.reason, /掙扎/);

  // Reset and verify a brief 0.4s false pass decays cleanly to 0
  acc.reset();
  acc.update({ active: true, rate: 1.0 }, 20.0);
  acc.update({ active: true, rate: 1.0 }, 20.4);
  acc.update({ active: false }, 20.4);
  const decayed = acc.update({ active: false }, 22.0);
  assert.equal(decayed.active, false);
  assert.equal(decayed.duration, 0);
});

test('multi-path L4 evaluator distinguishes struggle (3.0s), two-hand sign (2.5s), and post-cough clutch (2.5s)', () => {
  // Single still hand without cough -> NOT an L4 candidate
  assert.equal(
    ConnectionCore.evaluateL4Candidate({ bodyShaking: false, handInZone: true, handsInZone: 1, recentCough: false }).active,
    false
  );

  // Path A: struggle + hand -> 1.0x (3.0s)
  const pathA = ConnectionCore.evaluateL4Candidate({ bodyShaking: true, handInZone: true, handsInZone: 1, recentCough: false });
  assert.equal(pathA.active, true);
  assert.equal(pathA.rate, 1.0);
  assert.equal(pathA.path, 'struggle');

  // Path B: both hands in zone -> 1.2x (2.5s even without shaking)
  const pathB = ConnectionCore.evaluateL4Candidate({ bodyShaking: false, handInZone: true, handsInZone: 2, recentCough: false });
  assert.equal(pathB.active, true);
  assert.equal(pathB.rate, 1.2);
  assert.equal(pathB.path, 'two_hands');

  // Path C: post-cough clutch -> reaches 3.0s trigger in 2.5s
  const pathC = ConnectionCore.evaluateL4Candidate({ bodyShaking: false, handInZone: true, handsInZone: 1, recentCough: true });
  const acc = ConnectionCore.createChokeDangerAccumulator({ triggerSec: 3.0, graceSec: 0.6, decayRate: 0.5 });
  acc.update(pathC, 5.0);
  const res = acc.update(pathC, 7.5);
  assert.equal(res.triggered, true);
  assert.equal(res.path, 'post_cough_clutch');
});


test('privacy storage keys isolate cough records and kiosk locks by account and patient code', () => {
  assert.equal(
    ConnectionCore.coughStorageKey('user-uuid-1', 'P001'),
    'anti_choke_cough_records:user-uuid-1:P001'
  );
  assert.equal(
    ConnectionCore.coughStorageKey('user-uuid-1', 'P002'),
    'anti_choke_cough_records:user-uuid-1:P002'
  );
  assert.notEqual(
    ConnectionCore.coughStorageKey('user-uuid-1', 'P001'),
    ConnectionCore.coughStorageKey('user-uuid-2', 'P001')
  );
  assert.equal(ConnectionCore.coughStorageKey('', 'P001'), null);
  assert.equal(ConnectionCore.coughStorageKey('user-uuid-1', ''), null);
  assert.equal(ConnectionCore.coughStorageKey('user-uuid-1', '../bad'), null);

  assert.equal(ConnectionCore.kioskLockStorageKey('user-uuid-1'), 'anti_choke_kiosk_lock:user-uuid-1');
  assert.equal(ConnectionCore.kioskLockStorageKey(''), null);
});

test('nextPatientCode avoids collisions when earlier patient codes were removed', () => {
  assert.equal(ConnectionCore.nextPatientCode([]), 'P001');
  assert.equal(ConnectionCore.nextPatientCode([{ patient_code: 'P001' }]), 'P002');
  assert.equal(
    ConnectionCore.nextPatientCode([{ patient_code: 'P002' }, { patient_code: 'P004' }]),
    'P005'
  );
});

test('legacy unscoped keys and logout cleanup remove patient PII without touching unrelated keys', () => {
  const map = new Map([
    ['anti_choke_patient_list', '[{"code":"P001"}]'],
    ['anti_choke_cough_records', '[{"patientCode":"P001"}]'],
    ['anti_choke_cough_records:user-1:P001', '[{"patientCode":"P001"}]'],
    ['anti_choke_kiosk_lock:user-1', 'P001'],
    ['unrelated_app_setting', 'keep-me']
  ]);
  const storage = {
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] || null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); }
  };

  ConnectionCore.purgeLegacySharedPatientKeys(storage);
  assert.equal(map.has('anti_choke_patient_list'), false);
  assert.equal(map.has('anti_choke_cough_records'), false);
  assert.equal(map.has('anti_choke_cough_records:user-1:P001'), true);
  assert.equal(map.get('unrelated_app_setting'), 'keep-me');

  ConnectionCore.purgeAllLocalPatientKeys(storage);
  assert.equal(map.has('anti_choke_cough_records:user-1:P001'), false);
  assert.equal(map.has('anti_choke_kiosk_lock:user-1'), false);
  assert.equal(map.get('unrelated_app_setting'), 'keep-me');
});
