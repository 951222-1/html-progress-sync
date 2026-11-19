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

    return Object.freeze({ channelTopic, privateChannelOptions, createCandidateBuffer, takeMatchingCandidates, latestSessionsChronological, stopMediaStream, finalizeMealSession, createMealSessionTracker, createStartLock, createNegotiationGate });
});
