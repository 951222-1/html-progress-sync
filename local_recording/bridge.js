/* 本機伴隨 UI：沿用頁面既有 Supabase 登入，以短時 JWT 呼叫 loopback API；不替代任何雲端登入或警報邏輯。 */
(function(root,factory){
 const api=factory(root);
 if(typeof module==='object'&&module.exports)module.exports=api;
 else api.attach(root);
})(typeof globalThis!=='undefined'?globalThis:this,function(defaultRoot){
 'use strict';
 const API_PREFIX='/api/local/';
 const PAGES_ORIGIN='https://951222-1.github.io';
 const DEFAULT_REMOTE_API_ORIGIN='http://127.0.0.1:18765';
 function errorFrom(envelope,status){
  const item=envelope&&envelope.error||{};
  const error=new Error(item.message||'本機錄影服務請求失敗。');
  error.code=item.code||'LOCAL_REQUEST_FAILED';error.status=status;return error;
 }
 function authClientFrom(root){
  try{if(typeof supabaseClient!=='undefined'&&supabaseClient)return supabaseClient;}catch(_){}
  return root.supabaseClient||null;
 }
 function createApi(environment={}){
  const root=environment.root||defaultRoot;
  const location=environment.location||root.location;
  const fetcher=environment.fetch||root.fetch?.bind(root);
  const getClient=environment.getSupabaseClient||(()=>authClientFrom(root));
  const permissionManager=environment.navigator||root.navigator;
  if(!location||typeof fetcher!=='function')throw new Error('本機 API 環境未就緒。');
  const page=new URL(location.href);
  const localPage=['localhost','127.0.0.1'].includes(page.hostname)&&['http:','https:'].includes(page.protocol);
  const pagesPage=page.origin===PAGES_ORIGIN&&page.protocol==='https:';
  if(!localPage&&!pagesPage)throw new Error('錄影只允許 localhost，或指定的 GitHub Pages 網站。');
  const remoteMode=pagesPage;
  const origin=remoteMode?(environment.loopbackApiOrigin||DEFAULT_REMOTE_API_ORIGIN):page.origin;
  const apiUrl=new URL(origin);
  if(remoteMode&&(!['localhost','127.0.0.1'].includes(apiUrl.hostname)||apiUrl.protocol!=='http:'||apiUrl.username||apiUrl.password))throw new Error('GitHub Pages 模式只允許連到 localhost loopback 服務。');
  const read=async response=>{
   let envelope;try{envelope=await response.json();}catch(_){throw errorFrom({error:{code:'LOCAL_RESPONSE_INVALID',message:'本機服務回應格式錯誤。'}},response.status);}
   if(!envelope||typeof envelope!=='object'||!Object.prototype.hasOwnProperty.call(envelope,'data')||!Object.prototype.hasOwnProperty.call(envelope,'error'))throw errorFrom({error:{code:'LOCAL_RESPONSE_INVALID',message:'本機服務回應不符合契約。'}},response.status);
   if(envelope.error||!response.ok)throw errorFrom(envelope,response.status);
   return envelope.data;
  };
  let configPromise=null,connected=false;
  async function getPermissionState(){
   if(!remoteMode)return 'granted';
   if(!permissionManager?.permissions?.query)return 'prompt';
   try{return (await permissionManager.permissions.query({name:'loopback-network'})).state||'prompt';}catch(_){return 'prompt';}
  }
  async function connect(){
   if(configPromise)return configPromise;
   configPromise=(async()=>{
    const response=await fetcher(origin+'/api/local/config',{
     method:'GET',mode:remoteMode?'cors':'same-origin',credentials:remoteMode?'include':'same-origin',
     redirect:'error',cache:'no-store',...(remoteMode?{targetAddressSpace:'loopback'}:{})
    });
    const config=await read(response);
    if(!config||config.mode!=='local-recording'||typeof config.csrf_token!=='string'||!config.csrf_token)throw new Error('本機服務設定不完整；錄影保持關閉。');
    connected=true;
    return Object.freeze({csrf_token:config.csrf_token,ffmpeg_available:config.ffmpeg_available===true,
     max_recording_bytes:Number.isSafeInteger(config.max_recording_bytes)?config.max_recording_bytes:0,
     max_storage_bytes:Number.isSafeInteger(config.max_storage_bytes)?config.max_storage_bytes:0});
   })();
   try{return await configPromise;}catch(error){configPromise=null;connected=false;throw error;}
  }
  async function request(path,options={}){
   if(remoteMode&&!configPromise)throw Object.assign(new Error('請先按「連接本機錄影服務」並允許瀏覽器本機網路存取。'),{code:'LOCAL_CONNECT_REQUIRED'});
   const config=await connect();
   if(typeof path!=='string'||!path.startsWith(API_PREFIX)||path.includes('\\')||/%(?:2e|2f|5c)/i.test(path)||path.split('?')[0].split('/').some(part=>part==='.'||part==='..'))throw new Error('只允許本機 API 路徑。');
   const target=new URL(path,origin);
   if(target.origin!==origin||!target.pathname.startsWith(API_PREFIX)||target.hash||target.username||target.password)throw new Error('只允許本機 API 路徑。');
   const client=getClient();
   if(!client?.auth?.getSession)throw Object.assign(new Error('請先登入既有照護帳號。'),{code:'SUPABASE_SESSION_REQUIRED',status:401});
   const {data,error}=await client.auth.getSession();
   if(error)throw Object.assign(new Error(error.message||'無法讀取登入狀態。'),{code:'SUPABASE_SESSION_INVALID',status:401});
   const bearer=data?.session?.access_token;
   if(typeof bearer!=='string'||!bearer)throw Object.assign(new Error('請先登入既有照護帳號。'),{code:'SUPABASE_SESSION_REQUIRED',status:401});
   const method=String(options.method||'GET').toUpperCase();
   const headers={...(options.headers||{})};
   for(const key of Object.keys(headers))if(['authorization','x-local-token'].includes(key.toLowerCase()))delete headers[key];
   headers.Authorization='Bearer '+bearer;
   if(!['GET','HEAD'].includes(method))headers['X-Local-Token']=config.csrf_token;
   let body=options.body;
   if(Object.prototype.hasOwnProperty.call(options,'json')){headers['Content-Type']='application/json';body=JSON.stringify(options.json);}
   const response=await fetcher(target.href,{method,headers,body,mode:remoteMode?'cors':'same-origin',
    credentials:remoteMode?'include':'same-origin',redirect:'error',cache:'no-store',...(remoteMode?{targetAddressSpace:'loopback'}:{})});
   return read(response);
  }
  function videoUrl(path){
   if(typeof path!=='string'||!path.startsWith(API_PREFIX)||path.includes('\\')||/%(?:2e|2f|5c)/i.test(path))throw new Error('只允許本機影片路徑。');
   const target=new URL(path,origin);
   if(target.origin!==origin||!target.pathname.startsWith(API_PREFIX))throw new Error('只允許本機影片路徑。');
   return target.href;
  }
  const api={connect,request,getPermissionState,videoUrl};
  Object.defineProperties(api,{
   ready:{get(){return remoteMode&&!configPromise?Promise.reject(Object.assign(new Error('請由使用者動作啟動本機連線。'),{code:'LOCAL_CONNECT_REQUIRED'})):connect();}},
   isConnected:{get(){return connected;}},isRemote:{value:remoteMode},apiOrigin:{value:origin}
  });
  if(!remoteMode)void connect().catch(()=>{});
  return Object.freeze(api);
 }
 function installPlaybackLogoutRevocation(client,api,onFailure){
  const auth=client?.auth;if(!auth||typeof auth.signOut!=='function'||typeof api?.request!=='function')return false;
  if(auth.signOut.__localRecordingRevoker===true)return true;
  const original=auth.signOut;
  const wrapped=async function(...args){
   try{await api.request('/api/local/playback-session/revoke',{method:'POST',json:{}});}
   catch(error){try{onFailure?.(error);}catch(_){} }
   return original.apply(this,args);
  };
  Object.defineProperty(wrapped,'__localRecordingRevoker',{value:true});
  try{auth.signOut=wrapped;}catch(error){try{onFailure?.(error);}catch(_){}return false;}
  if(auth.signOut!==wrapped){try{onFailure?.(new Error('Auth signOut is immutable'));}catch(_){}return false;}
  return true;
 }
 function attachLogoutRevocation(root,api){
  const onFailure=()=>{
   const message='無法立即撤銷本機回看權限；播放權杖最長仍可能有效五分鐘。請停止本機服務，並在服務恢復後重新登出。';
   const status=root.document?.getElementById('local-recording-status')||root.document?.getElementById('local-recording-panel-status');
   if(status){status.hidden=false;status.textContent=message;status.dataset.state='error';}
   else root.console?.warn?.(message);
  };
  const install=()=>{const client=authClientFrom(root);return client?installPlaybackLogoutRevocation(client,api,onFailure):false;};
  install();
  wrap(root,'initSupabase',original=>function(...args){const result=original.apply(this,args);install();return result;});
 }
 function getPatient(root){return root.currentPatient&&root.currentPatient.id?root.currentPatient:null;}
 function getSessionPromise(root=defaultRoot){
  try{if(typeof root?.getCurrentMealSessionInsertPromise==='function')return root.getCurrentMealSessionInsertPromise();}catch(_){}
  try{return typeof currentMealSessionInsertPromise!=='undefined'?currentMealSessionInsertPromise:Promise.resolve(null);}catch(_){return Promise.resolve(null);}
 }
 function addPatientConsentControl(root){
  const doc=root.document,save=doc?.getElementById('btn-save-new-patient');
  if(!save||doc.getElementById('new-patient-local-recording'))return;
  const label=doc.createElement('label');label.className='flex items-start gap-3 rounded-2xl border border-blue-900 bg-slate-900 p-3 text-left cursor-pointer';
  const input=doc.createElement('input');input.type='checkbox';input.id='new-patient-local-recording';input.checked=false;input.className='mt-1 h-5 w-5 accent-blue-500';
  const text=doc.createElement('span');text.className='text-xs leading-relaxed text-slate-200';
  const strong=doc.createElement('strong');strong.className='block text-blue-300';strong.textContent='需要本機整餐無聲錄影（預設關閉）';
  const detail=doc.createElement('span');detail.textContent='影片只保存在這台電腦，不上傳至 Supabase。';text.append(strong,detail);label.append(input,text);
  save.parentElement?.parentElement?.insertBefore(label,save.parentElement);
 }
 function wrap(root,name,makeWrapper){
  const original=root[name];if(typeof original!=='function'||original.__localRecordingWrapped)return;
  const wrapped=makeWrapper(original);wrapped.__localRecordingWrapped=true;root[name]=wrapped;
 }
 function attachPatient(root,api){
  const ui=root.LocalRecordingUI;if(!ui)return;
  const recorder=ui.initialize({api});
  const connectButton=root.document?.getElementById('local-recording-connect');
  const connectPanel=root.document?.getElementById('local-recording-connect-panel');
  const confirmDialog=root.document?.getElementById('meal-recording-confirm-dialog');
  const recordChoiceButton=root.document?.getElementById('meal-recording-choice-record');
  const noRecordChoiceButton=root.document?.getElementById('meal-recording-choice-no-record');
  const cancelChoiceButton=root.document?.getElementById('meal-recording-choice-cancel');
  const confirmStatus=root.document?.getElementById('meal-recording-confirm-status');
  const connectStatus=root.document?.getElementById('local-recording-connect-status');
  attachLogoutRevocation(root,api);
  addPatientConsentControl(root);
  let selectedId=null,consent=false,consentGeneration=0,creatingPatient=false,startLocked=false,channel=null,pendingConsent=null,startPromptPending=false,recordThisMeal=false;
  function say(text,state='selected'){
   const modalOpen=Boolean(startPromptPending||confirmDialog?.open);
   const status=modalOpen?confirmStatus:root.document?.getElementById('local-recording-status');
   if(!status)return;
   if(!modalOpen&&state!=='error'){status.hidden=true;status.textContent='';return;}
   status.hidden=!text;status.textContent=text;status.dataset.state=state;
  }
  function canRecordThisMeal(profile){return !!(profile?.id&&api.isConnected&&consent&&selectedId===profile.id&&getPatient(root)?.id===profile.id);}
  function refreshMealStartOptions(profile=getPatient(root)){
   const canRecord=canRecordThisMeal(profile);
   if(recordChoiceButton)recordChoiceButton.hidden=!canRecord;
   if(noRecordChoiceButton){noRecordChoiceButton.hidden=false;noRecordChoiceButton.textContent=canRecord?'不錄影，照常開始用餐':'照常開始用餐（不錄影）';}
   if(connectPanel)connectPanel.hidden=!!api.isConnected;
   if(confirmStatus){
    confirmStatus.hidden=false;
    confirmStatus.textContent=!profile?.id
     ?'尚未選擇個案；本次不會錄影，開始用餐後會先要求選擇個案。'
     :canRecord
      ?'照護端已同意且本機服務已連線。請選擇本餐是否錄影；「不錄影」不會改動已儲存的同意。'
      :!api.isConnected
       ?'本機錄影服務尚未連線；若繼續，本餐不會錄影。可先連接服務，或選擇不錄影開始。'
       :'照護端尚未啟用此個案的本機錄影；此處不會更改同意設定。可照常開始但不錄影。';
   }
   return canRecord;
  }
  function requestMealStartChoice(profile){
   if(!confirmDialog||typeof confirmDialog.showModal!=='function'||!noRecordChoiceButton||!cancelChoiceButton){
    startPromptPending=false;say('無法顯示開始用餐確認視窗；為避免未確認就啟動，已取消。請重新載入頁面。','error');return Promise.resolve('cancel');
   }
   refreshMealStartOptions(profile);
   startPromptPending=true;
   return new Promise(resolve=>{
    let settled=false;
    const finish=choice=>{
     if(settled)return;settled=true;
     recordChoiceButton?.removeEventListener?.('click',onRecord);
     noRecordChoiceButton.removeEventListener?.('click',onNoRecord);
     cancelChoiceButton.removeEventListener?.('click',onCancel);
     confirmDialog.removeEventListener?.('cancel',onEscape);
     startPromptPending=false;
     try{confirmDialog.close?.();}catch(_){}
     if(choice==='cancel'&&root.document?.fullscreenElement&&typeof root.document.exitFullscreen==='function'){
      try{Promise.resolve(root.document.exitFullscreen()).catch(()=>{});}catch(_){}
     }
     resolve(choice);
    };
    const onRecord=event=>{
     event?.preventDefault?.();
     if(canRecordThisMeal(profile))finish('record');
     else{refreshMealStartOptions(profile);if(confirmStatus)confirmStatus.textContent+=' 錄影條件已變更；請重新選擇不錄影開始或返回。';}
    };
    const onNoRecord=event=>{event?.preventDefault?.();finish('no-record');};
    const onCancel=event=>{event?.preventDefault?.();finish('cancel');};
    const onEscape=event=>{event?.preventDefault?.();finish('cancel');};
    recordChoiceButton?.addEventListener?.('click',onRecord);
    noRecordChoiceButton.addEventListener('click',onNoRecord);
    cancelChoiceButton.addEventListener('click',onCancel);
    confirmDialog.addEventListener?.('cancel',onEscape);
    try{confirmDialog.showModal();}
    catch(_){startPromptPending=false;say('無法顯示開始用餐確認視窗；為避免未確認就啟動，已取消。請重新載入頁面。','error');finish('cancel');}
   });
  }
  async function connectLocalService(){
   if(api.isConnected)return true;
   if(connectButton)connectButton.disabled=true;
   try{
    await api.connect();
    if(connectPanel)connectPanel.hidden=true;else if(connectButton)connectButton.hidden=true;
    attachLogoutRevocation(root,api);
    if(pendingConsent){
     const pending=pendingConsent;
     try{await api.request('/api/local/consent',{method:'PUT',json:{patient_id:pending.patientId,enabled:pending.enabled}});pendingConsent=null;}
     catch(error){say('本機同意設定未儲存；錄影仍保持關閉。請在照護端重新確認。','error');return false;}
    }
    const profile=getPatient(root);if(profile)await loadConsent(profile);
    refreshMealStartOptions(profile);
    return true;
   }catch(error){
    if(connectButton)connectButton.disabled=false;
    const message=error?.code==='LOCAL_NETWORK_PERMISSION_DENIED'?'瀏覽器拒絕了本機網路權限；請在網址列的網站權限中允許後重試。':'無法連接本機錄影服務；請啟動本機伴隨服務並允許瀏覽器連線。';
    say(message,'error');return false;
   }
  }
  if(connectButton)connectButton.addEventListener('click',()=>void connectLocalService());
  if(api.isRemote){
   void api.getPermissionState().then(state=>{
    if(state==='granted')void connectLocalService();
    else if(connectStatus)connectStatus.textContent=state==='denied'
     ?'瀏覽器尚未允許此網站存取本機錄影服務；開始用餐前可按此處並依網站權限提示操作。'
     :'如要錄影，請在開始用餐前連接本機服務；瀏覽器會詢問本機網路權限。';
   });
  }else void connectLocalService();
  async function loadConsent(profile){
   if(!profile?.id){selectedId=null;consent=false;ui.selectPatient(null);say('');return false;}
   selectedId=profile.id;consent=false;const generation=++consentGeneration;
   ui.selectPatient({...profile,recording_enabled:false});
   if(!api.isConnected){say('請先連接本機錄影服務；未連線時不會保存影片或同意狀態。','selected');refreshMealStartOptions(profile);return false;}
   try{
    const result=await api.request('/api/local/consent?patient_id='+encodeURIComponent(profile.id));
    if(generation!==consentGeneration||selectedId!==profile.id)return false;
    consent=result.recording_enabled===true;
    ui.selectPatient({...profile,recording_enabled:consent});
    say(consent?'此個案已啟用整餐無聲錄影；影片只保存在這台電腦。':'本機錄影未啟用；原有即時偵測照常運作。',consent?'selected':'idle');
    refreshMealStartOptions(profile);
   }catch(error){if(generation===consentGeneration){consent=false;ui.selectPatient({...profile,recording_enabled:false});say('本機錄影服務或登入驗證不可用；錄影保持關閉，原有偵測照常運作。','error');refreshMealStartOptions(profile);}return false;}
   return consent;
  }
  function installConsentChannel(patientId){
   if(channel){channel.close();channel=null;}
   if(!patientId||typeof root.BroadcastChannel!=='function')return;
   channel=new root.BroadcastChannel('local-recording-consent:'+patientId);
   channel.onmessage=event=>{
    if(event.data?.patientId!==selectedId)return;
    consent=event.data.enabled===true;
    if(!consent)void recorder.end();
    const profile=getPatient(root);if(profile){ui.selectPatient({...profile,recording_enabled:consent});refreshMealStartOptions(profile);}
    say(consent?'照護端已啟用本機無聲錄影。':'照護端已關閉本機錄影；目前影片會保留在這台電腦。',consent?'selected':'idle');
   };
  }
  function observeSelectedPatient(){const profile=getPatient(root);if(profile&&profile.id!==selectedId){installConsentChannel(profile.id);void loadConsent(profile);}}
  wrap(root,'applySelectedPatientProfile',original=>function(profile,...args){
   const result=original.call(this,profile,...args);
   if(result&&!creatingPatient){const current=getPatient(root);installConsentChannel(current?.id);void loadConsent(current);}
   return result;
  });
  wrap(root,'saveAndLoginNewPatient',original=>async function(...args){
   const before=getPatient(root)?.id||null;
   const requested=!!root.document?.getElementById('new-patient-local-recording')?.checked;
   creatingPatient=true;
   try{await original.apply(this,args);}finally{creatingPatient=false;}
   const profile=getPatient(root);
   if(profile?.id&&profile.id!==before){
    if(!api.isConnected){pendingConsent={patientId:profile.id,enabled:requested};selectedId=profile.id;consent=false;installConsentChannel(profile.id);ui.selectPatient({...profile,recording_enabled:false});say('個案已建立；請先連接本機服務，才能儲存本機同意設定。','error');return;}
    try{await api.request('/api/local/consent',{method:'PUT',json:{patient_id:profile.id,enabled:requested}});installConsentChannel(profile.id);await loadConsent(profile);}
    catch(error){consent=false;selectedId=profile.id;ui.selectPatient({...profile,recording_enabled:false});say('個案已建立；本機同意設定未儲存，錄影保持關閉。','error');}
   }
  });
  wrap(root,'startMealSession',original=>async function(...args){
   if(startLocked)return;startLocked=true;recordThisMeal=false;
   const profile=getPatient(root);
   try{
    startPromptPending=true;
    await loadConsent(profile);
    refreshMealStartOptions(profile);
    startPromptPending=false;
    const choice=await requestMealStartChoice(profile);
    if(choice==='cancel')return false;
    recordThisMeal=choice==='record'&&canRecordThisMeal(profile);
    const result=await original.apply(this,args);
    if(root.isMealSessionActive?.()&&profile?.id&&selectedId===profile.id&&recordThisMeal&&canRecordThisMeal(profile)){
     recorder.begin({id:profile.id,recording_enabled:true},getSessionPromise(root));
    }
    return result;
   }finally{startPromptPending=false;recordThisMeal=false;startLocked=false;}
  });
  wrap(root,'endMealSession',original=>function(...args){
   // stop() releases the recorder's derived canvas track immediately; its upload continues in the background.
   void recorder.end();
   return original.apply(this,args);
  });
  wrap(root,'processVideoFrame',original=>async function(...args){
   const result=await original.apply(this,args);
   try{if(root.isMealSessionActive?.()&&root.document?.getElementById('ai-canvas'))recorder.captureFrame(root.document.getElementById('ai-canvas'),root.performance.now());}catch(_){}
   return result;
  });
  wrap(root,'logAnomalyToSupabase',original=>function(level,...args){
   const sessionPromise=getSessionPromise(root),timestamp=root.performance.now();
   const result=original.call(this,level,...args);
   if(level==='COUGH'&&result&&typeof result.then==='function')void ui.trackCoughEvent(result,timestamp,'疑似嗆咳',sessionPromise);
   return result;
  });
  root.LocalRecordingBridge=Object.freeze({api,connect:connectLocalService,loadConsent,begin:(profile,session)=>recorder.begin(profile,session),end:()=>recorder.end(),captureFrame:(canvas,time)=>recorder.captureFrame(canvas,time),trackCoughEvent:(event,time,kind,session)=>ui.trackCoughEvent(event,time,kind,session),setConsent:async(patientId,enabled)=>api.request('/api/local/consent',{method:'PUT',json:{patient_id:patientId,enabled}}),getConsent:patientId=>api.request('/api/local/consent?patient_id='+encodeURIComponent(patientId)),getState:()=>recorder.getState()});
  if(root.MutationObserver&&root.document?.getElementById('current-patient-label')){const observer=new root.MutationObserver(observeSelectedPatient);observer.observe(root.document.getElementById('current-patient-label'),{childList:true,subtree:true,characterData:true});}
  root.document?.addEventListener('visibilitychange',observeSelectedPatient);
 }
 function attachCaregiver(root,api){
  const panelModule=root.LocalRecordingPanel;if(!panelModule)return;
  attachLogoutRevocation(root,api);
  const panel=panelModule.mount({api,document:root.document});
  const toggle=root.document.getElementById('local-recording-consent-toggle');
  const connectButton=root.document.getElementById('local-recording-connect');
  const connectPanel=root.document.getElementById('local-recording-connect-panel');
  const status=root.document.getElementById('local-recording-panel-status');
  let selectedId=null,profile=null,generation=0,connecting=false;
  const say=text=>{if(status){status.hidden=!text;status.textContent=text;}};
  function readProfile(){
   let id='',code='';try{if(typeof currentPatientProfileId!=='undefined')id=currentPatientProfileId||'';if(typeof currentPatientCode!=='undefined')code=currentPatientCode||'';}catch(_){}
   if(!id){const selected=root.document?.getElementById('caregiver-patient-select')?.value||'';try{if(typeof currentPatientProfileId!=='undefined')id=currentPatientProfileId||'';}catch(_){}code=selected||code;}
   const label=root.document?.getElementById('caregiver-patient-name')?.textContent||'';
   return id?{id,patient_code:code,full_name:label}:null;
  }
  async function syncPatient(){
   const current=readProfile(),request=++generation;
   if(!current?.id){selectedId=null;profile=null;if(toggle){toggle.checked=false;toggle.disabled=true;}await panel.setPatient(null);say('先選擇並連線個案，才能管理這台電腦的錄影同意。');return;}
   selectedId=current.id;profile=current;if(toggle)toggle.disabled=true;
   if(!api.isConnected){profile={...current,recording_enabled:false};if(toggle){toggle.checked=false;toggle.disabled=true;}await panel.setPatient(profile);say('請先按「連接本機錄影服務」；尚未連線時不會讀取同意或影片。');return;}
   try{
    const consent=await api.request('/api/local/consent?patient_id='+encodeURIComponent(current.id));
    if(request!==generation)return;
    profile={...current,recording_enabled:consent.recording_enabled===true};
    if(toggle){toggle.checked=profile.recording_enabled;toggle.disabled=false;}
    await panel.setPatient(profile);say(profile.recording_enabled?'此個案已同意本機無聲錄影；影片只留在這台電腦。':'此個案尚未啟用本機錄影；雲端警報與趨勢不受影響。');
   }catch(_){if(request!==generation)return;if(toggle){toggle.checked=false;toggle.disabled=true;}profile={...current,recording_enabled:false};await panel.setPatient(profile);say('本機服務或登入驗證不可用；未更改雲端設定，錄影保持關閉。');}
  }
  if(toggle)toggle.addEventListener('change',async()=>{
   if(!profile?.id){toggle.checked=false;return;}
   const enabled=toggle.checked;toggle.disabled=true;
   try{
    await api.request('/api/local/consent',{method:'PUT',json:{patient_id:profile.id,enabled}});
    profile={...profile,recording_enabled:enabled};await panel.setPatient(profile);say(enabled?'已在這台電腦啟用本機無聲錄影。':'已在這台電腦關閉本機錄影；既有影片不會自動刪除。');
    if(typeof root.BroadcastChannel==='function'){const channel=new root.BroadcastChannel('local-recording-consent:'+profile.id);channel.postMessage({patientId:profile.id,enabled});channel.close();}
   }catch(_){toggle.checked=!enabled;say('同意狀態儲存失敗；請確認本機服務和登入狀態。');}
   finally{toggle.disabled=false;}
  });
  async function connectLocalService(){
   if(api.isConnected)return true;
   if(connecting)return false;connecting=true;if(connectButton)connectButton.disabled=true;
   try{
    await api.connect();
    if(connectPanel)connectPanel.hidden=true;else if(connectButton)connectButton.hidden=true;
    attachLogoutRevocation(root,api);say('本機錄影服務已連線；影片只會存放在這台電腦。');
    await syncPatient();return true;
   }catch(error){
    if(connectButton)connectButton.disabled=false;
    say(error?.code==='LOCAL_NETWORK_PERMISSION_DENIED'?'瀏覽器拒絕了本機網路權限；請在網址列的網站權限中允許後重試。':'無法連接本機錄影服務；請啟動本機伴隨服務並允許瀏覽器連線。');
    return false;
   }finally{connecting=false;}
  }
  if(connectButton)connectButton.addEventListener('click',()=>void connectLocalService());
  if(api.isRemote){
   void api.getPermissionState().then(state=>{
    if(state==='granted')void connectLocalService();
    else if(state==='denied')say('瀏覽器尚未允許此網站存取本機錄影服務；請按連線按鈕並依網站權限提示操作。');
    else say('請先按「連接本機錄影服務」；連線時瀏覽器會詢問本機網路權限。');
   });
  }else void connectLocalService();
  wrap(root,'connectToPatient',original=>async function(...args){const result=await original.apply(this,args);if(result)void syncPatient();return result;});
  if(root.MutationObserver&&root.document?.getElementById('caregiver-patient-name')){const observer=new root.MutationObserver(()=>void syncPatient());observer.observe(root.document.getElementById('caregiver-patient-name'),{childList:true,subtree:true,characterData:true});}
  root.LocalRecordingBridge=Object.freeze({api,connect:connectLocalService,syncPatient,getState:()=>({patientId:selectedId,recordingEnabled:!!profile?.recording_enabled})});
 }
 function attach(root=defaultRoot){
  if(!root?.document||root.LocalRecordingBridge)return null;
  const api=createApi({root,location:root.location,fetch:root.fetch?.bind(root)});
  if(root.document.getElementById('local-recording-list'))attachCaregiver(root,api);else attachPatient(root,api);
  return api;
 }
 return Object.freeze({createApi,attach,installPlaybackLogoutRevocation});
});
