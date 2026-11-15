'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const bridge=require('../local_recording/bridge.js');

const envelope=(data,error=null)=>({data,error});
function response(data,status=200){return {ok:status>=200&&status<300,status,json:async()=>data};}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const config={mode:'local-recording',csrf_token:'synthetic-csrf-token',ffmpeg_available:true};

function startMealHarness({serviceAvailable=true,consentEnabled=true,consentReadFails=false,consentWriteFails=false,consentReadQueue=[],consentReadGate=null,startBarrier=null,includePatientForm=false,remoteMode=false,onConsentReadStart=null,onRecordingBegin=null}={}){
 const calls=[],serviceState={value:serviceAvailable},consentSetting={value:consentEnabled},queuedConsentReads=[...consentReadQueue];let mealActive=false,consentReadCount=0;
 const makeElement=id=>({id,hidden:false,checked:false,type:'',textContent:'',dataset:{},listeners:{},children:[],parentElement:null,append(...items){for(const item of items){item.parentElement=this;this.children.push(item);}},insertBefore(item,reference){item.parentElement=this;const index=this.children.indexOf(reference);this.children.splice(index<0?this.children.length:index,0,item);},addEventListener(type,fn){(this.listeners[type]||(this.listeners[type]=[])).push(fn);},removeEventListener(type,fn){this.listeners[type]=(this.listeners[type]||[]).filter(value=>value!==fn);},click(){for(const fn of [...(this.listeners.click||[])])fn({target:this,preventDefault(){}});}});
 const elements={
  'local-recording-connect':makeElement('local-recording-connect'),
  'local-recording-connect-panel':{hidden:false},'local-recording-privacy':{hidden:false,role:'region',ariaLabel:'錄影隱私說明'},'local-recording-status':{hidden:true,textContent:'',dataset:{}}
 };
 if(includePatientForm){const form=makeElement('patient-add-view'),actions=makeElement('patient-add-actions'),save=makeElement('btn-save-new-patient');actions.append(save);form.append(actions);elements['patient-add-view']=form;elements['btn-save-new-patient']=save;}
 function findElement(node,id){if(!node)return null;if(node.id===id)return node;for(const child of node.children||[]){const found=findElement(child,id);if(found)return found;}return null;}
 const recorder={begin:(profile,session)=>{calls.push(['recording-begin',profile,session]);onRecordingBegin?.({profile,session,mealActive});},selectPatient(){},end:async()=>null,getState:()=>({active:false})};
 const channelRef={current:null};
 class FakeBroadcastChannel{constructor(name){this.name=name;this.onmessage=null;channelRef.current=this;}postMessage(data){this.onmessage?.({data});}close(){this.onmessage=null;}}
 const document={getElementById:id=>elements[id]||Object.values(elements).map(node=>findElement(node,id)).find(Boolean)||null,createElement:tag=>makeElement(tag),addEventListener(){},fullscreenElement:null,exitFullscreen(){calls.push(['exit-fullscreen']);this.fullscreenElement=null;return Promise.resolve();}};
 const root={
  location:{href:remoteMode?'https://951222-1.github.io/html-progress-sync/mobile/index.html':'http://127.0.0.1:8123/mobile/index.html'},performance:{now:()=>1000},currentPatient:null,BroadcastChannel:FakeBroadcastChannel,
  navigator:remoteMode?{permissions:{query:async()=>({state:'prompt'})}}:undefined,
  document,
  fetch:async(url,options={})=>{const method=String(options.method||'GET').toUpperCase();calls.push(['fetch',url,method]);if(url.endsWith('/config')){if(!serviceState.value)throw Error('companion offline');return response(envelope(config));}if(method==='PUT'&&url.includes('/consent')){if(consentWriteFails)throw Error('consent write unavailable');const body=JSON.parse(options.body);consentSetting.value=body.enabled;return response(envelope({patient_id:body.patient_id,recording_enabled:body.enabled}));}if(method==='GET'&&url.includes('/consent?patient_id=')){const read=++consentReadCount;onConsentReadStart?.({read,mealActive});if(consentReadFails)throw Error('consent unavailable');if(consentReadGate){const row=await consentReadGate({read,mealActive});if(row instanceof Error)throw row;return response(envelope(row));}if(queuedConsentReads.length){const row=await queuedConsentReads.shift();if(row instanceof Error)throw row;return response(envelope(row));}const patientId=new URL(url,'http://127.0.0.1').searchParams.get('patient_id')||'synthetic-patient';return response(envelope({patient_id:patientId,recording_enabled:consentSetting.value}));}return response(envelope({}));},
  supabaseClient:{auth:{getSession:async()=>({data:{session:{access_token:'synthetic-jwt'}},error:null}),signOut:async()=>({error:null})}},
  LocalRecordingUI:{initialize:()=>recorder,selectPatient(){}},
  getCurrentMealSessionInsertPromise:()=>Promise.resolve('22222222-2222-4222-8222-222222222222'),
  applySelectedPatientProfile(profile){this.currentPatient=profile;return true;},
  async saveAndLoginNewPatient(){calls.push(['new-patient-created']);this.currentPatient={id:'synthetic-new-patient',patient_code:'P-NEW',recording_enabled:false};},
  startMealSession:async function(){calls.push(['original-start']);if(startBarrier)await startBarrier;mealActive=true;calls.push(['original-start-complete']);},endMealSession(){mealActive=false;},isMealSessionActive:()=>mealActive
 };
 bridge.attach(root);
 root.applySelectedPatientProfile({id:'synthetic-patient',patient_code:'P-SYN',recording_enabled:false});
 return {root,calls,elements,channelRef,consentSetting,serviceState};
}

test('local API obtains only the existing Supabase access token and adds localhost CSRF on writes',async()=>{
 const calls=[];
 const client={auth:{getSession:async()=>({data:{session:{access_token:'synthetic-user-jwt'}},error:null})}};
 const api=bridge.createApi({location:{href:'http://127.0.0.1:8123/mobile/index.html'},getSupabaseClient:()=>client,fetch:async(url,options)=>{
  calls.push({url,options});
  if(url.endsWith('/api/local/config'))return response(envelope(config));
  return response(envelope({patient_id:'synthetic-patient',recording_enabled:true}));
 }});
 assert.deepEqual(await api.request('/api/local/consent?patient_id=synthetic-patient',{method:'PUT',json:{patient_id:'synthetic-patient',enabled:true},headers:{Authorization:'Bearer attacker', 'X-Local-Token':'attacker'}}),{patient_id:'synthetic-patient',recording_enabled:true});
 assert.equal(calls[0].url,'http://127.0.0.1:8123/api/local/config');
 assert.equal(calls[0].options.headers,undefined);
 assert.equal(calls[1].options.headers.Authorization,'Bearer synthetic-user-jwt');
 assert.equal(calls[1].options.headers['X-Local-Token'],'synthetic-csrf-token');
 assert.equal(calls[1].options.headers['Content-Type'],'application/json');
 assert.equal(calls[1].options.credentials,'same-origin');
 assert.deepEqual(JSON.parse(calls[1].options.body),{patient_id:'synthetic-patient',enabled:true});
});

test('binary chunk requests keep bytes intact while attaching current JWT, CSRF and recording capability',async()=>{
 const calls=[],bytes=new Blob(['synthetic-webm']);
 const client={auth:{getSession:async()=>({data:{session:{access_token:'fresh-jwt'}},error:null})}};
 const api=bridge.createApi({location:{href:'http://localhost:8123/mobile/index.html'},getSupabaseClient:()=>client,fetch:async(url,options)=>{
  calls.push({url,options});return response(envelope(url.endsWith('/config')?config:{sequence:0,duplicate:false}));
 }});
 await api.request('/api/local/recordings/00000000-0000-4000-8000-000000000001/chunks/0',{method:'POST',body:bytes,headers:{'Content-Type':'application/octet-stream','X-Recording-Token':'synthetic-upload-capability'}});
 const sent=calls[1].options;
 assert.equal(sent.headers.Authorization,'Bearer fresh-jwt');
 assert.equal(sent.headers['X-Local-Token'],'synthetic-csrf-token');
 assert.equal(sent.headers['X-Recording-Token'],'synthetic-upload-capability');
 assert.equal(sent.body,bytes);
});

test('patient bridge follows the existing meal lifecycle, captures completed frames, and observes persisted cough IDs',async()=>{
 const calls=[],sessionPromise=Promise.resolve('22222222-2222-4222-8222-222222222222'),eventId='11111111-1111-4111-8111-111111111111';
 let mealActive=false,releaseRecordingEnd;
 const canvas={tag:'ai-canvas'},status={hidden:true,textContent:'',dataset:{}};
 const makeControl=id=>({id,disabled:false,hidden:false,textContent:'',dataset:{},listeners:{},addEventListener(type,fn){(this.listeners[type]||(this.listeners[type]=[])).push(fn);},removeEventListener(type,fn){this.listeners[type]=(this.listeners[type]||[]).filter(value=>value!==fn);}});
 const connectButton=makeControl('local-recording-connect'),connectPanel={hidden:false};
 const recorder={begin:(profile,session)=>calls.push(['begin',profile,session]),captureFrame:(frame,time)=>calls.push(['frame',frame,time]),trackCoughEvent:(promise,time,kind,session)=>{calls.push(['cough-promise',promise,time,kind,session]);return Promise.resolve();},end:()=>{calls.push(['recording-end']);return new Promise(resolve=>releaseRecordingEnd=resolve);},getState:()=>({active:false})};
 const root={
  location:{href:'http://127.0.0.1:8123/mobile/index.html'},performance:{now:()=>4321},
  document:{getElementById:id=>({
   'ai-canvas':canvas,'local-recording-status':status,
   'local-recording-connect':connectButton,'local-recording-connect-panel':connectPanel
  })[id]||null,createElement:()=>({append(){}}),addEventListener(){}},
  fetch:async(url,options)=>{calls.push(['fetch',url,options]);if(url.endsWith('/playback-session/revoke'))throw Error('synthetic local outage');return response(envelope(url.endsWith('/config')?config:{patient_id:'synthetic-patient',recording_enabled:true}));},
  supabaseClient:{auth:{getSession:async()=>({data:{session:{access_token:'existing-jwt'}},error:null}),signOut:async()=>{calls.push(['supabase-signout']);return {error:null};}}},
  getCurrentMealSessionInsertPromise:()=>sessionPromise,
  LocalRecordingUI:{initialize:()=>recorder,selectPatient:profile=>calls.push(['select',profile]),trackCoughEvent:(...args)=>recorder.trackCoughEvent(...args)},
  currentPatient:null,
  applySelectedPatientProfile(profile){this.currentPatient=profile;return true;},
  async startMealSession(){mealActive=true;calls.push(['original-start']);},
  async endMealSession(){calls.push(['original-end']);mealActive=false;},
  async processVideoFrame(){calls.push(['original-frame']);},
  async logAnomalyToSupabase(level){calls.push(['original-log',level]);return eventId;},
  isMealSessionActive:()=>mealActive
 };
 bridge.attach(root);
 root.applySelectedPatientProfile({id:'synthetic-patient',patient_code:'P-SYN',recording_enabled:false});
 await new Promise(resolve=>setImmediate(resolve));
 const startPromise=root.startMealSession();
 await new Promise(resolve=>setImmediate(resolve));
 await startPromise;
 assert.equal(root.document.getElementById('meal-recording-confirm-dialog'),null,'the patient bridge must not require the removed confirmation dialog');
 assert.ok(calls.some(x=>x[0]==='original-start'),'meal startup should proceed immediately');
 assert.equal(calls.find(x=>x[0]==='begin')[1].recording_enabled,true);
 assert.equal(calls.find(x=>x[0]==='begin')[2],sessionPromise);
 await root.processVideoFrame(1000);
 assert.deepEqual(calls.find(x=>x[0]==='frame'),['frame',canvas,4321]);
 await root.logAnomalyToSupabase('COUGH','synthetic cough');
 const cough=calls.find(x=>x[0]==='cough-promise');
 assert.equal(await cough[1],eventId);assert.equal(cough[2],4321);assert.equal(cough[3],'疑似嗆咳');assert.equal(cough[4],sessionPromise);
 await root.endMealSession();
 assert.ok(calls.findIndex(x=>x[0]==='recording-end')<calls.findIndex(x=>x[0]==='original-end'));
 releaseRecordingEnd();
 await root.supabaseClient.auth.signOut();
 const revokeIndex=calls.findIndex(x=>x[0]==='fetch'&&x[1].endsWith('/api/local/playback-session/revoke'));
 assert.ok(revokeIndex>=0);
 assert.ok(revokeIndex<calls.findIndex(x=>x[0]==='supabase-signout'));
 assert.match(status.textContent,/五分鐘/);
});

test('meal starts without a dialog and automatically records when consent is saved and the local service is connected', async () => {
 const {root,calls}=startMealHarness({serviceAvailable:true,consentEnabled:true});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 await root.startMealSession();
 const mealStart=calls.findIndex(call=>call[0]==='original-start');
 const recordingStart=calls.findIndex(call=>call[0]==='recording-begin');
 assert.ok(mealStart>=0,'meal monitoring should start without a confirmation dialog');
 assert.ok(recordingStart>mealStart,'recording should start automatically after meal startup');
 assert.equal(calls[recordingStart][1].recording_enabled,true);
});

test('privacy disclosure remains visible after the connection panel hides',async()=>{
 const {elements}=startMealHarness({serviceAvailable:true});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(elements['local-recording-connect-panel'].hidden,true);
 assert.equal(elements['local-recording-privacy'].hidden,false);
 assert.equal(elements['local-recording-privacy'].ariaLabel,'錄影隱私說明');
});

test('meal startup does not wait for a pending post-start consent refresh',async()=>{
 const refresh=deferred();
 const freshReadStarted=deferred();
 const {root,calls}=startMealHarness({serviceAvailable:true,consentEnabled:true,remoteMode:true,consentReadQueue:[Promise.resolve({patient_id:'synthetic-patient',recording_enabled:true}),refresh.promise],onConsentReadStart:event=>{if(event.mealActive)freshReadStarted.resolve(event);}});
 await root.LocalRecordingBridge.connect();
 const start=root.startMealSession();
 const readEvent=await freshReadStarted.promise;
 assert.equal(readEvent.mealActive,true,'the fresh consent read should begin only after meal monitoring has started');
 assert.ok(calls.some(call=>call[0]==='original-start'),'meal monitoring must start before the consent refresh resolves');
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
 refresh.resolve({patient_id:'synthetic-patient',recording_enabled:true});
 await start;
 assert.ok(calls.some(call=>call[0]==='recording-begin'),JSON.stringify({calls,status:root.document.getElementById('local-recording-status')?.textContent}));
});

test('profile without saved caregiver recording setting starts without recording',async()=>{
 const {root,calls,elements}=startMealHarness({serviceAvailable:true,consentEnabled:false});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 await root.startMealSession();
 assert.ok(calls.some(call=>call[0]==='original-start'));
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
 assert.match(elements['local-recording-status'].textContent,/尚未為此個案啟用/);
});

test('unchecked new-patient opt-in explicitly keeps recording disabled',async()=>{
 const {root,calls,elements,consentSetting}=startMealHarness({serviceAvailable:true,consentEnabled:true,includePatientForm:true});
 await root.LocalRecordingBridge.connect();
 const optIn=(function flatten(node){return [node,...(node.children||[]).flatMap(flatten)];})(elements['patient-add-view']).find(node=>node.id==='new-patient-local-recording');
 assert.ok(optIn);assert.equal(optIn.checked,false);
 await root.saveAndLoginNewPatient();
 assert.ok(calls.some(call=>call[0]==='new-patient-created'));
 assert.ok(calls.some(call=>call[0]==='fetch'&&call[1].includes('/consent')&&call[2]==='PUT'));
 assert.equal(consentSetting.value,false);
 assert.equal((await root.LocalRecordingBridge.getConsent('synthetic-new-patient')).recording_enabled,false);
 await root.startMealSession();
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
});

test('new patient form provides an explicit unchecked local silent-recording opt-in',()=>{
 const {elements}=startMealHarness({includePatientForm:true});
 const form=elements['patient-add-view'];
 const nodes=(function flatten(node){return [node,...(node.children||[]).flatMap(flatten)];})(form);
 const checkbox=nodes.find(node=>node.id==='new-patient-local-recording');
 assert.ok(checkbox,'new patient form should expose the recording opt-in');
 assert.equal(checkbox.checked,false,'the opt-in must be unchecked by default');
 const copy=nodes.map(node=>node.textContent).join(' ');
 assert.match(copy,/本人或有權代理人/);
 assert.match(copy,/無聲|不收錄音/);
 assert.match(copy,/本機服務連線後才會保存設定/);
 assert.match(copy,/不會上傳到 Supabase/);
});

test('checked new-patient opt-in persists recording consent when the local service is connected',async()=>{
 const {root,calls,elements,consentSetting}=startMealHarness({serviceAvailable:true,consentEnabled:false,includePatientForm:true});
 await root.LocalRecordingBridge.connect();
 const checkbox=(function flatten(node){return [node,...(node.children||[]).flatMap(flatten)];})(elements['patient-add-view']).find(node=>node.id==='new-patient-local-recording');
 checkbox.checked=true;
 await root.saveAndLoginNewPatient();
 const update=calls.find(call=>call[0]==='fetch'&&call[1].includes('/consent')&&call[2]==='PUT');
 assert.ok(update,'checked opt-in should be saved through the local consent API');
 assert.equal(consentSetting.value,true);
 assert.equal((await root.LocalRecordingBridge.getConsent('synthetic-new-patient')).recording_enabled,true);
});

test('checked new-patient opt-in is not saved when the local service is offline',async()=>{
 const {root,calls,elements,consentSetting}=startMealHarness({serviceAvailable:false,consentEnabled:false,includePatientForm:true});
 const checkbox=(function flatten(node){return [node,...(node.children||[]).flatMap(flatten)];})(elements['patient-add-view']).find(node=>node.id==='new-patient-local-recording');
 checkbox.checked=true;
 await root.saveAndLoginNewPatient();
 assert.equal(calls.some(call=>call[0]==='fetch'&&call[1].includes('/consent')&&call[2]==='PUT'),false);
 assert.equal(consentSetting.value,false);
 assert.match(elements['local-recording-status'].textContent,/尚未保存/);
});

test('checked offline opt-in still starts the meal without recording',async()=>{
 const {root,calls,elements,consentSetting}=startMealHarness({serviceAvailable:false,consentEnabled:false,includePatientForm:true});
 const checkbox=(function flatten(node){return [node,...(node.children||[]).flatMap(flatten)];})(elements['patient-add-view']).find(node=>node.id==='new-patient-local-recording');
 checkbox.checked=true;
 await root.saveAndLoginNewPatient();
 await root.startMealSession();
 assert.equal(root.currentPatient.recording_enabled,false);
 assert.equal(consentSetting.value,false);
 assert.ok(calls.some(call=>call[0]==='original-start'));
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
});

test('offline unchecked onboarding cannot inherit a stale enabled value after reconnect',async()=>{
 const {root,calls,elements,consentSetting,serviceState}=startMealHarness({serviceAvailable:false,consentEnabled:true,includePatientForm:true});
 const checkbox=(function flatten(node){return [node,...(node.children||[]).flatMap(flatten)];})(elements['patient-add-view']).find(node=>node.id==='new-patient-local-recording');
 assert.equal(checkbox.checked,false);
 await root.saveAndLoginNewPatient();
 serviceState.value=true;
 await root.LocalRecordingBridge.connect();
 assert.equal(consentSetting.value,true,'simulate a stale local setting for this newly selected ID');
 await root.startMealSession();
 assert.ok(calls.some(call=>call[0]==='original-start'));
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
});

test('failed opt-in write leaves recording disabled for the new patient',async()=>{
 const {root,calls,elements,consentSetting}=startMealHarness({serviceAvailable:true,consentEnabled:false,consentWriteFails:true,includePatientForm:true});
 await root.LocalRecordingBridge.connect();
 const checkbox=(function flatten(node){return [node,...(node.children||[]).flatMap(flatten)];})(elements['patient-add-view']).find(node=>node.id==='new-patient-local-recording');
 checkbox.checked=true;
 await root.saveAndLoginNewPatient();
 assert.ok(calls.some(call=>call[0]==='fetch'&&call[1].includes('/consent')&&call[2]==='PUT'));
 assert.equal(consentSetting.value,false);
 assert.match(elements['local-recording-status'].textContent,/未保存/);
 await root.startMealSession();
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
});

test('offline local service starts the meal without recording',async()=>{
 const {root,calls,elements}=startMealHarness({serviceAvailable:false,consentEnabled:true});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 await root.startMealSession();
 assert.ok(calls.some(call=>call[0]==='original-start'));
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
 assert.match(elements['local-recording-status'].textContent,/服務未連線/);
});

test('unreadable caregiver setting fails closed and starts the meal without recording',async()=>{
 const {root,calls,elements}=startMealHarness({serviceAvailable:true,consentEnabled:true,consentReadFails:true});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 await root.startMealSession();
 assert.ok(calls.some(call=>call[0]==='original-start'));
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
 assert.match(elements['local-recording-status'].textContent,/無法確認/);
});

test('consent response without an explicit boolean fails closed',async()=>{
 const {root,calls,elements}=startMealHarness({serviceAvailable:true,consentEnabled:true,consentReadQueue:[Promise.resolve({patient_id:'synthetic-patient',recording_enabled:true}),Promise.resolve({patient_id:'synthetic-patient'})]});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 await root.startMealSession();
 assert.ok(calls.some(call=>call[0]==='original-start'));
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
 assert.match(elements['local-recording-status'].textContent,/無法確認/);
});

test('consent response for a different patient fails closed',async()=>{
 const {root,calls,elements}=startMealHarness({serviceAvailable:true,consentEnabled:true,consentReadQueue:[Promise.resolve({patient_id:'synthetic-patient',recording_enabled:true}),Promise.resolve({patient_id:'other-patient',recording_enabled:true})]});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 await root.startMealSession();
 assert.ok(calls.some(call=>call[0]==='original-start'));
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
 assert.match(elements['local-recording-status'].textContent,/無法確認/);
});

test('an enabled broadcast cannot authorize recording when the fresh caregiver setting cannot be read',async()=>{
 let releaseCameraStart;
 const freshRead=deferred();
 const cameraStartup=new Promise(resolve=>releaseCameraStart=resolve);
 const {root,calls,channelRef}=startMealHarness({serviceAvailable:true,consentEnabled:true,consentReadQueue:[Promise.resolve({patient_id:'synthetic-patient',recording_enabled:true}),Promise.resolve({patient_id:'synthetic-patient',recording_enabled:true}),freshRead.promise],startBarrier:cameraStartup});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 const start=root.startMealSession();await new Promise(resolve=>setImmediate(resolve));
 assert.ok(calls.some(call=>call[0]==='original-start'));
 channelRef.current.onmessage({data:{patientId:'synthetic-patient',enabled:true}});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 releaseCameraStart();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 freshRead.resolve(new Error('fresh consent read unavailable'));
 await start;
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
 assert.match(root.document.getElementById('local-recording-status').textContent,/無法確認/);
});

test('revocation invalidates an in-flight fresh consent read before recording can begin',async()=>{
 const freshRead=deferred();
 const {root,calls,channelRef,consentSetting}=startMealHarness({serviceAvailable:true,consentEnabled:true,consentReadQueue:[Promise.resolve({patient_id:'synthetic-patient',recording_enabled:true}),freshRead.promise]});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 const start=root.startMealSession();await new Promise(resolve=>setImmediate(resolve));
 assert.ok(calls.some(call=>call[0]==='original-start-complete'));
 consentSetting.value=false;
 channelRef.current.onmessage({data:{patientId:'synthetic-patient',enabled:false}});
 freshRead.resolve({patient_id:'synthetic-patient',recording_enabled:true});
 await start;
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
});

test('consent revoked while camera startup is pending prevents automatic recording',async()=>{
 let releaseCameraStart;
 const cameraStartup=new Promise(resolve=>releaseCameraStart=resolve);
 const {root,calls,channelRef,consentSetting}=startMealHarness({serviceAvailable:true,consentEnabled:true,startBarrier:cameraStartup});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 const start=root.startMealSession();await new Promise(resolve=>setImmediate(resolve));
 assert.ok(calls.some(x=>x[0]==='original-start'));
 assert.equal(calls.some(x=>x[0]==='original-start-complete'),false);
 consentSetting.value=false;
 channelRef.current.onmessage({data:{patientId:'synthetic-patient',enabled:false}});
 releaseCameraStart();
 await start;
 assert.ok(calls.some(call=>call[0]==='original-start-complete'));
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
});

test('fresh consent is rechecked after camera startup even when a revoke message is missed',async()=>{
 let releaseCameraStart;
 const cameraStartup=new Promise(resolve=>releaseCameraStart=resolve);
 const {root,calls,consentSetting}=startMealHarness({serviceAvailable:true,consentEnabled:true,startBarrier:cameraStartup});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 const start=root.startMealSession();await new Promise(resolve=>setImmediate(resolve));
 assert.ok(calls.some(call=>call[0]==='original-start'));
 consentSetting.value=false;
 releaseCameraStart();await start;
 assert.ok(calls.some(call=>call[0]==='original-start-complete'));
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
});

test('start without a patient profile proceeds without recording',async()=>{
 const {root,calls,elements}=startMealHarness({serviceAvailable:true,consentEnabled:true});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 root.currentPatient=null;
 await root.startMealSession();
 assert.ok(calls.some(call=>call[0]==='original-start'));
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
 assert.match(elements['local-recording-status'].textContent,/未選擇個案/);
});

test('logout revokes the local playback capability before Supabase clears the active JWT',async()=>{
 const order=[],client={auth:{signOut:async()=>{order.push('supabase-signout');return {error:null};}}};
 const api={request:async(path,options)=>{order.push(path);assert.equal(options.method,'POST');return {revoked:true};}};
 assert.equal(typeof bridge.installPlaybackLogoutRevocation,'function');
 bridge.installPlaybackLogoutRevocation(client,api);
 const result=await client.auth.signOut();
 assert.deepEqual(order,['/api/local/playback-session/revoke','supabase-signout']);
 assert.equal(result.error,null);
});

test('logout revocation failures are surfaced while the existing Supabase signOut still completes',async()=>{
 let warning='';const order=[];
 const client={auth:{signOut:async()=>{order.push('signed-out');return {error:null};}}};
 const api={request:async()=>{order.push('revoke-attempt');throw Object.assign(new Error('local server unavailable'),{code:'LOCAL_NETWORK_ERROR'});}};
 bridge.installPlaybackLogoutRevocation(client,api,error=>{warning=error.message;});
 const result=await client.auth.signOut();
 assert.equal(result.error,null);
 assert.deepEqual(order,['revoke-attempt','signed-out']);
 assert.match(warning,/local server unavailable/);
});

test('logout revocation degrades safely if the auth SDK signOut method is immutable',async()=>{
 const original=async()=>({error:null}),auth={};
 Object.defineProperty(auth,'signOut',{value:original,writable:false});
 const client={auth};
 assert.equal(bridge.installPlaybackLogoutRevocation(client,{request:async()=>({})}),false);
 assert.equal((await client.auth.signOut()).error,null);
});

test('GitHub Pages mode defers loopback fetch until explicit connect and annotates Local Network Access',async()=>{
 const calls=[];
 const client={auth:{getSession:async()=>({data:{session:{access_token:'existing-jwt'}},error:null})}};
 const api=bridge.createApi({location:{href:'https://951222-1.github.io/html-progress-sync/mobile/index.html'},
  loopbackApiOrigin:'http://127.0.0.1:18765',getSupabaseClient:()=>client,
  navigator:{permissions:{query:async info=>{assert.equal(info.name,'loopback-network');return {state:'prompt'};}}},
  fetch:async(url,options)=>{calls.push({url,options});return response(envelope(url.endsWith('/config')?config:{recording_enabled:true}));}});
 assert.equal(calls.length,0,'a public page must not probe localhost on page load');
 await assert.rejects(api.request('/api/local/consent?patient_id=synthetic'),error=>error.code==='LOCAL_CONNECT_REQUIRED');
 await api.connect();
 assert.equal(calls[0].url,'http://127.0.0.1:18765/api/local/config');
 assert.equal(calls[0].options.mode,'cors');
 assert.equal(calls[0].options.credentials,'include');
 assert.equal(calls[0].options.targetAddressSpace,'loopback');
 await api.request('/api/local/consent?patient_id=synthetic');
 assert.equal(calls[1].options.mode,'cors');
 assert.equal(calls[1].options.credentials,'include');
 assert.equal(calls[1].options.targetAddressSpace,'loopback');
});

test('remote pages, external paths, missing sessions and invalid config fail closed',async()=>{
 assert.throws(()=>bridge.createApi({location:{href:'https://example.invalid/mobile/index.html'},fetch:async()=>response(envelope(config))}),/localhost/i);
 const client={auth:{getSession:async()=>({data:{session:null},error:null})}};
 const api=bridge.createApi({location:{href:'http://127.0.0.1:9000/mobile/index.html'},getSupabaseClient:()=>client,fetch:async()=>response(envelope(config))});
 await assert.rejects(api.request('https://example.invalid/api/local/consent'),/本機 API/);
 await assert.rejects(api.request('/api/local/consent'),error=>error.code==='SUPABASE_SESSION_REQUIRED');
 const bad=bridge.createApi({location:{href:'http://127.0.0.1:9000/mobile/index.html'},getSupabaseClient:()=>client,fetch:async()=>response(envelope({mode:'local',csrf_token:'bad'}))});
 await assert.rejects(bad.ready,/設定不完整/);
});
