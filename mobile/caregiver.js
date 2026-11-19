/**
 * 🛡️ 防哽咽即時監測系統 - 遠端照護者 Dashboard 核心引擎 (caregiver.js)
 * 核心功能：WebRTC P2P 視訊接收 + Supabase Realtime 訂閱 + 個人化動態校正檢視 + Chart.js 趨勢分析
 */

let supabaseClient = null;
let currentPatientCode = null;
let currentPatientProfileId = null;
let caregiverClientId = null;
let peerConnection = null;
let supabaseChannel = null;
let lastOfferRequestAt = 0;
let lastLoggedAlertLevel = null;
let activeNegotiationId = null;
let currentAnswerPayload = null;
const remoteCandidateBuffer = window.ConnectionCore.createCandidateBuffer();
const negotiationGate = window.ConnectionCore.createNegotiationGate();
let audioMuted = false;
let audioCtx = null;
let buzzerInterval = null;
let activeCaregiverAlertLevel = null;
let pendingCaregiverAlertLevel = null;
let caregiverAlertAcknowledged = false;

// Chart.js 實例變數
let anomaliesChart = null;
let chewTrendChart = null;

document.addEventListener('DOMContentLoaded', async () => {
    document.addEventListener('click', unlockAlertAudio, { once: true, capture: true });
    initSupabase();
    if (!supabaseClient) {
        setRealtimeStatus('連線服務尚未設定', false);
        window.AuthUI.showSetupError('系統連線設定尚未完成。請聯絡管理者，不會顯示示範資料或未授權資料。');
        return;
    }
    try {
        await window.AuthUI.requireAuth(supabaseClient, '照護者端');
        initCharts();
        const codeInput = document.getElementById('caregiver-patient-code');
        document.getElementById('btn-refresh-anomaly-history')?.addEventListener('click', () => {
            if (currentPatientProfileId) {
                void fetchHistoricalSessions(currentPatientCode, currentPatientProfileId);
            } else {
                const status = document.getElementById('caregiver-anomaly-history-status');
                if (status) status.textContent = '請先連線個案，再重新載入已儲存異常紀錄。';
            }
        });
        const initialCode = new URLSearchParams(location.search).get('patient') || (codeInput && codeInput.value) || 'P001';
        if (codeInput) codeInput.value = initialCode;
        document.getElementById('btn-connect-patient')?.addEventListener('click', () => connectToPatient());
        await connectToPatient(initialCode, { quiet: true });
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

function resetPatientEventHistory() {
    const container = document.getElementById('realtime-log-container');
    const historyList = document.getElementById('caregiver-anomaly-history-list');
    const status = document.getElementById('caregiver-anomaly-history-status');
    if (historyList) historyList.replaceChildren();
    if (container && historyList) {
        const empty = document.createElement('div');
        empty.id = 'empty-log-msg';
        empty.className = 'text-center py-8 text-xs text-slate-500 italic';
        empty.textContent = '正在載入所選個案的異常紀錄…';
        container.replaceChildren(empty, historyList);
    }
    if (status) status.textContent = '正在載入所選個案的已儲存事件…';
    lastLoggedAlertLevel = null;
}

async function connectToPatient(code = document.getElementById('caregiver-patient-code')?.value, options = {}) {
    const normalizedCode = String(code || '').trim();
    const button = document.getElementById('btn-connect-patient');
    try {
        if (!supabaseClient || !window.ConnectionCore) throw new Error('連線設定未完成。');
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(normalizedCode)) throw new Error('個案代碼格式錯誤。');
        if (supabaseChannel) {
            await supabaseChannel.unsubscribe();
            supabaseChannel = null;
        }
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        currentPatientCode = null;
        currentPatientProfileId = null;
        resetPatientEventHistory();
        caregiverClientId = null;
        activeNegotiationId = null;
        currentAnswerPayload = null;
        remoteCandidateBuffer.clear();
        if (button) button.disabled = true;
        setRealtimeStatus('查詢個案資料…', false);
        const { data: profile, error } = await supabaseClient
            .from('patient_profiles')
            .select('*')
            .eq('patient_code', normalizedCode)
            .maybeSingle();
        if (error) throw error;
        if (!profile) {
            setRealtimeStatus('尚無此個案資料', false);
            if (!options.quiet) alert('找不到此個案。請先在使用者端以相同帳號選擇個案並開始用餐，再回來連線。');
            return false;
        }
        currentPatientCode = profile.patient_code;
        currentPatientProfileId = profile.id;
        caregiverClientId = crypto.randomUUID();
        lastOfferRequestAt = 0;
        document.getElementById('caregiver-patient-name').innerText = `${profile.full_name} (${profile.patient_code})`;
        document.getElementById('caregiver-diet-type').innerText = (CONFIG.DIET_PROFILES[profile.diet_type] || {}).name || profile.diet_type;
        document.getElementById('base-chew-sec').innerText = `${Number(profile.baseline_chew_duration || 0.85).toFixed(2)} 秒`;
        document.getElementById('base-swallow-sec').innerText = `${Number(profile.baseline_swallow_pause || 1.10).toFixed(2)} 秒`;
        if (button) button.innerText = `已選 ${profile.patient_code}`;
        await fetchHistoricalSessions(normalizedCode, profile.id);
        await setupWebRTCSignaling(profile.id);
        return true;
    } catch (error) {
        console.error('[Caregiver] Patient connection failed:', error);
        setRealtimeStatus('連線失敗，請重試', false);
        if (!options.quiet) alert('個案連線失敗。請確認個案代碼與兩端登入帳號相同。');
        return false;
    } finally {
        if (button) button.disabled = false;
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
async function fetchHistoricalSessions(code, patientId = null) {
    let sessionData = [];
    let anomalyLogs = [];
    let anomalyError = null;
    try {
        if (!patientId) {
            const { data: profile, error: profileError } = await supabaseClient
                .from('patient_profiles').select('id').eq('patient_code', code).maybeSingle();
            if (profileError) throw profileError;
            patientId = profile?.id;
        }
        if (patientId) {
            const { data, error } = await supabaseClient
                .from('meal_sessions')
                .select('*')
                .eq('patient_id', patientId)
                .order('created_at', { ascending: false })
                .limit(7);
            if (error) throw error;
            sessionData = window.ConnectionCore.latestSessionsChronological(data || [], 7);
            const sessionIds = sessionData.map(session => session.id).filter(Boolean);
            if (sessionIds.length) {
                const { data: logs, error: logsError } = await supabaseClient
                    .from('anomaly_logs')
                    .select('id, session_id, event_type, triggered_at, details, jaw_velocity, hands_on_neck')
                    .in('session_id', sessionIds)
                    .order('triggered_at', { ascending: false })
                    .limit(100);
                if (logsError) throw logsError;
                anomalyLogs = Array.isArray(logs) ? logs : [];
            }
        }
    } catch (error) {
        anomalyError = error;
        console.error('[Caregiver] Could not load session/anomaly history:', error);
    }
    updateCharts(sessionData);
    renderStoredAnomalyLogs(anomalyLogs, anomalyError);
}

function renderStoredAnomalyLogs(logs, error = null) {
    const status = document.getElementById('caregiver-anomaly-history-status');
    const list = document.getElementById('caregiver-anomaly-history-list');
    if (!status || !list) return;
    if (error) {
        status.textContent = '已儲存紀錄載入失敗；即時警報仍會顯示，請重新載入或確認照護帳號權限。';
        return;
    }
    list.replaceChildren();
    const rows = Array.isArray(logs) ? logs : [];
    const emptyMessage = document.getElementById('empty-log-msg');
    if (rows.length && emptyMessage) emptyMessage.remove();
    status.textContent = rows.length
        ? `已載入近 7 餐的 ${rows.length} 筆已儲存事件，與即時警報顯示於同一清單。`
        : '近 7 餐目前沒有已儲存事件；即時警報仍會顯示於此清單。';
    const labels = { L1: '第一級提醒', L2: '第二級警報', L3: '第三級警報', L4: '第四級哽噎警報', COUGH: '咳嗽事件' };
    for (const row of rows) {
        const item = document.createElement('article');
        item.className = 'rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs space-y-1';
        const heading = document.createElement('div');
        heading.className = row.event_type === 'L4' ? 'font-bold text-rose-300' : 'font-semibold text-slate-200';
        heading.textContent = labels[row.event_type] || String(row.event_type || '異常事件');
        const timestamp = document.createElement('time');
        const parsedTime = Date.parse(row.triggered_at || '');
        timestamp.dateTime = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : '';
        timestamp.className = 'block text-slate-500';
        timestamp.textContent = Number.isFinite(parsedTime)
            ? new Date(parsedTime).toLocaleString('zh-TW')
            : '時間未記錄';
        item.appendChild(heading);
        item.appendChild(timestamp);
        if (row.details) {
            const details = document.createElement('p');
            details.className = 'text-slate-300 break-words';
            details.textContent = String(row.details);
            item.appendChild(details);
        }
        list.appendChild(item);
    }
}

// 4. Chart.js 圖表繪製與更新
function initCharts() {
    const palette = getComputedStyle(document.documentElement);
    const chartMuted = palette.getPropertyValue('--tea-muted').trim() || '#7b6657';
    const chartInk = palette.getPropertyValue('--tea-ink').trim() || '#554237';
    const chartGrid = palette.getPropertyValue('--tea-border').trim() || '#d9c5b0';
    const chartAccent = palette.getPropertyValue('--tea-accent').trim() || '#886246';
    const chartFontSize = 10 * (window.FontSizeUI?.getPercent?.() || 100) / 100;
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
                x: { ticks: { color: chartMuted, font: { size: chartFontSize } }, grid: { display: false } },
                y: { ticks: { color: chartMuted, font: { size: chartFontSize } }, grid: { color: chartGrid } }
            },
            plugins: { legend: { labels: { color: chartInk, font: { size: chartFontSize } } } }
        }
    });

    chewTrendChart = new Chart(ctxChew, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: '平均咀嚼耗時（秒）', data: [], borderColor: '#486b42', backgroundColor: 'rgba(72, 107, 66, 0.1)', fill: true, tension: 0.3 },
                { label: '對照基線（0.85 秒）', data: [0.85, 0.85, 0.85, 0.85, 0.85], borderColor: chartAccent, borderDash: [4, 4], pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { ticks: { color: chartMuted, font: { size: chartFontSize } }, grid: { display: false } },
                y: { ticks: { color: chartMuted, font: { size: chartFontSize } }, grid: { color: chartGrid } }
            },
            plugins: { legend: { labels: { color: chartInk, font: { size: chartFontSize } } } }
        }
    });
    if (!initCharts.fontPreferenceHandler) {
        initCharts.fontPreferenceHandler = event => {
            const percent = Number(event.detail?.percent) || window.FontSizeUI?.getPercent?.() || 100;
            const size = 10 * Math.max(.8, Math.min(2, percent / 100));
            for (const chart of [anomaliesChart, chewTrendChart]) {
                if (!chart) continue;
                chart.options.scales.x.ticks.font.size = size;
                chart.options.scales.y.ticks.font.size = size;
                chart.options.plugins.legend.labels.font.size = size;
                chart.update();
            }
        };
        window.addEventListener('ui-font-size-change', initCharts.fontPreferenceHandler);
    }

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
async function setupWebRTCSignaling(profileId = currentPatientProfileId) {
    if (!supabaseClient || !profileId || !window.ConnectionCore) return;
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
                if (payload.type === 'patient_ready' && payload.profileId === currentPatientProfileId) {
                    requestOffer(channel, true);
                } else if (payload.type === 'offer' && payload.negotiationId && payload.clientId === caregiverClientId) {
                    await handleOfferAndAnswer(payload.sdp, payload.negotiationId, payload.clientId);
                } else if (payload.type === 'candidate') {
                    await receiveRemoteCandidate(payload);
                }
            })
            .on('broadcast', { event: 'state_update' }, ({ payload }) => {
                if (payload.patientCode === currentPatientCode) handleStateUpdate(payload);
            })
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    setRealtimeStatus(`已連線 ${currentPatientCode}，等待使用者端…`, true);
                    requestOffer(channel);
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                    setRealtimeStatus({ CHANNEL_ERROR: '連線發生錯誤，請重試', TIMED_OUT: '連線逾時，請重試', CLOSED: '連線已關閉' }[status], false);
                }
            });
    } catch (error) {
        setRealtimeStatus('即時連線建立失敗', false);
        console.error('[WebRTC Signalling] Caregiver channel error:', error);
    }
}

function requestOffer(channel, force = false) {
    if (channel !== supabaseChannel || !currentPatientProfileId) return;
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

async function sendActiveAnswer() {
    if (!supabaseChannel || !currentAnswerPayload) return;
    const result = await supabaseChannel.send({
        type: 'broadcast',
        event: 'signal',
        payload: currentAnswerPayload
    });
    if (result !== 'ok') console.warn('[WebRTC] Answer send status:', result);
}

async function handleOfferAndAnswer(offerSdp, negotiationId, clientId) {
    if (!negotiationId || !clientId || clientId !== caregiverClientId) return;
    if (activeNegotiationId === negotiationId && currentAnswerPayload) {
        await sendActiveAnswer();
        return;
    }
    return negotiationGate.run(`${clientId}:${negotiationId}`, async () => {
        if (activeNegotiationId === negotiationId && currentAnswerPayload) {
            await sendActiveAnswer();
            return;
        }
        await processOfferAndAnswer(offerSdp, negotiationId, clientId);
    });
}

async function processOfferAndAnswer(offerSdp, negotiationId, clientId) {
    const pending = remoteCandidateBuffer.drain();
    pending.filter(payload => payload.negotiationId === negotiationId && payload.clientId === clientId)
        .forEach(payload => remoteCandidateBuffer.enqueue(payload));
    try {
        if (peerConnection) peerConnection.close();
        activeNegotiationId = negotiationId;
        currentAnswerPayload = null;
        peerConnection = new RTCPeerConnection(CONFIG.RTC_CONFIG);
        peerConnection.ontrack = (event) => {
            const remoteVideo = document.getElementById('remote-video');
            if (remoteVideo && event.streams && event.streams[0]) {
                remoteVideo.srcObject = event.streams[0];
                document.getElementById('no-stream-placeholder').classList.add('hidden');
                console.log('[WebRTC P2P] Video stream attached successfully!');
            }
        };
        peerConnection.onconnectionstatechange = () => {
            const state = peerConnection && peerConnection.connectionState;
            if (state === 'connected') setRealtimeStatus(`視訊已連線 ${currentPatientCode}`, true);
            else if (state === 'failed' || state === 'disconnected') setRealtimeStatus(`視訊${state === 'failed' ? '連線失敗' : '中斷'}`, false);
        };
        const activeConnection = peerConnection;
        activeConnection.onicecandidate = async (event) => {
            if (event.candidate && supabaseChannel) {
                await supabaseChannel.send({
                    type: 'broadcast',
                    event: 'signal',
                    payload: { type: 'candidate', candidate: event.candidate, negotiationId, clientId }
                });
            }
        };
        await activeConnection.setRemoteDescription(new RTCSessionDescription(offerSdp));
        await flushRemoteCandidates(activeConnection, negotiationId, clientId);
        const answer = await activeConnection.createAnswer();
        await activeConnection.setLocalDescription(answer);
        currentAnswerPayload = { type: 'answer', sdp: answer, negotiationId, clientId };
        await sendActiveAnswer();
    } catch (error) {
        console.error('[WebRTC Answer Error]:', error);
        setRealtimeStatus('視訊協商失敗', false);
    }
}

// 6. 即時狀態數據與警報跳窗更新
function alertLevelLabel(level) {
    return { L1: '第一級', L2: '第二級', L3: '第三級', L4: '第四級' }[level] || '照護提醒';
}

function handleStateUpdate(state) {
    document.getElementById('stat-coughs').innerText = state.coughEvents || 0;

    const dietInfo = CONFIG.DIET_PROFILES[state.dietType];
    if (dietInfo) {
        document.getElementById('caregiver-diet-type').innerText = dietInfo.name;
    }

    if (state.activeAlertLevel) {
        activeCaregiverAlertLevel = state.activeAlertLevel;
        if (state.activeAlertLevel === 'L3' || state.activeAlertLevel === 'L4') {
            if (pendingCaregiverAlertLevel !== state.activeAlertLevel) {
                pendingCaregiverAlertLevel = state.activeAlertLevel;
                caregiverAlertAcknowledged = false;
                showCaregiverEmergencyPopup(state.activeAlertLevel, state.patientName);
                playBuzzerSound();
            }
            showCaregiverAlert(pendingCaregiverAlertLevel);
        } else {
            if (pendingCaregiverAlertLevel && caregiverAlertAcknowledged) {
                pendingCaregiverAlertLevel = null;
                caregiverAlertAcknowledged = false;
                hideCaregiverEmergencyPopup();
            }
            showCaregiverAlert(pendingCaregiverAlertLevel && !caregiverAlertAcknowledged
                ? pendingCaregiverAlertLevel
                : state.activeAlertLevel);
            if (!pendingCaregiverAlertLevel || caregiverAlertAcknowledged) playBuzzerSound();
        }
        if (state.activeAlertLevel !== lastLoggedAlertLevel) {
            addRealtimeLog(state.activeAlertLevel, `${state.patientName} 觸發${alertLevelLabel(state.activeAlertLevel)}警報！`);
            lastLoggedAlertLevel = state.activeAlertLevel;
        }
    } else {
        activeCaregiverAlertLevel = null;
        if (pendingCaregiverAlertLevel && !caregiverAlertAcknowledged) {
            showCaregiverAlert(pendingCaregiverAlertLevel);
            playBuzzerSound();
            lastLoggedAlertLevel = pendingCaregiverAlertLevel;
        } else {
            hideCaregiverAlert();
            hideCaregiverEmergencyPopup();
            pendingCaregiverAlertLevel = null;
            caregiverAlertAcknowledged = false;
            lastLoggedAlertLevel = null;
        }
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

function showCaregiverAlert(level) {
    const banner = document.getElementById('caregiver-alert-banner');
    const text = document.getElementById('caregiver-alert-text');
    text.innerText = `觸發${alertLevelLabel(level)}嚴重警報！請立即查看個案狀況`;
    banner.classList.remove('hidden');
}

function hideCaregiverAlert() {
    document.getElementById('caregiver-alert-banner').classList.add('hidden');
    stopBuzzerSound();
}

function showCaregiverEmergencyPopup(level, patientName) {
    const popup = document.getElementById('caregiver-emergency-popup');
    const title = document.getElementById('caregiver-emergency-title');
    const description = document.getElementById('caregiver-emergency-text');
    if (!popup || !title || !description) return;

    title.innerText = level === 'L4'
        ? '🚨 第四級急性哽噎緊急警報'
        : '⚠️ 第三級視覺遮蔽警示';
    description.innerText = `${patientName || '個案'}觸發${alertLevelLabel(level)}警報，請立即查看並確認狀況。`;
    popup.classList.remove('hidden');
    document.getElementById('caregiver-alert-ack')?.focus?.();
}

function hideCaregiverEmergencyPopup() {
    document.getElementById('caregiver-emergency-popup')?.classList.add('hidden');
}

function acknowledgeCaregiverAlert() {
    if (!pendingCaregiverAlertLevel || caregiverAlertAcknowledged) return;
    caregiverAlertAcknowledged = true;
    hideCaregiverEmergencyPopup();
    if (!activeCaregiverAlertLevel) {
        hideCaregiverAlert();
        pendingCaregiverAlertLevel = null;
        caregiverAlertAcknowledged = false;
        lastLoggedAlertLevel = null;
    } else if (activeCaregiverAlertLevel !== 'L3' && activeCaregiverAlertLevel !== 'L4') {
        stopBuzzerSound();
        pendingCaregiverAlertLevel = null;
        caregiverAlertAcknowledged = false;
        showCaregiverAlert(activeCaregiverAlertLevel);
    } else {
        stopBuzzerSound();
    }
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
    badge.textContent = alertLevelLabel(level);
    logItem.append(left, badge);
    container.insertBefore(logItem, container.firstChild);
}

// 7. 音效廣播與切換
function toggleAudioMute() {
    audioMuted = !audioMuted;
    document.getElementById('sound-icon').innerText = audioMuted ? '🔇' : '🔊';
    document.getElementById('sound-text').innerText = audioMuted ? '警報音效: 靜音' : '警報音效: 開啟';
    if (audioMuted) stopBuzzerSound();
    else if ((pendingCaregiverAlertLevel && !caregiverAlertAcknowledged) ||
        (activeCaregiverAlertLevel && activeCaregiverAlertLevel !== 'L3' && activeCaregiverAlertLevel !== 'L4')) {
        playBuzzerSound();
    }
}

function unlockAlertAudio() {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume()?.catch?.(() => {});
    } catch (e) {}
}

function playBuzzerSound() {
    if (audioMuted || buzzerInterval) return;
    try {
        unlockAlertAudio();
        if (!audioCtx) return;
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
