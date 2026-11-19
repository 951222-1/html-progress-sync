(function (browserWindow, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
        return;
    }
    if (browserWindow) browserWindow.FontSizeUI = api.createFontSizeUI({ window: browserWindow });
    if (typeof define === 'function' && define.amd) define([], () => api);
})(typeof window !== 'undefined' ? window : null, function () {
'use strict';
const MIN_PERCENT = 80;
const MAX_PERCENT = 200;
const DEFAULT_PERCENT = 100;
const STORAGE_KEY = 'antichoke-ui-font-percent-v1';

function normalizePercent(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') ||
        (typeof value === 'string' && !value.trim())) return DEFAULT_PERCENT;
    const number = Number(value);
    return Number.isFinite(number)
        ? Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(number)))
        : DEFAULT_PERCENT;
}

// Explicit options override window defaults; null disables an optional dependency.
// Storage uses plain integer strings. Initialization and incoming storage events do not write.
// Instance methods: getPercent() -> number; setPercent(value) -> normalized number;
// attachLogout(existingButton) -> toolbar element, or null if required DOM nodes are missing.
function createFontSizeUI(options = {}) {
    const browserWindow = options.window || (typeof window !== 'undefined' ? window : null);
    const hasOption = name => Object.prototype.hasOwnProperty.call(options, name);
    const document = hasOption('document') ? options.document : browserWindow && browserWindow.document;
    const root = document && document.documentElement;
    let storage = null;
    try {
        storage = hasOption('storage') ? options.storage : browserWindow && browserWindow.localStorage;
    } catch (_) { /* Storage denied. */ }
    const eventTarget = hasOption('eventTarget') ? options.eventTarget : browserWindow;
    const CustomEvent = hasOption('CustomEvent') ? options.CustomEvent : browserWindow && browserWindow.CustomEvent;
    const ResizeObserver = hasOption('ResizeObserver') ? options.ResizeObserver : browserWindow && browserWindow.ResizeObserver;
    let percent = DEFAULT_PERCENT;
    let controls = null;
    let bar = null;
    let attachedLogout = null;
    let observer = null;
    let watchingHeight = false;

    function measureHeight() {
        if (!bar || !root || !root.style || typeof root.style.setProperty !== 'function') return;
        let height = bar.offsetHeight;
        if (typeof bar.getBoundingClientRect === 'function') height = bar.getBoundingClientRect().height;
        if (typeof height === 'number' && Number.isFinite(height) && height >= 0) {
            root.style.setProperty('--ui-preferences-height', String(Math.ceil(height)) + 'px');
        }
    }

    function watchHeight() {
        if (watchingHeight) return;
        watchingHeight = true;
        if (typeof ResizeObserver === 'function') {
            try {
                observer = new ResizeObserver(measureHeight);
                observer.observe(bar);
                return;
            } catch (_) { /* Fall back when observation is unavailable. */ }
        }
        if (eventTarget && typeof eventTarget.addEventListener === 'function') {
            eventTarget.addEventListener('resize', measureHeight);
        }
    }

    function updateControls() {
        if (!controls) return;
        controls.input.value = String(percent);
        controls.decrease.disabled = percent <= MIN_PERCENT;
        controls.increase.disabled = percent >= MAX_PERCENT;
    }

    function apply(value, persist) {
        percent = normalizePercent(value);
        const scale = percent / 100;
        if (root && root.style && typeof root.style.setProperty === 'function') {
            root.style.setProperty('--ui-font-scale', String(scale));
        }
        if (root && root.dataset) root.dataset.fontPercent = String(percent);
        updateControls();
        measureHeight();
        if (persist && storage && typeof storage.setItem === 'function') {
            try { storage.setItem(STORAGE_KEY, String(percent)); } catch (_) { /* Private mode / quota. */ }
        }
        if (eventTarget && typeof eventTarget.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
            eventTarget.dispatchEvent(new CustomEvent('ui-font-size-change', { detail: { percent, scale } }));
        }
        return percent;
    }

    function attachLogout(button) {
        if (!button || !document || !document.body ||
            typeof document.createElement !== 'function' ||
            typeof document.body.appendChild !== 'function') return null;
        if (!bar) {
            bar = (typeof document.getElementById === 'function' && document.getElementById('ui-preferences-bar')) || document.createElement('div');
            bar.id = 'ui-preferences-bar';
            bar.className = 'ui-preferences-bar';
            const group = document.createElement('div');
            group.className = 'ui-font-controls';
            const label = document.createElement('label');
            label.className = 'ui-font-label';
            label.textContent = '字體大小';
            label.htmlFor = 'ui-font-percent';
            const decrease = document.createElement('button');
            decrease.id = 'ui-font-decrease';
            decrease.type = 'button';
            decrease.textContent = '縮小';
            decrease.setAttribute('aria-label', '縮小字體，每次 10 個百分點');
            const value = document.createElement('span');
            value.className = 'ui-font-value';
            const input = document.createElement('input');
            input.id = 'ui-font-percent';
            input.type = 'number';
            input.min = String(MIN_PERCENT);
            input.max = String(MAX_PERCENT);
            input.step = '1';
            input.value = String(percent);
            input.setAttribute('aria-label', '字體大小百分比');
            const suffix = document.createElement('span');
            suffix.textContent = '%';
            suffix.setAttribute('aria-hidden', 'true');
            value.appendChild(input);
            value.appendChild(suffix);
            const increase = document.createElement('button');
            increase.id = 'ui-font-increase';
            increase.type = 'button';
            increase.textContent = '放大';
            increase.setAttribute('aria-label', '放大字體，每次 10 個百分點');
            controls = { input, decrease, increase };
            decrease.addEventListener('click', () => apply(percent - 10, true));
            increase.addEventListener('click', () => apply(percent + 10, true));
            input.addEventListener('change', () => apply(input.value, true));
            for (const child of [label, decrease, value, increase]) group.appendChild(child);
            bar.appendChild(group);
            if (bar.parentNode !== document.body) document.body.appendChild(bar);
        }
        if (attachedLogout && attachedLogout !== button && attachedLogout.parentNode === bar) {
            bar.removeChild(attachedLogout);
        }
        button.type = 'button';
        if (typeof button.setAttribute === 'function' && typeof button.getAttribute === 'function' && !button.getAttribute('aria-label')) {
            button.setAttribute('aria-label', '登出');
        }
        if (button.parentNode !== bar) bar.appendChild(button);
        attachedLogout = button;
        if (document.body.classList && typeof document.body.classList.add === 'function') {
            document.body.classList.add('has-ui-preferences');
        }
        updateControls();
        measureHeight();
        watchHeight();
        return bar;
    }

    let saved = null;
    try {
        if (storage && typeof storage.getItem === 'function') saved = storage.getItem(STORAGE_KEY);
    } catch (_) { /* Storage denied. */ }
    apply(saved, false);
    if (eventTarget && typeof eventTarget.addEventListener === 'function') {
        eventTarget.addEventListener('storage', event => {
            if (event.key !== STORAGE_KEY && event.key !== null) return;
            if (event.storageArea && storage && event.storageArea !== storage) return;
            apply(event.key === null ? null : event.newValue, false);
        });
    }
    return { getPercent: () => percent, setPercent: value => apply(value, true), attachLogout };
}

return { createFontSizeUI, normalizePercent, MIN_PERCENT, MAX_PERCENT, DEFAULT_PERCENT, STORAGE_KEY };
});
