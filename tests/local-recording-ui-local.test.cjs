'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const ui=require('../local_recording/local-recording-ui.js');
test('new local patient codes never reuse a stored code when the list has gaps',()=>{
 assert.equal(typeof ui.nextPatientCode,'function','next patient code helper missing');
 assert.equal(ui.nextPatientCode([{code:'P001'},{code:'P003'}]),'P004');
 assert.equal(ui.nextPatientCode([{code:'P004'}]),'P005');assert.equal(ui.nextPatientCode([]),'P001');
 const rows=[{code:'p01'},{code:'CUSTOM-CASE'}];assert.equal(ui.nextPatientCode(rows),'P001');assert.deepEqual(rows,[{code:'p01'},{code:'CUSTOM-CASE'}]);
});

test('cough replay begins ten seconds before the event and clamps to real available video',()=>{
 assert.equal(typeof ui.seekBeforeCough,'function','replay offset helper missing');
 assert.equal(ui.seekBeforeCough(25,40),15);assert.equal(ui.seekBeforeCough(4,40),0);assert.equal(ui.seekBeforeCough(100,20),20);
 assert.equal(ui.seekBeforeCough(NaN,40),0);assert.equal(ui.seekBeforeCough(-1,40),0);
});
test('recording bridge gates consent, forwards actual frame events and stops without awaiting meal persistence',async()=>{
 assert.equal(typeof ui.createBridge,'function','recording bridge missing');
 const calls=[];let resolve;const session=new Promise(r=>resolve=r);
 const b=ui.createBridge({makeRecorder:opts=>({start:o=>calls.push(['start',o]),captureFrame:(...a)=>calls.push(['frame',...a]),markCough:(...a)=>calls.push(['cough',...a]),trackCoughEvent:(...a)=>{calls.push(['track',...a]);return Promise.resolve('tracked');},stop:o=>{calls.push(['stop',o]);return o.sessionIdPromise.then(id=>({id:'record-1',session_id:id,status:'processing'}));},cancel:()=>calls.push(['cancel'])})});
 assert.equal(b.begin({id:'patient-a',recording_enabled:false},session),false);assert.equal(calls.length,0);
 const eventId='11111111-1111-4111-8111-111111111111',eventSession='22222222-2222-4222-8222-222222222222';
 assert.equal(b.begin({id:'patient-a',recording_enabled:true},session),true);b.captureFrame('canvas',120);b.markCough(125,'疑似嗆咳',eventId,eventSession,session);
 assert.equal(calls[0][1].patientId,'patient-a');assert.deepEqual(calls[1],['frame','canvas',120]);assert.deepEqual(calls[2],['cough',125,'疑似嗆咳',eventId,eventSession]);
 const eventPromise=Promise.resolve(eventId);await b.trackCoughEvent(eventPromise,126,'疑似嗆咳',session);assert.equal(calls[3][0],'track');
 const ended=b.end();assert.equal(calls[4][0],'stop','stop must run before the insert resolves');assert.equal(calls[4][1].sessionIdPromise,session);
 b.captureFrame('late',130);assert.equal(calls.length,5);resolve('meal-a');assert.equal((await ended).session_id,'meal-a');
 const errors=[],bad=ui.createBridge({onState:s=>errors.push(s),makeRecorder:()=>({start(){},captureFrame(){throw Error('codec failed');},cancel(){}})});
 bad.begin({id:'patient-a',recording_enabled:true});assert.doesNotThrow(()=>bad.captureFrame('canvas',1));assert.equal(errors.at(-1).state,'error');
});

test('patient choices reload from the local database rather than losing recording consent with browser storage',async()=>{
 assert.equal(typeof ui.loadPatients,'function','local profile reload missing');
 const rows=[{patient_code:'P004',full_name:'合成個案 (女)',gender:'女',diet_type:'regular',recording_enabled:true}];
 const store=new Map(),storage={setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
 const client={from:()=>({select:async()=>({data:rows,error:null})})};
 const result=await ui.loadPatients(client,storage,{allowReplacePatientCache:true});assert.equal(result[0].name,'合成個案');assert.equal(result[0].recording_enabled,true);
 assert.equal(JSON.parse(store.get('anti_choke_patient_list'))[0].code,'P004');assert.equal(rows[0].full_name,'合成個案 (女)');
 await ui.loadPatients({from:()=>({select:async()=>({data:[],error:null})})},storage,{allowReplacePatientCache:true});assert.equal(store.has('anti_choke_patient_list'),false);
});

test('recording quota errors are shown to the patient without interrupting the detection loop',()=>{
 const vm=require('node:vm'),status={hidden:true,textContent:'',dataset:{}},live={hidden:true,textContent:''};
 const ctx={document:{getElementById:id=>id==='local-recording-status'?status:id==='local-recording-live'?live:null},addEventListener(){},console,Date};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../local_recording/local-recording-ui.js'),'utf8'),ctx);
 const message='本機錄影資料夾已達設定容量上限；未接收此分塊。';
 const bridge=ctx.LocalRecordingUI.initialize({makeRecorder:({onState})=>({start(){},captureFrame(){onState({state:'error',message});return false;}})});
 bridge.begin({id:'synthetic-patient',recording_enabled:true});
 assert.doesNotThrow(()=>bridge.captureFrame({width:10,height:10},123));
 assert.equal(status.hidden,false);assert.ok(status.textContent.includes(message));
});

test('a nonfatal session-link warning remains visible after finalization but never leaks to the next patient',async()=>{
 const vm=require('node:vm'),status={hidden:true,textContent:'',dataset:{}},ctx={document:{getElementById:id=>id==='local-recording-status'?status:null},addEventListener(){},console,Date};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../local_recording/local-recording-ui.js'),'utf8'),ctx);
 const warning='用餐紀錄未能連結；影片仍保留，可稍後處理。';
 const bridge=ctx.LocalRecordingUI.initialize({makeRecorder:({onState})=>({start(){},stop(){onState({state:'uploading',warning:'SESSION_UNLINKED',message:warning});return Promise.resolve({id:'synthetic-video',status:'processing'});}})});
 bridge.begin({id:'synthetic-patient',recording_enabled:true});await bridge.end();
 assert.equal(status.hidden,false);assert.ok(status.textContent.includes(warning),'should visibly retain session-link warning after finalization');
 bridge.begin({id:'different-patient',recording_enabled:false});assert.equal(status.hidden,true);assert.equal(status.textContent.includes(warning),false,'previous patient warning must clear');
});

