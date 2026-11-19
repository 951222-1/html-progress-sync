(function (root, factory) {
    'use strict';
    const commonJS = typeof module === 'object' && module.exports;
    const api = factory(commonJS ? require('./detection-policy.js') : root.DetectionPolicyCore,
        commonJS ? require('./sensor-features.js') : root.DetectionSensorFeatures);
    if (commonJS) module.exports = api;
    if (root) root.DetectionRuntime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, sensors) {
    'use strict';
    const OVERRIDE_KEY = 'anti_choke_threshold_overrides_v1';
    const TIMING_KEYS = Object.freeze(['CHOKE_DEBOUNCE_SEC', 'CHOKE_PRE_ALARM_SEC', 'CHOKE_ALARM_SEC',
        'COUGH_IGNORE_SEC', 'COUGH_LOG_SEC', 'COUGH_ALERT_SEC', 'COUGH_HIGH_RISK_ALERT_SEC']);
    function resolveSettings(config, values = {}, profile = 'standard') {
        const shared = core.validateConfig(config);
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('本機覆寫格式錯誤，監測已停用。');
        for (const key of Object.keys(values)) if (!TIMING_KEYS.includes(key)) throw new TypeError(`不可覆寫參數：${key}`);
        const effective = core.validateConfig({ ...shared, ...values });
        new core.DetectionPolicy(effective, profile); // Validate manual profile as well.
        return { shared, effective, overrides: { ...values }, profile, overridden: Object.keys(values).length > 0 || profile !== 'standard' };
    }
    async function loadSettings(fetcher, storage) {
        const response = await fetcher('../shared/thresholds.json', { cache: 'no-store' });
        if (!response || !response.ok) throw new Error('共用參數讀取失敗：監測已停用，無舊規則備援。');
        const shared = core.validateConfig(await response.json());
        const raw = storage ? storage.getItem(OVERRIDE_KEY) : null;
        if (raw === null) return resolveSettings(shared);
        const saved = JSON.parse(raw);
        if (!saved || typeof saved.profile !== 'string' || !saved.values) throw new TypeError('本機設定損壞，請恢復共用值。');
        return resolveSettings(shared, saved.values, saved.profile);
    }
    function saveOverrides(shared, values, profile, storage) {
        const settings = resolveSettings(shared, values, profile);
        storage.setItem(OVERRIDE_KEY, JSON.stringify({ values: settings.overrides, profile: settings.profile }));
        return settings;
    }
    function restoreSharedSettings(shared, storage) {
        const settings = resolveSettings(shared);
        storage.removeItem(OVERRIDE_KEY);
        return settings;
    }
    const EVENT_KEY = 'anti_choke_local_policy_events_v1';
    const LABELS = Object.freeze({
        unknown: '感測不足／需人工確認', normal: '目前未達雙訊號門檻（非安全判定）',
        observing: '雙訊號研究觀察中，請持續人工注意', pre_alarm: '疑似異常預警，請確認個案狀況',
        emergency: '疑似梗塞異常，請立即人工確認及協助', caregiver_alert: '嗆咳持續且研究特徵衰減，請溫和確認'
    });
    const ACTIONS = Object.freeze({
        pre_alarm: { message: '疑似異常預警，請查看個案。靜音不會停止緊急升級。', fullScreen: false, sound: 'soft' },
        emergency: { message: '疑似梗塞異常持續，請立即人工確認並依現場緊急處置流程協助。', fullScreen: true, sound: 'alarm' },
        cough_log: { message: '雙訊號嗆咳研究事件：僅本機靜默紀錄。', fullScreen: false, sound: null },
        caregiver_alert: { message: '嗆咳研究訊號持續且音量或事件頻率衰減，請溫和確認狀況。', fullScreen: false, sound: 'soft' }
    });
    class MonitoringRuntime {
        constructor(settings, { storage } = {}) {
            this.storage = storage;
            this.patientKey = null;
            // No external notification transport is installed in this research build.
            this.externalNotificationsEnabled = false;
            this.applySettings(settings);
        }
        applySettings(settings) {
            const validated = resolveSettings(settings.shared, settings.overrides, settings.profile);
            this.settings = validated;
            this.policy = new core.DetectionPolicy(validated.effective, validated.profile);
            this.audioFeatures = new sensors.AudioFeatureTracker(validated.effective);
            this.chestFeatures = new sensors.ChestMotionTracker(validated.effective);
            this.reset();
        }
        reset() {
            this.policy.reset();
            this.audioFeatures.reset();
            this.chestFeatures.reset();
            this.preMuted = false;
            this.lastResult = { events: [], status: 'unknown', chokeElapsed: 0, coughElapsed: 0 };
        }
        changePatient(key) {
            if (key !== this.patientKey) {
                this.patientKey = key;
                this.reset();
            }
        }
        acknowledgePreAlarm() {
            this.policy.acknowledgePreAlarm();
            this.preMuted = true;
        }
        step(now, signals) {
            const result = this.policy.step(now, signals);
            if (result.status !== 'pre_alarm') this.preMuted = false;
            const actions = result.events.map(event => ({ ...ACTIONS[event.type], ...event }));
            let storageWarning = '';
            if (result.events.length && this.storage) {
                try {
                    const raw = this.storage.getItem(EVENT_KEY);
                    const old = raw === null ? [] : JSON.parse(raw);
                    if (!Array.isArray(old)) throw new Error('invalid local event log');
                    const records = result.events.map(event => ({ ...event, monotonicTime: now, patientKey: this.patientKey }));
                    this.storage.setItem(EVENT_KEY, JSON.stringify([...old, ...records].slice(-100)));
                } catch (_) { storageWarning = '本機紀錄寫入失敗；警報 UI 仍有效，請人工記錄。'; }
            }
            this.lastResult = result;
            return { ...result, presentation: { label: LABELS[result.status], actions, preMuted: this.preMuted, storageWarning } };
        }
    }
    return Object.freeze({ loadSettings, saveOverrides, restoreSharedSettings, resolveSettings, OVERRIDE_KEY, TIMING_KEYS, EVENT_KEY, MonitoringRuntime });
});
