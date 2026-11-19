(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.L4Safety = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Explicitly experimental profile copied from the desktop L4 sensitivity test.
    // The web acoustic value is raw browser energy, not a YAMNet confidence score.
    const TEST_PROFILE = Object.freeze({
        triggerSec: 2.5,
        graceSec: 0.9,
        decayRate: 0.25,
        postCoughWindowSec: 12.0,
        cooldownSec: 10.0,
        maxSignalGapSec: 1.5,
        anchorGraceSec: 2.0,
        motionWindowSec: 1.4,
        motionMinFrames: 4,
        motionMinSpanSec: 0.35,
        motionSpanThreshold: 0.10,
        motionSpeedThreshold: 1.0,
        faceSizeSpanThreshold: 0.12,
        reversalDeadbandPx: 2.0,
        throatExtend: 0.50,
        throatRadiusScale: 0.72,
        throatMinRadiusPx: 24.0,
        chestExtend: 1.15,
        chestRadiusScale: 1.25,
        chestMinRadiusPx: 44.0,
        minHandPoints: 1,
        coughStdThreshold: 15.0,
        coughVelocityThreshold: 8.0,
        coughConfirmFrames: 4,
        audioEnergyThreshold: 0.20
    });

    function finitePoint(point) {
        return !!point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
            point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
    }

    function dangerZoneGeometry(nose, chin, width, height, profile = TEST_PROFILE) {
        if (!finitePoint(nose) || !finitePoint(chin) || !(width > 0) || !(height > 0)) return null;
        const faceSize = Math.hypot((chin.x - nose.x) * width, (chin.y - nose.y) * height);
        if (!Number.isFinite(faceSize) || faceSize <= 0) return null;
        const throatCenter = {
            x: chin.x + profile.throatExtend * (chin.x - nose.x),
            y: chin.y + profile.throatExtend * (chin.y - nose.y)
        };
        const chestCenter = {
            x: chin.x + profile.chestExtend * (chin.x - nose.x),
            y: chin.y + profile.chestExtend * (chin.y - nose.y)
        };
        return {
            faceSize,
            throatCenter,
            throatRadius: Math.max(faceSize * profile.throatRadiusScale, profile.throatMinRadiusPx),
            chestCenter,
            chestRadius: Math.max(faceSize * profile.chestRadiusScale, profile.chestMinRadiusPx)
        };
    }

    function analyzeHandsInDangerZones(hands, nose, chin, width, height, profile = TEST_PROFILE) {
        const geometry = dangerZoneGeometry(nose, chin, width, height, profile);
        if (!geometry) return { handsInZone: 0, nearThroat: false, nearChest: false, nearAny: false, geometry: null };
        let handsInZone = 0;
        let nearThroat = false;
        let nearChest = false;
        for (const hand of Array.isArray(hands) ? hands : []) {
            let throatPoints = 0;
            let chestPoints = 0;
            for (const point of Array.isArray(hand) ? hand : []) {
                if (!finitePoint(point)) continue;
                const px = point.x * width;
                const py = point.y * height;
                const throatDistance = Math.hypot(px - geometry.throatCenter.x * width, py - geometry.throatCenter.y * height);
                const chestDistance = Math.hypot(px - geometry.chestCenter.x * width, py - geometry.chestCenter.y * height);
                if (throatDistance < geometry.throatRadius) throatPoints++;
                if (chestDistance < geometry.chestRadius) chestPoints++;
            }
            const handInThroat = throatPoints >= profile.minHandPoints;
            const handInChest = chestPoints >= profile.minHandPoints;
            if (handInThroat || handInChest) handsInZone++;
            nearThroat ||= handInThroat;
            nearChest ||= handInChest;
        }
        return { handsInZone, nearThroat, nearChest, nearAny: handsInZone > 0, geometry };
    }

    function countDirectionReversals(positions, minExcursionPx = TEST_PROFILE.reversalDeadbandPx) {
        if (!Array.isArray(positions) || positions.length < 2) return 0;
        const threshold = Math.max(0, Number(minExcursionPx) || 0);
        let pivot = null;
        let direction = 0;
        let reversals = 0;
        for (const raw of positions) {
            if (!Number.isFinite(raw)) continue;
            if (pivot === null) {
                pivot = raw;
                continue;
            }
            if (direction === 0) {
                const delta = raw - pivot;
                if (Math.abs(delta) >= threshold && delta !== 0) {
                    direction = delta > 0 ? 1 : -1;
                    pivot = raw;
                }
            } else if (direction > 0) {
                if (raw >= pivot) pivot = raw;
                else if (pivot - raw >= threshold) {
                    reversals++;
                    direction = -1;
                    pivot = raw;
                }
            } else if (raw <= pivot) pivot = raw;
            else if (raw - pivot >= threshold) {
                reversals++;
                direction = 1;
                pivot = raw;
            }
        }
        return reversals;
    }

    function checkContinuousBodyShaking(history, nose, faceSize, now, width, height, profile = TEST_PROFILE) {
        if (!Array.isArray(history) || !finitePoint(nose) || !Number.isFinite(faceSize) || faceSize <= 0 ||
            !Number.isFinite(now) || !(width > 0) || !(height > 0)) return false;
        history.push({ x: nose.x, y: nose.y, faceSize, time: now });
        while (history.length && now - history[0].time > profile.motionWindowSec) history.shift();
        if (history.length < profile.motionMinFrames) return false;
        const elapsed = history[history.length - 1].time - history[0].time;
        if (elapsed < profile.motionMinSpanSec) return false;

        const xs = history.map(item => item.x * width);
        const ys = history.map(item => item.y * height);
        const sizes = history.map(item => item.faceSize);
        let totalSpeed = 0;
        for (let index = 1; index < history.length; index++) {
            const current = history[index];
            const previous = history[index - 1];
            const dx = (current.x - previous.x) * width;
            const dy = (current.y - previous.y) * height;
            totalSpeed += Math.hypot(dx, dy) / current.faceSize;
        }
        const xReversals = countDirectionReversals(xs, profile.reversalDeadbandPx);
        const yReversals = countDirectionReversals(ys, profile.reversalDeadbandPx);
        const minSize = Math.min(...sizes), maxSize = Math.max(...sizes);
        const sizeSpan = (maxSize - minSize) / faceSize;
        const xSpan = (Math.max(...xs) - Math.min(...xs)) / faceSize;
        const ySpan = (Math.max(...ys) - Math.min(...ys)) / faceSize;
        const hasReversal = xReversals >= 1 || yReversals >= 1 || sizeSpan > profile.faceSizeSpanThreshold;
        const hasSpan = xSpan > profile.motionSpanThreshold || ySpan > profile.motionSpanThreshold || sizeSpan > profile.motionSpanThreshold;
        return hasSpan && totalSpeed > profile.motionSpeedThreshold && hasReversal;
    }

    function evaluateL4Candidate({ bodyShaking = false, handsInZone = 0, recentCough = false } = {}) {
        const hands = Math.max(0, Math.floor(Number(handsInZone) || 0));
        if (hands >= 2) return { active: true, rate: 1.2, path: 'B', reason: '雙手同時進入喉嚨／胸口感應區' };
        if (hands >= 1 && recentCough) return { active: true, rate: 1.2, path: 'C', reason: '咳嗽後抓喉／撫胸' };
        if (hands >= 1 && bodyShaking) return { active: true, rate: 1.0, path: 'A', reason: '身體掙扎晃動＋抓喉／撫胸' };
        return { active: false, rate: 0, path: null, reason: null };
    }

    class L4Accumulator {
        constructor(profile = TEST_PROFILE) {
            this.profile = profile;
            this.reset();
        }
        reset() {
            this.duration = 0;
            this.started = false;
            this.graceStart = null;
            this.lastActive = null;
            this.lastUpdate = null;
            this.inDecay = false;
            this.reason = null;
            this.path = null;
        }
        update(now, candidate = {}) {
            if (!Number.isFinite(now)) throw new TypeError('L4 time must be finite monotonic seconds');
            const active = candidate.active === true;
            const rate = Number.isFinite(candidate.rate) && candidate.rate > 0 ? candidate.rate : 1;
            if (active) {
                if (!this.started) {
                    this.started = true;
                    this.duration = 0;
                } else if (this.graceStart !== null) {
                    if (!this.inDecay && this.lastActive !== null) this.duration += Math.max(0, now - this.lastActive) * rate;
                } else if (this.lastUpdate !== null) {
                    this.duration += Math.max(0, now - this.lastUpdate) * rate;
                }
                this.graceStart = null;
                this.inDecay = false;
                this.lastActive = now;
                this.reason = candidate.reason || this.reason;
                this.path = candidate.path || this.path;
            } else if (this.started) {
                if (this.graceStart === null) this.graceStart = now;
                else if (now - this.graceStart > this.profile.graceSec) {
                    const decayTime = this.inDecay
                        ? Math.max(0, now - (this.lastUpdate ?? now))
                        : Math.max(0, now - (this.graceStart + this.profile.graceSec));
                    this.inDecay = true;
                    this.duration = Math.max(0, this.duration - this.profile.decayRate * decayTime);
                    if (this.duration <= 1e-9) this.reset();
                }
            }
            this.lastUpdate = now;
            const duration = this.duration;
            return {
                duration,
                thresholdReached: this.started && duration + 1e-9 >= this.profile.triggerSec,
                path: this.path,
                reason: this.reason,
                active
            };
        }
    }

    class L4Detector {
        constructor(profile = TEST_PROFILE) {
            this.profile = profile;
            this.reset();
        }
        reset() {
            this.motionHistory = [];
            this.coughFrameCount = 0;
            this.lastCoughAt = null;
            this.lastAnchor = null;
            this.lastNow = null;
            this.accumulator = new L4Accumulator(this.profile);
        }
        step(now, frame = {}) {
            if (!Number.isFinite(now)) throw new TypeError('L4 time must be finite monotonic seconds');
            if (this.lastNow !== null && (now < this.lastNow || now - this.lastNow > this.profile.maxSignalGapSec)) this.reset();
            this.lastNow = now;

            const width = Number(frame.width), height = Number(frame.height);
            const landmarks = Array.isArray(frame.faceLandmarks) ? frame.faceLandmarks : null;
            const nose = landmarks && landmarks[4];
            const chin = landmarks && landmarks[152];
            const faceAvailable = finitePoint(nose) && finitePoint(chin) && width > 0 && height > 0;
            let bodyShaking = false;
            let anchor = null;
            if (faceAvailable) {
                const faceSize = Math.hypot((chin.x - nose.x) * width, (chin.y - nose.y) * height);
                bodyShaking = checkContinuousBodyShaking(this.motionHistory, nose, faceSize, now, width, height, this.profile);
                anchor = { nose, chin };
                this.lastAnchor = { nose: { ...nose }, chin: { ...chin }, time: now };
            } else {
                this.motionHistory = [];
                if (this.lastAnchor && now - this.lastAnchor.time <= this.profile.anchorGraceSec) anchor = this.lastAnchor;
                else this.lastAnchor = null;
            }

            const handInfo = anchor
                ? analyzeHandsInDangerZones(frame.handLandmarks, anchor.nose, anchor.chin, width, height, this.profile)
                : { handsInZone: 0, nearThroat: false, nearChest: false, nearAny: false, geometry: null };

            const visualCoughFrame = Number.isFinite(frame.movementStd) && frame.movementStd > this.profile.coughStdThreshold &&
                Number.isFinite(frame.jawVelocity) && Math.abs(frame.jawVelocity) > this.profile.coughVelocityThreshold;
            this.coughFrameCount = visualCoughFrame ? this.coughFrameCount + 1 : 0;
            const visionCough = frame.visionCough === true || this.coughFrameCount >= this.profile.coughConfirmFrames;
            if (this.coughFrameCount >= this.profile.coughConfirmFrames) this.coughFrameCount = 0;
            const audioCough = Number.isFinite(frame.audioEnergy) && frame.audioEnergy >= this.profile.audioEnergyThreshold;
            if (visionCough || audioCough) this.lastCoughAt = now;
            const recentCough = this.lastCoughAt !== null && now - this.lastCoughAt <= this.profile.postCoughWindowSec;
            const candidate = evaluateL4Candidate({ bodyShaking, handsInZone: handInfo.handsInZone, recentCough });
            const accumulated = this.accumulator.update(now, candidate);
            return {
                ...accumulated,
                bodyShaking,
                handInfo,
                handInZone: handInfo.nearAny,
                handsInZone: handInfo.handsInZone,
                recentCough,
                visionCough,
                audioCough,
                candidate: candidate.active
            };
        }
    }

    function createDetector(profile = TEST_PROFILE) { return new L4Detector(profile); }

    return Object.freeze({
        TEST_PROFILE,
        dangerZoneGeometry,
        analyzeHandsInDangerZones,
        countDirectionReversals,
        checkContinuousBodyShaking,
        evaluateL4Candidate,
        L4Accumulator,
        L4Detector,
        createDetector
    });
});
