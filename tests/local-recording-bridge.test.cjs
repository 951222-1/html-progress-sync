'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const bridge=require('../local_recording/bridge.js');

const envelope=(data,error=null)=>({data,error});
function response(data,status=200){return {ok:status>=200&&status<300,status,json:async()=>data};}
const config={mode:'local-recording',csrf_token:'synthetic-csrf-token',ffmpeg_available:true};

function startPromptHarness({serviceAvailable=true,consentEnabled=true,dialogAvailable=true,showModalThrows=false,startBarrier=null}={}){
 const calls=[];let mealActive=false;
 const makeElement=id=>({id,hidden:id==='meal-recording-choice-record',textContent:'',dataset:{},listeners:{},addEventListener(type,fn){(this.listeners[type]||(this.listeners[type]=[])).push(fn);},removeEventListener(type,fn){this.listeners[type]=(this.listeners[type]||[]).filter(value=>value!==fn);},click(){for(const fn of [...(this.listeners.click||[])])fn({target:this,preventDefault(){}});}});
 const dialog=makeElement('meal-recording-confirm-dialog');dialog.open=false;dialog.showModal=()=>{if(showModalThrows)throw Error('dialog unavailable');dialog.open=true;};dialog.close=()=>{dialog.open=false;};
 const elements={
  'meal-recording-confirm-dialog':dialog,'local-recording-connect':makeElement('local-recording-connect'),
  'local-recording-connect-panel':{hidden:false},'local-recording-status':{hidden:true,textContent:'',dataset:{}},
  'meal-recording-choice-record':makeElement('meal-recording-choice-record'),
  'meal-recording-choice-no-record':makeElement('meal-recording-choice-no-record'),
  'meal-recording-choice-cancel':makeElement('meal-recording-choice-cancel')
 };
 if(!dialogAvailable)delete elements['meal-recording-confirm-dialog'];
 const recorder={begin:(profile,session)=>calls.push(['recording-begin',profile,session]),selectPatient(){},end:async()=>null,getState:()=>({active:false})};
 const channelRef={current:null};
 class FakeBroadcastChannel{constructor(name){this.name=name;this.onmessage=null;channelRef.current=this;}postMessage(data){this.onmessage?.({data});}close(){this.onmessage=null;}}
 const document={getElementById:id=>elements[id]||null,createElement:()=>({append(){}}),addEventListener(){},fullscreenElement:null,exitFullscreen(){calls.push(['exit-fullscreen']);this.fullscreenElement=null;return Promise.resolve();}};
 const root={
  location:{href:'http://127.0.0.1:8123/mobile/index.html'},performance:{now:()=>1000},currentPatient:null,BroadcastChannel:FakeBroadcastChannel,
  document,
  fetch:async(url,options={})=>{calls.push(['fetch',url,String(options.method||'GET').toUpperCase()]);if(url.endsWith('/config')){if(!serviceAvailable)throw Error('companion offline');return response(envelope(config));}return response(envelope({patient_id:'synthetic-patient',recording_enabled:consentEnabled}));},
  supabaseClient:{auth:{getSession:async()=>({data:{session:{access_token:'synthetic-jwt'}},error:null}),signOut:async()=>({error:null})}},
  LocalRecordingUI:{initialize:()=>recorder,selectPatient(){}},
  getCurrentMealSessionInsertPromise:()=>Promise.resolve('22222222-2222-4222-8222-222222222222'),
  applySelectedPatientProfile(profile){this.currentPatient=profile;return true;},
  startMealSession:async function(){calls.push(['original-start']);if(startBarrier)await startBarrier;mealActive=true;calls.push(['original-start-complete']);},endMealSession(){mealActive=false;},isMealSessionActive:()=>mealActive
 };
 bridge.attach(root);
 root.applySelectedPatientProfile({id:'synthetic-patient',patient_code:'P-SYN',recording_enabled:false});
 return {root,calls,elements,dialog,channelRef};
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
 const makeControl=id=>({id,hidden:id==='meal-recording-choice-record',textContent:'',dataset:{},listeners:{},addEventListener(type,fn){(this.listeners[type]||(this.listeners[type]=[])).push(fn);},removeEventListener(type,fn){this.listeners[type]=(this.listeners[type]||[]).filter(value=>value!==fn);},click(){for(const fn of [...(this.listeners.click||[])])fn({target:this,preventDefault(){}});}});
 const dialog=makeControl('meal-recording-confirm-dialog');dialog.open=false;dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};
 const connectButton=makeControl('local-recording-connect'),connectPanel={hidden:false};
 const recordChoice=makeControl('meal-recording-choice-record'),noRecordChoice=makeControl('meal-recording-choice-no-record'),cancelChoice=makeControl('meal-recording-choice-cancel');
 const recorder={begin:(profile,session)=>calls.push(['begin',profile,session]),captureFrame:(frame,time)=>calls.push(['frame',frame,time]),trackCoughEvent:(promise,time,kind,session)=>{calls.push(['cough-promise',promise,time,kind,session]);return Promise.resolve();},end:()=>{calls.push(['recording-end']);return new Promise(resolve=>releaseRecordingEnd=resolve);},getState:()=>({active:false})};
 const root={
  location:{href:'http://127.0.0.1:8123/mobile/index.html'},performance:{now:()=>4321},
  document:{getElementById:id=>({
   'ai-canvas':canvas,'local-recording-status':status,'meal-recording-confirm-dialog':dialog,
   'local-recording-connect':connectButton,'local-recording-connect-panel':connectPanel,
   'meal-recording-choice-record':recordChoice,'meal-recording-choice-no-record':noRecordChoice,
   'meal-recording-choice-cancel':cancelChoice
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
 assert.equal(dialog.open,true,'meal startup must pause on the confirmation dialog');
 assert.equal(calls.some(x=>x[0]==='original-start'),false,'camera/meal startup must wait for the user choice');
 assert.equal(recordChoice.hidden,false,'recording choice is available only when service and caregiver consent are ready');
 recordChoice.click();
 await startPromise;
 assert.equal(dialog.open,false);
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

test('per-meal opt-out still starts monitoring without recording or changing saved consent',async()=>{
 const {root,calls,elements,dialog}=startPromptHarness({serviceAvailable:true,consentEnabled:true});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 const start=root.startMealSession();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(dialog.open,true);assert.equal(elements['meal-recording-choice-record'].hidden,false);
 elements['meal-recording-choice-no-record'].click();await start;
 assert.ok(calls.some(call=>call[0]==='original-start'));
 assert.equal(calls.filter(call=>call[0]==='recording-begin').length,0);
 assert.equal(calls.some(call=>call[0]==='fetch'&&call[2]==='PUT'),false);
});

test('offline companion hides record consent choice but allows an explicit no-record start',async()=>{
 const {root,calls,elements,dialog}=startPromptHarness({serviceAvailable:false,consentEnabled:true});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 const start=root.startMealSession();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(dialog.open,true);assert.equal(elements['meal-recording-choice-record'].hidden,true);
 assert.equal(elements['meal-recording-choice-no-record'].hidden,false);
 elements['meal-recording-choice-no-record'].click();await start;
 assert.ok(calls.some(call=>call[0]==='original-start'));
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
});

test('canceling the meal confirmation starts nothing and exits fullscreen',async()=>{
 const {root,calls,elements,dialog}=startPromptHarness({serviceAvailable:true,consentEnabled:true});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 root.document.fullscreenElement={tag:'main'};
 const start=root.startMealSession();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(dialog.open,true);
 elements['meal-recording-choice-cancel'].click();await start;
 assert.equal(dialog.open,false);
 assert.equal(calls.some(call=>call[0]==='original-start'),false);
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
 assert.ok(calls.some(call=>call[0]==='exit-fullscreen'));
});

test('stale recording choice does not silently become a no-record start after consent is revoked',async()=>{
 const {root,calls,elements,dialog,channelRef}=startPromptHarness({serviceAvailable:true,consentEnabled:true});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 const start=root.startMealSession();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(elements['meal-recording-choice-record'].hidden,false);
 channelRef.current.onmessage({data:{patientId:'synthetic-patient',enabled:false}});
 assert.equal(elements['meal-recording-choice-record'].hidden,true);
 elements['meal-recording-choice-record'].click();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(dialog.open,true,'stale record click must leave dialog open for a new explicit choice');
 assert.equal(calls.some(call=>call[0]==='original-start'),false);
 elements['meal-recording-choice-no-record'].click();await start;
 assert.ok(calls.some(call=>call[0]==='original-start'));
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
});

test('consent revoked while camera startup is pending prevents the meal from becoming a recording',async()=>{
 let releaseCameraStart;
 const cameraStartup=new Promise(resolve=>releaseCameraStart=resolve);
 const {root,calls,elements,channelRef}=startPromptHarness({serviceAvailable:true,consentEnabled:true,startBarrier:cameraStartup});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 const start=root.startMealSession();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(elements['meal-recording-choice-record'].hidden,false);
 elements['meal-recording-choice-record'].click();
 await new Promise(resolve=>setImmediate(resolve));
 assert.ok(calls.some(call=>call[0]==='original-start'));
 assert.equal(calls.some(call=>call[0]==='original-start-complete'),false);
 channelRef.current.onmessage({data:{patientId:'synthetic-patient',enabled:false}});
 releaseCameraStart();
 await start;
 assert.ok(calls.some(call=>call[0]==='original-start-complete'));
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
});

test('start without a patient profile still requires the no-record confirmation',async()=>{
 const {root,calls,elements,dialog}=startPromptHarness({serviceAvailable:true,consentEnabled:true});
 root.currentPatient=null;
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 const start=root.startMealSession();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(dialog.open,true);assert.equal(elements['meal-recording-choice-record'].hidden,true);
 assert.equal(calls.some(call=>call[0]==='original-start'),false);
 elements['meal-recording-choice-no-record'].click();await start;
 assert.ok(calls.some(call=>call[0]==='original-start'));
 assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
});

test('meal startup fails closed if the confirmation dialog is missing or cannot open',async()=>{
 for(const options of [{dialogAvailable:false},{showModalThrows:true}]){
  const {root,calls,elements}=startPromptHarness({serviceAvailable:true,consentEnabled:true,...options});
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  await root.startMealSession();
  assert.equal(calls.some(call=>call[0]==='original-start'),false);
  assert.equal(calls.some(call=>call[0]==='recording-begin'),false);
  assert.match(elements['local-recording-status'].textContent,/確認|取消/);
 }
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
