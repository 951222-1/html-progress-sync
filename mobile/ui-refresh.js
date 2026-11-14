(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.attach(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_PERCENT = 80;
  const MAX_PERCENT = 200;
  const DEFAULT_PERCENT = 100;
  const STORAGE_KEY = 'antichoke-ui-font-percent-v2';

  function normalizePercent(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') ||
        (typeof value === 'string' && !value.trim())) return DEFAULT_PERCENT;
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(number)))
      : DEFAULT_PERCENT;
  }

  function dateParts(date) {
    const pad = number => String(number).padStart(2, '0');
    const year = String(date.getFullYear()).padStart(4, '0');
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const weekday = new Intl.DateTimeFormat('zh-TW', { weekday: 'long' }).format(date);
    const period = date.getHours() >= 5 && date.getHours() < 12
      ? '早安'
      : date.getHours() >= 12 && date.getHours() < 18 ? '午安' : '晚安';
    return {
      date: `${year} 年 ${month} 月 ${day} 日`,
      isoDate: `${year}-${month}-${day}`,
      weekday,
      time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
      isoTime: date.toISOString(),
      period
    };
  }

  function patientNameFromLabel(label) {
    const text = typeof label === 'string' ? label.trim() : '';
    if (!text || /尚未登入|尚未選擇/.test(text)) return '';
    return text.replace(/\s*\([^)]*\)/g, '').trim();
  }

  function bindMealFullscreen(doc) {
    if (!doc || typeof doc.getElementById !== 'function') return () => {};
    const main = typeof doc.querySelector === 'function' ? doc.querySelector('main') : null;
    const start = doc.getElementById('btn-start-meal');
    const end = doc.getElementById('btn-end-meal');
    if (!main || !start || !end || typeof start.addEventListener !== 'function' || typeof end.addEventListener !== 'function') return () => {};
    const onStart = () => {
      if (doc.fullscreenElement || typeof main.requestFullscreen !== 'function') return;
      try { const pending = main.requestFullscreen(); if (pending && typeof pending.catch === 'function') pending.catch(() => {}); } catch (_) {}
    };
    const onEnd = () => {
      if (!doc.fullscreenElement || typeof doc.exitFullscreen !== 'function') return;
      try { const pending = doc.exitFullscreen(); if (pending && typeof pending.catch === 'function') pending.catch(() => {}); } catch (_) {}
    };
    start.addEventListener('click', onStart, true);
    end.addEventListener('click', onEnd, true);
    return () => {
      if (typeof start.removeEventListener === 'function') start.removeEventListener('click', onStart, true);
      if (typeof end.removeEventListener === 'function') end.removeEventListener('click', onEnd, true);
    };
  }

  function createUiRefresh(options = {}) {
    const win = options.window || (typeof window !== 'undefined' ? window : null);
    const doc = Object.prototype.hasOwnProperty.call(options, 'document')
      ? options.document
      : win && win.document;
    const now = options.now || (() => new Date());
    const setIntervalFn = options.setInterval || (win && win.setInterval ? win.setInterval.bind(win) : setInterval);
    const clearIntervalFn = options.clearInterval || (win && win.clearInterval ? win.clearInterval.bind(win) : clearInterval);
    const storageKey = STORAGE_KEY;
    let storage = null;
    try { storage = Object.prototype.hasOwnProperty.call(options, 'storage') ? options.storage : win && win.localStorage; }
    catch (_) { storage = null; }
    if (!doc || !doc.documentElement) return { destroy() {} };

    const rootElement = doc.documentElement;
    const removeFullscreenHandlers = bindMealFullscreen(doc);
    const patientLabel = doc.getElementById('current-patient-label');
    const patientGreeting = doc.getElementById('idle-greeting');
    const dashboardGreeting = doc.getElementById('dashboard-greeting');
    const dateNodes = [doc.getElementById('idle-date'), doc.getElementById('dashboard-date')].filter(Boolean);
    const weekdayNodes = [doc.getElementById('idle-weekday'), doc.getElementById('dashboard-weekday')].filter(Boolean);
    const timeNodes = [doc.getElementById('idle-time'), doc.getElementById('dashboard-time')].filter(Boolean);
    const percentNode = doc.getElementById('ui-font-percent');
    const decreaseButton = doc.getElementById('ui-font-decrease');
    const increaseButton = doc.getElementById('ui-font-increase');
    let percent = DEFAULT_PERCENT;
    let clockTimer = null;
    let observer = null;

    function setText(node, text) {
      if (node) node.textContent = text;
    }

    function renderClock() {
      const instant = now();
      const parts = dateParts(instant);
      for (const node of dateNodes) {
        setText(node, parts.date);
        if (node.tagName === 'TIME') node.setAttribute('datetime', parts.isoDate);
      }
      for (const node of weekdayNodes) setText(node, parts.weekday);
      for (const node of timeNodes) {
        setText(node, parts.time);
        if (node.tagName === 'TIME') node.setAttribute('datetime', parts.isoTime);
      }
      const name = patientNameFromLabel(patientLabel && patientLabel.textContent);
      if (patientGreeting) setText(patientGreeting, name ? `${name}，${parts.period}` : '歡迎使用');
      if (dashboardGreeting) setText(dashboardGreeting, '照護狀態總覽');
      return parts;
    }

    function applyFontSize(value, persist) {
      percent = normalizePercent(value);
      const scale = percent / 100;
      rootElement.style.setProperty('--ui-font-scale', String(scale));
      rootElement.dataset.fontPercent = String(percent);
      setText(percentNode, `${percent}%`);
      if (decreaseButton) decreaseButton.disabled = percent <= MIN_PERCENT;
      if (increaseButton) increaseButton.disabled = percent >= MAX_PERCENT;
      if (persist && storage && typeof storage.setItem === 'function') {
        try { storage.setItem(storageKey, String(percent)); } catch (_) { /* Private mode or quota: keep this session usable. */ }
      }
      return percent;
    }

    let saved = null;
    try { if (storage && typeof storage.getItem === 'function') saved = storage.getItem(storageKey); }
    catch (_) { saved = null; }
    applyFontSize(saved, false);
    if (decreaseButton) decreaseButton.addEventListener('click', () => applyFontSize(percent - 10, true));
    if (increaseButton) increaseButton.addEventListener('click', () => applyFontSize(percent + 10, true));
    renderClock();
    clockTimer = setIntervalFn(renderClock, 30000);

    const Observer = options.MutationObserver || (win && win.MutationObserver);
    if (patientLabel && typeof Observer === 'function') {
      try {
        observer = new Observer(renderClock);
        observer.observe(patientLabel, { childList: true, characterData: true, subtree: true });
      } catch (_) { if (observer) observer.disconnect(); observer = null; }
    }
    const storageListener = event => {
      if (event && (event.key === storageKey || event.key === null)) {
        if (!event.storageArea || !storage || event.storageArea === storage) applyFontSize(event.key === null ? null : event.newValue, false);
      }
    };
    if (win && typeof win.addEventListener === 'function') win.addEventListener('storage', storageListener);

    return {
      getPercent: () => percent,
      setPercent: value => applyFontSize(value, true),
      renderClock,
      destroy() {
        if (clockTimer !== null) clearIntervalFn(clockTimer);
        if (observer) observer.disconnect();
        if (win && typeof win.removeEventListener === 'function') win.removeEventListener('storage', storageListener);
        removeFullscreenHandlers();
      }
    };
  }

  function attach(win) {
    if (!win || !win.document) return null;
    const start = () => {
      if (win.UiRefresh) return win.UiRefresh;
      win.UiRefresh = createUiRefresh({ window: win });
      return win.UiRefresh;
    };
    if (win.document.readyState === 'loading') {
      win.document.addEventListener('DOMContentLoaded', start, { once: true });
      return null;
    }
    return start();
  }

  return { MIN_PERCENT, MAX_PERCENT, DEFAULT_PERCENT, STORAGE_KEY, normalizePercent, dateParts, patientNameFromLabel, createUiRefresh, attach };
});
