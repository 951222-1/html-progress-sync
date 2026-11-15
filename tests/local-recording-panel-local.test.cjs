'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const file=path.join(__dirname,'../local_recording/local-recording-panel.js'),panel=fs.existsSync(file)?require(file):{};
const ids={patient:'00000000-0000-4000-8000-000000000002',record:'00000000-0000-4000-8000-000000000003'};
class Element{
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.hidden=false;this.textContent='';this.listeners={};this.readyState=1;this.duration=40;this.currentTime=0;this.src='';}
 append(...items){for(const x of items){x.parent=this;this.children.push(x);}} replaceChildren(...items){this.children=[];this.append(...items);}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}removeEventListener(type,fn){this.listeners[type]=(this.listeners[type]||[]).filter(f=>f!==fn);}
 async fire(type){for(const fn of this.listeners[type]||[])await fn({target:this});}
 setAttribute(k,v){this[k]=v;}removeAttribute(k){delete this[k];}pause(){this.paused=true;}load(){}play(){this.paused=false;return Promise.resolve();}
 set innerHTML(_){throw Error('Do not interpret patient data as HTML');}
}
function dom(){const nodes=new Map();for(const id of ['local-recording-list','local-recording-empty','local-recording-player','local-recording-marks','local-recording-player-title','local-recording-panel-status','local-recordings-refresh'])nodes.set(id,new Element(id==='local-recording-player'?'video':'div'));return {nodes,document:{getElementById:id=>nodes.get(id)||null,createElement:tag=>new Element(tag),addEventListener(){},removeEventListener(){},hidden:false}};}
function all(root){return [root,...root.children.flatMap(all)];}
const recording={id:ids.record,patient_id:ids.patient,status:'ready',started_at:'2026-11-10T04:00:00Z',duration_sec:40,width:640,height:360,effective_fps:10,cough_markers:[{offset_sec:25,kind:'疑似嗆咳'}]};
test('case-specific local video panel plays real API URLs and seeks ten seconds before a cough marker',async()=>{
 assert.equal(typeof panel.mount,'function','recordings panel missing');const d=dom(),calls=[];
 const api={request:async p=>{calls.push(p);return p.includes('patient_id='+ids.patient)?[recording]:[];}};
 const p=panel.mount({api,document:d.document,autoRefresh:false});await p.setPatient({id:ids.patient,full_name:'合成個案',recording_enabled:true});
 const play=all(d.nodes.get('local-recording-list')).find(e=>e.dataset.action==='play');assert.ok(play);assert.equal(d.nodes.get('local-recording-player').hidden,true,'do not autoplay when merely listing');
 await play.fire('click');const v=d.nodes.get('local-recording-player');assert.equal(v.src,'/api/local/recordings/'+ids.record+'/video');assert.equal(v.hidden,false);
 const mark=all(d.nodes.get('local-recording-marks')).find(e=>e.dataset.action==='seek');assert.ok(mark);await mark.fire('click');assert.equal(v.currentTime,15);
 await p.setPatient({id:'00000000-0000-4000-8000-000000000004',recording_enabled:false});assert.equal(v.hidden,true);assert.equal(d.nodes.get('local-recording-marks').children.length,0);p.destroy();
});
test('disabled recording state points to the caregiver control rather than a removed patient checkbox',async()=>{
 const d=dom(),api={request:async()=>[]};
 const p=panel.mount({api,document:d.document,autoRefresh:false});
 await p.setPatient({id:ids.patient,recording_enabled:false});
 const text=d.nodes.get('local-recording-empty').textContent;
 assert.match(text,/照護端/);
 assert.doesNotMatch(text,/新增個案時可勾選/);
 p.destroy();
});

test('failed recordings show the local quota/failure reason without using HTML insertion',async()=>{
 const d=dom(),failure='本機錄影資料夾已達設定容量上限；原始分塊保留於本機。';
 const row={...recording,status:'failed',error_message:failure};
 const api={request:async()=>[row]};
 const p=panel.mount({api,document:d.document,autoRefresh:false});
 await p.setPatient({id:ids.patient,full_name:'合成個案',recording_enabled:true});
 const card=d.nodes.get('local-recording-list').children[0];
 const paragraph=card.children.find(child=>child.tagName==='P');
 assert.ok(paragraph.textContent.includes(failure));
 p.destroy();
});

test('video deletion requires explicit confirmation and deletes only the chosen recording',async()=>{
 const d=dom(),deleted=[];let allow=false,rows=[recording];
 const api={request:async(p,o={})=>{if(o.method==='DELETE'){deleted.push(p);rows=[];return {deleted:true};}return rows;}};
 const p=panel.mount({api,document:d.document,autoRefresh:false,confirm:()=>allow});await p.setPatient({id:ids.patient,recording_enabled:true});
 const remove=all(d.nodes.get('local-recording-list')).find(e=>e.dataset.action==='delete');assert.ok(remove,'manual delete action missing');
 await remove.fire('click');assert.equal(deleted.length,0);allow=true;await remove.fire('click');
 assert.deepEqual(deleted,['/api/local/recordings/'+ids.record]);assert.equal(d.nodes.get('local-recording-list').children.length,0);p.destroy();
});

