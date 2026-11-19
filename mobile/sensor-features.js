(function (root, factory) {
    'use strict';
    const core = typeof module === 'object' && module.exports ? require('./detection-policy.js') : root.DetectionPolicyCore;
    const api = factory(core);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DetectionSensorFeatures = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
    'use strict';
    // Research features only: amplitude is not a clinical cough classifier.
    function computeRms(samples) {
        if (!samples || !samples.length) return null;
        let sum = 0;
        for (const value of samples) {
            if (!Number.isFinite(value) || Math.abs(value) > 1) return null;
            sum += value * value;
        }
        return Math.sqrt(sum / samples.length);
    }
    const unknownAudio = () => ({ audioAvailable: false, audioQuiet: null, audioCough: null, weakWheeze: null, coughDecaying: null, rms: null, reason: '音訊不足或過期' });
    class AudioFeatureTracker {
        constructor(config) {
            this.config = core.validateConfig(config);
            this.reset();
        }
        reset() {
            this.lastNow = null;
            this.lastSampleTime = null;
            this.since = null;
            this.bursts = [];
            this.wasCough = false;
        }
        sample(now, frame = {}) {
            const rms = computeRms(frame.samples);
            if (!Number.isFinite(now) || frame.available !== true || rms === null || !Number.isFinite(frame.sampleTime) ||
                (this.lastSampleTime !== null && frame.sampleTime <= this.lastSampleTime)) {
                const lastSampleTime = this.lastSampleTime;
                this.reset();
                // A frozen buffer must remain stale, not become fresh every other frame.
                if (Number.isFinite(frame.sampleTime)) this.lastSampleTime = Math.max(lastSampleTime ?? -Infinity, frame.sampleTime);
                return unknownAudio();
            }
            if (this.lastNow !== null && (now < this.lastNow || now - this.lastNow > this.config.SIGNAL_MAX_GAP_SEC)) this.reset();
            this.lastNow = now;
            this.lastSampleTime = frame.sampleTime;
            if (this.since === null) this.since = now;
            const audioCough = rms >= this.config.AUDIO_COUGH_RMS_THRESHOLD;
            if (audioCough && !this.wasCough) this.bursts.push({ time: now, rms });
            this.wasCough = audioCough;
            const window = this.config.AUDIO_DECAY_WINDOW_SEC;
            this.bursts = this.bursts.filter(item => now - item.time <= window);
            let coughDecaying = null;
            if (now - this.since >= window) {
                const early = this.bursts.filter(item => item.time < now - window / 2);
                const recent = this.bursts.filter(item => item.time >= now - window / 2);
                if (early.length >= 2 && recent.length >= 1) {
                    const mean = items => items.reduce((total, item) => total + item.rms, 0) / items.length;
                    coughDecaying = mean(recent) <= mean(early) * this.config.AUDIO_DECAY_RATIO ||
                        recent.length <= early.length * this.config.AUDIO_DECAY_RATIO;
                }
            }
            return {
                audioAvailable: true,
                audioQuiet: rms < this.config.AUDIO_QUIET_RMS_THRESHOLD,
                audioCough,
                // No calibrated wheeze model: do not invent positive evidence.
                weakWheeze: null,
                coughDecaying,
                rms,
                reason: '音量突發研究特徵；非咳嗽診斷'
            };
        }
    }
    function estimateChestROI(face, width, height) {
        if (!face || !face.nose || !face.chin || !Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16) return null;
        const { nose, chin } = face;
        if (![nose.x, nose.y, chin.x, chin.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return null;
        const length = Math.hypot((chin.x - nose.x) * width, (chin.y - nose.y) * height);
        if (length < height * 0.04 || length > height * 0.4 || chin.y <= nose.y || Math.abs(chin.x - nose.x) * width > length * 0.5) return null;
        const x = Math.floor(chin.x * width - length * 1.3);
        const y = Math.ceil(chin.y * height + length * 0.5);
        const roiWidth = Math.round(length * 2.6), roiHeight = Math.round(length * 1.3);
        if (x < 0 || y < 0 || x + roiWidth > width || y + roiHeight > height || roiWidth < 6 || roiHeight < 6) return null;
        return { x, y, width: roiWidth, height: roiHeight };
    }
    function pixelPatch(frame, rect) {
        const values = [];
        for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
            const index = (y * frame.width + x) * 4;
            if (frame.rgba[index + 3] < 200) return null;
            values.push((frame.rgba[index] * 0.2126 + frame.rgba[index + 1] * 0.7152 + frame.rgba[index + 2] * 0.0722) / 255);
        }
        return values;
    }
    function texture(values) {
        if (!values || values.length === 0) return 0;
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        if (mean < 0.02 || mean > 0.98) return 0;
        return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
    }
    function difference(a, b) {
        if (!a || !b || a.length !== b.length) return Infinity;
        return a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
    }
    class ChestMotionTracker {
        constructor(config) {
            this.config = core.validateConfig(config);
            this.reset();
        }
        reset() {
            this.lastNow = null;
            this.lastSampleTime = null;
            this.since = null;
            this.previous = null;
            this.history = [];
        }
        sample(now, frame = {}) {
            const roi = estimateChestROI(frame.face, frame.width, frame.height);
            const unavailable = reason => {
                const previousSampleTime = this.lastSampleTime;
                this.reset();
                if (Number.isFinite(frame.sampleTime)) this.lastSampleTime = Math.max(previousSampleTime ?? -Infinity, frame.sampleTime);
                return { chestStill: null, visualAvailable: false, motion: null, roi, reason };
            };
            if (!Number.isFinite(now) || frame.available !== true || !roi || !frame.rgba || frame.rgba.length !== frame.width * frame.height * 4 ||
                !Number.isFinite(frame.sampleTime) || (this.lastSampleTime !== null && frame.sampleTime <= this.lastSampleTime)) return unavailable('胸部出框、影像不足或過期');
            if (this.lastNow !== null && (now < this.lastNow || now - this.lastNow > this.config.SIGNAL_MAX_GAP_SEC)) this.reset();
            const chest = pixelPatch(frame, roi);
            const background = pixelPatch(frame, { x: 1, y: 1, width: Math.floor(frame.width * 0.2), height: Math.floor(frame.height * 0.35) });
            if (texture(chest) < this.config.CHEST_MIN_TEXTURE || texture(background) < this.config.CHEST_MIN_TEXTURE) return unavailable('低紋理／光線不佳；需人工確認');
            let motion = null;
            if (this.previous) {
                const displacement = Math.hypot(frame.face.nose.x - this.previous.face.nose.x, frame.face.nose.y - this.previous.face.nose.y);
                if (difference(background, this.previous.background) > this.config.CHEST_MOTION_THRESHOLD * 2 || displacement > 0.03) return unavailable('鏡頭或錨點移動；需人工確認');
                motion = difference(chest, this.previous.chest);
                if (!Number.isFinite(motion)) return unavailable('胸部 ROI 尺寸改變');
                this.history.push({ time: now, motion });
            }
            if (this.since === null) this.since = now;
            this.previous = { chest, background, face: { nose: { ...frame.face.nose } } };
            this.lastNow = now;
            this.lastSampleTime = frame.sampleTime;
            this.history = this.history.filter(item => now - item.time <= this.config.CHEST_STILL_WINDOW_SEC);
            if (now - this.since < this.config.CHEST_STILL_WINDOW_SEC || !this.history.length) {
                return { chestStill: null, visualAvailable: false, motion, roi, reason: '胸部研究 ROI 收集時間序列中' };
            }
            const chestStill = this.history.every(item => item.motion < this.config.CHEST_MOTION_THRESHOLD);
            return { chestStill, visualAvailable: true, motion, roi, reason: '未校驗胸部影像運動特徵，不等於呼吸量' };
        }
    }
    return Object.freeze({ computeRms, AudioFeatureTracker, estimateChestROI, ChestMotionTracker });
});
