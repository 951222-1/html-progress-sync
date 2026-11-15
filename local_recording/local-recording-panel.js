/* 交接註解：後台回看片段：保留目標歷史趨勢及警報行為，只增設播放器、前10秒定位和確認刪除。
 * 目標既有警報參數、判斷、通知、路徑和設定優先。先閱讀根目錄安裝手冊；不可整檔覆蓋目標。
 */
(function(root,factory){const helpers=typeof module==='object'&&module.exports?require('./local-recording-ui.js'):root.LocalRecordingUI;const api=factory(root,helpers);if(typeof module==='object'&&module.exports)module.exports=api;else root.LocalRecordingPanel=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root,ui){
'use strict';
function clock(value){const n=Math.max(0,Math.floor(Number(value)||0));return (n>=3600?String(Math.floor(n/3600))+':':'')+String(Math.floor(n/60)%60).padStart(2,'0')+':'+String(n%60).padStart(2,'0');}
function dateLabel(value){const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleString('zh-TW',{hour12:false}):'時間未提供';}
function mount(env={}){
 const d=env.document||root.document,api=env.api||root.LocalBackend;if(!d||!api)throw Error('本機錄影面板服務未就緒');
 const get=id=>d.getElementById(id),list=get('local-recording-list'),empty=get('local-recording-empty'),video=get('local-recording-player'),marks=get('local-recording-marks'),title=get('local-recording-player-title'),status=get('local-recording-panel-status'),refreshButton=get('local-recordings-refresh');
 let profile=null,generation=0,playGeneration=0,destroyed=false,timer=null;
 const el=(tag,text,cls='')=>{const node=d.createElement(tag);node.textContent=text;node.className=cls;return node;};
 const say=text=>{if(status){status.textContent=text;status.hidden=!text;}};
 function resetPlayer(){playGeneration++;video?.pause();if(video){video.removeAttribute('src');video.load();video.hidden=true;}marks?.replaceChildren();if(title)title.textContent='';}
 function whenReady(){if(video.readyState>=1)return Promise.resolve();return new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timeout);video.removeEventListener('loadedmetadata',ok);video.removeEventListener('error',bad);};const ok=()=>{done();resolve();},bad=()=>{done();reject(Error('影片載入失敗'));};const timeout=setTimeout(bad,12000);video.addEventListener('loadedmetadata',ok);video.addEventListener('error',bad);});}
 async function seek(marker){try{await whenReady();video.currentTime=ui.seekBeforeCough(marker.offset_sec,video.duration);await video.play();say('已從疑似嗆咳前 10 秒定位；若沒有自動播放，請按播放器的播放鍵。');}catch(_){say('無法播放或定位此影片，請確認本機服務與影片檔仍可使用。');}}
 async function selectRecording(row){
  if(row.status!=='ready')return;const token=++playGeneration;
  video.pause();video.crossOrigin='use-credentials';const videoPath='/api/local/recordings/'+encodeURIComponent(row.id)+'/video';video.src=typeof api.videoUrl==='function'?api.videoUrl(videoPath):videoPath;video.muted=true;video.hidden=false;video.load();
  title.textContent=dateLabel(row.started_at)+'・整餐錄影（無聲）';marks.replaceChildren();
  for(const marker of Array.isArray(row.cough_markers)?row.cough_markers:[]){const b=el('button','疑似嗆咳 '+clock(marker.offset_sec)+'｜前10秒回看','text-xs px-3 py-2 rounded-xl border border-slate-700 bg-slate-800');b.type='button';b.dataset.action='seek';b.dataset.offsetSec=String(marker.offset_sec);b.addEventListener('click',()=>seek(marker));marks.append(b);}
  if(!marks.children.length)marks.append(el('p','此餐沒有已標記的疑似嗆咳事件。','text-xs text-slate-400'));
  try{await whenReady();if(token===playGeneration)await video.play();}catch(_){if(token===playGeneration)say('影片已載入；請按播放器的播放鍵。');}
 }
 async function removeRecording(row){
  const confirm=env.confirm||root.confirm;if(!confirm||!confirm('確定刪除此整餐影片？刪除後無法復原；用餐數據與趨勢不會刪除。'))return;
  if(row.patient_id&&row.patient_id!==profile?.id){say('個案已切換，未刪除影片。');return;}
  try{resetPlayer();await api.request('/api/local/recordings/'+encodeURIComponent(row.id),{method:'DELETE'});await refresh();say('指定影片已從本機刪除，用餐數據與趨勢仍保留。');}catch(_){say('刪除失敗，影片紀錄仍保留，請確認檔案沒有被其他程式使用。');}
 }
 async function refresh(){
  if(destroyed)return;const token=++generation;
  if(!profile?.id){list.replaceChildren();empty.hidden=false;empty.textContent='請先選取個案。';return;}
  try{
   const rows=await api.request('/api/local/recordings?patient_id='+encodeURIComponent(profile.id));if(token!==generation||destroyed)return;
   list.replaceChildren();empty.hidden=rows.length>0;empty.textContent=profile.recording_enabled?'此個案尚無影片；開始並結束用餐後，會在本機轉存並顯示。':'照護端尚未為此個案啟用錄影；既有影片不會自動刪除。';
   for(const row of rows){
    const card=el('article','','border border-slate-700 bg-slate-950 rounded-2xl p-4 space-y-2');card.dataset.recordingId=row.id;
    card.append(el('h4',dateLabel(row.started_at),'font-bold text-sm'));
    const state={recording:'錄影中',processing:'本機轉存中',ready:'可播放',failed:'轉存失敗（來源資料保留）',interrupted:'錄影中斷（已接收資料保留）'}[row.status]||row.status;
    const parts=[state,'整餐無聲',clock(row.duration_sec)];if(row.width&&row.height)parts.push(row.width+'×'+row.height);if(row.status==='failed'&&row.error_message)parts.push(row.error_message);card.append(el('p',parts.join('・'),'text-xs text-slate-400'));
    if(row.status==='ready'){const play=el('button','播放整餐','text-xs px-3 py-2 rounded-xl bg-blue-600 text-white font-bold');play.type='button';play.dataset.action='play';play.addEventListener('click',()=>selectRecording(row));card.append(play);}
    if(['ready','failed','interrupted'].includes(row.status)){const remove=el('button','刪除影片','text-xs px-3 py-2 rounded-xl border border-rose-400 text-rose-600 ml-2');remove.type='button';remove.dataset.action='delete';remove.addEventListener('click',()=>removeRecording(row));card.append(remove);}
    list.append(card);
   }
   say('');
  }catch(_){if(token===generation)say('本機影片讀取失敗，請確認本機服務仍在執行。');}
 }
 async function setPatient(value){profile=value;generation++;resetPlayer();return refresh();}
 if(refreshButton)refreshButton.addEventListener('click',refresh);
 const onFocus=()=>{if(!d.hidden&&profile)refresh();};if(d.addEventListener)d.addEventListener('visibilitychange',onFocus);
 if(env.autoRefresh!==false&&root.setInterval)timer=root.setInterval(onFocus,5000);
 return {setPatient,refresh,selectRecording,getState:()=>({patientId:profile?.id||null}),destroy(){destroyed=true;generation++;resetPlayer();if(timer)root.clearInterval(timer);d.removeEventListener?.('visibilitychange',onFocus);}};
}
let singleton=null;
return {mount,clock,dateLabel,setPatient:profile=>{singleton=singleton||mount();return singleton.setPatient(profile);},refresh:()=>singleton?.refresh()};
});
