/**
 * 🛡️ 防哽咽即時監測系統 - 遠端照護者 Dashboard 核心引擎 (caregiver.js)
 * 核心功能：WebRTC P2P 視訊接收 + Supabase Realtime 訂閱 + 個人化動態校正檢視 + Chart.js 趨勢分析
 */

let supabaseClient = null;
let currentPatientCode = 'P001';
let peerConnection = null;
let supabaseChannel = null;
let audioMuted = false;
let audioCtx = null;
let buzzerInterval = null;

// Chart.js 實例變數
let anomaliesChart = null;
let chewTrendChart = null;

document.addEventListener('DOMContentLoaded', async () => {
    initSupabase();
    initCharts();
    await loadPatientProfile(currentPatientCode);
    await fetchHistoricalSessions(currentPatientCode);
    setupWebRTCSignaling();
});

// 1. Supabase Client 初始化
function initSupabase() {
    try {
        if (window.supabase && CONFIG.SUPABASE_URL && !CONFIG.SUPABASE_URL.includes('xyzcompany')) {
            supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
            console.log('[Caregiver Supabase] Connected to live backend.');
        } else {
            console.warn('[Caregiver Supabase] Running in Standalone / Fallback mode.');
        }
    } catch (e) {
        console.error('[Caregiver Supabase] Init error:', e);
    }
}

// 2. 載入個案檔案與動態校正基準
async function loadPatientProfile(code) {
    if (supabaseClient) {
        try {
            const { data } = await supabaseClient
                .from('patient_profiles')
                .select('*')
                .eq('patient_code', code)
                .single();
            if (data) {
                document.getElementById('caregiver-patient-name').innerText = `${data.full_name} (${data.patient_code})`;
                document.getElementById('base-chew-sec').innerText = `${data.baseline_chew_duration.toFixed(2)} 秒`;
                document.getElementById('base-swallow-sec').innerText = `${data.baseline_swallow_pause.toFixed(2)} 秒`;
            }
        } catch (e) {
            console.warn('[Supabase] Failed to fetch profile, using defaults:', e);
        }
    }
}

// 3. 載入個案歷史用餐場次數據與繪製圖表
async function fetchHistoricalSessions(code) {
    let sessionData = [];
    if (supabaseClient) {
        try {
            const { data: profile } = await supabaseClient.from('patient_profiles').select('id').eq('patient_code', code).single();
            if (profile) {
                const { data } = await supabaseClient
                    .from('meal_sessions')
                    .select('*')
                    .eq('patient_id', profile.id)
                    .order('created_at', { ascending: true })
                    .limit(7);
                if (data) sessionData = data;
            }
        } catch (e) {}
    }

    // 若無 Supabase 資料，提供豐富測試數據繪圖
    if (sessionData.length === 0) {
        sessionData = [
            { created_at: '餐次 1', pouching_events: 1, cough_count_l2: 0, avg_chew_duration: 0.82 },
            { created_at: '餐次 2', pouching_events: 0, cough_count_l2: 0, avg_chew_duration: 0.86 },
            { created_at: '餐次 3', pouching_events: 2, cough_count_l2: 1, avg_chew_duration: 0.58 },
            { created_at: '餐次 4', pouching_events: 0, cough_count_l2: 0, avg_chew_duration: 0.84 },
            { created_at: '餐次 5', pouching_events: 1, cough_count_l2: 0, avg_chew_duration: 0.88 }
        ];
    }

    updateCharts(sessionData);
}

// 4. Chart.js 圖表繪製與更新
function initCharts() {
    const ctxAnomalies = document.getElementById('chart-anomalies').getContext('2d');
    const ctxChew = document.getElementById('chart-chew-trend').getContext('2d');

    anomaliesChart = new Chart(ctxAnomalies, {
        type: 'bar',
        data: {
            labels: [],
            datasets: [
                { label: '含飯/發呆次數', data: [], backgroundColor: 'rgba(251, 191, 36, 0.7)' },
                { label: '嗆咳/卡喉次數', data: [], backgroundColor: 'rgba(244, 63, 94, 0.7)' }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { display: false } },
                y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: '#334155' } }
            },
            plugins: { legend: { labels: { color: '#cbd5e1', font: { size: 10 } } } }
        }
    });

    chewTrendChart = new Chart(ctxChew, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: '平均咀嚼耗時 (s)', data: [], borderColor: '#34d399', backgroundColor: 'rgba(52, 211, 153, 0.1)', fill: true, tension: 0.3 },
                { label: '對照基線 (0.85s)', data: [0.85, 0.85, 0.85, 0.85, 0.85], borderColor: '#60a5fa', borderDash: [4, 4], pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { display: false } },
                y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: '#334155' } }
            },
            plugins: { legend: { labels: { color: '#cbd5e1', font: { size: 10 } } } }
        }
    });
}

function updateCharts(sessions) {
    const labels = sessions.map((s, idx) => `餐次 ${idx + 1}`);
    const pouchings = sessions.map(s => s.pouching_events || 0);
    const coughs = sessions.map(s => (s.cough_count_l2 || 0) + (s.choking_events_l3 || 0));
    const chewAvg = sessions.map(s => s.avg_chew_duration || 0.85);

    anomaliesChart.data.labels = labels;
    anomaliesChart.data.datasets[0].data = pouchings;
    anomaliesChart.data.datasets[1].data = coughs;
    anomaliesChart.update();

    chewTrendChart.data.labels = labels;
    chewTrendChart.data.datasets[0].data = chewAvg;
    chewTrendChart.data.datasets[1].data = new Array(labels.length).fill(0.85);
    chewTrendChart.update();
}

// 5. WebRTC P2P 影音接收與 Supabase Realtime 信令
function setupWebRTCSignaling() {
    if (!supabaseClient) return;
    try {
        supabaseChannel = supabaseClient.channel(`webrtc-${currentPatientCode}`);
        
        supabaseChannel
            .on('broadcast', { event: 'signal' }, async ({ payload }) => {
                if (payload.type === 'offer') {
                    await handleOfferAndAnswer(payload.sdp);
                } else if (payload.type === 'candidate' && peerConnection) {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
                }
            })
            .on('broadcast', { event: 'state_update' }, ({ payload }) => {
                handleStateUpdate(payload);
            })
            .subscribe();

    } catch (e) {
        console.warn('[WebRTC Signalling] Caregiver channel error:', e);
    }
}

async function handleOfferAndAnswer(offerSdp) {
    try {
        peerConnection = new RTCPeerConnection(CONFIG.RTC_CONFIG);

        peerConnection.ontrack = (event) => {
            const remoteVideo = document.getElementById('remote-video');
            if (remoteVideo && event.streams && event.streams[0]) {
                remoteVideo.srcObject = event.streams[0];
                document.getElementById('no-stream-placeholder').classList.add('hidden');
                console.log('[WebRTC P2P] Video stream attached successfully!');
            }
        };

        peerConnection.onicecandidate = (event) => {
            if (event.candidate && supabaseChannel) {
                supabaseChannel.send({
                    type: 'broadcast',
                    event: 'signal',
                    payload: { type: 'candidate', candidate: event.candidate }
                });
            }
        };

        await peerConnection.setRemoteDescription(new RTCSessionDescription(offerSdp));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        if (supabaseChannel) {
            supabaseChannel.send({
                type: 'broadcast',
                event: 'signal',
                payload: { type: 'answer', sdp: answer }
            });
        }
    } catch (e) {
        console.error('[WebRTC Answer Error]:', e);
    }
}

// 6. 即時狀態數據與警報跳窗更新
function handleStateUpdate(state) {
    document.getElementById('stat-chews').innerText = state.totalChews || 0;
    const statSwallows = document.getElementById('stat-swallows');
    if (statSwallows) statSwallows.innerText = state.totalSwallows || 0;
    document.getElementById('stat-jaw-vel').innerText = state.jawVelocity ? state.jawVelocity.toFixed(2) : '0.00';
    document.getElementById('stat-pouching').innerText = state.pouchingEvents || 0;
    document.getElementById('stat-coughs').innerText = state.coughEvents || 0;

    const dietInfo = CONFIG.DIET_PROFILES[state.dietType];
    if (dietInfo) {
        document.getElementById('caregiver-diet-type').innerText = dietInfo.name;
    }

    // 若收到 Level 2, L3, L4 警報
    if (state.activeAlertLevel) {
        showCaregiverAlert(state.activeAlertLevel);
        addRealtimeLog(state.activeAlertLevel, `${state.patientName} 觸發 ${state.activeAlertLevel} 警報！`);
    } else {
        hideCaregiverAlert();
    }
}

function showCaregiverAlert(level) {
    const banner = document.getElementById('caregiver-alert-banner');
    const text = document.getElementById('caregiver-alert-text');
    text.innerText = `觸發 ${level} 嚴重警報！請立即關注個案`;
    banner.classList.remove('hidden');
    playBuzzerSound();
}

function hideCaregiverAlert() {
    document.getElementById('caregiver-alert-banner').classList.add('hidden');
    stopBuzzerSound();
}

function addRealtimeLog(level, msg) {
    const container = document.getElementById('realtime-log-container');
    const emptyMsg = document.getElementById('empty-log-msg');
    if (emptyMsg) emptyMsg.remove();

    const nowStr = new Date().toTimeString().split(' ')[0];
    const logItem = document.createElement('div');
    logItem.className = 'bg-slate-800/80 p-3 rounded-2xl border border-slate-700/60 flex items-center justify-between text-xs animate-fade-in';
    
    const colorClass = level === 'L4' ? 'text-rose-400 font-bold' : (level === 'L2' ? 'text-amber-400 font-bold' : 'text-blue-400');
    
    logItem.innerHTML = `
        <div class="flex items-center space-x-2">
            <span class="font-mono text-slate-500">${nowStr}</span>
            <span class="${colorClass}">${msg}</span>
        </div>
        <span class="text-[10px] bg-slate-900 px-2 py-0.5 rounded text-slate-400 border border-slate-700">${level}</span>
    `;

    container.insertBefore(logItem, container.firstChild);
}

// 7. 音效廣播與切換
function toggleAudioMute() {
    audioMuted = !audioMuted;
    document.getElementById('sound-icon').innerText = audioMuted ? '🔇' : '🔊';
    document.getElementById('sound-text').innerText = audioMuted ? '警報音效: 靜音' : '警報音效: 開啟';
    if (audioMuted) stopBuzzerSound();
}

function playBuzzerSound() {
    if (audioMuted || buzzerInterval) return;
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        buzzerInterval = setInterval(() => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(880, audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.3);
            gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.3);
        }, 500);
    } catch (e) {}
}

function stopBuzzerSound() {
    if (buzzerInterval) {
        clearInterval(buzzerInterval);
        buzzerInterval = null;
    }
}
