(function(root,factory){
    const api=factory(root);
    if(typeof module==='object'&&module.exports)module.exports=api;
    else {
        root.IdleCalendar=api;
        const mount=()=>{if(!root.IdleCalendarWidget)root.IdleCalendarWidget=api.createIdleCalendar({document:root.document});};
        if(root.document){
            if(root.document.getElementById('idle-calendar'))mount();
            else if(root.document.addEventListener)root.document.addEventListener('DOMContentLoaded',mount,{once:true});
        }
    }
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
    'use strict';
    function formatDateTime(date){
        if(!date||typeof date.getTime!=='function'||!Number.isFinite(date.getTime()))throw new Error('無效的時間');
        const pad=value=>String(value).padStart(2,'0');
        const year=String(date.getFullYear()).padStart(4,'0'),month=pad(date.getMonth()+1),day=pad(date.getDate());
        return {day,date:year+' / '+month+' / '+day,weekday:new Intl.DateTimeFormat('zh-TW',{weekday:'long'}).format(date),time:pad(date.getHours())+':'+pad(date.getMinutes())+':'+pad(date.getSeconds()),isoDate:year+'-'+month+'-'+day,isoTime:date.toISOString()};
    }
    function formatGreeting(name,date){
        const hour=date.getHours(),period=hour>=5&&hour<12?'早安':hour>=12&&hour<18?'午安':'晚安';
        const person=typeof name==='string'?name.trim():'';
        return (person?person+'，':'')+period;
    }
    function describeWeather(code,isDay){
        const unknown={icon:'—',label:'暫無資料',reminder:'稍後再試',available:false};
        if(typeof code!=='number'||!Number.isFinite(code))return unknown;
        if(code===0||code===1)return {icon:isDay===0||isDay===false?'🌙':'☀️',label:code===0?'晴天':'晴時多雲',reminder:'多補充水分',available:true};
        if([51,53,55,56,57,61,63,65,66,67,80,81,82,95,96,99].includes(code))return {icon:code>=95?'⛈️':'🌧️',label:code>=95?'雷陣雨':'雨天',reminder:'攜帶雨傘',available:true};
        if(code===2||code===3)return {icon:code===2?'⛅':'☁️',label:code===2?'多雲':'陰天',reminder:'留意天氣變化',available:true};
        if(code===45||code===48)return {icon:'🌫️',label:'有霧',reminder:'留意行車視線',available:true};
        if([71,73,75,77,85,86].includes(code))return {icon:'❄️',label:'降雪',reminder:'留意保暖',available:true};
        return unknown;
    }
    const CITIES=Object.freeze([
        {id:'taoyuan',label:'桃園',latitude:24.99368,longitude:121.29696}
    ].map(city=>Object.freeze(city)));
    function weatherUrl(){
        const query=new URLSearchParams({latitude:CITIES.map(c=>c.latitude).join(','),longitude:CITIES.map(c=>c.longitude).join(','),current:'weather_code,is_day',timezone:'Asia/Taipei',forecast_days:'1'});
        return 'https://api.open-meteo.com/v1/forecast?'+query;
    }
    async function fetchCityWeather(fetcher=root.fetch,options={}){
        if(typeof fetcher!=='function')throw new Error('氣象服務暫時無法使用');
        const response=await fetcher(weatherUrl(),{method:'GET',credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',signal:options.signal});
        if(!response||!response.ok)throw new Error('氣象資料暫時無法取得');
        const payload=await response.json();
        const data=Array.isArray(payload)?payload:(payload&&typeof payload==='object'?[payload]:[]);
        if(!Array.isArray(data)||data.length!==CITIES.length)throw new Error('氣象資料格式不完整');
        return data.map((row,index)=>{
            if(row&&row.location_id!==undefined&&row.location_id!==index)throw new Error('氣象地區資料不一致');
            const current=row&&row.current;
            return {...CITIES[index],...describeWeather(current&&current.weather_code,current&&current.is_day),observedAt:current&&current.time||null};
        });
    }
    function createIdleCalendar(options={}){
        const doc=options.document||root.document,panel=doc&&doc.getElementById('idle-calendar');
        if(!panel)return null;
        const now=options.now||(()=>new Date()),every=options.setInterval||root.setInterval.bind(root),cancel=options.clearInterval||root.clearInterval.bind(root);
        const put=(id,text)=>{const node=doc.getElementById(id);if(node)node.textContent=text;};
        const end=doc.getElementById('btn-end-meal');
        function syncSessionVisibility(){
            const active=!!(end&&!end.hidden);
            panel.hidden=active;panel.setAttribute('aria-hidden',String(active));
        }
        const getPatientName=options.getPatientName||(()=>typeof root.getCalendarPatientName==='function'?root.getCalendarPatientName():'');
        function updateClock(){
            syncSessionVisibility();
            const instant=now(),value=formatDateTime(instant);let name='';
            try{name=getPatientName();}catch(_){} // 姓名尚未就緒時仍持續更新日期與時間。
            put('idle-greeting',formatGreeting(name,instant));
            put('idle-day',value.day);put('idle-date',value.date);put('idle-weekday',value.weekday);put('idle-time',value.time.slice(0,5));
            const date=doc.getElementById('idle-date'),time=doc.getElementById('idle-time');
            if(date)date.setAttribute('datetime',value.isoDate);
            if(time)time.setAttribute('datetime',value.isoTime);
            return value;
        }
        updateClock();const clockTimer=every(updateClock,1000);
        const Observer=options.MutationObserver||root.MutationObserver;let observer=null;
        if(end&&typeof Observer==='function'){
            try{observer=new Observer(syncSessionVisibility);observer.observe(end,{attributes:true,attributeFilter:['hidden']});}catch(_){if(observer)observer.disconnect();observer=null;}
        }
        let destroyed=false,generation=0,activeController=null;
        const delay=options.setTimeout||root.setTimeout.bind(root),clearDelay=options.clearTimeout||root.clearTimeout.bind(root);
        const timeoutMs=Number.isFinite(options.timeoutMs)&&options.timeoutMs>0?options.timeoutMs:8000;
        function renderWeather(rows){
            for(const row of rows){
                const prefix='idle-weather-'+row.id;
                put(prefix+'-icon',row.icon);put(prefix+'-label',row.label);put(prefix+'-tip',row.reminder);
            }
        }
        async function refreshWeather(){
            if(destroyed)return false;
            const ticket=++generation;put('idle-weather-status','正在更新天氣…');
            if(activeController)activeController.abort();
            const Controller=options.AbortController||root.AbortController;
            const controller=typeof Controller==='function'?new Controller():null;
            activeController=controller;let timeout;
            try{
                const rows=await Promise.race([
                    fetchCityWeather(options.fetch||root.fetch,{signal:controller&&controller.signal}),
                    new Promise((resolve,reject)=>{timeout=delay(()=>{if(controller)controller.abort();reject(new Error('取得天氣逾時'));},timeoutMs);})
                ]);
                if(destroyed||ticket!==generation)return false;
                renderWeather(rows);const available=rows.filter(row=>row.available).length;
                put('idle-weather-status',available===CITIES.length?'更新 '+formatDateTime(now()).time.slice(0,5):'天氣暫時無法取得');
                return available>0;
            }catch(_){
                if(destroyed||ticket!==generation)return false;
                renderWeather(CITIES.map(city=>({...city,...describeWeather(undefined)})));
                put('idle-weather-status','天氣暫時無法取得');return false;
            }finally{
                clearDelay(timeout);if(activeController===controller)activeController=null;
            }
        }
        const ready=refreshWeather(),weatherTimer=every(()=>{void refreshWeather();},1800000);
        return {updateClock,syncSessionVisibility,refreshWeather,ready,destroy(){destroyed=true;generation++;if(activeController)activeController.abort();cancel(clockTimer);cancel(weatherTimer);if(observer)observer.disconnect();}};
    }
    return {formatDateTime,formatGreeting,describeWeather,CITIES,weatherUrl,fetchCityWeather,createIdleCalendar};
});
