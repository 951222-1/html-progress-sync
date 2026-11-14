const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const patient = read('mobile/index.html');
const caregiver = read('mobile/caregiver.html');

test('patient UI adds warm idle clock and accessible font controls without replacing meal/alert anchors', () => {
  for (const id of ['ui-refresh-controls', 'ui-font-decrease', 'ui-font-percent', 'ui-font-increase', 'idle-greeting', 'idle-date', 'idle-weekday', 'idle-time']) {
    assert.match(patient, new RegExp(`id="${id}"`));
  }
  for (const id of ['btn-start-meal', 'btn-end-meal', 'alert-overlay', 'camera-container', 'webcam-video', 'ai-canvas', 'current-patient-label']) {
    assert.match(patient, new RegExp(`id="${id}"`));
  }
  assert.match(patient, /ui-refresh\.css/);
  assert.match(patient, /ui-refresh\.js/);
});

test('caregiver UI gets monitor header controls while preserving alert, audio, chart and history anchors', () => {
  for (const id of ['ui-refresh-controls', 'ui-font-decrease', 'ui-font-percent', 'ui-font-increase', 'dashboard-date', 'dashboard-weekday', 'dashboard-time']) {
    assert.match(caregiver, new RegExp(`id="${id}"`));
  }
  for (const id of ['caregiver-alert-banner', 'caregiver-alert-text', 'btn-toggle-sound', 'remote-video', 'realtime-log-container', 'chart-anomalies', 'chart-chew-trend', 'meal-history-list']) {
    assert.match(caregiver, new RegExp(`id="${id}"`));
  }
  assert.match(caregiver, /ui-refresh\.css/);
  assert.match(caregiver, /ui-refresh\.js/);
});

test('UI refresh remains presentation-only and does not filter camera/video or alter alarm modules', () => {
  const css = read('mobile/ui-refresh.css');
  const js = read('mobile/ui-refresh.js');
  assert.doesNotMatch(css, /filter\s*:/i);
  assert.doesNotMatch(js, /auth\.signOut|purgeAllLocalPatientKeys|purgeLegacySharedPatientKeys|alert-overlay|caregiver-alert-banner/);
  assert.match(js, /antichoke-ui-font-percent-v2/);
  assert.match(js, /--ui-font-scale/);
});

const uiRefresh = require(path.join(root, 'mobile/ui-refresh.js'));

test('font-size values clamp to the documented 80–200 percent range', () => {
  assert.equal(uiRefresh.normalizePercent(20), 80);
  assert.equal(uiRefresh.normalizePercent(100), 100);
  assert.equal(uiRefresh.normalizePercent(250), 200);
  assert.equal(uiRefresh.normalizePercent('bad'), 100);
});

test('font controls touch only the dedicated UI preference key and clock reads the existing patient label', () => {
  const ids = ['idle-greeting', 'idle-date', 'idle-weekday', 'idle-time', 'ui-font-percent', 'ui-font-decrease', 'ui-font-increase', 'current-patient-label'];
  const nodes = Object.fromEntries(ids.map(id => [id, {
    id,
    tagName: id === 'idle-date' || id === 'idle-time' ? 'TIME' : 'SPAN',
    textContent: id === 'current-patient-label' ? '王爺爺 (P001)' : '',
    attributes: {},
    listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, fn) { this.listeners[name] = fn; }
  }]));
  const style = { values: {}, setProperty(name, value) { this.values[name] = value; } };
  const document = { documentElement: { style, dataset: {} }, getElementById: id => nodes[id] || null };
  const writes = [];
  const reads = [];
  const storage = {
    getItem(key) { reads.push(key); return '120'; },
    setItem(key, value) { writes.push([key, value]); }
  };
  const win = { document, localStorage: storage, addEventListener() {}, removeEventListener() {} };
  const instance = uiRefresh.createUiRefresh({
    window: win, document, storage,
    now: () => new Date(2026, 10, 14, 9, 7, 0),
    setInterval: () => 1, clearInterval() {}
  });
  assert.equal(instance.getPercent(), 120);
  assert.equal(style.values['--ui-font-scale'], '1.2');
  assert.equal(nodes['idle-greeting'].textContent, '王爺爺，早安');
  assert.equal(nodes['idle-time'].textContent, '09:07');
  nodes['ui-font-increase'].listeners.click();
  assert.deepEqual(reads, [uiRefresh.STORAGE_KEY]);
  assert.deepEqual(writes, [[uiRefresh.STORAGE_KEY, '130']]);
  instance.destroy();
});

test('fullscreen is entered only from the start-button gesture and exits from the end-button gesture', () => {
  const makeButton = id => ({ id, listeners: {}, addEventListener(type, fn, capture) { this.listeners[type] = { fn, capture }; }, removeEventListener() {} });
  const start = makeButton('btn-start-meal');
  const end = makeButton('btn-end-meal');
  let enterCalls = 0;
  let exitCalls = 0;
  const main = { requestFullscreen() { enterCalls += 1; doc.fullscreenElement = main; return Promise.resolve(); } };
  const doc = {
    documentElement: { style: { setProperty() {} }, dataset: {} },
    getElementById(id) { return ({ 'btn-start-meal': start, 'btn-end-meal': end })[id] || null; },
    querySelector(selector) { return selector === 'main' ? main : null; },
    exitFullscreen() { exitCalls += 1; doc.fullscreenElement = null; return Promise.resolve(); },
    fullscreenElement: null
  };
  const instance = uiRefresh.createUiRefresh({ document: doc, storage: null, setInterval: () => 1, clearInterval() {} });
  assert.equal(enterCalls, 0);
  assert.equal(exitCalls, 0);
  assert.equal(start.listeners.click.capture, true);
  start.listeners.click.fn();
  assert.equal(enterCalls, 1);
  end.listeners.click.fn();
  assert.equal(exitCalls, 1);
  instance.destroy();
});

