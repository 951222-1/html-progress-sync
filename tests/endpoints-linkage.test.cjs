const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
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
  assert.match(caregiverJs, /setupWebRTCSignaling\(profile\.id\)/);
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
  assert.match(caregiverJs, /\.order\('created_at', \{ ascending: false \}\)/);
  assert.match(caregiverJs, /latestSessionsChronological\(data \|\| \[\], 7\)/);
});

test('caregiver channel registration resolves to the patient code selected in the UI', () => {
  assert.match(caregiverPage, /id="caregiver-patient-code"/);
  assert.match(caregiverJs, /connectToPatient/);
});
