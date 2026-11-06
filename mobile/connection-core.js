(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.ConnectionCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function channelTopic(profileId) {
        const id = String(profileId || '').trim();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
            throw new TypeError('A valid patient profile ID is required to create a Realtime channel.');
        }
        return `webrtc-${id.toLowerCase()}`;
    }

    function privateChannelOptions() {
        return { config: { private: true } };
    }

    function createCandidateBuffer() {
        let pending = [];
        return Object.freeze({
            enqueue(candidate) {
                if (candidate) pending.push(candidate);
            },
            drain() {
                const items = pending;
                pending = [];
                return items;
            },
            clear() {
                pending = [];
            },
            get size() {
                return pending.length;
            }
        });
    }

    function takeMatchingCandidates(buffer, negotiationId, clientId) {
        if (!buffer || typeof buffer.drain !== 'function') return [];
        return buffer.drain().filter(candidate =>
            candidate && candidate.negotiationId === negotiationId && candidate.clientId === clientId
        );
    }

    function canReplaceAlertLevel(activeLevel, incomingLevel) {
        if (!activeLevel) return true;
        const priority = { L1: 1, L3: 2, L2: 3, L4: 4 };
        return (priority[incomingLevel] || 0) > (priority[activeLevel] || 0);
    }

    function resolveVisibilityAlert(activeLevel, baseMessage, currentMessage, notice, eventType = 'L3_VISIBILITY') {
        const detail = String(notice || '');
        const visibilityEventType = eventType === 'VISIBILITY_LOSS' ? 'VISIBILITY_LOSS' : 'L3_VISIBILITY';
        if (canReplaceAlertLevel(activeLevel, 'L3')) {
            return {
                level: 'L3',
                baseMessage: detail,
                message: detail,
                replacePrimary: true,
                countAsChoking: false,
                eventType: visibilityEventType
            };
        }

        const primary = String(baseMessage || currentMessage || '');
        const current = String(currentMessage || primary);
        const message = current.includes(detail) ? current : [primary, detail].filter(Boolean).join('\n\n');
        return {
            level: activeLevel,
            baseMessage: primary || detail,
            message,
            replacePrimary: false,
            countAsChoking: false,
            eventType: visibilityEventType
        };
    }

    function createFaceLossWarningGuard(graceSec = 0.6) {
        const grace = Number.isFinite(Number(graceSec)) ? Math.max(0, Number(graceSec)) : 0.6;
        let missingSince = null;
        let candidateAtLoss = false;
        let warned = false;
        return Object.freeze({
            update(faceVisible, candidate, currentTime) {
                const now = Number(currentTime);
                if (!Number.isFinite(now)) return false;
                if (faceVisible) {
                    missingSince = null;
                    candidateAtLoss = false;
                    warned = false;
                    return false;
                }
                if (missingSince === null) {
                    missingSince = now;
                    candidateAtLoss = Boolean(candidate);
                }
                if (!candidateAtLoss || warned || now - missingSince <= grace) return false;
                warned = true;
                return true;
            },
            reset() {
                missingSince = null;
                candidateAtLoss = false;
                warned = false;
            }
        });
    }

    function countDirectionReversals(positions, minExcursion = 3.0) {
        if (!Array.isArray(positions) || positions.length < 2) return 0;
        const threshold = Number.isFinite(Number(minExcursion)) ? Math.max(0, Number(minExcursion)) : 3.0;
        let pivot = null;
        let direction = 0;
        let reversals = 0;

        for (const rawPosition of positions) {
            const position = Number(rawPosition);
            if (!Number.isFinite(position)) continue;
            if (pivot === null) {
                pivot = position;
                continue;
            }

            if (direction === 0) {
                const initialMovement = position - pivot;
                if (Math.abs(initialMovement) >= threshold && initialMovement !== 0) {
                    direction = Math.sign(initialMovement);
                    pivot = position;
                }
            } else if (direction > 0) {
                if (position >= pivot) {
                    pivot = position;
                } else if (pivot - position >= threshold) {
                    reversals += 1;
                    direction = -1;
                    pivot = position;
                }
            } else if (position <= pivot) {
                pivot = position;
            } else if (position - pivot >= threshold) {
                reversals += 1;
                direction = 1;
                pivot = position;
            }
        }
        return reversals;
    }

    function evaluateL4Candidate(input = {}) {
        const {
            bodyShaking = false,
            handInZone = false,
            handsInZone = 0,
            recentCough = false
        } = input || {};
        const count = Math.max(0, Math.floor(Number(handsInZone) || 0));
        const hasHand = Boolean(handInZone || count >= 1);

        if (count >= 2) {
            return {
                active: true,
                rate: 1.2,
                path: 'two_hands',
                reason: '雙手同時抓喉／撫胸窒息手勢'
            };
        }
        if (hasHand && Boolean(recentCough)) {
            return {
                active: true,
                rate: 1.2,
                path: 'post_cough_clutch',
                reason: '嗆咳後持續抓喉／撫胸'
            };
        }
        if (hasHand && Boolean(bodyShaking)) {
            return {
                active: true,
                rate: 1.0,
                path: 'struggle',
                reason: '身體掙扎晃動＋手部拍胸／抓喉'
            };
        }
        return { active: false, rate: 0.0, path: null, reason: null };
    }

    function createChokeDangerAccumulator(options = {}) {
        const trigger = Number.isFinite(Number(options.triggerSec)) && Number(options.triggerSec) > 0
            ? Number(options.triggerSec)
            : 3.0;
        const grace = Number.isFinite(Number(options.graceSec)) && Number(options.graceSec) >= 0
            ? Number(options.graceSec)
            : 0.6;
        const decay = Number.isFinite(Number(options.decayRate)) && Number(options.decayRate) >= 0
            ? Number(options.decayRate)
            : 0.5;

        let started = false;
        let graceStartTime = null;
        let inDecay = false;
        let lastActiveTime = null;
        let lastUpdateTime = null;
        let duration = 0.0;
        let reason = null;
        let path = null;

        function reset() {
            started = false;
            graceStartTime = null;
            inDecay = false;
            lastActiveTime = null;
            lastUpdateTime = null;
            duration = 0.0;
            reason = null;
            path = null;
        }

        function snapshot() {
            return {
                active: started,
                duration,
                triggered: duration + 1e-9 >= trigger,
                triggerSec: trigger,
                reason,
                path
            };
        }

        return Object.freeze({
            update(candidateOrActive, currentTime) {
                const now = Number(currentTime);
                if (!Number.isFinite(now)) return snapshot();

                const isObject = candidateOrActive && typeof candidateOrActive === 'object';
                const isActive = isObject ? Boolean(candidateOrActive.active) : Boolean(candidateOrActive);
                const rawRate = isObject && Number.isFinite(Number(candidateOrActive.rate))
                    ? Number(candidateOrActive.rate)
                    : 1.0;
                const effectiveRate = rawRate > 0 ? rawRate : 1.0;
                const stepReason = isObject ? candidateOrActive.reason : null;
                const stepPath = isObject ? candidateOrActive.path : null;

                if (isActive) {
                    if (stepReason) reason = stepReason;
                    if (stepPath) path = stepPath;

                    if (!started) {
                        started = true;
                        duration = 0.0;
                    } else if (graceStartTime !== null) {
                        if (!inDecay && lastActiveTime !== null) {
                            duration += Math.max(0, now - lastActiveTime) * effectiveRate;
                        }
                    } else if (lastUpdateTime !== null) {
                        duration += Math.max(0, now - lastUpdateTime) * effectiveRate;
                    }

                    graceStartTime = null;
                    inDecay = false;
                    lastActiveTime = now;
                } else if (started) {
                    if (graceStartTime === null) {
                        graceStartTime = now;
                    } else if (now - graceStartTime > grace) {
                        if (decay <= 0) {
                            reset();
                            return snapshot();
                        }
                        const decayDt = !inDecay
                            ? Math.max(0, now - (graceStartTime + grace))
                            : Math.max(0, now - (lastUpdateTime !== null ? lastUpdateTime : now));
                        inDecay = true;
                        duration = Math.max(0, duration - decay * decayDt);
                        if (duration <= 1e-9) {
                            reset();
                            return snapshot();
                        }
                    }
                }

                lastUpdateTime = now;
                return snapshot();
            },
            reset,
            snapshot,
            get active() { return started; },
            get duration() { return duration; },
            get reason() { return reason; }
        });
    }

    function latestSessionsChronological(sessions, limit = 7) {
        const items = Array.isArray(sessions) ? sessions.slice() : [];
        const count = Math.max(0, Math.floor(Number(limit) || 0));
        if (!count) return [];
        items.sort((a, b) => {
            const left = Date.parse(a.created_at);
            const right = Date.parse(b.created_at);
            return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
        });
        return items.slice(-count);
    }

    function stopMediaStream(stream) {
        if (!stream || typeof stream.getTracks !== 'function') return;
        for (const track of stream.getTracks()) {
            try {
                if (track && typeof track.stop === 'function') track.stop();
            } catch (_) {
                // Continue stopping remaining tracks if one has already ended.
            }
        }
    }

    async function finalizeMealSession(sessionInsertPromise, stopMonitoring, updateSession) {
        if (typeof stopMonitoring !== 'function') {
            throw new TypeError('A meal cleanup operation is required.');
        }
        await stopMonitoring();
        const sessionId = await sessionInsertPromise;
        if (sessionId && typeof updateSession === 'function') {
            await updateSession(sessionId);
        }
        return sessionId || null;
    }

    function createStartLock() {
        let active = false;
        return Object.freeze({
            tryEnter() {
                if (active) return false;
                active = true;
                return true;
            },
            release() {
                active = false;
            },
            get active() {
                return active;
            }
        });
    }

    function createMealSessionTracker() {
        let currentId = null;
        return Object.freeze({
            async begin(insertOperation) {
                currentId = null;
                if (typeof insertOperation !== 'function') {
                    throw new TypeError('A meal session insert operation is required.');
                }
                const id = await insertOperation();
                currentId = typeof id === 'string' && id.trim() ? id : null;
                return currentId;
            },
            clear() {
                currentId = null;
            },
            get currentId() {
                return currentId;
            }
        });
    }

    function summarizeMealEventsBySession(sessions, eventLogs, eventLogsAvailable = true) {
        const items = Array.isArray(sessions) ? sessions : [];
        const logs = Array.isArray(eventLogs) ? eventLogs : [];
        const summaryById = new Map(items.map(session => {
            const alertBreakdownAvailable = eventLogsAvailable
                && Number(session.event_schema_version || 1) >= 2;
            return [session.id, {
                ...session,
                alertBreakdownAvailable,
                eventCounts: alertBreakdownAvailable
                    ? { cough: 0, l1: 0, l2: 0, l3: 0, l4: 0, visibility: 0 }
                    : null,
                events: []
            }];
        }));

        for (const event of logs) {
            const summary = summaryById.get(event && event.session_id);
            if (!summary) continue;
            summary.events.push(event);
            if (!summary.alertBreakdownAvailable) continue;
            const type = String(event.event_type || '').toUpperCase();
            if (type === 'COUGH') summary.eventCounts.cough += 1;
            else if (type === 'L1') summary.eventCounts.l1 += 1;
            else if (type === 'L2') summary.eventCounts.l2 += 1;
            else if (type === 'L3') summary.eventCounts.l3 += 1;
            else if (type === 'L4') summary.eventCounts.l4 += 1;
            else if (type === 'L3_VISIBILITY' || type === 'VISIBILITY_LOSS') summary.eventCounts.visibility += 1;
        }

        for (const summary of summaryById.values()) {
            summary.events.sort((a, b) => {
                const left = Date.parse(a.triggered_at);
                const right = Date.parse(b.triggered_at);
                return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
            });
        }
        return items.map(session => summaryById.get(session.id));
    }

    function createNegotiationGate() {
        let tail = Promise.resolve();
        const pending = new Map();
        return Object.freeze({
            run(key, operation) {
                if (pending.has(key)) return pending.get(key);
                let task;
                task = tail.catch(() => undefined).then(operation).finally(() => {
                    if (pending.get(key) === task) pending.delete(key);
                });
                pending.set(key, task);
                tail = task.catch(() => undefined);
                return task;
            }
        });
    }

    function coughStorageKey(ownerId, patientCode) {
        const owner = String(ownerId || '').trim();
        const code = String(patientCode || '').trim();
        if (!owner || !/^[A-Za-z0-9_-]{1,32}$/.test(code)) return null;
        return `anti_choke_cough_records:${owner}:${code}`;
    }

    function kioskLockStorageKey(ownerId) {
        const owner = String(ownerId || '').trim();
        if (!owner) return null;
        return `anti_choke_kiosk_lock:${owner}`;
    }

    function nextPatientCode(existingProfiles) {
        const items = Array.isArray(existingProfiles) ? existingProfiles : [];
        const used = new Set();
        let maxNum = 0;
        for (const item of items) {
            const raw = String((item && (item.patient_code || item.code)) || '').trim().toUpperCase();
            if (!raw) continue;
            used.add(raw);
            const match = raw.match(/^P(\d+)$/);
            if (match) {
                const num = parseInt(match[1], 10);
                if (Number.isFinite(num) && num > maxNum) maxNum = num;
            }
        }
        let next = maxNum + 1;
        let candidate = 'P' + String(next).padStart(3, '0');
        while (used.has(candidate)) {
            next += 1;
            candidate = 'P' + String(next).padStart(3, '0');
        }
        return candidate;
    }

    function purgeLegacySharedPatientKeys(storage) {
        if (!storage || typeof storage.removeItem !== 'function') return;
        for (const key of ['anti_choke_patient_list', 'anti_choke_cough_records']) {
            try {
                storage.removeItem(key);
            } catch (_) {
                // Ignore restricted storage environments.
            }
        }
    }

    function purgeAllLocalPatientKeys(storage) {
        if (!storage) return;
        try {
            if (typeof storage.length === 'number' && typeof storage.key === 'function') {
                const keysToRemove = [];
                for (let i = 0; i < storage.length; i++) {
                    const key = storage.key(i);
                    if (typeof key === 'string' && key.startsWith('anti_choke_')) {
                        keysToRemove.push(key);
                    }
                }
                for (const key of keysToRemove) {
                    storage.removeItem(key);
                }
                return;
            }
        } catch (_) {
            // Fall through to explicit legacy removal.
        }
        purgeLegacySharedPatientKeys(storage);
    }

    return Object.freeze({ channelTopic, privateChannelOptions, createCandidateBuffer, takeMatchingCandidates, canReplaceAlertLevel, resolveVisibilityAlert, createFaceLossWarningGuard, countDirectionReversals, evaluateL4Candidate, createChokeDangerAccumulator, latestSessionsChronological, stopMediaStream, finalizeMealSession, createMealSessionTracker, summarizeMealEventsBySession, createStartLock, createNegotiationGate, coughStorageKey, kioskLockStorageKey, nextPatientCode, purgeLegacySharedPatientKeys, purgeAllLocalPatientKeys });
});
