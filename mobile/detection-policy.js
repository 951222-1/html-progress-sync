(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DetectionPolicyCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const RANGES = Object.freeze({
        CHOKE_DEBOUNCE_SEC: [0.1, 10], CHOKE_PRE_ALARM_SEC: [0.1, 60], CHOKE_ALARM_SEC: [0.1, 120],
        COUGH_IGNORE_SEC: [0.1, 60], COUGH_LOG_SEC: [0.1, 120], COUGH_ALERT_SEC: [0.1, 300],
        COUGH_HIGH_RISK_ALERT_SEC: [0.1, 300], SIGNAL_MAX_GAP_SEC: [0.05, 10], COUGH_EVENT_GAP_SEC: [0.05, 10],
        AUDIO_QUIET_RMS_THRESHOLD: [0.000001, 1], AUDIO_COUGH_RMS_THRESHOLD: [0.000001, 1],
        AUDIO_DECAY_WINDOW_SEC: [0.1, 60], AUDIO_DECAY_RATIO: [0.01, 0.99],
        CHEST_STILL_WINDOW_SEC: [0.1, 30], CHEST_MOTION_THRESHOLD: [0.000001, 1], CHEST_MIN_TEXTURE: [0.000001, 1],
        AUDIO_CHOKE_TH_FUSION: [0, 1], AUDIO_CHOKE_TH_SOLO: [0, 1], AUDIO_SOLO_CONFIRM: [1, 100],
        ALERT_COOLDOWN_SEC: [0, 300], AUDIO_SAMPLE_RATE: [8000, 192000], AUDIO_WINDOW_SEC: [0.01, 30], AUDIO_HOP_SEC: [0.01, 30]
    });
    function validateConfig(config) {
        const fail = message => { throw new TypeError(`Invalid config: ${message}. Monitoring blocked.`); };
        if (!config || typeof config !== 'object' || Array.isArray(config)) fail('complete config required');
        if (config.SCHEMA_VERSION !== 1) fail('SCHEMA_VERSION must be 1');
        if (config.TIMING_ORIGIN !== 'first_signal') fail('TIMING_ORIGIN must be first_signal');
        if (typeof config.ENABLE_EXTERNAL_NOTIFICATIONS !== 'boolean') fail('ENABLE_EXTERNAL_NOTIFICATIONS must be boolean');
        for (const [key, [min, max]] of Object.entries(RANGES)) {
            if (!Number.isFinite(config[key]) || config[key] < min || config[key] > max) fail(`${key} outside ${min}..${max}`);
        }
        if (!(config.CHOKE_DEBOUNCE_SEC <= config.CHOKE_PRE_ALARM_SEC && config.CHOKE_PRE_ALARM_SEC < config.CHOKE_ALARM_SEC)) fail('CHOKE timing order');
        if (!(config.COUGH_IGNORE_SEC <= config.COUGH_LOG_SEC && config.COUGH_LOG_SEC < config.COUGH_ALERT_SEC && config.COUGH_ALERT_SEC <= config.COUGH_HIGH_RISK_ALERT_SEC)) fail('COUGH timing order');
        if (!(config.AUDIO_QUIET_RMS_THRESHOLD < config.AUDIO_COUGH_RMS_THRESHOLD)) fail('RMS timing order');
        if (config.AUDIO_HOP_SEC > config.AUDIO_WINDOW_SEC) fail('AUDIO_HOP_SEC exceeds window');
        if (!Number.isInteger(config.AUDIO_SAMPLE_RATE) || !Number.isInteger(config.AUDIO_SOLO_CONFIRM)) fail('audio counts must be integers');
        return Object.freeze({ ...config });
    }
    class DetectionPolicy {
        constructor(config, profile = 'standard') {
            this.config = validateConfig(config);
            if (!['standard', 'high_risk'].includes(profile)) throw new TypeError('Unknown research profile');
            this.profile = profile;
            this.reset();
        }
        reset() {
            this.lastNow = null;
            this.chokeStart = null;
            this.preEmitted = false;
            this.emergencyEmitted = false;
            this.preAcknowledged = false;
            this.coughStart = null;
            this.coughLogged = false;
            this.caregiverEmitted = false;
            this.lastCough = null;
        }
        acknowledgePreAlarm() {
            // UI may silence the pre-alarm. Do not clear the ongoing episode.
            if (this.preEmitted) this.preAcknowledged = true;
        }
        step(now, signals = {}) {
            if (!Number.isFinite(now)) {
                this.reset();
                throw new TypeError('now must be finite monotonic seconds');
            }
            if (this.lastNow !== null && (now < this.lastNow || now - this.lastNow > this.config.SIGNAL_MAX_GAP_SEC)) this.reset();
            this.lastNow = now;
            signals = signals && typeof signals === 'object' ? signals : {};
            const events = [];
            const candidate = signals.visualAvailable === true && signals.audioAvailable === true &&
                signals.handNearThroat === true && signals.chestStill === true &&
                (signals.audioQuiet === true || signals.weakWheeze === true);
            if (candidate) {
                this.coughStart = null;
                this.coughLogged = false;
                this.caregiverEmitted = false;
                this.lastCough = null;
                if (this.chokeStart === null) this.chokeStart = now;
                const elapsed = now - this.chokeStart;
                if (elapsed >= this.config.CHOKE_PRE_ALARM_SEC && !this.preEmitted) {
                    this.preEmitted = true;
                    events.push({ type: 'pre_alarm', elapsed });
                }
                if (elapsed >= this.config.CHOKE_ALARM_SEC && !this.emergencyEmitted) {
                    this.emergencyEmitted = true;
                    events.push({ type: 'emergency', elapsed });
                }
                const status = this.emergencyEmitted ? 'emergency' : this.preEmitted ? 'pre_alarm' : 'observing';
                return { events, status, chokeElapsed: elapsed, coughElapsed: 0 };
            }
            this.chokeStart = null;
            this.preEmitted = false;
            this.emergencyEmitted = false;
            this.preAcknowledged = false;
            const dualAvailable = signals.visualAvailable === true && signals.audioAvailable === true;
            const coughCandidate = dualAvailable &&
                signals.visionCough === true && signals.audioCough === true;
            const coughKnown = dualAvailable && typeof signals.visionCough === 'boolean' && typeof signals.audioCough === 'boolean';
            if (coughCandidate) this.lastCough = now;
            const bridging = coughKnown && this.lastCough !== null && now - this.lastCough <= this.config.COUGH_EVENT_GAP_SEC;
            if (coughCandidate || bridging) {
                if (this.coughStart === null) this.coughStart = now;
                const elapsed = now - this.coughStart;
                if (elapsed >= this.config.COUGH_LOG_SEC && !this.coughLogged) {
                    this.coughLogged = true;
                    events.push({ type: 'cough_log', elapsed });
                }
                const threshold = this.profile === 'high_risk' ? this.config.COUGH_HIGH_RISK_ALERT_SEC : this.config.COUGH_ALERT_SEC;
                if (elapsed > threshold && signals.coughDecaying === true && !this.caregiverEmitted) {
                    this.caregiverEmitted = true;
                    events.push({ type: 'caregiver_alert', elapsed });
                }
                return { events, status: this.caregiverEmitted ? 'caregiver_alert' : 'observing', chokeElapsed: 0, coughElapsed: elapsed };
            }
            this.coughStart = null;
            this.coughLogged = false;
            this.caregiverEmitted = false;
            this.lastCough = null;
            const known = signals.visualAvailable === true && signals.audioAvailable === true &&
                ['handNearThroat', 'chestStill', 'audioQuiet', 'weakWheeze', 'visionCough', 'audioCough'].every(key => typeof signals[key] === 'boolean');
            return { events, status: known ? 'normal' : 'unknown', chokeElapsed: 0, coughElapsed: 0 };
        }
    }
    return Object.freeze({ validateConfig, DetectionPolicy });
});
