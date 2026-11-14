/* 交接註解：錄影核心：只擁有衍生的無聲影像 track；不得停止目標原相機/麥克風。時鐘使用處理完成時 performance.now()。
 * 目標既有警報參數、判斷、通知、路徑和設定優先。先閱讀根目錄安裝手冊；不可整檔覆蓋目標。
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MealRecording = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';
    // Own only the derived canvas video track; never acquire or stop application media.
    // Caller timestamps and now() must share the performance.now() monotonic domain.
    function fitWithin640(width, height) {
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            throw new Error('Invalid canvas dimensions');
        }
        const scale = Math.min(1, 640 / Math.max(width, height));
        return {width:Math.max(1, Math.round(width * scale)), height:Math.max(1, Math.round(height * scale))};
    }
    function chooseMimeType(Recorder) {
        // The real Chrome probe found AVC MP4 buffered until stop; never use it for a whole meal.
        // Stream WebM to local disk, then let local FFmpeg normalize to seekable H.264 MP4.
        const candidates = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
        const type = candidates.find(candidate => Recorder && Recorder.isTypeSupported(candidate));
        if (!type) throw new Error('No supported streaming WebM recording container; MP4-only recording is not enabled.');
        return type;
    }
    const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
    const MAX_PENDING_BYTES = 32 * 1024 * 1024;
    function createController({api, now = () => root.performance.now(), onState} = {}) {
        let current = null;
        function snapshot(s = current) {
            return s ? {state:s.state, frameCount:s.frameCount, width:s.width, height:s.height,
                recordingId:s.recordingId, captureStartMs:s.captureStartMs, lastFrameMs:s.lastFrameMs,
                pendingBytes:s.pendingBytes, uploadedChunks:s.uploadedChunks, warnings:s.warnings.map(w => ({...w})),
                ...(s.error ? {error:{...s.error}, message:s.error.message} : {})} :
                {state:'idle', frameCount:0, width:0, height:0, recordingId:null};
        }
        function publish(s, state, details = {}) {
            s.state = state;
            if (s === current && onState) {
                try {
                    const result = onState({...snapshot(s), ...details});
                    if (result && typeof result.catch === 'function') result.catch(() => {});
                } catch (_) { /* UI observers never own the detection loop. */ }
            }
        }
        function sessionWarning(s) {
            const warning = {warning:'SESSION_UNLINKED', message:'用餐紀錄未能連結；影片仍保留，可稍後處理。'};
            s.warnings.push(warning);
            publish(s, s.state, warning);
        }
        function start({enabled, patientId, sessionId, startedAt} = {}) {
            if (enabled !== true || (current && current.accepting)) return snapshot();
            current = {state:'armed', patientId, sessionId, width:0, height:0, frameCount:0,
                recordingId:null, captureStartMs:null, lastFrameMs:null,
                tasks:[], pendingMarkers:[], warnings:[], pendingBytes:0, uploadedChunks:0, nextSequence:0, accepting:true,
                armedAtMs:now(), wallAtArm:startedAt ? Date.parse(startedAt) : Date.now(), pendingEventPromises:[], finalized:false};
            publish(current, 'armed');
            return snapshot();
        }
        function drawFrame(s, source) {
            fitWithin640(source.width, source.height); // Validate every incoming frame, not only the first.
            const scale = Math.min(s.width / source.width, s.height / source.height);
            const width = source.width * scale, height = source.height * scale;
            if (width !== s.width || height !== s.height) {
                s.context.fillStyle = '#000000';
                s.context.fillRect(0, 0, s.width, s.height);
            }
            s.context.drawImage(source, (s.width - width) / 2, (s.height - height) / 2, width, height);
        }
        function captureFrame(source, timestampMs) {
            const s = current;
            if (!s || !s.accepting || !['armed','recording'].includes(s.state)) return false;
            try {
                const t = Number.isFinite(timestampMs) ? timestampMs : now();
                if (!Number.isFinite(t) || t < s.armedAtMs || (s.lastFrameMs !== null && t <= s.lastFrameMs)) return false;
                if (!s.recorder) {
                    Object.assign(s, fitWithin640(source.width, source.height));
                    s.canvas = root.document.createElement('canvas');
                    s.canvas.width = s.width; s.canvas.height = s.height;
                    s.context = s.canvas.getContext('2d');
                    drawFrame(s, source);
                    s.stream = s.canvas.captureStream(0);
                    s.tracks = s.stream.getVideoTracks();
                    if (s.tracks.length !== 1 || typeof s.tracks[0].requestFrame !== 'function') {
                        throw new Error('Manual canvas requestFrame capture is unavailable');
                    }
                    const mimeType = chooseMimeType(root.MediaRecorder);
                    s.recorder = new root.MediaRecorder(new root.MediaStream(s.tracks), {mimeType});
                    s.mimeType = s.recorder.mimeType || mimeType;
                    s.captureStartMs = t;
                    s.stoppedPromise = new Promise(resolve => {s.resolveStopped = resolve;});
                    s.recorder.onstop = () => s.resolveStopped();
                    s.recorder.onerror = event => {
                        s.mediaIncomplete = true;
                        fail(s, event.error || new Error('MediaRecorder encoding failed'));
                    };
                    s.recorder.ondataavailable = event => {
                        s.mimeType = s.recorder.mimeType || s.mimeType;
                        if (!event.data || !event.data.size) return;
                        if (s.pendingBytes + event.data.size > MAX_PENDING_BYTES) {
                            s.mediaIncomplete = true;
                            fail(s, new Error('Local recording upload backlog exceeded 32 MiB; recording stopped to protect memory.'));
                            return;
                        }
                        s.pendingBytes += event.data.size;
                        for (let offset = 0; offset < event.data.size; offset += MAX_CHUNK_BYTES) {
                            s.tasks.push({path:'/chunks/' + s.nextSequence++, body:event.data.slice(offset, offset + MAX_CHUNK_BYTES)});
                        }
                        pump(s);
                    };
                    s.recorder.start(1000);
                    s.createPromise = Promise.resolve().then(() => api.request('/api/local/recordings', {method:'POST', json:{
                        patient_id:s.patientId, ...(s.sessionId ? {session_id:s.sessionId} : {}),
                        started_at:new Date(s.wallAtArm + t - s.armedAtMs).toISOString(),
                        mime_type:s.mimeType, width:s.width, height:s.height
                    }})).then(row => {
                        if (!row || typeof row.id !== 'string' || typeof row.recording_token !== 'string' || !row.recording_token) {
                            throw new Error('Local recording API did not return an upload capability');
                        }
                        s.recordingId = row.id; s.recordingToken = row.recording_token; return row;
                    }).catch(error => {
                        s.createError = error; fail(s, error); return null;
                    });
                    for (const marker of s.pendingMarkers) enqueueMarker(s, marker);
                    s.pendingMarkers = [];
                    publish(s, 'recording');
                } else {
                    drawFrame(s, source);
                }
                s.tracks[0].requestFrame();
                s.frameCount++;
                s.lastFrameMs = t;
                return true;
            } catch (error) {fail(s, error); return false;}
        }
        function fail(s, error) {
            s.error = {name:error.name || 'Error', message:String(error.message || error), ...(error.code ? {code:error.code} : {})};
            s.accepting = false;
            release(s);
            publish(s, 'error', {error:{...s.error}, message:s.error.message});
        }
        function enqueueMarker(s, marker) {
            s.tasks.push({path:'/coughs', json:{event_id:marker.eventId, session_id:marker.sessionId, kind:marker.kind,
                offset_sec:Math.max(0, marker.timestampMs - s.captureStartMs) / 1000,
                occurred_at:new Date(s.wallAtArm + marker.timestampMs - s.armedAtMs).toISOString()}});
            pump(s);
        }
        function markCough(timestampMs, kind = '疑似嗆咳', eventId, sessionId) {
            const s = current;
            if (!s || s.finalized || !['armed','recording','uploading'].includes(s.state)) return null;
            const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            if (typeof eventId !== 'string' || !uuid.test(eventId) || typeof sessionId !== 'string' || !uuid.test(sessionId)) return null;
            const marker = {eventId, sessionId, timestampMs:Number.isFinite(timestampMs) ? timestampMs : now(), kind};
            if (!Number.isFinite(marker.timestampMs)) return null;
            if (s.captureStartMs === null) s.pendingMarkers.push(marker);
            else enqueueMarker(s, marker);
            return eventId;
        }
        function trackCoughEvent(eventPromise, timestampMs, kind = '疑似嗆咳', sessionIdPromise) {
            const s=current;
            if (!s || s.finalized || !['armed','recording','uploading'].includes(s.state)) return Promise.resolve(null);
            const task=Promise.resolve(eventPromise).then(async eventId => {
                let sessionId;
                try {sessionId=await Promise.resolve(sessionIdPromise);} catch (_) {return null;}
                if (!eventId || !sessionId) return null;
                return markCough(timestampMs,kind,eventId,sessionId);
            }).catch(() => null);
            s.pendingEventPromises.push(task);
            return task;
        }
        async function requestRetry(s, path, options) {
            if (!s.recordingToken) throw new Error('Local recording upload capability is unavailable');
            const headers = {...(options && options.headers || {}), 'X-Recording-Token':s.recordingToken};
            const requestOptions = {...options, headers};
            for (let attempt = 0; ; attempt++) {
                try {return await api.request(path, requestOptions);} catch (error) {
                    const status = Number(error.status || error.statusCode);
                    if (attempt >= 2 || (status >= 400 && status < 500 && status !== 408 && status !== 429)) throw error;
                }
            }
        }
        function pump(s) {
            if (s.pumpPromise) return s.pumpPromise;
            s.pumpPromise = Promise.resolve().then(async () => {
                await s.createPromise;
                if (s.createError) throw s.createError;
                while (s.tasks.length) {
                    const task = s.tasks[0];
                    await requestRetry(s, '/api/local/recordings/' + s.recordingId + task.path,
                        {method:'POST', ...(task.body ? {body:task.body} : {json:task.json})});
                    if (task.body) {s.pendingBytes -= task.body.size; s.uploadedChunks++;}
                    s.tasks.shift(); // Release each uploaded Blob immediately; retain only bounded unsent work.
                }
                return true;
            }).catch(error => {s.uploadError = error; fail(s, error); return false;})
                .finally(() => {s.pumpPromise = null;});
            return s.pumpPromise;
        }
        function release(s) {
            if (s.recorder && s.recorder.state !== 'inactive') {
                try {s.recorder.stop();} catch (_) {if (s.resolveStopped) s.resolveStopped();}
            }
            if (!s.released) {
                s.released = true;
                for (const track of s.tracks || []) {try {track.stop();} catch (_) { /* Release every owned track. */ }}
                if (s.canvas) {s.canvas.width = 0; s.canvas.height = 0;}
                s.context = null; s.canvas = null; s.stream = null;
            }
        }
        function stop({sessionId, sessionIdPromise} = {}) {
            const s = current;
            const sessionResolution = sessionIdPromise === undefined ? null :
                Promise.resolve(sessionIdPromise).then(id => ({id}), error => ({error}));
            if (!s) return Promise.resolve(null);
            if (!s.stopPromise && !s.finalizeJson) {
                if (sessionResolution && !s.sessionResolution) s.sessionResolution = sessionResolution;
                if (sessionId && !s.stopSessionId) s.stopSessionId = sessionId;
            }
            if (s.stopPromise) return s.stopPromise;
            s.accepting = false;
            if (!s.frameCount) {release(s); if (!s.error) publish(s, 'idle'); return Promise.resolve(null);}
            if (s.endedAtMs === undefined) s.endedAtMs = Math.max(now(), s.lastFrameMs);
            release(s);
            publish(s, 'uploading');
            s.stopPromise = (async () => {
                await s.stoppedPromise;
                if (!await pump(s)) {s.stopPromise = null; return null;}
                if (s.pendingEventPromises.length) await Promise.allSettled(s.pendingEventPromises);
                if (!await pump(s)) {s.stopPromise = null; return null;}
                if (s.mediaIncomplete) {publish(s, 'error'); return null;}
                if (!s.finalizeJson) {
                    const session = s.sessionResolution ? await s.sessionResolution : null;
                    const finalSessionId = s.stopSessionId || (session && session.id) || s.sessionId;
                    if (session && !finalSessionId) sessionWarning(s);
                    s.finalizeJson = {
                        ...(finalSessionId ? {session_id:finalSessionId} : {}),
                        duration_sec:Math.max(0, s.endedAtMs - s.captureStartMs) / 1000,
                        frame_count:s.frameCount,
                        // Submitted interval cadence, NOT measured model/device FPS or ffprobe frame rate.
                        effective_fps:s.lastFrameMs > s.captureStartMs ? (s.frameCount - 1) * 1000 / (s.lastFrameMs - s.captureStartMs) : 0,
                        width:s.width, height:s.height, mime_type:s.mimeType,
                        ended_at:new Date(s.wallAtArm + s.endedAtMs - s.armedAtMs).toISOString()
                    };
                }
                const row = await requestRetry(s, '/api/local/recordings/' + s.recordingId + '/finalize', {method:'POST', json:s.finalizeJson});
                if (!row || !['processing','ready'].includes(row.status)) {
                    throw new Error((row && row.error_message) || 'Local recording finalize returned an invalid status');
                }
                s.finalized = true;
                s.error = null;
                publish(s, row.status === 'ready' ? 'ready' : 'processing');
                return row;
            })().catch(error => {fail(s, error); s.stopPromise = null; return null;});
            return s.stopPromise;
        }
        // Cancel releases immediately and salvages already-recorded local bytes; it never deletes.
        function cancel() {return stop();}
        return {start, captureFrame, markCough, trackCoughEvent, cancel, stop, getState:snapshot};
    }
    return {createController, fitWithin640, chooseMimeType};
});
