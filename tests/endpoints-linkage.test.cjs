const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ConnectionCore = require(path.join(root, 'mobile', 'connection-core.js'));
const patientPage = read('mobile/index.html');
const caregiverPage = read('mobile/caregiver.html');
const patientJs = read('mobile/app.js');
const caregiverJs = read('mobile/caregiver.js');

const legacyCaregiverPage = read('mobile/caregiver/index.html');

test('legacy caregiver route redirects to the canonical dashboard', () => {
  assert.match(legacyCaregiverPage, /location\.replace\([^)]*caregiver\.html/);
});

test('browser config uses the project publishable key and contains no privileged key', () => {
  const config = read('mobile/config.js');
  assert.equal(/https:\/\/shcnvdnhrfmxfywzwtpm\.supabase\.co/.test(config), true, 'project URL missing');
  assert.equal(/SUPABASE_PUBLISHABLE_KEY:\s*"sb_publishable_[A-Za-z0-9_-]+"/.test(config), true, 'publishable key missing');
  assert.equal(/SUPABASE_SERVICE_ROLE|sb_secret_|service_role|xyzcompany/.test(config), false, 'privileged or placeholder key found');
});

test('L3 alert title does not mislabel face-visibility warnings as low-chew alerts', () => {
  assert.match(patientJs, /L3 需注意警示/);
  assert.equal(/L3 吞嚥前少咀嚼預警/.test(patientJs), false);
});

test('patient and caregiver scripts use one release-specific cache-bust version', () => {
  const versions = page => [...page.matchAll(/<script src="[^"]+\.js\?v=([^"]+)"/g)].map(match => match[1]);
  const patientVersions = versions(patientPage);
  const caregiverVersions = versions(caregiverPage);
  assert.equal(patientVersions.length, 4);
  assert.equal(caregiverVersions.length, 4);
  assert.equal(new Set(patientVersions).size, 1);
  assert.equal(new Set(caregiverVersions).size, 1);
  assert.equal(patientVersions[0], caregiverVersions[0]);
  assert.match(patientVersions[0], /^\d{8}_[a-f0-9]{7}$/);
});

test('both endpoints load shared authentication and private-channel support', () => {
  assert.match(patientPage, /auth-ui\.js/);
  assert.match(caregiverPage, /auth-ui\.js/);
  assert.match(patientJs, /ConnectionCore\.privateChannelOptions\(\)/);
  assert.match(caregiverJs, /ConnectionCore\.privateChannelOptions\(\)/);
});

test('patient endpoint answers caregiver offer requests with a WebRTC offer', () => {
  assert.match(patientJs, /request_offer/);
  assert.match(patientJs, /await startPeerConnection\(payload\.clientId\)/);
  assert.match(patientJs, /\.subscribe\(\s*\(status\)/);
});

test('online body-shake detector uses deadbanded extremum reversal counting', () => {
  const startAt = patientJs.indexOf('function checkContinuousBodyShaking(');
  const endAt = patientJs.indexOf('function handNearThroat(', startAt);
  const detector = patientJs.slice(startAt, endAt);
  assert.match(detector, /ConnectionCore\.countDirectionReversals/);
  assert.doesNotMatch(detector, /dx\s*\*\s*prevDx/);
});

test('face loss expires stale L4 motion/gesture evidence and clears old trajectory samples', () => {
  const frameStart = patientJs.indexOf('async function processVideoFrame(');
  const frameEnd = patientJs.indexOf('// 8. 警報觸發', frameStart);
  const frameFunction = patientJs.slice(frameStart, frameEnd);
  const noFaceStart = frameFunction.indexOf('} else {', frameFunction.indexOf('if (faceLandmarks)'));
  const noFaceBranch = frameFunction.slice(noFaceStart);
  assert.match(noFaceBranch, /isBodyShakingContinuous = false/);
  assert.match(noFaceBranch, /isHandOnChest = false/);
  assert.match(noFaceBranch, /isHandOnChestOrThroat = isHandOnNeck/);
  assert.match(noFaceBranch, /bodyMotionHistory = \[\]/);
});

test('face loss during a recent L4 candidate raises an unconfirmed visibility warning', () => {
  assert.match(patientJs, /createFaceLossWarningGuard/);
  assert.match(patientJs, /chokeFaceLossWarningGuard\.update\(false,\s*l4CandidateAtFaceLoss,\s*currentTime\)/);
  assert.match(patientJs, /showChokeVisibilityWarning\(/);
  assert.match(patientJs, /countAsChoking: update\.countAsChoking/);
  assert.match(patientJs, /eventType: update\.eventType/);
  assert.match(patientJs, /level === 'L3' && options\.countAsChoking !== false/);
});

test('unconfirmed face-loss warning is broadcast to caregiver with its specific message', () => {
  assert.match(patientJs, /activeAlertMessage: sessionEnded \? null : activeAlertMessage/);
  assert.match(patientJs, /activeAlertMessage = msg/);
  assert.match(caregiverJs, /state\.activeAlertMessage/);
  assert.match(caregiverJs, /showCaregiverAlert\(state\.activeAlertLevel,\s*alertMessage/);
});

test('caregiver displays and logs the supplemental visibility message without downgrading severity', () => {
  const startAt = caregiverJs.indexOf('function handleStateUpdate(state) {');
  const endAt = caregiverJs.indexOf('function showCaregiverAlert(', startAt);
  assert.ok(startAt >= 0 && endAt > startAt, 'handleStateUpdate source must be found');
  const source = caregiverJs.slice(startAt, endAt) + '\nglobalThis.testHandleStateUpdate = handleStateUpdate;';
  const nodes = new Map();
  const displays = [];
  const logs = [];
  const context = {
    document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { innerText: '' });
      return nodes.get(id);
    } },
    CONFIG: { DIET_PROFILES: {} },
    lastLoggedAlertLevel: null,
    lastLoggedAlertMessage: null,
    showCaregiverAlert: (level, message) => displays.push({ level, message }),
    addRealtimeLog: (level, message) => logs.push({ level, message }),
    hideCaregiverAlert() {},
    setRealtimeStatus() {}
  };
  vm.runInNewContext(source, context);
  const primary = {
    patientCode: 'P001', patientName: 'Test patient', dietType: 'soft',
    totalChews: 0, totalSwallows: 0, jawVelocity: 0, pouchingEvents: 0, coughEvents: 0,
    activeAlertLevel: 'L2', activeAlertMessage: 'Existing high alert', sessionEnded: false
  };
  const supplemented = {
    ...primary,
    activeAlertMessage: 'Existing high alert\\n\\nVisibility unclear; please check the patient.'
  };
  context.testHandleStateUpdate(primary);
  context.testHandleStateUpdate(supplemented);
  context.testHandleStateUpdate(supplemented);
  assert.equal(displays[1].level, 'L2');
  assert.match(displays[1].message, /Visibility unclear/);
  assert.equal(logs.length, 2, 'the changed message should log once, not on every Realtime update');
  assert.match(logs[1].message, /Visibility unclear/);
});

test('visibility warning preserves higher alerts and appends context without duplicate metrics', () => {
  assert.match(patientJs, /ConnectionCore\.resolveVisibilityAlert\(\s*activeAlertLevel/);
  assert.match(patientJs, /if \(update\.replacePrimary\)/);
  assert.match(patientJs, /activeAlertBaseMessage = update\.baseMessage/);
  assert.match(patientJs, /activeAlertMessage = update\.message/);
  assert.match(patientJs, /logAnomalyToSupabase\(update\.eventType, msg\)/);
  assert.match(patientJs, /canReplaceAlertLevel\(activeAlertLevel,\s*level\)/);
  assert.match(caregiverJs, /lastLoggedAlertMessage/);
});

test('anomaly logger waits for the active meal insert before attaching an event', async () => {
  const startAt = patientJs.indexOf('async function logAnomalyToSupabase(');
  const endAt = patientJs.indexOf('\nasync function updatePatientAdaptiveBaseline(', startAt);
  assert.ok(startAt >= 0 && endAt > startAt, 'anomaly logger source must be found');
  const source = patientJs.slice(startAt, endAt) + '\nglobalThis.testLogAnomaly = logAnomalyToSupabase;';
  let resolveSession;
  const pendingSession = new Promise(resolve => { resolveSession = resolve; });
  const inserts = [];
  const context = {
    mealSessionTracker: { currentId: null },
    currentMealSessionInsertPromise: pendingSession,
    isMealActive: true,
    supabaseClient: { from(table) {
      assert.equal(table, 'anomaly_logs');
      return { insert: async rows => { inserts.push(rows[0]); return { error: null }; } };
    } },
    mealMetrics: { jawVelocity: 3.25 },
    isHandOnNeck: false,
    console
  };
  vm.runInNewContext(source, context);
  const write = context.testLogAnomaly('COUGH', '雙流事件');
  context.mealMetrics.jawVelocity = 9.9;
  context.isHandOnNeck = true;
  resolveSession('meal-current');
  context.mealSessionTracker.currentId = 'meal-current';
  await write;
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].session_id, 'meal-current');
  assert.equal(inserts[0].event_type, 'COUGH');
  assert.equal(inserts[0].jaw_velocity, 3.25);
  assert.equal(inserts[0].hands_on_neck, false);
});

test('patient meal persists swallow count and marks the new event schema version', () => {
  assert.match(patientJs, /total_swallow_count:\s*mealMetrics\.swallowCount\s*\|\|\s*0/);
  assert.match(patientJs, /event_schema_version:\s*2/);
});

test('generic face-loss alert is recorded as non-confirmed visibility, not L3 choking', () => {
  const startAt = patientJs.indexOf('async function processVideoFrame(');
  const endAt = patientJs.indexOf('// 8. 警報觸發', startAt);
  const frame = patientJs.slice(startAt, endAt);
  assert.match(frame, /showChokeVisibilityWarning\(lostMsg,\s*'VISIBILITY_LOSS'\)/);
  assert.match(frame, /!faceLossVisibilityLogged/);
});

test('cough, L1, visibility, and L4 events stay separate from confirmed-choke counters', () => {
  assert.match(patientJs, /logAnomalyToSupabase\('COUGH',\s*typeStr\)/);
  assert.match(patientJs, /logAnomalyToSupabase\('L1',\s*msg\)/);
  const triggerStart = patientJs.indexOf('function triggerAlertLevel(');
  const triggerEnd = patientJs.indexOf('function speakVoicePrompt(', triggerStart);
  const trigger = patientJs.slice(triggerStart, triggerEnd);
  assert.doesNotMatch(trigger, /if \(level === 'L4'\) mealMetrics\.coughCountL2\+\+/);
  assert.match(trigger, /options\.countAsChoking !== false/);
});

test('caregiver charts separate alert events and use the selected patient baselines', () => {
  const startAt = caregiverJs.indexOf('function updateCharts(sessions = []) {');
  const endAt = caregiverJs.indexOf('// 5. WebRTC', startAt);
  assert.ok(startAt >= 0 && endAt > startAt, 'chart update source must be found');
  const source = caregiverJs.slice(startAt, endAt) + '\nglobalThis.testUpdateCharts = updateCharts;';
  const makeChart = datasetCount => ({
    data: { labels: [], datasets: Array.from({ length: datasetCount }, () => ({ data: [] })) },
    update() {}
  });
  const context = {
    anomaliesChart: makeChart(6),
    chewTrendChart: makeChart(2),
    currentPatientBaselines: { chew: 0.72 }
  };
  vm.runInNewContext(source, context);
  context.testUpdateCharts([
    { start_time: '2026-11-05T10:00:00Z', avg_chew_duration: 0.65,
          alertBreakdownAvailable: true,
      eventCounts: { cough: 1, l1: 2, l2: 0, l3: 0, l4: 1, visibility: 1 } },
    { start_time: '2026-11-04T10:00:00Z', avg_chew_duration: 0.8,
          alertBreakdownAvailable: false, eventCounts: null }
  ]);
  assert.deepEqual(context.anomaliesChart.data.datasets.map(dataset => dataset.data[0]), [1, 2, 0, 0, 1, 1]);
  assert.equal(context.anomaliesChart.data.datasets[0].data[1], null);
  assert.equal(context.chewTrendChart.data.datasets[1].data[0], 0.72);
});

test('meal history renders separate alert counts, legacy warning and event details as text', () => {
  const startAt = caregiverJs.indexOf('function renderMealHistory(');
  const endAt = caregiverJs.indexOf('// 4. Chart.js', startAt);
  assert.ok(startAt >= 0 && endAt > startAt, 'meal history renderer source must be found');
  const source = caregiverJs.slice(startAt, endAt) + '\nglobalThis.testRenderMealHistory = renderMealHistory;';
  const container = { children: [], replaceChildren() { this.children = []; }, appendChild(node) { this.children.push(node); } };
  const makeNode = tag => ({ tag, children: [], textContent: '', appendChild(node) { this.children.push(node); } });
  const context = {
    document: {
      getElementById: id => id === 'meal-history-list' ? container : null,
      createElement: makeNode
    },
    CONFIG: { DIET_PROFILES: { soft: { name: '軟食' } } }
  };
  vm.runInNewContext(source, context);
  context.testRenderMealHistory([
    { id: 'old', event_schema_version: 1, start_time: '2026-11-04T10:00:00Z', diet_type: 'soft',
      total_duration_sec: 600, total_chew_count: 15, total_swallow_count: null, avg_chew_duration: 0.8,
      risk_level: 'NORMAL', alertBreakdownAvailable: false, eventCounts: null, events: [] },
    { id: 'new', event_schema_version: 2, start_time: '2026-11-05T10:00:00Z', diet_type: 'soft',
      total_duration_sec: 540, total_chew_count: 14.5, total_swallow_count: 8, avg_chew_duration: 0.65,
      risk_level: 'HIGH_RISK', alertBreakdownAvailable: true,
      eventCounts: { cough: 1, l1: 0, l2: 0, l3: 0, l4: 1, visibility: 1 },
      events: [{ event_type: 'L3_VISIBILITY', triggered_at: '2026-11-05T10:01:00Z', details: '<img src=x onerror=alert(1)>' }] }
  ], 'recent7');
  const flatten = node => [node.textContent, ...(node.children || []).map(flatten)].join(' ');
  const rendered = container.children.map(flatten).join(' ');
  assert.equal(container.children.length, 2);
  assert.match(rendered, /舊資料：警報分級無法拆分/);
  assert.match(rendered, /一般咳嗽 1/);
  assert.match(rendered, /吞嚥 8 次/);
  assert.match(rendered, /L4 1/);
  assert.match(rendered, /畫面遮蔽 1/);
  assert.match(rendered, /<img src=x onerror=alert\(1\)>/);
});

test('history loader fetches per-meal anomaly events and preserves legacy breakdown warnings', async () => {
  const startAt = caregiverJs.indexOf('async function fetchHistoricalSessions(');
  const endAt = caregiverJs.indexOf('\nfunction setMealHistoryStatus(', startAt);
  assert.ok(startAt >= 0 && endAt > startAt, 'history loader source must be found');
  const source = caregiverJs.slice(startAt, endAt) + '\nglobalThis.testFetchMealHistory = fetchHistoricalSessions;';
  const calls = [];
  const responses = [
    { data: [
      { id: 'session-new', event_schema_version: 2, start_time: '2026-11-05T10:00:00Z' },
      { id: 'session-old', event_schema_version: 1, start_time: '2026-11-04T10:00:00Z' }
    ], error: null },
    { data: [
      { id: 'e1', session_id: 'session-new', event_type: 'COUGH', triggered_at: '2026-11-05T10:01:00Z' },
      { id: 'e2', session_id: 'session-new', event_type: 'L3_VISIBILITY', triggered_at: '2026-11-05T10:02:00Z' },
      { id: 'e3', session_id: 'session-old', event_type: 'L4', triggered_at: '2026-11-04T10:02:00Z' }
    ], error: null }
  ];
  const context = {
    caregiverSessionGeneration: 1,
    historyRequestGeneration: 0,
    supabaseClient: { from(table) {
      const call = { table, filters: [], orders: [] };
      calls.push(call);
      const response = responses.shift();
      const query = {
        select(columns) { call.columns = columns; return this; },
        eq(column, value) { call.filters.push(['eq', column, value]); return this; },
        gte(column, value) { call.filters.push(['gte', column, value]); return this; },
        in(column, value) { call.filters.push(['in', column, value]); return this; },
        order(column, options) { call.orders.push([column, options]); return this; },
        limit(value) { call.limit = value; return this; },
        then(resolve, reject) { return Promise.resolve(response).then(resolve, reject); }
      };
      return query;
    } },
    window: { ConnectionCore },
    updateCharts(rows) { context.chartRows = rows; },
    renderMealHistory(rows, range) { context.renderedRows = rows; context.renderedRange = range; },
    setMealHistoryStatus(text) { context.status = text; },
    console
  };
  vm.runInNewContext(source, context);
  await context.testFetchMealHistory('P001', 'profile-a', 1, 'recent7');
  assert.deepEqual(calls.map(call => call.table), ['meal_sessions', 'anomaly_logs']);
  assert.equal(calls[0].limit, 7);
  assert.deepEqual(calls[1].filters[0], ['in', 'session_id', ['session-old', 'session-new']]);
  const current = context.chartRows.find(session => session.id === 'session-new');
  const legacy = context.chartRows.find(session => session.id === 'session-old');
  assert.equal(current.eventCounts.cough, 1);
  assert.equal(current.eventCounts.visibility, 1);
  assert.equal(legacy.alertBreakdownAvailable, false);
  assert.equal(legacy.eventCounts, null);
  assert.equal(context.renderedRange, 'recent7');
});

test('history loader applies the selected 30-day start-time filter', async () => {
  const startAt = caregiverJs.indexOf('async function fetchHistoricalSessions(');
  const endAt = caregiverJs.indexOf('\nfunction setMealHistoryStatus(', startAt);
  const source = caregiverJs.slice(startAt, endAt) + '\nglobalThis.testFetchMealHistory = fetchHistoricalSessions;';
  const calls = [];
  const responses = [{ data: [], error: null }];
  const context = {
    caregiverSessionGeneration: 1,
    historyRequestGeneration: 0,
    supabaseClient: { from(table) {
      const call = { table, filters: [], orders: [] };
      calls.push(call);
      const response = responses.shift();
      const query = {
        select() { return this; }, eq(c,v) { call.filters.push(['eq', c, v]); return this; },
        gte(c,v) { call.filters.push(['gte', c, v]); return this; },
        order(c,o) { call.orders.push([c,o]); return this; }, limit(n) { call.limit=n; return this; },
        then(resolve,reject) { return Promise.resolve(response).then(resolve,reject); }
      };
      return query;
    } },
    window: { ConnectionCore },
    updateCharts() {}, renderMealHistory() {}, setMealHistoryStatus() {}, console
  };
  vm.runInNewContext(source, context);
  await context.testFetchMealHistory('P001', 'profile-a', 1, '30days');
  const startFilter = calls[0].filters.find(filter => filter[0] === 'gte' && filter[1] === 'start_time');
  assert.ok(startFilter, '30-day mode must filter meal start_time');
  assert.ok(Number.isFinite(Date.parse(startFilter[2])));
  assert.equal(calls[0].limit, 500);
});

test('patient session migration adds swallow-count and event-schema version fields', () => {
  const migrationPath = path.join(root, 'supabase/migrations/20261106150000_caregiver_history_data.sql');
  assert.equal(fs.existsSync(migrationPath), true, 'caregiver history migration must exist');
  const migration = fs.readFileSync(migrationPath, 'utf8');
  assert.match(migration, /add column if not exists total_swallow_count integer/);
  assert.match(migration, /add column if not exists event_schema_version smallint/);
  assert.match(migration, /default 1/);
  assert.doesNotMatch(migration, /total_swallow_count integer not null default 0/i);
  assert.doesNotMatch(migration, /avg_swallow_pause/);
});

test('caregiver history UI exposes the agreed range selector, per-meal list and live swallow count', () => {
  assert.match(caregiverPage, /id="caregiver-history-range"/);
  assert.match(caregiverPage, /value="recent7"/);
  assert.match(caregiverPage, /value="30days"/);
  assert.match(caregiverPage, /id="meal-history-list"/);
  assert.match(caregiverPage, /id="stat-swallows"/);
  assert.doesNotMatch(caregiverPage, /id="chart-swallow-trend"/);
});

test('patient meal writes use a fresh session ID and never fall back to a previous meal', () => {
  assert.match(patientJs, /createMealSessionTracker/);
  assert.match(patientJs, /mealSessionTracker\.begin\(async/);
  assert.match(patientJs, /mealSessionTracker\.currentId/);
  assert.equal(/currentSessionId/.test(patientJs), false);
});

test('patient meal startup locks synchronously before media awaits and releases in finally', () => {
  assert.match(patientJs, /createStartLock/);
  const startAt = patientJs.indexOf('async function startMealSession() {');
  const endAt = patientJs.indexOf('async function endMealSession()', startAt);
  const startFunction = patientJs.slice(startAt, endAt);
  const acquireAt = startFunction.indexOf('mealStartLock.tryEnter()');
  const mediaAwaitAt = startFunction.indexOf('await getWebcamStream()');
  assert.ok(acquireAt >= 0 && acquireAt < mediaAwaitAt, 'start lock must be acquired before the first media await');
  assert.match(startFunction, /finally\s*\{\s*mealStartLock\.release\(\);\s*\}/);
});

test('partial camera startup failure stops the acquired stream and detaches the video', () => {
  const startAt = patientJs.indexOf('async function startMealSession() {');
  const endAt = patientJs.indexOf('async function endMealSession()', startAt);
  const startFunction = patientJs.slice(startAt, endAt);
  const catchAt = startFunction.indexOf('} catch (err) {');
  const catchBlock = startFunction.slice(catchAt);
  assert.match(catchBlock, /ConnectionCore\.stopMediaStream\(stream\)/);
  assert.match(catchBlock, /webcamStream = null/);
  assert.match(catchBlock, /webcamVideo\.srcObject = null/);
});

test('patient monitoring starts while the meal insert is still pending', () => {
  const startAt = patientJs.indexOf('async function startMealSession() {');
  const endAt = patientJs.indexOf('async function endMealSession()', startAt);
  const startFunction = patientJs.slice(startAt, endAt);
  const beginAt = startFunction.indexOf('mealSessionTracker.begin(');
  assert.ok(beginAt >= 0, 'meal start should create a session insert promise');
  assert.doesNotMatch(startFunction, /await\s+mealSessionTracker\.begin\(/, 'monitoring must not wait on the database insert');
  assert.ok(startFunction.indexOf('setupWebRTCSignaling()', beginAt) > beginAt);
  assert.ok(startFunction.indexOf('requestAnimationFrame(processVideoFrame)', beginAt) > beginAt);
});

test('ending waits on the current meal insert only after stopping monitoring', () => {
  const endAt = patientJs.indexOf('async function endMealSession() {');
  const endFunction = patientJs.slice(endAt, patientJs.indexOf('// 6. Web Audio API', endAt));
  assert.match(endFunction, /currentMealSessionInsertPromise/);
  assert.match(endFunction, /await window\.ConnectionCore\.finalizeMealSession\(/);
});

test('caregiver endpoint requests a stream after its private channel subscribes', () => {
  assert.match(caregiverJs, /request_offer/);
  assert.match(caregiverJs, /\.subscribe\(\s*\(status\)/);
  assert.match(caregiverJs, /state\.activeAlertLevel !== lastLoggedAlertLevel/);
  assert.match(caregiverJs, /messageSpan\.textContent = msg/);
});

test('both endpoints derive private topics from the owner-scoped profile UUID', () => {
  assert.match(patientJs, /channelTopic\(currentPatient\.id\)/);
  assert.match(caregiverJs, /setupWebRTCSignaling\(profile\.id(?:, generation)?\)/);
  assert.match(caregiverJs, /channelTopic\(profileId\)/);
});

test('WebRTC signaling correlates negotiations and buffers early ICE candidates', () => {
  assert.match(patientJs, /payload\.clientId !== activePeerClientId/);
  assert.match(caregiverJs, /payload\.clientId === caregiverClientId/);
  assert.match(caregiverJs, /negotiationGate\.run/);
  assert.match(caregiverJs, /processOfferAndAnswer/);
  assert.match(patientJs, /remoteCandidateBuffer\.enqueue/);
  assert.match(caregiverJs, /remoteCandidateBuffer\.enqueue/);
  assert.match(patientJs, /ConnectionCore\.takeMatchingCandidates\(remoteCandidateBuffer/);
  assert.match(caregiverJs, /ConnectionCore\.takeMatchingCandidates\(remoteCandidateBuffer/);
});

test('caregiver history reads the latest sessions but renders them chronologically', () => {
  assert.match(caregiverJs, /\.order\('(?:start_time|created_at)', \{ ascending: false \}\)/);
  assert.match(caregiverJs, /\.sort\(\(a, b\) => dateValue\(a\) - dateValue\(b\)\)/);
});

test('caregiver selector loads profiles and connects using the selected profile code', () => {
  assert.match(caregiverPage, /<select[^>]*id="caregiver-patient-select"/);
  assert.match(caregiverPage, /id="btn-refresh-patients"/);
  assert.doesNotMatch(caregiverPage, /id="btn-connect-patient"[^>]*onclick=/);
  assert.match(caregiverJs, /loadCaregiverProfiles\(/);
  assert.match(caregiverJs, /connectToPatient\(\)/);
});

test('caregiver patient list query uses the authenticated owner-scoped profile table', () => {
  assert.match(caregiverJs, /\.from\('patient_profiles'\)\s*\.select\('id, patient_code, full_name'\)\s*\.order\('full_name'/);
  const migration = read('supabase/migrations/20261103120000_online_connection.sql');
  assert.match(migration, /patient_profiles_owner_select[\s\S]*owner_id = \(select auth\.uid\(\)\)/);
});

test('caregiver channel registration resolves to the selected profile and filters history by its UUID', () => {
  assert.match(caregiverJs, /select\.value\s*=\s*profile\.patient_code/);
  assert.match(caregiverJs, /fetchHistoricalSessions\(normalizedCode, profile\.id(?:, generation)?\)/);
  assert.match(caregiverJs, /setupWebRTCSignaling\(profile\.id(?:, generation)?\)/);
});

test('patient switch does not wait for slow history before attaching the new live channel', async () => {
  const startAt = caregiverJs.indexOf('async function connectToPatient(');
  const endAt = caregiverJs.indexOf('window.connectToPatient = connectToPatient;', startAt);
  assert.ok(startAt >= 0 && endAt > startAt, 'connection function source must be found');
  const source = caregiverJs.slice(startAt, endAt) + '\nglobalThis.testConnectToPatient = connectToPatient;';
  let finishHistory;
  const pendingHistory = new Promise(resolve => { finishHistory = resolve; });
  const flags = { historyStarted: false, signalingStarted: false };
  const profile = {
    id: 'profile-new', patient_code: 'P002', full_name: 'Beta', diet_type: 'soft',
    baseline_chew_duration: 0.85, baseline_swallow_pause: 1.1
  };
  const context = {
    patientSwitchInProgress: false,
    caregiverSessionGeneration: 0,
    currentPatientCode: 'P001', currentPatientProfileId: 'profile-old', caregiverClientId: 'old-client',
    peerConnection: null, supabaseChannel: null, activeNegotiationId: null, currentAnswerPayload: null,
    remoteCandidateBuffer: { clear() {} },
    supabaseClient: { from: table => {
      assert.equal(table, 'patient_profiles');
      const query = {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: profile, error: null })
      };
      return query;
    } },
    window: { ConnectionCore: {} },
    document: { getElementById: id => id === 'caregiver-patient-select'
      ? { value: 'P002', disabled: false }
      : { innerText: '', disabled: false } },
    resetCaregiverPatientView() {},
    setRealtimeStatus() {},
    setPatientListStatus() {},
    fetchHistoricalSessions() { flags.historyStarted = true; return pendingHistory; },
    setupWebRTCSignaling: async () => { flags.signalingStarted = true; },
    CONFIG: { DIET_PROFILES: { soft: { name: '軟食' } } },
    crypto: { randomUUID: () => 'new-client' },
    console
  };
  vm.runInNewContext(source, context);
  const connection = context.testConnectToPatient('P002', { quiet: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(flags.historyStarted, true);
  assert.equal(flags.signalingStarted, true, 'new live signaling should start while history is pending');
  assert.equal(await connection, true);
  finishHistory(true);
});

test('switching caregiver patients clears the previous patient view before querying the new profile', () => {
  const startAt = caregiverJs.indexOf('async function connectToPatient(');
  const endAt = caregiverJs.indexOf('window.connectToPatient = connectToPatient;', startAt);
  const connectFunction = caregiverJs.slice(startAt, endAt);
  const resetAt = connectFunction.indexOf('resetCaregiverPatientView();');
  const queryAt = connectFunction.indexOf(".from('patient_profiles')");
  assert.ok(resetAt >= 0 && queryAt > resetAt);
  assert.match(caregiverJs, /remoteVideo\.srcObject\s*=\s*null/);
  assert.match(caregiverJs, /updateCharts\(\[\]\)/);
});

test('reset caregiver view clears the previous patient video, alerts, and history logs', () => {
  const startAt = caregiverJs.indexOf('function resetCaregiverPatientView() {');
  const endAt = caregiverJs.indexOf('\nasync function connectToPatient(', startAt);
  assert.ok(startAt >= 0 && endAt > startAt, 'patient view reset source must be found');
  const source = caregiverJs.slice(startAt, endAt) + '\nglobalThis.testResetCaregiverPatientView = resetCaregiverPatientView;';
  const nodes = new Map();
  const video = { srcObject: { oldPatient: true }, pause() { this.paused = true; } };
  const placeholder = { classList: { remove(value) { this.removed = value; } } };
  const logContainer = { children: ['old patient alert'], replaceChildren(...children) { this.children = children; } };
  const context = {
    document: {
      getElementById(id) {
        if (id === 'remote-video') return video;
        if (id === 'no-stream-placeholder') return placeholder;
        if (id === 'realtime-log-container') return logContainer;
        if (!nodes.has(id)) nodes.set(id, { innerText: 'old data' });
        return nodes.get(id);
      },
      createElement() { return {}; }
    },
    anomaliesChart: {},
    chewTrendChart: {},
    historyRequestGeneration: 0,
    currentPatientBaselines: { chew: 0.85 },
    currentHistoryRange: 'recent7',
    setMealHistoryStatus() {},
    renderMealHistory() {},
    lastLoggedAlertLevel: 'L4',
    lastLoggedAlertMessage: 'old patient alert',
    hideCaregiverAlert() { context.alertHidden = true; },
    updateCharts(sessions) { context.chartSessions = sessions; }
  };
  vm.runInNewContext(source, context);
  context.testResetCaregiverPatientView();
  assert.equal(video.paused, true);
  assert.equal(video.srcObject, null);
  assert.equal(placeholder.classList.removed, 'hidden');
  assert.equal(context.alertHidden, true);
  assert.equal(context.chartSessions.length, 0);
  assert.equal(logContainer.children[0].textContent, '目前尚無異常事件紀錄');
  assert.equal(nodes.get('caregiver-patient-name').innerText, '尚未選擇個案');
  assert.equal(context.lastLoggedAlertLevel, null);
  assert.equal(context.lastLoggedAlertMessage, null);
});

test('caregiver channel generation isolates in-flight offers during patient switch', () => {
  assert.match(caregiverJs, /caregiverSessionGeneration/);
  assert.match(caregiverJs, /channel !== supabaseChannel/);
  assert.match(caregiverJs, /peerConnection !== activeConnection/);
});

test('stale realtime channel cannot route old ICE or state events after patient switch', async () => {
  const startAt = caregiverJs.indexOf('async function setupWebRTCSignaling(');
  const endAt = caregiverJs.indexOf('\nfunction requestOffer(', startAt);
  assert.ok(startAt >= 0 && endAt > startAt, 'signaling setup source must be found');
  const source = caregiverJs.slice(startAt, endAt) + '\nglobalThis.testSetupWebRTCSignaling = setupWebRTCSignaling;';
  const handlers = {};
  const oldChannel = {
    on(_type, filter, handler) { handlers[filter.event] = handler; return this; },
    subscribe(handler) { handler('SUBSCRIBED'); return this; }
  };
  const calls = { candidates: 0, states: 0 };
  const context = {
    supabaseClient: { channel: () => oldChannel },
    window: { ConnectionCore: { channelTopic: id => id, privateChannelOptions: () => ({ private: true }) } },
    caregiverSessionGeneration: 1,
    supabaseChannel: null,
    currentPatientCode: 'P001',
    currentPatientProfileId: 'profile-old',
    caregiverClientId: 'client-old',
    activeNegotiationId: null,
    currentAnswerPayload: null,
    remoteCandidateBuffer: { clear() {} },
    setRealtimeStatus() {},
    requestOffer() {},
    receiveRemoteCandidate() { calls.candidates += 1; },
    handleStateUpdate() { calls.states += 1; },
    console
  };
  vm.runInNewContext(source, context);
  await context.testSetupWebRTCSignaling('profile-old', 1);
  context.caregiverSessionGeneration = 2;
  context.supabaseChannel = {};
  context.currentPatientCode = 'P002';
  context.currentPatientProfileId = 'profile-new';
  context.caregiverClientId = 'client-new';
  await handlers.signal({ payload: {
    type: 'candidate', candidate: { candidate: 'old-ice' },
    negotiationId: 'old-negotiation', clientId: 'client-old'
  } });
  handlers.state_update({ payload: { patientCode: 'P001', totalChews: 999 } });
  assert.equal(calls.candidates, 0);
  assert.equal(calls.states, 0);
});

test('late patient history responses cannot overwrite the next selected patient', async () => {
  const startAt = caregiverJs.indexOf('async function fetchHistoricalSessions(');
  const endAt = caregiverJs.indexOf('\nfunction setMealHistoryStatus(', startAt);
  assert.ok(startAt >= 0 && endAt > startAt, 'history loader source must be found');
  const source = caregiverJs.slice(startAt, endAt) + '\nglobalThis.testFetchHistoricalSessions = fetchHistoricalSessions;';
  let resolveQuery;
  const pendingQuery = new Promise(resolve => { resolveQuery = resolve; });
  const query = {
    eq() { return this; },
    order() { return this; },
    limit() { return pendingQuery; }
  };
  const chartUpdates = [];
  const context = {
    supabaseClient: { from: table => { assert.equal(table, 'meal_sessions'); return { select: () => query }; } },
    caregiverSessionGeneration: 1,
    historyRequestGeneration: 0,
    currentHistoryRange: 'recent7',
    window: { ConnectionCore: { latestSessionsChronological: data => data } },
    updateCharts: data => chartUpdates.push(data),
    console
  };
  vm.runInNewContext(source, context);
  const load = context.testFetchHistoricalSessions('P001', 'profile-old', 1);
  context.caregiverSessionGeneration = 2;
  resolveQuery({ data: [{ id: 'old-patient-session' }], error: null });
  await load;
  assert.equal(chartUpdates.length, 0, 'stale patient history must not replace the new selection view');
});

test('caregiver profile loader populates a safe select and prefers requested then current patient', async () => {
  const startAt = caregiverJs.indexOf('async function loadCaregiverProfiles(');
  const endAt = caregiverJs.indexOf('\nasync function connectToPatient(', startAt);
  assert.ok(startAt >= 0 && endAt > startAt, 'profile loader source must be found');
  const source = caregiverJs.slice(startAt, endAt) + '\nglobalThis.testLoadCaregiverProfiles = loadCaregiverProfiles;';
  const nodes = new Map();
  const calls = {};
  const makeNode = () => ({
    disabled: false,
    value: '',
    options: [],
    replaceChildren() { this.options = []; },
    appendChild(option) { this.options.push(option); }
  });
  const context = {
    supabaseClient: {
      from(table) {
        calls.table = table;
        return { select(columns) {
          calls.columns = columns;
          return { order: async (column, options) => {
            calls.order = [column, options];
            return { data: [
              { patient_code: 'P001', full_name: 'Alpha' },
              { patient_code: 'P002', full_name: 'Beta' }
            ], error: null };
          } };
        } };
      }
    },
    currentPatientCode: 'P002',
    document: {
      getElementById(id) { if (!nodes.has(id)) nodes.set(id, makeNode()); return nodes.get(id); },
      createElement() { return { value: '', textContent: '' }; }
    },
    setPatientListStatus(message) { calls.status = message; },
    console
  };
  vm.runInNewContext(source, context);
  const profiles = await context.testLoadCaregiverProfiles('P001');
  const select = nodes.get('caregiver-patient-select');
  assert.deepEqual(profiles.map(profile => profile.patient_code), ['P001', 'P002']);
  assert.equal(calls.table, 'patient_profiles');
  assert.equal(calls.columns, 'id, patient_code, full_name');
  assert.equal(calls.order[0], 'full_name');
  assert.equal(select.value, 'P001');
  assert.deepEqual(select.options.map(option => option.textContent), ['Alpha (P001)', 'Beta (P002)']);
  assert.equal(nodes.get('btn-connect-patient').disabled, false);
  await context.testLoadCaregiverProfiles('NOT_PRESENT');
  assert.equal(select.value, 'P002', 'existing selection is preferred when requested code is unavailable');
});

test('patient diet selector stays removed while caregiver shows concise live metrics', () => {
  assert.doesNotMatch(patientPage, /請選擇本次用餐質地/);
  assert.doesNotMatch(patientPage, /id="btn-diet-(regular|soft|pureed)"/);

  assert.match(caregiverPage, /id="stat-chews"/);
  assert.match(caregiverPage, /id="stat-swallows"/);
  assert.match(caregiverPage, /id="stat-coughs"/);
  assert.doesNotMatch(caregiverPage, /id="stat-jaw-vel"/);
  assert.doesNotMatch(caregiverPage, /id="stat-pouching"/);

  const startAt = caregiverJs.indexOf('function handleStateUpdate(state) {');
  const endAt = caregiverJs.indexOf('function showCaregiverAlert(', startAt);
  const source = caregiverJs.slice(startAt, endAt) + '\nglobalThis.testHandleStateUpdate = handleStateUpdate;';
  const chewNode = { innerText: '0' };
  const swallowNode = { innerText: '0' };
  const coughNode = { innerText: '0' };
  const dietNode = { innerText: '-' };
  const context = {
    document: {
      getElementById(id) {
        if (id === 'stat-chews') return chewNode;
        if (id === 'stat-swallows') return swallowNode;
        if (id === 'stat-coughs') return coughNode;
        if (id === 'caregiver-diet-type') return dietNode;
        return null;
      }
    },
    CONFIG: { DIET_PROFILES: { soft: { name: '軟食餐盒' } } },
    lastLoggedAlertLevel: null,
    lastLoggedAlertMessage: null,
    currentPatientCode: 'P001',
    showCaregiverAlert() {},
    addRealtimeLog() {},
    hideCaregiverAlert() {},
    setRealtimeStatus() {}
  };
  vm.runInNewContext(source, context);
  context.testHandleStateUpdate({
    patientCode: 'P001',
    patientName: '王爺爺',
    dietType: 'soft',
    totalChews: 25,
    totalSwallows: 3,
    jawVelocity: -0.27,
    pouchingEvents: 0,
    coughEvents: 6,
    activeAlertLevel: null,
    sessionEnded: false
  });
  assert.equal(chewNode.innerText, 25);
  assert.equal(swallowNode.innerText, 3);
  assert.equal(coughNode.innerText, 6);
});

test('L4 overlay circles share exact geometry with handNearChestOrThroat and low-FPS body shaking works', () => {
  assert.match(patientJs, /lastCoughTime = -Infinity/);
  assert.match(patientJs, /CHOKE_SIMULTANEOUS_TRIGGER_SEC = 3\.0/);
  assert.match(patientJs, /ConnectionCore\.evaluateL4Candidate\(/);
  assert.match(patientJs, /chokeDangerAccumulator\.update\(/);

  // Verify drawOriginalDetectionOverlay uses getDangerZoneGeometry instead of mismatched canvas-width radii
  const overlayIdx = patientJs.indexOf('function drawOriginalDetectionOverlay(');
  const overlaySrc = patientJs.slice(overlayIdx);
  assert.match(overlaySrc, /getDangerZoneGeometry\(nose, chin, w, h\)/);
  assert.doesNotMatch(overlaySrc, /faceH \* 0\.55 \* w/);

  // Execute getDangerZoneGeometry, handNearChestOrThroat, and checkContinuousBodyShaking in VM
  const startAt = patientJs.indexOf('function estimateThroat(');
  const endAt = patientJs.indexOf('function calculateMAR(', startAt);
  const source = patientJs.slice(startAt, endAt) + '\nglobalThis.fns = { getDangerZoneGeometry, handNearChestOrThroat, checkContinuousBodyShaking };';
  const context = {
    bodyMotionHistory: [],
    window: { ConnectionCore },
    Math,
    Number,
    Boolean
  };
  vm.runInNewContext(source, context);

  const nose = { x: 0.5, y: 0.35 };
  const chin = { x: 0.5, y: 0.50 };
  const geom = context.fns.getDangerZoneGeometry(nose, chin, 640, 480);
  const onePointHand = [
    [{ x: geom.chestCenter.x / 640, y: geom.chestCenter.y / 480 }, ...Array.from({ length: 20 }, () => ({ x: 0.02, y: 0.02 }))]
  ];
  const stillCheck = context.fns.handNearChestOrThroat(onePointHand, nose, chin, 640, 480, 2);
  const shakingCheck = context.fns.handNearChestOrThroat(onePointHand, nose, chin, 640, 480, 1);
  assert.equal(stillCheck.near, false, 'single stray point is ignored when body is still');
  assert.equal(shakingCheck.near, true, 'single point in chest zone registers during shaking motion blur');
  assert.equal(shakingCheck.chestRadius, geom.chestRadius);
  assert.equal(shakingCheck.throatRadius, geom.throatRadius);

  // Low-FPS (6 FPS: 5 samples over 0.8s) moderate struggling shake registers true
  const samples = [
    { x: 0.45, y: 0.35, t: 1.0 },
    { x: 0.56, y: 0.37, t: 1.2 },
    { x: 0.44, y: 0.34, t: 1.4 },
    { x: 0.55, y: 0.38, t: 1.6 },
    { x: 0.46, y: 0.35, t: 1.8 }
  ];
  let shakeDetected = false;
  for (const s of samples) {
    shakeDetected = context.fns.checkContinuousBodyShaking({ x: s.x, y: s.y }, 72, s.t, 640, 480);
  }
  assert.equal(shakeDetected, true, 'moderate distress shaking at 5-6 FPS must not be locked out');
});


test('patient endpoint removes hardcoded defaults, dashboard backdoor link, and unscoped upsert pollution', () => {
  assert.doesNotMatch(patientPage, /王爺爺|陳奶奶|林伯伯/);
  assert.doesNotMatch(patientPage, /anti_choke_patient_list/);
  assert.doesNotMatch(patientPage, /caregiver\.html/);
  assert.match(patientPage, /id="login-modal"[^>]*hidden/);
  assert.match(patientPage, /id="standby-overlay"/);
  assert.match(patientPage, /id="chk-kiosk-lock"/);

  const loginStart = patientJs.indexOf('async function loginAsPatient(');
  const loginEnd = patientJs.indexOf('// ====== 依「帳號＋單一個案」嚴格隔離之嗆咳紀錄管理', loginStart);
  assert.ok(loginStart >= 0 && loginEnd > loginStart);
  const loginBody = patientJs.slice(loginStart, loginEnd);
  assert.doesNotMatch(loginBody, /\.upsert\(/, 'selecting a patient must never upsert stale localStorage profiles into another account');
  assert.doesNotMatch(loginBody, /startMealSession\(/, 'selecting a patient must enter standby instead of starting camera immediately');

  const authUiJs = read('mobile/auth-ui.js');
  assert.match(authUiJs, /purgeLocalState\(\)/);
  assert.match(authUiJs, /verifyCurrentPassword/);
  assert.match(authUiJs, /isMealSessionActive/);
  assert.match(authUiJs, /isPatientKioskLocked/);
});

test('authenticated flow enters standby for single home patient, isolates cough records, and enforces meal & kiosk locks', async () => {
  const startAt = patientJs.indexOf('// 3. UI 互動、雲端個案管理、待機模式與嗆咳紀錄隔離');
  const endAt = patientJs.indexOf('// 🎯 全域 Window 顯式綁定', startAt);
  assert.ok(startAt >= 0 && endAt > startAt, 'patient privacy/standby section must exist');
  const source = patientJs.slice(startAt, endAt) + `
    globalThis.api = {
      initializeAuthenticatedPatientFlow,
      openLoginModal,
      loginAsPatient,
      recordCoughEvent,
      getCoughRecords,
      clearAllCoughRecords,
      syncMealAndSwitchControls,
      getState: () => ({ currentAuthUser, currentPatient, isMealActive, isKioskLocked, cloudPatientProfiles }),
      setMealActive: (v) => { isMealActive = v; syncMealAndSwitchControls(); }
    };
  `;

  const store = new Map();
  const localStorageMock = {
    get length() { return store.size; },
    key(i) { return Array.from(store.keys())[i] || null; },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); }
  };

  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add(...cls) { cls.forEach(c => set.add(c)); },
      remove(...cls) { cls.forEach(c => set.delete(c)); },
      toggle(c, force) {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains(c) { return set.has(c); }
    };
  };

  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) {
      const initialHidden = (id === 'login-modal' || id === 'patient-add-view' || id === 'cough-record-modal' || id === 'btn-close-login-modal');
      elements.set(id, {
        id,
        disabled: false,
        checked: false,
        value: '',
        textContent: '',
        innerText: '',
        style: {},
        children: [],
        classList: makeClassList(initialHidden ? ['hidden'] : []),
        replaceChildren(...kids) { this.children = kids; },
        appendChild(child) { this.children.push(child); },
        append(...kids) { this.children.push(...kids); }
      });
    }
    return elements.get(id);
  };

  let cloudRows = [
    { id: 'uuid-p1', patient_code: 'P001', full_name: '張爺爺 (男)', gender: '男', diet_type: 'soft', baseline_chew_duration: 0.85, baseline_swallow_pause: 1.1 }
  ];
  let passwordVerifyResult = false;
  let verifyCalls = 0;
  const alerts = [];
  let startMealCalled = 0;

  const context = {
    supabaseClient: {
      from(table) {
        assert.equal(table, 'patient_profiles');
        return {
          select() {
            return {
              order: async () => ({ data: cloudRows.slice(), error: null }),
              eq(_col, val) {
                return {
                  maybeSingle: async () => ({ data: cloudRows.find(r => r.patient_code === val) || null, error: null })
                };
              }
            };
          }
        };
      }
    },
    currentAuthUser: null,
    cloudPatientProfiles: [],
    isKioskLocked: false,
    currentPatient: { id: null, patient_code: '', full_name: '', diet_type: 'soft', baseline_chew: 0.85, baseline_swallow: 1.1 },
    currentDiet: 'soft',
    isMealActive: false,
    mealMetrics: {},
    activeAlertLevel: null,
    activeAlertMessage: null,
    activeAlertBaseMessage: null,
    aiCtx: { clearRect() {} },
    aiCanvas: { width: 640, height: 480 },
    CONFIG: { DIET_PROFILES: { soft: { name: '軟食' }, regular: { name: '普通餐' } } },
    dismissAlertOverlay() {},
    updateRiskBadge() {},
    startMealSession: async () => { startMealCalled += 1; },
    localStorage: localStorageMock,
    confirm: () => true,
    alert: (m) => alerts.push(m),
    document: {
      getElementById: getEl,
      querySelectorAll: () => [],
      querySelector: () => ({ value: '男' }),
      createElement: (tag) => ({
        tag,
        type: '',
        className: '',
        textContent: '',
        style: {},
        attrs: {},
        children: [],
        setAttribute(k, v) { this.attrs[k] = v; },
        append(...kids) { this.children.push(...kids); },
        appendChild(c) { this.children.push(c); }
      })
    },
    window: {
      ConnectionCore,
      AuthUI: {
        verifyCurrentPassword: async () => {
          verifyCalls += 1;
          return passwordVerifyResult;
        }
      }
    },
    console,
    Date,
    String,
    Boolean,
    Array,
    JSON
  };

  vm.runInNewContext(source, context);

  // 1. Single-profile home account auto-enters standby without starting camera or opening modal
  await context.api.initializeAuthenticatedPatientFlow({ id: 'owner-A', email: 'a@example.com' });
  assert.equal(context.api.getState().currentPatient.patient_code, 'P001');
  assert.equal(startMealCalled, 0, 'must wait in standby until user clicks Start Meal');
  assert.equal(getEl('login-modal').classList.contains('hidden'), true);
  assert.equal(getEl('standby-overlay').classList.contains('hidden'), false);
  assert.equal(getEl('btn-start-meal').disabled, false);

  // 2. Cough records strictly isolated per (ownerId, patientCode)
  cloudRows.push({ id: 'uuid-p2', patient_code: 'P002', full_name: '李奶奶 (女)', gender: '女', diet_type: 'soft' });
  context.api.recordCoughEvent('AI 聽覺辨識 (咳嗽聲)', '細節 P001');
  assert.equal(context.api.getCoughRecords().length, 1);
  assert.equal(getEl('header-cough-badge').textContent, '1');

  await context.api.loginAsPatient('P002', '李奶奶 (女)');
  assert.equal(context.api.getState().currentPatient.patient_code, 'P002');
  assert.equal(context.api.getCoughRecords().length, 0, 'P002 must not see P001 cough records');
  assert.equal(getEl('header-cough-badge').textContent, '0');

  context.api.recordCoughEvent('影像頭部急抽動', '細節 P002');
  assert.equal(context.api.getCoughRecords().length, 1);
  context.api.clearAllCoughRecords();
  assert.equal(context.api.getCoughRecords().length, 0);

  await context.api.loginAsPatient('P001', '張爺爺 (男)');
  assert.equal(context.api.getCoughRecords().length, 1, 'clearing P002 cough records must preserve P001 records');

  // Cross-account check: Owner B with same patient_code P001 sees zero of Owner A's records
  await context.api.initializeAuthenticatedPatientFlow({ id: 'owner-B', email: 'b@example.com' });
  await context.api.loginAsPatient('P001', '張爺爺 (男)');
  assert.equal(context.api.getCoughRecords().length, 0, 'Owner B must never see Owner A cough records');

  // 3. Active meal locks patient switching completely
  context.api.setMealActive(true);
  assert.equal(getEl('btn-login-modal').disabled, true);
  assert.match(getEl('btn-login-modal').textContent, /用餐中鎖定/);
  await context.api.loginAsPatient('P002', '李奶奶 (女)');
  assert.equal(context.api.getState().currentPatient.patient_code, 'P001', 'cannot switch patient mid-meal');
  context.api.setMealActive(false);

  // 4. Institution Kiosk Lock blocks opening patient list until caregiver password verifies
  getEl('chk-kiosk-lock').checked = true;
  await context.api.loginAsPatient('P002', '李奶奶 (女)');
  assert.equal(context.api.getState().isKioskLocked, true);
  assert.equal(getEl('patient-list-container').children.length, 0, 'other patients removed from DOM when locked');

  passwordVerifyResult = false;
  await context.api.openLoginModal();
  assert.equal(verifyCalls, 1);
  assert.equal(getEl('login-modal').classList.contains('hidden'), true, 'wrong/cancelled password keeps modal locked');

  passwordVerifyResult = true;
  await context.api.openLoginModal();
  assert.equal(verifyCalls, 2);
  assert.equal(context.api.getState().isKioskLocked, false);
  assert.equal(getEl('login-modal').classList.contains('hidden'), false, 'valid caregiver password unlocks patient selector');
});
