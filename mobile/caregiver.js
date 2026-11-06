/**
 * 🛡️ 防哽咽即時監測系統 - 遠端照護者 Dashboard 核心引擎 (caregiver.js)
 * 核心功能：WebRTC P2P 視訊接收 + Supabase Realtime 訂閱 + 個人化動態校正檢視 + Chart.js 趨勢分析
 */

let supabaseClient = null;
let currentPatientCode = null;
let currentPatientProfileId = null;
let caregiverClientId = null;
let caregiverSessionGeneration = 0;
let patientSwitchInProgress = false;
let peerConnection = null;
let supabaseChannel = null;
let lastOfferRequestAt = 0;
let lastLoggedAlertLevel = null;
let lastLoggedAlertMessage = null;
let activeNegotiationId = null;
let currentAnswerPayload = null;
const remoteCandidateBuffer = window.ConnectionCore.createCandidateBuffer();
const negotiationGate = window.ConnectionCore.createNegotiationGate();
let audioMuted = false;
let audioCtx = null;
let buzzerInterval = null;

// Chart.js 實例變數
let anomaliesChart = null;
let chewTrendChart = null;
let currentPatientBaselines = { chew: 0.85 };
let currentHistoryRange = 'recent7';
let historyRequestGeneration = 0;

document.addEventListener('DOMContentLoaded', async () => {
    initSupabase();
    if (!supabaseClient) {
        setRealtimeStatus('Supabase 設定未完成', false);
        window.AuthUI.showSetupError('系統連線設定尚未完成。請聯絡管理者，不會顯示示範資料或未授權資料。');
        return;
    }
    try {
        await window.AuthUI.requireAuth(supabaseClient, '照護者端');
        initCharts();
        const historyRangeSelect = document.getElementById('caregiver-history-range');
        historyRangeSelect?.addEventListener('change', async () => {
            currentHistoryRange = historyRangeSelect.value === '30days' ? '30days' : 'recent7';
            if (currentPatientCode && currentPatientProfileId) {
                await fetchHistoricalSessions(currentPatientCode, currentPatientProfileId,
                    caregiverSessionGeneration, currentHistoryRange);
            }
        });
        const initialCode = new URLSearchParams(location.search).get('patient') || 'P001';
        document.getElementById('btn-connect-patient')?.addEventListener('click', () => connectToPatient());
        document.getElementById('btn-refresh-patients')?.addEventListener('click', async () => {
            const select = document.getElementById('caregiver-patient-select');
            await loadCaregiverProfiles(select?.value || currentPatientCode || initialCode);
        });
        const profiles = await loadCaregiverProfiles(initialCode);
        const selectedCode = document.getElementById('caregiver-patient-select')?.value;
        if (profiles.length && selectedCode) {
            await connectToPatient(selectedCode, { quiet: true });
        } else {
            setRealtimeStatus('此帳號尚無可選個案', false);
        }
    } catch (error) {
        console.error('[Caregiver] Startup failed:', error);
        setRealtimeStatus('登入／連線失敗', false);
        window.AuthUI.showSetupError('照護者端無法連線。請確認兩端使用同一個帳號，並重新整理。');
    }
});

function initSupabase() {
    try {
        if (!window.supabase || !CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_PUBLISHABLE_KEY) {
            console.error('[Caregiver Supabase] Project URL or publishable key is missing.');
            return;
        }
        supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_PUBLISHABLE_KEY);
        console.log('[Caregiver Supabase] Client initialized; sign-in is required.');
    } catch (e) {
        console.error('[Caregiver Supabase] Init error:', e);
    }
}

function setRealtimeStatus(text, connected) {
    const label = document.getElementById('rt-status-text');
    const dot = document.getElementById('rt-status-dot');
    if (label) label.innerText = text;
    if (dot) {
        dot.className = connected
            ? 'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse'
            : 'w-2.5 h-2.5 rounded-full bg-slate-500';
    }
}

function setPatientListStatus(text) {
    const status = document.getElementById('caregiver-patient-list-status');
    if (status) status.textContent = text;
}

async function loadCaregiverProfiles(preferredCode = '') {
    const select = document.getElementById('caregiver-patient-select');
    const connectButton = document.getElementById('btn-connect-patient');
    const refreshButton = document.getElementById('btn-refresh-patients');
    if (!select || !supabaseClient) return [];

    select.disabled = true;
    if (connectButton) connectButton.disabled = true;
    if (refreshButton) refreshButton.disabled = true;
    let hasProfiles = false;
    try {
        // RLS limits this authenticated query to profiles owned by the signed-in account.
        const { data, error } = await supabaseClient
            .from('patient_profiles')
            .select('id, patient_code, full_name')
            .order('full_name', { ascending: true });
        if (error) throw error;

        const profiles = Array.isArray(data) ? data.filter(profile =>
            profile && /^[A-Za-z0-9_-]{1,32}$/.test(String(profile.patient_code || ''))
        ) : [];
        select.replaceChildren();
        if (!profiles.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '此帳號尚無個案';
            select.appendChild(option);
            setPatientListStatus('請先在使用者端建立個案資料。');
            return [];
        }

        for (const profile of profiles) {
            const option = document.createElement('option');
            option.value = profile.patient_code;
            option.textContent = `${profile.full_name || profile.patient_code} (${profile.patient_code})`;
            select.appendChild(option);
        }

        const requestedCode = String(preferredCode || '').trim();
        const selectedProfile = profiles.find(profile => profile.patient_code === requestedCode)
            || profiles.find(profile => profile.patient_code === currentPatientCode)
            || profiles[0];
        select.value = selectedProfile.patient_code;
        setPatientListStatus(`已載入 ${profiles.length} 位個案`);
        hasProfiles = true;
        return profiles;
    } catch (error) {
        console.error('[Caregiver] Could not load patient list:', error);
        select.replaceChildren();
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '無法載入個案名單';
        select.appendChild(option);
        setPatientListStatus('個案名單載入失敗，請重新整理或重新登入。');
        return [];
    } finally {
        select.disabled = !hasProfiles;
        if (connectButton) connectButton.disabled = !hasProfiles;
        if (refreshButton) refreshButton.disabled = false;
    }
}

function resetCaregiverPatientView() {
    const defaults = {
        'caregiver-patient-name': '尚未選擇個案',
        'caregiver-diet-type': '-',
        'base-chew-sec': '-',
        'base-swallow-sec': '-',
        'stat-chews': '0',
        'stat-swallows': '0',
        'stat-jaw-vel': '0.00',
        'stat-pouching': '0',
        'stat-coughs': '0'
    };
    for (const [id, value] of Object.entries(defaults)) {
        const element = document.getElementById(id);
        if (element) element.innerText = value;
    }

    const remoteVideo = document.getElementById('remote-video');
    if (remoteVideo) {
        remoteVideo.pause();
        remoteVideo.srcObject = null;
    }
    document.getElementById('no-stream-placeholder')?.classList.remove('hidden');
    hideCaregiverAlert();
    lastLoggedAlertLevel = null;
    lastLoggedAlertMessage = null;

    const logContainer = document.getElementById('realtime-log-container');
    if (logContainer) {
        const emptyMessage = document.createElement('div');
        emptyMessage.id = 'empty-log-msg';
        emptyMessage.className = 'text-center py-8 text-xs text-slate-500 italic';
        emptyMessage.textContent = '目前尚無異常事件紀錄';
        logContainer.replaceChildren(emptyMessage);
    }
    historyRequestGeneration += 1;
    currentPatientBaselines = { chew: 0.85 };
    const historyRangeSelect = document.getElementById('caregiver-history-range');
    if (historyRangeSelect) historyRangeSelect.disabled = true;
    setMealHistoryStatus('尚未選擇個案');
    renderMealHistory([], currentHistoryRange);
    if (anomaliesChart && chewTrendChart) updateCharts([]);
}

async function connectToPatient(code = document.getElementById('caregiver-patient-select')?.value, options = {}) {
    if (patientSwitchInProgress) return false;
    patientSwitchInProgress = true;
    const generation = ++caregiverSessionGeneration;
    const normalizedCode = String(code || '').trim();
    const button = document.getElementById('btn-connect-patient');
    const select = document.getElementById('caregiver-patient-select');
    const refreshButton = document.getElementById('btn-refresh-patients');
    try {
        if (!supabaseClient || !window.ConnectionCore) throw new Error('連線設定未完成。');
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(normalizedCode)) throw new Error('個案代碼格式錯誤。');
        if (button) button.disabled = true;
        if (select) select.disabled = true;
        if (refreshButton) refreshButton.disabled = true;
        const previousChannel = supabaseChannel;
        supabaseChannel = null;
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        currentPatientCode = null;
        currentPatientProfileId = null;
        caregiverClientId = null;
        activeNegotiationId = null;
        currentAnswerPayload = null;
        remoteCandidateBuffer.clear();
        resetCaregiverPatientView();
        setRealtimeStatus('查詢個案資料…', false);
        if (previousChannel) {
            try { await previousChannel.unsubscribe(); }
            catch (error) { console.warn('[Caregiver] Previous channel could not close cleanly:', error); }
        }
        const { data: profile, error } = await supabaseClient
            .from('patient_profiles')
            .select('*')
            .eq('patient_code', normalizedCode)
            .maybeSingle();
        if (generation !== caregiverSessionGeneration) return false;
        if (error) throw error;
        if (!profile) {
            setRealtimeStatus('尚無此個案資料', false);
            setPatientListStatus('此個案不存在或不屬於目前登入帳號。');
            if (!options.quiet) alert('找不到此個案。請先在使用者端以相同帳號選擇個案並開始用餐，再回來連線。');
            return false;
        }
        currentPatientCode = profile.patient_code;
        currentPatientProfileId = profile.id;
        currentPatientBaselines = {
            chew: Number(profile.baseline_chew_duration) || 0.85
        };
        const historyRangeSelect = document.getElementById('caregiver-history-range');
        if (historyRangeSelect) historyRangeSelect.disabled = false;
        caregiverClientId = crypto.randomUUID();
        lastOfferRequestAt = 0;
        if (select) select.value = profile.patient_code;
        document.getElementById('caregiver-patient-name').innerText = `${profile.full_name} (${profile.patient_code})`;
        document.getElementById('caregiver-diet-type').innerText = (CONFIG.DIET_PROFILES[profile.diet_type] || {}).name || profile.diet_type;
        document.getElementById('base-chew-sec').innerText = `${Number(profile.baseline_chew_duration || 0.85).toFixed(2)} 秒`;
        document.getElementById('base-swallow-sec').innerText = `${Number(profile.baseline_swallow_pause || 1.10).toFixed(2)} 秒`;
        void fetchHistoricalSessions(normalizedCode, profile.id, generation)
            .catch(error => console.error('[Caregiver] History load failed:', error));
        await setupWebRTCSignaling(profile.id, generation);
        return true;
    } catch (error) {
        console.error('[Caregiver] Patient connection failed:', error);
        setRealtimeStatus('連線失敗，請重試', false);
        if (!options.quiet) alert('個案連線失敗。請確認個案代碼與兩端登入帳號相同。');
        return false;
    } finally {
        patientSwitchInProgress = false;
        const canConnect = Boolean(select?.value);
        if (button) button.disabled = !canConnect;
        if (select) select.disabled = !canConnect;
        if (refreshButton) refreshButton.disabled = false;
    }
}

window.connectToPatient = connectToPatient;

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
async function fetchHistoricalSessions(code, patientId = null, generation = caregiverSessionGeneration, range = currentHistoryRange) {
    const requestId = ++historyRequestGeneration;
    const normalizedRange = range === '30days' ? '30days' : 'recent7';
    const isCurrentRequest = () => generation === caregiverSessionGeneration
        && requestId === historyRequestGeneration;
    let sessionData = [];
    let eventLogsAvailable = true;
    let eventLogs = [];
    let loadError = null;
    let sessionLoadFailed = false;
    try {
        if (!patientId) {
            const { data: profile, error: profileError } = await supabaseClient
                .from('patient_profiles').select('id').eq('patient_code', code).maybeSingle();
            if (!isCurrentRequest()) return false;
            if (profileError) throw profileError;
            patientId = profile?.id;
        }
        if (patientId) {
            let query = supabaseClient.from('meal_sessions')
                .select('*')
                .eq('patient_id', patientId);
            if (normalizedRange === '30days') {
                const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
                query = query.gte('start_time', cutoff);
            }
            const sessionLimit = normalizedRange === '30days' ? 500 : 7;
            const { data, error } = await query
                .order('start_time', { ascending: false })
                .limit(sessionLimit);
            if (!isCurrentRequest()) return false;
            if (error) throw error;

            const dateValue = session => {
                const value = Date.parse(session.start_time || session.created_at);
                return Number.isFinite(value) ? value : 0;
            };
            const sessions = (Array.isArray(data) ? data : [])
                .slice()
                .sort((a, b) => dateValue(a) - dateValue(b));
            const sessionIds = sessions.map(session => session.id).filter(Boolean);
            if (sessionIds.length) {
                try {
                    const { data: logs, error: logsError } = await supabaseClient
                        .from('anomaly_logs')
                        .select('id, session_id, event_type, triggered_at, details, jaw_velocity, hands_on_neck')
                        .in('session_id', sessionIds)
                        .order('triggered_at', { ascending: true });
                    if (!isCurrentRequest()) return false;
                    if (logsError) throw logsError;
                    eventLogs = Array.isArray(logs) ? logs : [];
                } catch (error) {
                    if (!isCurrentRequest()) return false;
                    eventLogsAvailable = false;
                    loadError = error;
                    console.error('[Caregiver] Could not load meal event details:', error);
                }
            }
            sessionData = window.ConnectionCore.summarizeMealEventsBySession(
                sessions, eventLogs, eventLogsAvailable
            );
        }
    } catch (error) {
        if (!isCurrentRequest()) return false;
        loadError = error;
        sessionLoadFailed = true;
        console.error('[Caregiver] Could not load session history:', error);
        sessionData = [];
    }
    if (!isCurrentRequest()) return false;
    updateCharts(sessionData);
    renderMealHistory(sessionData, normalizedRange);
    setMealHistoryStatus(sessionLoadFailed
        ? '用餐紀錄載入失敗，請稍後重試。'
        : (loadError ? `已載入 ${sessionData.length} 餐；部分事件紀錄無法讀取。` : `顯示 ${sessionData.length} 餐。`));
    return true;
}

function setMealHistoryStatus(text) {
    const status = document.getElementById('meal-history-status');
    if (status) status.textContent = text;
}

function renderMealHistory(sessions, range = currentHistoryRange) {
    const container = document.getElementById('meal-history-list');
    if (!container) return;
    container.replaceChildren();
    if (!sessions.length) {
        const empty = document.createElement('p');
        empty.className = 'text-center py-6 text-xs text-slate-500 italic';
        empty.textContent = '目前沒有符合範圍的用餐紀錄';
        container.appendChild(empty);
        return;
    }

    const eventLabels = {
        COUGH: '一般咳嗽', L1: 'L1 含飯提醒', L2: 'L2 警報', L3: 'L3 警報',
        L4: 'L4 緊急警報', L3_VISIBILITY: '疑似哽噎／畫面遮蔽（未確認）',
        VISIBILITY_LOSS: '失臉／畫面遮蔽（未確認）'
    };
    const riskLabels = { NORMAL: '正常', ATTENTION: '需注意', HIGH_RISK: '高風險' };
    const showSeconds = value => value === null || value === undefined || !Number.isFinite(Number(value))
        ? '—' : `${Number(value).toFixed(2)} 秒`;

    for (const session of sessions.slice().reverse()) {
        const details = document.createElement('details');
        details.className = 'bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs';
        const summary = document.createElement('summary');
        summary.className = 'cursor-pointer text-slate-200 leading-relaxed';
        const startDate = new Date(session.start_time || session.created_at);
        const dateLabel = Number.isFinite(startDate.getTime())
            ? startDate.toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
            : '時間未記錄';
        const dietName = (CONFIG.DIET_PROFILES[session.diet_type] || {}).name || session.diet_type || '未記錄餐食';
        const durationValue = session.total_duration_sec;
        const duration = durationValue === null || durationValue === undefined || !Number.isFinite(Number(durationValue))
            ? '時長未記錄' : `${Math.round(Number(durationValue) / 60)} 分鐘`;
        const chewValue = session.total_chew_count;
        const chews = chewValue === null || chewValue === undefined || !Number.isFinite(Number(chewValue))
            ? '咀嚼數未記錄' : `咀嚼 ${Number(chewValue).toFixed(1)} 次`;
        const swallowValue = session.total_swallow_count;
        const swallows = swallowValue === null || swallowValue === undefined || !Number.isFinite(Number(swallowValue))
            ? '吞嚥數未記錄' : `吞嚥 ${Number(swallowValue)} 次`;
        summary.textContent = `${dateLabel}｜${dietName}｜${duration}｜${chews}｜${swallows}｜平均咀嚼 ${showSeconds(session.avg_chew_duration)}｜${riskLabels[session.risk_level] || session.risk_level || '風險未記錄'}`;
        details.appendChild(summary);

        const body = document.createElement('div');
        body.className = 'mt-3 space-y-2 text-slate-300';
        const countLine = document.createElement('p');
        if (session.alertBreakdownAvailable && session.eventCounts) {
            const counts = session.eventCounts;
            countLine.textContent = `一般咳嗽 ${counts.cough}｜L1 ${counts.l1}｜L2 未啟用｜L3 ${counts.l3}｜L4 ${counts.l4}｜畫面遮蔽 ${counts.visibility}`;
        } else if (Number(session.event_schema_version || 1) < 2) {
            countLine.textContent = '舊資料：警報分級無法拆分';
        } else {
            countLine.textContent = '事件紀錄暫不可用，分級統計無法顯示';
        }
        body.appendChild(countLine);

        if (session.events && session.events.length) {
            const eventList = document.createElement('ul');
            eventList.className = 'space-y-1 border-t border-slate-800 pt-2';
            for (const event of session.events) {
                const item = document.createElement('li');
                const time = new Date(event.triggered_at);
                const timeLabel = Number.isFinite(time.getTime())
                    ? time.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                    : '時間未記錄';
                const label = eventLabels[String(event.event_type || '').toUpperCase()] || String(event.event_type || '未分類事件');
                item.textContent = `${timeLabel}｜${label}${event.details ? `：${event.details}` : ''}`;
                eventList.appendChild(item);
            }
            body.appendChild(eventList);
        } else if (session.alertBreakdownAvailable) {
            const noEvents = document.createElement('p');
            noEvents.className = 'text-slate-500';
            noEvents.textContent = '本餐沒有已記錄的咳嗽或警報事件';
            body.appendChild(noEvents);
        }
        details.appendChild(body);
        container.appendChild(details);
    }
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
                { label: '一般咳嗽', data: [], backgroundColor: 'rgba(251, 191, 36, 0.75)' },
                { label: 'L1 提醒', data: [], backgroundColor: 'rgba(96, 165, 250, 0.75)' },
                { label: 'L2 未啟用', data: [], backgroundColor: 'rgba(148, 163, 184, 0.55)' },
                { label: 'L3', data: [], backgroundColor: 'rgba(167, 139, 250, 0.75)' },
                { label: 'L4 緊急警報', data: [], backgroundColor: 'rgba(244, 63, 94, 0.75)' },
                { label: '畫面遮蔽', data: [], backgroundColor: 'rgba(34, 211, 238, 0.75)' }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { display: false } },
                y: { beginAtZero: true, ticks: { color: '#94a3b8', font: { size: 10 }, precision: 0 }, grid: { color: '#334155' } }
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
                { label: '個案咀嚼基準', data: [], borderColor: '#60a5fa', borderDash: [4, 4], pointRadius: 0 }
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

    updateCharts([]);
}

function updateCharts(sessions = []) {
    if (!anomaliesChart || !chewTrendChart) return;
    const labels = sessions.map(session => {
        const date = new Date(session.start_time || session.created_at);
        return Number.isFinite(date.getTime())
            ? date.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' })
            : '餐次';
    });
    const countFor = (session, key) => session.alertBreakdownAvailable && session.eventCounts
        ? session.eventCounts[key] : null;
    const valueFor = (session, key) => {
        const value = session[key];
        return value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
            ? null : Number(value);
    };

    const eventSeries = [
        sessions.map(session => countFor(session, 'cough')),
        sessions.map(session => countFor(session, 'l1')),
        sessions.map(session => session.alertBreakdownAvailable ? 0 : null),
        sessions.map(session => countFor(session, 'l3')),
        sessions.map(session => countFor(session, 'l4')),
        sessions.map(session => countFor(session, 'visibility'))
    ];
    anomaliesChart.data.labels = labels;
    eventSeries.forEach((values, index) => { anomaliesChart.data.datasets[index].data = values; });
    anomaliesChart.update();

    chewTrendChart.data.labels = labels;
    chewTrendChart.data.datasets[0].data = sessions.map(session => valueFor(session, 'avg_chew_duration'));
    chewTrendChart.data.datasets[1].data = new Array(labels.length).fill(currentPatientBaselines.chew);
    chewTrendChart.update();
}

// 5. WebRTC P2P 影音接收與 Supabase Realtime 信令
async function setupWebRTCSignaling(profileId = currentPatientProfileId, generation = caregiverSessionGeneration) {
    if (!supabaseClient || !profileId || !window.ConnectionCore
        || generation !== caregiverSessionGeneration) return;
    try {
        if (supabaseChannel) await supabaseChannel.unsubscribe();
        activeNegotiationId = null;
        currentAnswerPayload = null;
        remoteCandidateBuffer.clear();
        setRealtimeStatus(`正在連線 ${currentPatientCode}…`, false);
        const channel = supabaseClient.channel(
            window.ConnectionCore.channelTopic(profileId),
            window.ConnectionCore.privateChannelOptions()
        );
        supabaseChannel = channel;
        channel
            .on('broadcast', { event: 'signal' }, async ({ payload }) => {
                if (channel !== supabaseChannel || generation !== caregiverSessionGeneration) return;
                if (payload.type === 'patient_ready' && payload.profileId === currentPatientProfileId) {
                    requestOffer(channel, true, generation);
                } else if (payload.type === 'offer' && payload.negotiationId && payload.clientId === caregiverClientId) {
                    await handleOfferAndAnswer(payload.sdp, payload.negotiationId, payload.clientId, channel, generation);
                } else if (payload.type === 'candidate') {
                    await receiveRemoteCandidate(payload);
                }
            })
            .on('broadcast', { event: 'state_update' }, ({ payload }) => {
                if (channel === supabaseChannel && generation === caregiverSessionGeneration
                    && payload.patientCode === currentPatientCode) handleStateUpdate(payload);
            })
            .subscribe((status) => {
                if (channel !== supabaseChannel || generation !== caregiverSessionGeneration) return;
                if (status === 'SUBSCRIBED') {
                    setRealtimeStatus(`已連線 ${currentPatientCode}，等待使用者端…`, true);
                    requestOffer(channel, false, generation);
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                    setRealtimeStatus(`連線失敗：${status}`, false);
                }
            });
    } catch (error) {
        if (generation !== caregiverSessionGeneration) return;
        setRealtimeStatus('Realtime 頻道建立失敗', false);
        console.error('[WebRTC Signalling] Caregiver channel error:', error);
    }
}

function requestOffer(channel, force = false, generation = caregiverSessionGeneration) {
    if (channel !== supabaseChannel || !currentPatientProfileId
        || generation !== caregiverSessionGeneration) return;
    const now = Date.now();
    if (!force && now - lastOfferRequestAt < 500) return;
    lastOfferRequestAt = now;
    channel.send({
        type: 'broadcast',
        event: 'signal',
        payload: { type: 'request_offer', profileId: currentPatientProfileId, clientId: caregiverClientId }
    }).then(result => {
        if (result !== 'ok') console.warn('[WebRTC] Offer request status:', result);
    });
}

async function receiveRemoteCandidate(payload) {
    if (!payload?.candidate || !payload.negotiationId || payload.clientId !== caregiverClientId) return;
    if (activeNegotiationId && payload.negotiationId === activeNegotiationId && peerConnection?.remoteDescription) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch (error) {
            console.warn('[WebRTC] Candidate was not accepted:', error);
        }
        return;
    }
    remoteCandidateBuffer.enqueue(payload);
}

async function flushRemoteCandidates(connection, negotiationId, clientId) {
    const pending = window.ConnectionCore.takeMatchingCandidates(remoteCandidateBuffer, negotiationId, clientId);
    for (const payload of pending) {
        if (!payload.candidate) continue;
        try {
            await connection.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch (error) {
            console.warn('[WebRTC] Buffered candidate was not accepted:', error);
        }
    }
}

async function sendActiveAnswer(channel = supabaseChannel, generation = caregiverSessionGeneration) {
    if (!channel || channel !== supabaseChannel || generation !== caregiverSessionGeneration || !currentAnswerPayload) return;
    const answerPayload = currentAnswerPayload;
    const result = await channel.send({
        type: 'broadcast',
        event: 'signal',
        payload: answerPayload
    });
    if (channel !== supabaseChannel || generation !== caregiverSessionGeneration) return;
    if (result !== 'ok') console.warn('[WebRTC] Answer send status:', result);
}

async function handleOfferAndAnswer(offerSdp, negotiationId, clientId, channel, generation) {
    if (!negotiationId || !clientId || clientId !== caregiverClientId
        || channel !== supabaseChannel || generation !== caregiverSessionGeneration) return;
    if (activeNegotiationId === negotiationId && currentAnswerPayload) {
        await sendActiveAnswer(channel, generation);
        return;
    }
    return negotiationGate.run(`${clientId}:${negotiationId}`, async () => {
        if (channel !== supabaseChannel || generation !== caregiverSessionGeneration) return;
        if (activeNegotiationId === negotiationId && currentAnswerPayload) {
            await sendActiveAnswer(channel, generation);
            return;
        }
        await processOfferAndAnswer(offerSdp, negotiationId, clientId, channel, generation);
    });
}

async function processOfferAndAnswer(offerSdp, negotiationId, clientId, channel, generation) {
    if (channel !== supabaseChannel || generation !== caregiverSessionGeneration) return;
    const pending = remoteCandidateBuffer.drain();
    pending.filter(payload => payload.negotiationId === negotiationId && payload.clientId === clientId)
        .forEach(payload => remoteCandidateBuffer.enqueue(payload));
    let activeConnection = null;
    try {
        if (peerConnection) peerConnection.close();
        activeNegotiationId = negotiationId;
        currentAnswerPayload = null;
        activeConnection = new RTCPeerConnection(CONFIG.RTC_CONFIG);
        peerConnection = activeConnection;
        activeConnection.ontrack = (event) => {
            if (peerConnection !== activeConnection || generation !== caregiverSessionGeneration) return;
            const remoteVideo = document.getElementById('remote-video');
            if (remoteVideo && event.streams && event.streams[0]) {
                remoteVideo.srcObject = event.streams[0];
                document.getElementById('no-stream-placeholder').classList.add('hidden');
                console.log('[WebRTC P2P] Video stream attached successfully!');
            }
        };
        activeConnection.onconnectionstatechange = () => {
            if (peerConnection !== activeConnection || generation !== caregiverSessionGeneration) return;
            const state = activeConnection.connectionState;
            if (state === 'connected') setRealtimeStatus(`視訊已連線 ${currentPatientCode}`, true);
            else if (state === 'failed' || state === 'disconnected') setRealtimeStatus(`視訊${state === 'failed' ? '連線失敗' : '中斷'}`, false);
        };
        activeConnection.onicecandidate = async (event) => {
            if (event.candidate && peerConnection === activeConnection
                && channel === supabaseChannel && generation === caregiverSessionGeneration) {
                await channel.send({
                    type: 'broadcast',
                    event: 'signal',
                    payload: { type: 'candidate', candidate: event.candidate, negotiationId, clientId }
                });
            }
        };
        await activeConnection.setRemoteDescription(new RTCSessionDescription(offerSdp));
        if (peerConnection !== activeConnection || channel !== supabaseChannel
            || generation !== caregiverSessionGeneration) return;
        await flushRemoteCandidates(activeConnection, negotiationId, clientId);
        if (peerConnection !== activeConnection || channel !== supabaseChannel
            || generation !== caregiverSessionGeneration) return;
        const answer = await activeConnection.createAnswer();
        if (peerConnection !== activeConnection || channel !== supabaseChannel
            || generation !== caregiverSessionGeneration) return;
        await activeConnection.setLocalDescription(answer);
        if (peerConnection !== activeConnection || channel !== supabaseChannel
            || generation !== caregiverSessionGeneration) return;
        currentAnswerPayload = { type: 'answer', sdp: answer, negotiationId, clientId };
        await sendActiveAnswer(channel, generation);
    } catch (error) {
        if (activeConnection && (peerConnection !== activeConnection
            || channel !== supabaseChannel || generation !== caregiverSessionGeneration)) return;
        console.error('[WebRTC Answer Error]:', error);
        setRealtimeStatus('視訊協商失敗', false);
    }
}

// 6. 即時狀態數據與警報跳窗更新
function handleStateUpdate(state) {
    const statChews = document.getElementById('stat-chews');
    if (statChews) statChews.innerText = state.totalChews || 0;
    const statSwallows = document.getElementById('stat-swallows');
    if (statSwallows) statSwallows.innerText = state.totalSwallows || 0;
    const statJawVel = document.getElementById('stat-jaw-vel');
    if (statJawVel) statJawVel.innerText = state.jawVelocity ? state.jawVelocity.toFixed(2) : '0.00';
    const statPouching = document.getElementById('stat-pouching');
    if (statPouching) statPouching.innerText = state.pouchingEvents || 0;
    const statCoughs = document.getElementById('stat-coughs');
    if (statCoughs) statCoughs.innerText = state.coughEvents || 0;

    const dietInfo = CONFIG.DIET_PROFILES[state.dietType];
    if (dietInfo) {
        document.getElementById('caregiver-diet-type').innerText = dietInfo.name;
    }

    if (state.activeAlertLevel) {
        const alertMessage = state.activeAlertMessage || `${state.patientName} 觸發 ${state.activeAlertLevel} 警報！`;
        showCaregiverAlert(state.activeAlertLevel, alertMessage);
        if (state.activeAlertLevel !== lastLoggedAlertLevel || alertMessage !== lastLoggedAlertMessage) {
            addRealtimeLog(state.activeAlertLevel, alertMessage);
            lastLoggedAlertLevel = state.activeAlertLevel;
            lastLoggedAlertMessage = alertMessage;
        }
    } else {
        hideCaregiverAlert();
        lastLoggedAlertLevel = null;
        lastLoggedAlertMessage = null;
    }
    if (state.sessionEnded) {
        const remoteVideo = document.getElementById('remote-video');
        if (remoteVideo) {
            remoteVideo.pause();
            remoteVideo.srcObject = null;
        }
        document.getElementById('no-stream-placeholder').classList.remove('hidden');
        setRealtimeStatus(`用餐結束：${currentPatientCode}`, true);
    }
}

function showCaregiverAlert(level, message = null) {
    const banner = document.getElementById('caregiver-alert-banner');
    const text = document.getElementById('caregiver-alert-text');
    text.innerText = message || `觸發 ${level} 嚴重警報！請立即關注個案`;
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
    if (!container) return;
    if (emptyMsg) emptyMsg.remove();

    const nowStr = new Date().toTimeString().split(' ')[0];
    const logItem = document.createElement('div');
    logItem.className = 'bg-slate-800/80 p-3 rounded-2xl border border-slate-700/60 flex items-center justify-between text-xs animate-fade-in';

    const left = document.createElement('div');
    left.className = 'flex items-center space-x-2';
    const timeLabel = document.createElement('span');
    timeLabel.className = 'font-mono text-slate-500';
    timeLabel.textContent = nowStr;
    const messageSpan = document.createElement('span');
    messageSpan.className = level === 'L4' ? 'text-rose-400 font-bold' : (level === 'L2' ? 'text-amber-400 font-bold' : 'text-blue-400');
    messageSpan.textContent = msg;
    left.append(timeLabel, messageSpan);

    const badge = document.createElement('span');
    badge.className = 'text-[10px] bg-slate-900 px-2 py-0.5 rounded text-slate-400 border border-slate-700';
    badge.textContent = level;
    logItem.append(left, badge);
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
