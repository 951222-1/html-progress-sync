 'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {webcrypto} = require('node:crypto');
const modulePath = path.join(__dirname, '../local_recording/meal-recording.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const calls = [], states = [], canvases = [], recorders = [], requests = [];
  let clock = 1000;
  const video = {kind:'video', stopped:0, readyState:'live', requestFrame() { requests.push(clock); }, stop() { this.stopped++; this.readyState='ended'; }};
  const audio = {kind:'audio', stopped:0, stop() { this.stopped++; }};
  class Stream { constructor(tracks) { this.tracks=tracks; } getTracks() {return this.tracks;} getVideoTracks() {return this.tracks.filter(t=>t.kind==='video');} getAudioTracks() {return this.tracks.filter(t=>t.kind==='audio');} }
  class Recorder {
    static isTypeSupported(type) { return options.supported ? options.supported.includes(type) : type.startsWith('video/webm'); }
    constructor(stream, config) {this.stream=stream; this.mimeType=config.mimeType; this.state='inactive'; recorders.push(this); if(options.constructorError) throw new Error('constructor failed');}
    start(timeslice) { this.timeslice=timeslice; this.state='recording'; }
    emit(data) { this.ondataavailable?.({data}); }
    stop() {this.state='inactive'; this.stops=(this.stops||0)+1; queueMicrotask(()=>{this.emit(new Blob(['FINAL'])); this.onstop?.();});}
  }
  const doc = {createElement(tag) { assert.equal(tag,'canvas'); const c={width:300,height:150,draws:[],getContext(){return {fillRect(){}, drawImage:(...args)=>{if(options.drawError)throw new Error('draw failed');c.draws.push(args);}};},captureStream(rate){c.rate=rate;return new Stream(options.extraAudio ? [video,audio] : [video]);}}; canvases.push(c); return c; }};
  const request = (url, args={})=>{calls.push({url,...args}); if(options.api) return options.api(url,args); if(url==='/api/local/recordings') return {id:'rec-1',status:'recording',recording_token:'synthetic-recording-token'}; if(url.endsWith('/finalize')) return {id:'rec-1',status:'processing'}; return {ok:true};};
  const api = {request: options.syncApi ? request : async (...args)=>request(...args)};
  if(options.noManualCapture) delete video.requestFrame;
  const context = vm.createContext({document:doc, MediaRecorder:Recorder, MediaStream:Stream, Blob, Date, performance:{now:()=>clock}, crypto:options.noCrypto?{}:webcrypto, queueMicrotask, setTimeout, clearTimeout, console});
  vm.runInContext(fs.existsSync(modulePath) ? fs.readFileSync(modulePath,'utf8') : 'globalThis.MealRecording = {};', context);
  const controller = context.MealRecording.createController?.({api, now:()=>clock, onState:s=>{states.push(s); if(options.observerError)throw new Error('observer failed');}});
  const source = {width:1280,height:720, webcamTrack:{stop(){throw new Error('must not touch webcam');}}};
  return {module:context.MealRecording,controller,calls,states,canvases,recorders,requests,video,audio,source,setClock:v=>{clock=v;}};
}

test('off is zero-resource, safe and exports UMD/CommonJS', async () => {
  const h=harness();
  assert.equal(typeof h.module.createController,'function');
  assert.equal(typeof require(modulePath).createController,'function');
  h.controller.start({enabled:false,patientId:'p-1'});
  h.controller.captureFrame(h.source,1000);
  h.controller.markCough(1000);
  assert.equal(await h.controller.stop(),null);
  h.controller.cancel();
  assert.equal(h.controller.getState().state,'idle');
  assert.equal(h.canvases.length,0); assert.equal(h.recorders.length,0); assert.equal(h.calls.length,0);
});
test('fitWithin640 keeps aspect ratio, never upscales and rejects invalid geometry', () => {
  const {module:m}=harness();
  for(const [w,h,ew,eh] of [[1280,720,640,360],[1920,1080,640,360],[720,1280,360,640],[320,240,320,240],[1001,777,640,497]]) {
    const s=m.fitWithin640(w,h); assert.equal(s.width,ew); assert.equal(s.height,eh);
    assert.ok(Math.abs(s.width/s.height-w/h)<0.003);
  }
  for(const [w,h] of [[0,720],[-1,5],[NaN,2],[Infinity,2]]) assert.throws(()=>m.fitWithin640(w,h), /dimension/i);
});
test('arming allocates nothing until the first current frame, then requests only supplied frames', async () => {
  const h=harness({extraAudio:true});
  assert.equal(h.controller.start({enabled:true,patientId:'p-1',startedAt:'2026-11-10T00:00:00Z'}).state,'armed');
  assert.equal(h.canvases.length,0); assert.equal(h.calls.length,0);
  h.setClock(1500); h.controller.captureFrame(h.source,1500);
  const r=h.recorders[0], c=h.canvases[0];
  assert.equal(c.width,640); assert.equal(c.height,360); assert.equal(c.rate,0);
  assert.equal(r.timeslice,1000); assert.equal(r.stream.getAudioTracks().length,0);
  assert.deepEqual(r.stream.getVideoTracks(),[h.video]);
  assert.equal(c.draws[0][0],h.source); assert.equal(h.source.width,1280); assert.equal(h.source.height,720);
  h.setClock(2100); h.controller.captureFrame(h.source,2100);
  await tick();
  assert.deepEqual(h.requests,[1500,2100]);
  assert.equal(h.controller.getState().frameCount,2);
  assert.equal(h.controller.getState().captureStartMs,1500);
  assert.equal(h.controller.getState().state,'recording');
  assert.equal(h.calls.length,1); assert.equal(h.calls[0].json.patient_id,'p-1');
  assert.equal(h.calls[0].json.width,640); assert.equal(h.calls[0].json.height,360);
  const snapshot=h.controller.getState(); snapshot.frameCount=999; assert.equal(h.controller.getState().frameCount,2);
});
test('chunks stream serially before end; stop releases immediately then flushes final chunk before finalize', async () => {
  let releaseChunk;
  const gate=new Promise(resolve=>releaseChunk=resolve);
  const h=harness({api:async(url)=>{if(url==='/api/local/recordings')return {id:'rec-1',recording_token:'synthetic-recording-token'}; if(url.endsWith('/chunks/0'))await gate; return url.endsWith('/finalize')?{id:'rec-1',status:'processing'}:{ok:true};}});
  h.controller.start({enabled:true,patientId:'p-1'});
  for(const t of [1500,2100,3500]){h.setClock(t);h.controller.captureFrame(h.source,t);}
  h.recorders[0].emit(new Blob(['ONE'])); h.recorders[0].emit(new Blob(['TWO']));
  await tick();
  assert.equal(h.calls.filter(c=>c.url.includes('/chunks/')).length,1,'first chunk uploads during recording');
  const ended=h.controller.stop({sessionId:'meal-1'});
  assert.equal(h.video.stopped,1); assert.equal(h.audio.stopped,0); assert.equal(h.recorders[0].state,'inactive');
  assert.equal(h.controller.captureFrame(h.source,4000),false);
  assert.equal(h.controller.getState().state,'uploading');
  await tick(); assert.equal(h.calls.some(c=>c.url.endsWith('/finalize')),false);
  releaseChunk(); const row=await ended;
  assert.equal(row.status,'processing'); assert.equal(h.controller.getState().state,'processing');
  const chunks=h.calls.filter(c=>c.url.includes('/chunks/'));
  assert.deepEqual(chunks.map(c=>c.url.split('/').at(-1)),['0','1','2']);
  assert.ok(chunks.every(c=>c.headers['X-Recording-Token']==='synthetic-recording-token'));
  assert.ok(h.calls.at(-1).headers['X-Recording-Token']==='synthetic-recording-token');
  assert.deepEqual(await Promise.all(chunks.map(c=>c.body.text())),['ONE','TWO','FINAL']);
  const metadata=h.calls.at(-1).json;
  assert.equal(metadata.session_id,'meal-1'); assert.equal(metadata.frame_count,3);
  assert.equal(metadata.duration_sec,2); assert.equal(metadata.effective_fps,1);
  assert.equal(metadata.width,640); assert.equal(metadata.height,360);
  assert.equal(h.controller.getState().pendingBytes,0);
  assert.equal(h.controller.stop(),ended,'double stop shares the same in-flight/completed result');
});
test('stop before any frame produces no fake recording', async () => {
  const h=harness();h.controller.start({enabled:true,patientId:'p-1'});
  assert.equal(await h.controller.stop(),null);assert.equal(h.controller.getState().state,'idle');assert.equal(h.calls.length,0);assert.equal(h.canvases.length,0);
});
test('persisted cough events keep their Supabase UUID/session and cannot invent marker identities', async () => {
  const h=harness();h.controller.start({enabled:true,patientId:'p-1',startedAt:'2026-11-10T00:00:00Z'});
  const eventId='11111111-1111-4111-8111-111111111111',sessionId='22222222-2222-4222-8222-222222222222';
  assert.equal(h.controller.markCough(1200,'疑似嗆咳',eventId,sessionId),eventId);
  assert.equal(h.controller.markCough(1250),null,'a new event UUID must never be fabricated');
  await tick();assert.equal(h.calls.length,0);
  h.setClock(1500);h.controller.captureFrame(h.source,1500);
  h.controller.markCough(2750,'疑似嗆咳','33333333-3333-4333-8333-333333333333',sessionId);
  await tick();
  const marks=h.calls.filter(c=>c.url.endsWith('/coughs'));
  assert.equal(marks.length,2);assert.equal(marks[0].json.event_id,eventId);
  assert.equal(marks[0].json.session_id,sessionId);assert.equal(marks[1].json.offset_sec,1.25);
  assert.equal(marks[0].json.occurred_at,'2026-11-10T00:00:00.200Z');
  assert.equal(marks[1].json.occurred_at,'2026-11-10T00:00:01.750Z');
  assert.equal(marks[0].json.kind,'疑似嗆咳');
  assert.equal(marks[0].headers['X-Recording-Token'],'synthetic-recording-token');
  assert.equal(h.calls[0].json.started_at,'2026-11-10T00:00:00.500Z');
  await h.controller.stop();
  const count=h.calls.length;assert.equal(h.controller.markCough(5000,'疑似嗆咳',eventId,sessionId),null);await tick();assert.equal(h.calls.length,count);
});
test('pending persisted cough inserts resolve after immediate stop but are uploaded before finalize', async () => {
  let resolveEvent;
  const eventPromise=new Promise(resolve=>resolveEvent=resolve);
  const eventId='88888888-8888-4888-8888-888888888888',sessionId='99999999-9999-4999-8999-999999999999';
  const h=harness();h.controller.start({enabled:true,patientId:'p-1'});h.controller.captureFrame(h.source,1000);
  const tracked=h.controller.trackCoughEvent(eventPromise,1500,'疑似嗆咳',Promise.resolve(sessionId));
  const stopping=h.controller.stop({sessionId:sessionId});
  assert.equal(h.video.stopped,1,'video tracks release immediately');
  await tick();assert.equal(h.calls.some(c=>c.url.endsWith('/finalize')),false);
  resolveEvent(eventId);await tracked;
  const row=await stopping;assert.equal(row.status,'processing');
  const markerAt=h.calls.findIndex(c=>c.url.endsWith('/coughs'));
  const finalizeAt=h.calls.findIndex(c=>c.url.endsWith('/finalize'));
  assert.ok(markerAt>=0&&markerAt<finalizeAt);
  assert.equal(h.calls[markerAt].json.event_id,eventId);
  assert.equal(h.calls[markerAt].json.session_id,sessionId);
});

test('sessionIdPromise is awaited only after immediate local release and binary flush', async () => {
  let resolveSession;const sessionIdPromise=new Promise(r=>resolveSession=r);
  const h=harness();h.controller.start({enabled:true,patientId:'p-1'});h.controller.captureFrame(h.source,1000);
  const done=h.controller.stop({sessionIdPromise});assert.equal(h.video.stopped,1);assert.equal(h.recorders[0].state,'inactive');
  await tick();assert.equal(h.calls.some(c=>c.url.includes('/chunks/')),true);assert.equal(h.calls.some(c=>c.url.endsWith('/finalize')),false);
  resolveSession('meal-late');await done;assert.equal(h.calls.at(-1).json.session_id,'meal-late');
});
test('a failed/null session promise keeps the video and emits a visible nonfatal warning', async () => {
  for(const result of ['reject','null']) {
    const h=harness();h.controller.start({enabled:true,patientId:'p-1'});h.controller.captureFrame(h.source,1000);
    const promise=result==='reject'?Promise.reject(new Error('session insert failed')):Promise.resolve(null);
    const row=await h.controller.stop({sessionIdPromise:promise});
    assert.equal(row.status,'processing');assert.equal('session_id' in h.calls.at(-1).json,false);
    assert.equal(h.calls.some(c=>c.method==='DELETE'),false);
    assert.ok(h.states.some(s=>s.warning==='SESSION_UNLINKED' && /影片.*保留/.test(s.message)));
    assert.equal(h.controller.getState().warnings.length,1);
  }
});
test('state observers cannot interrupt the caller even if they throw', async () => {
  const h=harness({observerError:true});
  assert.doesNotThrow(()=>h.controller.start({enabled:true,patientId:'p-1'}));
  assert.doesNotThrow(()=>h.controller.captureFrame(h.source,1000));
  assert.equal((await h.controller.stop()).status,'processing');
});
test('canvas, recorder and local API failures are isolated and release only owned video tracks', async () => {
  for(const options of [{drawError:true},{constructorError:true},{api:async()=>{throw new Error('local disk unavailable');}}]) {
    const h=harness(options);h.controller.start({enabled:true,patientId:'p-1'});
    assert.doesNotThrow(()=>h.controller.captureFrame(h.source,1000));
    await tick();
    assert.equal(h.controller.getState().state,'error');
    assert.ok(h.states.some(s=>s.state==='error' && s.error && s.message));
    assert.equal(h.controller.captureFrame(h.source,1100),false);
    assert.equal(h.audio.stopped,0);
    if(h.recorders.length) assert.equal(h.video.stopped,1);
    assert.equal(await h.controller.stop(),null);
    assert.equal(h.calls.some(c=>c.url.endsWith('/finalize')),false);
  }
});
test('transient chunk, marker and finalize retries reuse exactly the same identity and bytes', async () => {
  const attempts=new Map();
  const h=harness({api:async(url,args)=>{
    if(url==='/api/local/recordings')return {id:'rec-1',recording_token:'synthetic-recording-token'};
    const n=(attempts.get(url)||0)+1;attempts.set(url,n);
    if(n<3)throw new Error('connection reset after server commit');
    return url.endsWith('/finalize')?{id:'rec-1',status:'processing'}:{ok:true};
  }});
  h.controller.start({enabled:true,patientId:'p-1'});h.controller.captureFrame(h.source,1000);
  h.controller.markCough(1500,'疑似嗆咳','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555');h.recorders[0].emit(new Blob(['REAL-CHUNK']));
  const row=await h.controller.stop();assert.equal(row.status,'processing');
  for(const suffix of ['/coughs','/chunks/0','/chunks/1','/finalize']) {
    const calls=h.calls.filter(c=>c.url.endsWith(suffix));assert.equal(calls.length,3);
    if(suffix.includes('/chunks/')){assert.equal(calls[0].body,calls[1].body);assert.equal(calls[1].body,calls[2].body);}
    else {assert.equal(calls[0].json,calls[1].json);assert.equal(calls[1].json,calls[2].json);}
  }
  assert.equal(h.calls.filter(c=>c.url==='/api/local/recordings').length,1,'create is not blindly retried');
});
test('exhausted uploads are visible; another stop retries pending bytes without duplicating successful chunks or stop', async () => {
  let offline=true;
  const h=harness({api:async(url)=>{
    if(url==='/api/local/recordings')return {id:'rec-1',recording_token:'synthetic-recording-token'};
    if(url.endsWith('/chunks/1') && offline)throw new Error('disk temporarily busy');
    return url.endsWith('/finalize')?{id:'rec-1',status:'processing'}:{ok:true};
  }});
  h.controller.start({enabled:true,patientId:'p-1'});h.controller.captureFrame(h.source,1000);
  h.recorders[0].emit(new Blob(['OK']));
  assert.equal(await h.controller.stop(),null);assert.equal(h.controller.getState().state,'error');
  assert.equal(h.calls.some(c=>c.url.endsWith('/finalize')),false);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/chunks/0')).length,1);
  offline=false;
  assert.equal((await h.controller.stop()).status,'processing');
  assert.equal(h.calls.filter(c=>c.url.endsWith('/chunks/0')).length,1);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/chunks/1')).length,4);
  assert.equal(h.recorders[0].stops,1);assert.equal(h.video.stopped,1);
  assert.equal(h.controller.getState().pendingBytes,0);
});
test('binary chunks are sliced to the 16 MiB API limit and successful bytes are released, not accumulated', async () => {
  const h=harness();h.controller.start({enabled:true,patientId:'p-1'});h.controller.captureFrame(h.source,1000);
  const data=new Blob([new Uint8Array(17*1024*1024).fill(67)]);h.recorders[0].emit(data);
  await tick();assert.equal(h.controller.getState().pendingBytes,0);
  const first=h.calls.filter(c=>c.url.includes('/chunks/'));
  assert.equal(first.length,2);assert.equal(first[0].body.size,16*1024*1024);assert.equal(first[1].body.size,1024*1024);
  for(let i=0;i<30;i++){h.recorders[0].emit(new Blob(['small']));await tick();assert.equal(h.controller.getState().pendingBytes,0);}
  assert.equal((await h.controller.stop()).status,'processing');
});
test('a stalled disk cannot turn browser RAM into a whole-meal blob buffer', async () => {
  let unblock;const blocked=new Promise(r=>unblock=r);
  const h=harness({api:async(url)=>{if(url==='/api/local/recordings')return {id:'rec-1',recording_token:'synthetic-recording-token'};await blocked;return {ok:true};}});
  h.controller.start({enabled:true,patientId:'p-1'});h.controller.captureFrame(h.source,1000);
  const max=32*1024*1024;h.recorders[0].emit(new Blob([new Uint8Array(max)]));
  h.recorders[0].emit(new Blob(['overflow']));
  assert.equal(h.controller.getState().state,'error');assert.ok(h.controller.getState().pendingBytes<=max);
  assert.match(h.controller.getState().message,/backlog/i);assert.equal(h.video.stopped,1);
  unblock();await tick();assert.equal(await h.controller.stop(),null);
  assert.equal(h.calls.some(c=>c.url.endsWith('/finalize')),false,'incomplete media is never falsely finalized');
});
test('duplicate start cannot re-arm a live meal; cancel is safe and never deletes the recording', async () => {
  const h=harness();h.controller.start({enabled:true,patientId:'p-1'});h.controller.captureFrame(h.source,1000);
  h.controller.start({enabled:true,patientId:'p-other'});h.controller.captureFrame(h.source,1200);
  assert.equal(h.canvases.length,1);assert.equal(h.controller.getState().frameCount,2);
  const ending=h.controller.cancel();assert.equal(h.video.stopped,1);assert.equal(h.recorders[0].state,'inactive');
  await ending;await h.controller.cancel();
  assert.equal(h.video.stopped,1);assert.equal(h.recorders[0].stops,1);
  assert.equal(h.calls[0].json.patient_id,'p-1');assert.equal(h.calls.some(c=>c.method==='DELETE'),false);
  const noFrames=harness();noFrames.controller.start({enabled:true,patientId:'p-1'});await noFrames.controller.cancel();
  assert.equal(noFrames.controller.getState().state,'idle');assert.equal(noFrames.calls.length,0);
});
test('backwards/duplicate timestamps submit no extra frame and do not corrupt the cadence', async () => {
  const h=harness();h.controller.start({enabled:true,patientId:'p-1'});
  for(const t of [1500,1500,1400,1750,2400]){h.setClock(t);h.controller.captureFrame(h.source,t);}
  assert.deepEqual(h.requests,[1500,1750,2400]);
  await h.controller.stop();assert.equal(h.calls.at(-1).json.frame_count,3);
  assert.equal(h.calls.at(-1).json.effective_fps,(3-1)*1000/(2400-1500));
});
test('MIME negotiation prefers VP8, falls back within WebM and refuses non-streaming MP4-only support', async () => {
  const preferred=harness({supported:['video/mp4','video/webm;codecs=vp8']});
  preferred.controller.start({enabled:true,patientId:'p-1'});preferred.controller.captureFrame(preferred.source,1000);
  assert.equal(preferred.recorders[0].mimeType,'video/webm;codecs=vp8');await preferred.controller.stop();
  const fallback=harness({supported:['video/webm']});fallback.controller.start({enabled:true,patientId:'p-1'});fallback.controller.captureFrame(fallback.source,1000);
  assert.equal(fallback.recorders[0].mimeType,'video/webm');await fallback.controller.stop();
  const none=harness({supported:['video/mp4']});none.controller.start({enabled:true,patientId:'p-1'});assert.equal(none.controller.captureFrame(none.source,1000),false);
  assert.equal(none.controller.getState().state,'error');assert.equal(none.calls.length,0);assert.equal(none.recorders.length,0);
});
test('encoder errors and unsupported manual capture fail visibly without audio or a forged finalize', async () => {
  const h=harness();h.controller.start({enabled:true,patientId:'p-1'});h.controller.captureFrame(h.source,1000);
  h.recorders[0].onerror?.({error:new Error('encoder device lost')});await tick();
  assert.equal(h.controller.getState().state,'error');assert.equal(h.video.stopped,1);
  assert.equal(await h.controller.stop(),null);assert.equal(h.calls.some(c=>c.url.endsWith('/finalize')),false);
  const unsupported=harness({noManualCapture:true});unsupported.controller.start({enabled:true,patientId:'p-1'});
  assert.equal(unsupported.controller.captureFrame(unsupported.source,1000),false);
  assert.equal(unsupported.controller.getState().frameCount,0);assert.equal(unsupported.calls.length,0);assert.equal(unsupported.audio.stopped,0);
});
test('marker recording requires a persisted event/session identity and never invents one', async () => {
  const h=harness({noCrypto:true});h.controller.start({enabled:true,patientId:'p-1'});
  assert.equal(h.controller.markCough(1100),null);
  assert.equal(h.controller.getState().state,'armed');
  assert.equal(h.calls.length,0);
  h.controller.captureFrame(h.source,1200);
  assert.equal(h.controller.markCough(1300,'疑似嗆咳','66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777'),'66666666-6666-4666-8666-666666666666');
  await tick();
  assert.equal(h.calls.at(-1).headers['X-Recording-Token'],'synthetic-recording-token');
  await h.controller.stop();
});
test('retrying finalize preserves the resolved session and exact immutable metadata after acknowledgment loss', async () => {
  let offline=true;
  const h=harness({api:async(url)=>{if(url==='/api/local/recordings')return {id:'rec-1',recording_token:'synthetic-recording-token'};if(url.endsWith('/finalize')&&offline)throw new Error('finalize acknowledgment lost');return url.endsWith('/finalize')?{id:'rec-1',status:'processing'}:{ok:true};}});
  h.controller.start({enabled:true,patientId:'p-1'});h.controller.captureFrame(h.source,1000);
  h.setClock(2000);assert.equal(await h.controller.stop({sessionIdPromise:Promise.resolve('meal-late')}),null);
  const first=h.calls.find(c=>c.url.endsWith('/finalize')).json;
  offline=false;h.setClock(5000);assert.equal((await h.controller.stop()).status,'processing');
  const last=h.calls.at(-1).json;assert.deepEqual(last,first);assert.equal(last.session_id,'meal-late');
  assert.equal(h.controller.getState().error,undefined,'successful recovery clears stale error UI');
});
test('unused session promises on off/double stop are safely observed, not unhandled rejections', async () => {
  const h=harness();await h.controller.stop({sessionIdPromise:Promise.reject(new Error('off session failed'))});
  h.controller.start({enabled:true,patientId:'p-1'});h.controller.captureFrame(h.source,1000);
  const first=h.controller.stop({sessionId:'explicit-meal'});
  const second=h.controller.stop({sessionIdPromise:Promise.reject(new Error('duplicate stop session failed'))});
  assert.equal(first,second);await first;await tick();
  assert.equal(h.calls.at(-1).json.session_id,'explicit-meal');
});
test('a source aspect-ratio change is letterboxed without stretching or resizing the inference canvas', async () => {
  const h=harness();h.controller.start({enabled:true,patientId:'p-1'});h.controller.captureFrame(h.source,1000);
  const portrait={width:720,height:1280};h.controller.captureFrame(portrait,2000);
  const draw=h.canvases[0].draws.at(-1);assert.equal(draw[0],portrait);
  assert.equal(draw[1],(640-202.5)/2);assert.equal(draw[2],0);assert.equal(draw[3],202.5);assert.equal(draw[4],360);
  assert.equal(portrait.width,720);assert.equal(portrait.height,1280);
  assert.equal(h.canvases[0].width,640);assert.equal(h.canvases[0].height,360);
  await h.controller.stop();
});
test('a late session promise survives an upload failure and a later stop retry', async () => {
  let offline=true;
  const h=harness({api:async(url)=>{if(url==='/api/local/recordings')return {id:'rec-1',recording_token:'synthetic-recording-token'};if(url.includes('/chunks/')&&offline)throw new Error('offline');return url.endsWith('/finalize')?{id:'rec-1',status:'processing'}:{ok:true};}});
  h.controller.start({enabled:true,patientId:'p-1'});h.controller.captureFrame(h.source,1000);
  assert.equal(await h.controller.stop({sessionIdPromise:Promise.resolve('meal-persist-across-retry')}),null);
  offline=false;assert.equal((await h.controller.stop()).status,'processing');
  assert.equal(h.calls.at(-1).json.session_id,'meal-persist-across-retry');
});
test('a failed finalize row is never presented as processing or ready', async () => {
  const h=harness({api:async(url)=>url==='/api/local/recordings'?{id:'rec-1',recording_token:'synthetic-recording-token'}:url.endsWith('/finalize')?{id:'rec-1',status:'failed',error_message:'disk full'}:{ok:true}});
  h.controller.start({enabled:true,patientId:'p-1'});h.controller.captureFrame(h.source,1000);
  assert.equal(await h.controller.stop(),null);assert.equal(h.controller.getState().state,'error');assert.match(h.controller.getState().message,/disk full/);
});
test('late create/flush callbacks from the previous patient cannot alter a new meal', async () => {
  let createFirst;const firstCreate=new Promise(r=>createFirst=r);
  const h=harness({api:async(url,args)=>{
    if(url==='/api/local/recordings')return args.json.patient_id==='p-first'?await firstCreate:{id:'rec-new',recording_token:'synthetic-new-token'};
    if(url.endsWith('/finalize'))return {id:url.includes('rec-old')?'rec-old':'rec-new',status:'processing'};
    return {ok:true};
  }});
  h.controller.start({enabled:true,patientId:'p-first'});h.controller.captureFrame(h.source,1000);
  const oldStop=h.controller.stop();h.controller.start({enabled:true,patientId:'p-new'});h.controller.captureFrame(h.source,2000);
  await tick();assert.equal(h.controller.getState().recordingId,'rec-new');const count=h.states.length;
  createFirst({id:'rec-old',recording_token:'synthetic-old-token'});assert.equal((await oldStop).id,'rec-old');
  assert.equal(h.controller.getState().state,'recording');assert.equal(h.controller.getState().recordingId,'rec-new');assert.equal(h.states.length,count);
  assert.equal((await h.controller.stop()).id,'rec-new');
  assert.equal(h.calls.filter(c=>c.url==='/api/local/recordings').length,2);
  const oldFinal=h.calls.find(c=>c.url==='/api/local/recordings/rec-old/finalize').json;
  const newFinal=h.calls.find(c=>c.url==='/api/local/recordings/rec-new/finalize').json;
  assert.equal(oldFinal.frame_count,1);assert.equal(newFinal.frame_count,1);
});
test('final metadata records the MIME actually negotiated by a generic WebM encoder', async () => {
  const h=harness({supported:['video/webm']});h.controller.start({enabled:true,patientId:'p-1'});h.controller.captureFrame(h.source,1000);
  h.recorders[0].mimeType='video/webm;codecs=vp9';h.recorders[0].emit(new Blob(['WEBM-BYTES']));await h.controller.stop();
  assert.equal(h.calls.at(-1).json.mime_type,'video/webm;codecs=vp9');
});
test('a frame whose monotonic timestamp predates arming is ignored without allocating stale media', async () => {
  const h=harness();h.setClock(2000);h.controller.start({enabled:true,patientId:'p-1'});
  assert.equal(h.controller.captureFrame(h.source,1900),false);assert.equal(h.canvases.length,0);assert.equal(h.calls.length,0);
  h.setClock(2200);assert.equal(h.controller.captureFrame(h.source,2200),true);assert.equal(h.controller.getState().captureStartMs,2200);
  await h.controller.stop();
});
test('a synchronous create failure never produces a chunk request with a null recording ID', async () => {
  const h=harness({syncApi:true,api:(url)=>{if(url==='/api/local/recordings')throw new Error('sync create failed');return {ok:true};}});
  h.controller.start({enabled:true,patientId:'p-1'});assert.doesNotThrow(()=>h.controller.captureFrame(h.source,1000));
  await tick();assert.equal(h.controller.getState().state,'error');assert.equal(await h.controller.stop(),null);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/local/recordings');assert.equal(h.video.stopped,1);
});
// End synthetic-only browser boundary tests.
