/* 交接註解：UI橋接：沿用目標個案ID與錄影同意；不能以來源預設值覆寫目標設定。需先適配目標生命週期/API。
 * 目標既有警報參數、判斷、通知、路徑和設定優先。先閱讀根目錄安裝手冊；不可整檔覆蓋目標。
 */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.LocalRecordingUI=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
'use strict';
function nextPatientCode(rows){
 const used=new Set((rows||[]).map(p=>String(p.code||'')));let n=0;
 for(const code of used){const m=/^P(\d+)$/.exec(code);if(m&&Number.isSafeInteger(Number(m[1])))n=Math.max(n,Number(m[1]));}
 let value;do{n++;value='P'+String(n).padStart(3,'0');}while(used.has(value));return value;
}
function seekBeforeCough(offset,duration){
 let target=Number.isFinite(Number(offset))?Math.max(0,Number(offset)-10):0;
 if(Number.isFinite(Number(duration))&&Number(duration)>=0)target=Math.min(target,Number(duration));return target;
}
function createBridge(env={}){
 let active=null,stopping=[],generation=0,state='idle',recordingId=null,pending=0,warnings=[];
 const emit=(value,seq=generation)=>{if(seq!==generation)return;state=value.state||state;recordingId=value.recordingId||value.id||recordingId;if(Array.isArray(value.warnings))warnings=value.warnings.map(w=>({...w}));if(value.warning&&value.message&&!warnings.some(w=>w.warning===value.warning))warnings.push({warning:value.warning,message:value.message});if(env.onState)env.onState({...value,warnings:warnings.map(w=>({...w})),recordingId});};
 const failure=(error,seq=generation)=>{emit({state:'error',error,message:'錄影保存失敗；原本的影像偵測不受影響。'},seq);};
 function begin(profile,sessionIdPromise=Promise.resolve(null)){
  if(active)return false;
  const seq=++generation;recordingId=null;warnings=[];
  if(!profile||!profile.id||profile.recording_enabled!==true){emit({state:'idle'});return false;}
  try{
   const make=env.makeRecorder||root.MealRecording?.createController;if(!make)throw Error('本機錄影模組未載入');
   const controller=make({api:env.api||root.LocalBackend,onState:s=>emit(s,seq)});
   active={controller,sessionIdPromise,seq,patientId:profile.id};
   controller.start({enabled:true,patientId:profile.id,startedAt:profile.startedAt||new Date().toISOString()});
   emit({state:'armed'},seq);return true;
  }catch(error){active=null;failure(error,seq);return false;}
 }
 function captureFrame(canvas,time){if(!active)return;try{active.controller.captureFrame(canvas,time);}catch(error){try{active.controller.cancel?.();}catch(_){}failure(error,active.seq);active=null;}}
 function findController(sessionIdPromise){
  if(active&&active.sessionIdPromise===sessionIdPromise)return active;
  return stopping.find(item=>item.sessionIdPromise===sessionIdPromise)||null;
 }
 function markCough(time,kind='疑似嗆咳',eventId,sessionId,sessionIdPromise){
  const item=sessionIdPromise?findController(sessionIdPromise):(active||stopping.at(-1));
  if(!item)return null;
  try{return item.controller.markCough(time,kind,eventId,sessionId);}catch(error){failure(error,item.seq);return null;}
 }
 function trackCoughEvent(eventPromise,time,kind='疑似嗆咳',sessionIdPromise){
  const item=findController(sessionIdPromise);
  if(!item||typeof item.controller.trackCoughEvent!=='function')return Promise.resolve(null);
  try{return item.controller.trackCoughEvent(eventPromise,time,kind,sessionIdPromise).catch(error=>{failure(error,item.seq);return null;});}
  catch(error){failure(error,item.seq);return Promise.resolve(null);}
 }
 function end(){
  const item=active;active=null;if(!item)return Promise.resolve(null);pending++;stopping.push(item);
  try{return Promise.resolve(item.controller.stop({sessionIdPromise:item.sessionIdPromise})).then(row=>{if(row)emit({state:row.status||'processing',recordingId:row.id},item.seq);return row;}).catch(error=>{failure(error,item.seq);return null;}).finally(()=>{pending--;stopping=stopping.filter(value=>value!==item);});}
  catch(error){pending--;stopping=stopping.filter(value=>value!==item);try{item.controller.cancel?.();}catch(_){}failure(error,item.seq);return Promise.resolve(null);}
 }
 function cancel(){if(!active)return;const item=active;active=null;try{Promise.resolve(item.controller.cancel?.()).catch(error=>failure(error,item.seq));}catch(error){failure(error,item.seq);}emit({state:'idle'},item.seq);}
 return {begin,captureFrame,markCough,trackCoughEvent,end,cancel,getState:()=>({state,recordingId,active:!!active,pending})};
}
let singleton=null,selectedProfile=null,boundUnload=false;
function renderState(info){
 const d=root.document;if(!d)return;const live=d.getElementById('local-recording-live'),status=d.getElementById('local-recording-status');
 if(live){live.hidden=info.state!=='recording';live.textContent='● 本機錄影中（無聲）';}
 if(status){const labels={idle:'',selected:'此個案已啟用整餐無聲錄影，影片只保存在這台電腦。',armed:'錄影準備中（無聲）。',recording:'正在錄製整餐影像，不收錄聲音；疑似嗆咳會標記時間點。',uploading:'正在將影片寫入這台電腦，請暫勿關閉此頁。',processing:'影片已送交本機轉存；完成後可在照護後台播放。',ready:'影片已保存在本機，可到照護後台回看。',error:'錄影保存失敗；影像偵測仍繼續。請查看本機服務狀態與磁碟空間。'};const primary=info.state==='error'&&info.message?info.message:(labels[info.state]??'正在處理本機影片…');status.hidden=info.state==='idle';status.textContent=[primary,...(info.warnings||[]).map(w=>w.message).filter(Boolean)].filter(Boolean).join(' ');status.dataset.state=info.state;}
}
function initialize(env={}){
 if(singleton)return singleton;singleton=createBridge({...env,onState:s=>{renderState(s);env.onState?.(s);}});
 if(!boundUnload&&root.addEventListener){boundUnload=true;root.addEventListener('beforeunload',e=>{const s=singleton.getState();if(s.active||s.pending){e.preventDefault();e.returnValue='';}});}
 if(env.standaloneLocalOperatorMode===true){const logout=root.document?.getElementById('supabase-auth-logout');if(logout){logout.textContent='本機操作員';logout.disabled=true;logout.title='僅限顯式獨立本機操作員模式；不代表目標帳號已登出';}}
 return singleton;
}
function selectPatient(profile){selectedProfile=profile;if(!initialize().getState().active)renderState({state:profile?.recording_enabled===true?'selected':'idle'});}
async function loadPatients(client,storage,options={}){
 if(options?.allowReplacePatientCache!==true)throw Error('拒絕覆寫目標個案快取；必須以第三參數 {allowReplacePatientCache:true} 顯式授權。');
 if(storage===undefined)storage=root.localStorage;
 const {data,error}=await client.from('patient_profiles').select('*');if(error)throw error;
 const rows=(data||[]).map(p=>({code:p.patient_code,name:String(p.full_name||p.patient_code).replace(/ \((?:男|女)\)$/,''),gender:p.gender||'男',diet:p.diet_type||'regular',recording_enabled:p.recording_enabled===true,note:'本機個案'}));
 if(rows.length)storage?.setItem('anti_choke_patient_list',JSON.stringify(rows));else storage?.removeItem('anti_choke_patient_list');
 root.renderPatientList?.();return rows;
}
return {nextPatientCode,seekBeforeCough,createBridge,loadPatients,initialize,selectPatient,begin:(p,s)=>initialize().begin(p,s),captureFrame:(c,t)=>singleton?.captureFrame(c,t),markCough:(t,k,e,s,p)=>singleton?.markCough(t,k,e,s,p),trackCoughEvent:(event,t,k,s)=>singleton?.trackCoughEvent(event,t,k,s)||Promise.resolve(null),end:()=>singleton?.end()||Promise.resolve(null),cancel:()=>singleton?.cancel(),getState:()=>singleton?.getState()||{state:'idle',active:false,pending:0}};
});
