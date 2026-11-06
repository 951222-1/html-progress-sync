// =============================================================================
// 獨立核心偵測演算法模組 (Classes & Helper Functions)
// =============================================================================
class SilentChokeDetector {
    constructor(holdSec = 3.0) {
        this.hold = holdSec;
        this.since = null;
    }

    update(mar, movementStd, audioEnergy, mouthOpenTh = 0.3, stillTh = 0.05, quietTh = 0.1) {
        const cond = (mar > mouthOpenTh && movementStd < stillTh && audioEnergy < quietTh);
        const now = performance.now() / 1000.0;
        if (cond) {
            if (this.since === null) {
                this.since = now;
            } else if (now - this.since >= this.hold) {
                this.since = null;
                return true;
            }
        } else {
            this.since = null;
        }
        return false;
    }
}

class EvidenceFusion {
    constructor(windowSec = 5.0, threshold = 1.0, cooldownSec = 10.0) {
        this.window = windowSec;
        this.threshold = threshold;
        this.cooldown = cooldownSec;
        this.sources = {};
        this.lastFire = -1e9;
    }

    observe(source, weight) {
        if (weight > 0) {
            this.sources[source] = { time: performance.now() / 1000.0, weight: weight };
        }
    }

    score() {
        const now = performance.now() / 1000.0;
        let sum = 0.0;
        const validSources = {};
        for (const [src, data] of Object.entries(this.sources)) {
            if (now - data.time <= this.window) {
                validSources[src] = data;
                sum += data.weight;
            }
        }
        this.sources = validSources;
        return sum;
    }

    check() {
        const now = performance.now() / 1000.0;
        if (this.score() >= this.threshold && (now - this.lastFire >= this.cooldown)) {
            this.lastFire = now;
            return true;
        }
        return false;
    }
}

// 1. 全域變數與狀態
let supabaseClient = null;
let currentAuthUser = null;
let cloudPatientProfiles = [];
let isKioskLocked = false;
let currentPatient = { id: null, patient_code: '', full_name: '', diet_type: 'soft', baseline_chew: 0.85, baseline_swallow: 1.10 };
let currentDiet = 'soft'; // regular, soft, pureed
let isMealActive = false;

if (window.ConnectionCore && typeof window.ConnectionCore.purgeLegacySharedPatientKeys === 'function') {
    window.ConnectionCore.purgeLegacySharedPatientKeys(window.localStorage);
    window.ConnectionCore.purgeLegacySharedPatientKeys(window.sessionStorage);
}
const mealSessionTracker = window.ConnectionCore.createMealSessionTracker();
const mealStartLock = window.ConnectionCore.createStartLock();
let currentMealSessionInsertPromise = Promise.resolve(null);

// 原版防哽咽狀態機常數與狀態 (ST_IDLE, ST_INGEST, ST_CHEW, ST_SWALLOW, ST_CHECK)
const ST_IDLE = "IDLE";
const ST_INGEST = "INGEST";
const ST_CHEW = "CHEW";
const ST_SWALLOW = "SWALLOW";
const ST_CHECK = "CHECK";

let currentState = ST_IDLE;
let stateStartTime = performance.now() / 1000.0;

let prevJawY = null;
let jawMovementHistory = []; // max len 30
let marSmooth = null;
let jawSmooth = null;

let lastCoughTime = -Infinity;
let handOnNeckStartTime = null;
let handOnNeckDuration = 0.0;
let lastChokeAlertTime = 0.0;

let prevNose = null;
let noseSpeedHistory = []; // max len 30
let lastChewFlipTime = 0.0;
let coughFrameCounter = 0;
let faceLostSince = null;
let faceLossVisibilityLogged = false;

let lastNose = null;
let lastChin = null;
let lastAnchorTs = 0.0;
const ANCHOR_GRACE_SEC = 2.0;
const FACE_LOST_ALERT_SEC = 3.0;
const CHOKE_FACE_LOSS_WARNING_GRACE_SEC = 0.6;
const chokeFaceLossWarningGuard = window.ConnectionCore.createFaceLossWarningGuard(CHOKE_FACE_LOSS_WARNING_GRACE_SEC);
let lastChokeVisibilityWarningAt = -Infinity;

// 🎯 L4 急性哽噎判定狀態 (3.0s 門檻 + 0.6s 緩衝 + 0.5x/s 漏桶漸進衰減 + 三路徑高特異性觸發)
let bodyMotionHistory = []; // { x, y, faceSize, time }
let isBodyShakingContinuous = false;
let isHandOnChest = false;
let isHandOnChestOrThroat = false;
let handsInDangerZoneCount = 0;
let chokeSimultaneousStartTime = null;
let chokeSimultaneousDuration = 0.0;
let chokeGraceStartTime = null;
const CHOKE_SIMULTANEOUS_TRIGGER_SEC = 3.0; // 縮短為 3.0 秒門檻（雙手/嗆咳後抓喉為 2.5 秒）
const CHOKE_POST_COUGH_WINDOW_SEC = 8.0;
const chokeDangerAccumulator = window.ConnectionCore.createChokeDangerAccumulator({
    triggerSec: CHOKE_SIMULTANEOUS_TRIGGER_SEC,
    graceSec: 0.6,
    decayRate: 0.5
});

// 🎤 Google YAMNet AI 咳嗽與呼吸道聲紋辨識設定 (對齊桌面版防哽咽裝置4_2.py)
const YAMNET_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite";
const YAMNET_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@0.10.0/wasm";
const YAMNET_HOP_MS = 500;
const YAMNET_CHOKE_TH_FUSION = 0.15;
const YAMNET_COUGH_RECORD_TH = 0.20;
const YAMNET_COUGH_SOLO_TH = 0.32;
const YAMNET_CHOKE_KEYWORDS = ["cough", "throat", "choking", "gagging", "gasp", "wheeze", "pant"];
const YAMNET_SPEECH_KEYWORDS = ["speech", "conversation", "narration", "chatter", "hubbub"];
const YAMNET_LABEL_ZH = {
    "cough": "咳嗽聲",
    "throat clearing": "清喉嚨/乾咳",
    "throat": "喉部嗆咳聲",
    "choking": "哽噎嗆咳聲",
    "gagging": "作嘔反胃聲",
    "gasp": "倒抽氣/喘息",
    "wheeze": "氣道喘鳴聲",
    "pant": "急促喘氣聲"
};

// AI 與媒體串流變數
let webcamVideo = null;
let aiCanvas = null;
let aiCtx = null;
let webcamStream = null;
let faceLandmarker = null;
let handLandmarker = null;
let audioCtx = null;
let audioAnalyser = null;
let audioDataArray = null;
let audioClassifier = null;
let isAudioClassifierReady = false;
let audioClassifierFailed = false;
let audioMediaSource = null;
let audioScriptNode = null;
let audioMuteGain = null;
let audioRingBuffer = null;
let audioSamplesCollected = 0;
let audioInferenceTimer = null;
let lastAiCoughTime = -Infinity;
let aiAudioState = {
    chokeScore: 0.0,
    rawCoughScore: 0.0,
    speechScore: 0.0,
    topChokeLabel: "",
    topChokeLabelZh: "咳嗽聲",
    topOverallLabel: "-",
    rmsEnergy: 0.0,
    lastPeakScore: 0.0,
    updatedAt: 0.0
};

// 用餐狀態統計與演算法數據
let mealMetrics = {
    startTime: null,
    totalChews: 0,
    chewStartTime: null,
    chewDurations: [],
    lastJawY: null,
    jawVelocity: 0.0,
    jawStillTime: 0.0,
    currentBiteChews: 0,
    swallowCount: 0,
    coughCountL1: 0,
    coughCountL2: 0,
    chokingEventsL3: 0,
    pouchingEvents: 0,
    riskLevel: 'NORMAL'
};

// 手部與脖子狀態
let isHandOnNeck = false;
let activeAlertLevel = null;
let activeAlertMessage = null;
let activeAlertBaseMessage = null;
let audioBuzzerInterval = null;

// 獨立核心偵測演算法模組實例 (Standalone Detection Core)
let noseHistory = [];
const silentChokeDetector = new SilentChokeDetector(3.0);
const evidenceFusion = new EvidenceFusion(5.0, 1.0, 10.0);

// WebRTC 串流連線變數
let peerConnection = null;
let supabaseChannel = null;
let patientRealtimeReady = false;
let lastStateBroadcastAt = 0;
let activeNegotiationId = null;
let activePeerClientId = null;
let pendingPeerClientId = null;
let activeOfferPayload = null;
let peerOfferInProgress = false;
let resendOfferAfterCreation = false;
const remoteCandidateBuffer = window.ConnectionCore.createCandidateBuffer();

// 初始化啟動 (安全支援 DOMContentLoaded 與已就緒狀態)
async function startApp() {
    initSupabase();
    setupCanvasAndVideo();
    syncMealAndSwitchControls();
    initMediaPipe();
    initAudioClassifier();
    if (!supabaseClient) {
        window.AuthUI.showSetupError('系統連線設定尚未完成。請聯絡管理者，不會以未受保護的離線模式繼續。');
        return;
    }
    try {
        const user = await window.AuthUI.requireAuth(supabaseClient, '使用者端');
        currentAuthUser = user;
        await initializeAuthenticatedPatientFlow(user);
    } catch (error) {
        console.error('[Supabase Auth] User endpoint startup failed:', error);
        window.AuthUI.showSetupError('登入服務暫時無法使用，請重新整理頁面後再試。');
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
} else {
    startApp();
}

// 2. Supabase Client 初始化
function initSupabase() {
    try {
        if (!window.supabase || !CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_PUBLISHABLE_KEY) {
            console.error('[Supabase] Required project URL or publishable key is missing.');
            return;
        }
        supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_PUBLISHABLE_KEY);
        console.log('[Supabase] Client initialized; sign-in is required before data access.');
    } catch (e) {
        console.error('[Supabase] Initialization error:', e);
    }
}

// 3. UI 互動、雲端個案管理、待機模式與嗆咳紀錄隔離
function selectDiet(dietKey) {
    currentDiet = dietKey;
    document.querySelectorAll('.diet-btn').forEach(btn => btn.classList.remove('active', 'bg-blue-600', 'text-white'));
    const activeBtn = document.getElementById(`btn-diet-${dietKey}`);
    if (activeBtn) {
        activeBtn.classList.add('active', 'bg-blue-600', 'text-white');
    }
    const dietInfo = CONFIG.DIET_PROFILES[dietKey];
    const hudDiet = document.getElementById('hud-diet');
    if (hudDiet) hudDiet.innerText = dietInfo ? dietInfo.name : dietKey;
}

function clearCanvasFrame() {
    if (aiCtx && aiCanvas) {
        aiCtx.clearRect(0, 0, aiCanvas.width, aiCanvas.height);
    }
}

function setStandbyOverlayVisible(visible, titleText, descText, iconText) {
    const overlay = document.getElementById('standby-overlay');
    if (!overlay) return;
    if (visible) {
        overlay.classList.remove('hidden');
        const titleEl = document.getElementById('standby-title');
        const descEl = document.getElementById('standby-desc');
        const iconEl = document.getElementById('standby-icon');
        if (titleText && titleEl) titleEl.textContent = titleText;
        if (descText && descEl) descEl.textContent = descText;
        if (iconText && iconEl) iconEl.textContent = iconText;
    } else {
        overlay.classList.add('hidden');
    }
}

function syncMealAndSwitchControls() {
    const hasPatient = Boolean(currentPatient && currentPatient.id);
    const btnStart = document.getElementById('btn-start-meal');
    const btnEnd = document.getElementById('btn-end-meal');
    const btnSwitch = document.getElementById('btn-login-modal');
    const btnCough = document.getElementById('btn-cough-records');
    const btnFooterCough = document.getElementById('btn-footer-cough-records');
    const btnCloseModal = document.getElementById('btn-close-login-modal');

    if (btnStart) {
        const canStart = hasPatient && !isMealActive;
        btnStart.disabled = !canStart;
        btnStart.classList.toggle('opacity-50', !canStart);
        btnStart.classList.toggle('cursor-not-allowed', !canStart);
    }
    if (btnEnd) {
        btnEnd.disabled = !isMealActive;
        if (isMealActive) {
            btnEnd.classList.remove('opacity-50', 'cursor-not-allowed', 'bg-slate-800', 'text-slate-500');
            btnEnd.classList.add('bg-rose-600', 'text-white', 'hover:bg-rose-500');
        } else {
            btnEnd.classList.remove('bg-rose-600', 'text-white', 'hover:bg-rose-500');
            btnEnd.classList.add('bg-slate-800', 'text-slate-500', 'cursor-not-allowed');
        }
    }
    if (btnSwitch) {
        btnSwitch.disabled = !currentAuthUser || isMealActive;
        if (isMealActive) {
            btnSwitch.textContent = '🍽️ 用餐中鎖定';
            btnSwitch.title = '用餐監測進行中，請先點擊結束用餐再切換個案';
        } else if (isKioskLocked) {
            btnSwitch.textContent = '🔒 個案已鎖定';
            btnSwitch.title = '此裝置已鎖定於當前個案，點擊後須驗證照護密碼才可切換';
        } else {
            btnSwitch.textContent = '🔑 身分切換';
            btnSwitch.title = '切換或新增被照護者';
        }
    }
    if (btnCough) btnCough.disabled = !hasPatient;
    if (btnFooterCough) btnFooterCough.disabled = !hasPatient;
    if (btnCloseModal) btnCloseModal.classList.toggle('hidden', !hasPatient);
}

function getSavedKioskLockCode(ownerId) {
    const key = window.ConnectionCore && window.ConnectionCore.kioskLockStorageKey(ownerId);
    if (!key) return '';
    try {
        const raw = localStorage.getItem(key);
        return raw ? String(raw).trim() : '';
    } catch (_) {
        return '';
    }
}

function setKioskLock(locked, patientCode = '') {
    const ownerId = currentAuthUser && currentAuthUser.id;
    const key = window.ConnectionCore && window.ConnectionCore.kioskLockStorageKey(ownerId);
    if (locked && key && patientCode) {
        isKioskLocked = true;
        try { localStorage.setItem(key, patientCode); } catch (_) {}
        const container = document.getElementById('patient-list-container');
        if (container) container.replaceChildren();
    } else {
        isKioskLocked = false;
        if (key) {
            try { localStorage.removeItem(key); } catch (_) {}
        }
    }
    const chk = document.getElementById('chk-kiosk-lock');
    if (chk) chk.checked = isKioskLocked;
    syncMealAndSwitchControls();
}

async function loadCloudPatientProfiles() {
    if (!supabaseClient || !currentAuthUser) {
        cloudPatientProfiles = [];
        return [];
    }
    const { data, error } = await supabaseClient
        .from('patient_profiles')
        .select('id, patient_code, full_name, gender, diet_type, baseline_chew_duration, baseline_swallow_pause')
        .order('created_at', { ascending: true });
    if (error) throw error;
    cloudPatientProfiles = Array.isArray(data)
        ? data.filter(p => p && /^[A-Za-z0-9_-]{1,32}$/.test(String(p.patient_code || '')))
        : [];
    return cloudPatientProfiles;
}

function renderPatientList() {
    const container = document.getElementById('patient-list-container');
    const statusEl = document.getElementById('patient-list-status');
    if (!container) return;
    container.replaceChildren();

    if (!currentAuthUser || isKioskLocked) {
        return;
    }

    if (statusEl) {
        statusEl.textContent = cloudPatientProfiles.length > 0
            ? `已同步此帳號名下 ${cloudPatientProfiles.length} 位個案（選擇後先進入待機）`
            : '此帳號尚無個案，請先新增第一位被照護者';
    }

    for (const profile of cloudPatientProfiles) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'patient-select-btn w-full bg-slate-800 hover:bg-slate-700 text-slate-200 p-3 rounded-2xl font-semibold text-left flex items-center justify-between border border-slate-700 transition';
        btn.setAttribute('data-patient-code', profile.patient_code);
        btn.setAttribute('data-patient-name', profile.full_name || profile.patient_code);

        const leftSpan = document.createElement('span');
        leftSpan.style.pointerEvents = 'none';
        const icon = profile.gender === '女' ? '👵' : '👴';
        leftSpan.textContent = `${icon} ${profile.full_name || profile.patient_code} (${profile.patient_code})`;

        const rightSpan = document.createElement('span');
        rightSpan.style.pointerEvents = 'none';
        rightSpan.className = 'text-xs text-blue-400';
        rightSpan.textContent = (currentPatient && currentPatient.patient_code === profile.patient_code)
            ? '目前待機中'
            : '點擊待機';

        btn.append(leftSpan, rightSpan);
        container.appendChild(btn);
    }
}

function showAddPatientView() {
    const selectView = document.getElementById('patient-select-view');
    const addView = document.getElementById('patient-add-view');
    const backBtn = document.getElementById('btn-back-patient-list');
    if (selectView) selectView.classList.add('hidden');
    if (addView) addView.classList.remove('hidden');
    if (backBtn) backBtn.classList.toggle('hidden', cloudPatientProfiles.length === 0);
    const input = document.getElementById('new-patient-name');
    if (input) {
        input.value = '';
        input.focus();
    }
}

function showPatientListView() {
    if (cloudPatientProfiles.length === 0) {
        showAddPatientView();
        return;
    }
    const selectView = document.getElementById('patient-select-view');
    const addView = document.getElementById('patient-add-view');
    if (addView) addView.classList.add('hidden');
    if (selectView) selectView.classList.remove('hidden');
    renderPatientList();
}

function hideLoginModalElement() {
    const modal = document.getElementById('login-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
}

async function openLoginModal() {
    if (isMealActive) {
        alert('目前正在進行用餐監測，請先點擊「結束用餐」儲存紀錄後再切換個案。');
        return;
    }
    if (!currentAuthUser || !supabaseClient) return;

    if (isKioskLocked && window.AuthUI && typeof window.AuthUI.verifyCurrentPassword === 'function') {
        const verified = await window.AuthUI.verifyCurrentPassword(
            supabaseClient,
            `此平板已鎖定於「${currentPatient.full_name || currentPatient.patient_code}」。請輸入照護帳號密碼以解鎖切換個案。`
        );
        if (!verified) return;
        setKioskLock(false);
    }

    try {
        await loadCloudPatientProfiles();
    } catch (err) {
        console.error('[Patient List] Cloud sync failed:', err);
    }

    syncMealAndSwitchControls();
    showPatientListView();
    const modal = document.getElementById('login-modal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.remove('hidden');
    }
}

function closeLoginModal() {
    if (!currentPatient || !currentPatient.id) return;
    hideLoginModalElement();
}

function applySelectedPatientProfile(profile, options = {}) {
    if (isMealActive) {
        alert('目前正在進行用餐監測，請先點擊「結束用餐」儲存紀錄後再切換個案。');
        return false;
    }
    if (!profile || !profile.id) return false;

    currentPatient = {
        id: profile.id,
        patient_code: profile.patient_code,
        full_name: profile.full_name || profile.patient_code,
        diet_type: profile.diet_type || 'soft',
        baseline_chew: profile.baseline_chew_duration || 0.85,
        baseline_swallow: profile.baseline_swallow_pause || 1.10
    };
    window.currentPatient = currentPatient;
    currentDiet = currentPatient.diet_type;
    selectDiet(currentDiet);

    mealMetrics = {
        startTime: null,
        totalChews: 0,
        chewStartTime: null,
        chewDurations: [],
        lastJawY: null,
        jawVelocity: 0.0,
        jawStillTime: 0.0,
        currentBiteChews: 0,
        swallowCount: 0,
        coughCount: 0,
        coughCountL1: 0,
        coughCountL2: 0,
        chokingEventsL3: 0,
        pouchingEvents: 0,
        riskLevel: 'NORMAL'
    };
    window.mealMetrics = mealMetrics;
    activeAlertLevel = null;
    activeAlertMessage = null;
    activeAlertBaseMessage = null;
    dismissAlertOverlay();
    updateRiskBadge();
    clearCanvasFrame();
    closeCoughRecordModal();

    const shouldLock = typeof options.lockKiosk === 'boolean'
        ? options.lockKiosk
        : Boolean(document.getElementById('chk-kiosk-lock')?.checked);
    setKioskLock(shouldLock, currentPatient.patient_code);

    const label = document.getElementById('current-patient-label');
    if (label) label.textContent = `${currentPatient.full_name} (${currentPatient.patient_code})`;

    const statusText = document.getElementById('meal-status-text');
    if (statusText) statusText.textContent = '待機中（請按開始用餐）';

    setStandbyOverlayVisible(
        true,
        `已就緒：${currentPatient.full_name} (${currentPatient.patient_code})`,
        '目前為待機狀態（鏡頭與麥克風尚未開啟），請點擊下方「🍽️ 開始用餐」啟動即時守護。',
        shouldLock ? '🔒' : '🛡️'
    );

    updateCoughBadge();
    syncMealAndSwitchControls();
    hideLoginModalElement();
    console.log(`[Standby] Ready for patient: ${currentPatient.full_name} (${currentPatient.patient_code}), locked=${shouldLock}`);
    return true;
}

async function initializeAuthenticatedPatientFlow(user) {
    currentAuthUser = user;
    const profiles = await loadCloudPatientProfiles();
    const lockedCode = getSavedKioskLockCode(user.id);

    if (lockedCode) {
        const lockedProfile = profiles.find(p => p.patient_code === lockedCode);
        if (lockedProfile) {
            applySelectedPatientProfile(lockedProfile, { lockKiosk: true });
            return;
        }
        setKioskLock(false);
    }

    if (profiles.length === 1) {
        // 居家單一個案情境：登入後自動帶入待機狀態，省去重選步驟
        applySelectedPatientProfile(profiles[0], { lockKiosk: false });
        return;
    }

    syncMealAndSwitchControls();
    showPatientListView();
    const modal = document.getElementById('login-modal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.remove('hidden');
    }
}

async function saveAndLoginNewPatient() {
    if (isMealActive) {
        alert('目前正在進行用餐監測，請先點擊「結束用餐」後再新增個案。');
        return;
    }
    if (!supabaseClient || !currentAuthUser) {
        alert('請先登入照護帳號。');
        return;
    }
    const nameInput = document.getElementById('new-patient-name');
    const rawName = nameInput ? nameInput.value.trim() : '';
    if (!rawName) {
        alert('請輸入個案姓名或稱呼！');
        return;
    }
    const genderEl = document.querySelector('input[name="new-patient-gender"]:checked');
    const gender = (genderEl && genderEl.value === '女') ? '女' : '男';
    const saveBtn = document.getElementById('btn-save-new-patient');
    if (saveBtn) saveBtn.disabled = true;

    try {
        await loadCloudPatientProfiles();
        const code = window.ConnectionCore.nextPatientCode(cloudPatientProfiles);
        const fullName = `${rawName} (${gender})`;
        const { data: profile, error } = await supabaseClient
            .from('patient_profiles')
            .insert({
                owner_id: currentAuthUser.id,
                patient_code: code,
                full_name: fullName,
                gender: gender,
                diet_type: 'soft'
            })
            .select('*')
            .single();
        if (error) throw error;

        cloudPatientProfiles.push(profile);
        const lockChecked = Boolean(document.getElementById('chk-kiosk-lock')?.checked);
        applySelectedPatientProfile(profile, { lockKiosk: lockChecked });
    } catch (err) {
        console.error('[Patient Create] Failed to create cloud patient profile:', err);
        alert('無法儲存新個案至雲端，請檢查網路連線後重試。');
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

async function loginAsPatient(code, _nameStr) {
    if (isMealActive) {
        alert('目前正在進行用餐監測，請先點擊「結束用餐」儲存紀錄後再切換個案。');
        return;
    }
    try {
        if (!supabaseClient) throw new Error('Supabase client is unavailable.');
        if (!currentAuthUser) {
            const { data: authData, error: authError } = await supabaseClient.auth.getUser();
            if (authError || !authData.user) throw new Error('請先登入同一個照護帳號。');
            currentAuthUser = authData.user;
        }

        const normalizedCode = String(code || '').trim();
        let profile = cloudPatientProfiles.find(p => p.patient_code === normalizedCode) || null;
        if (!profile) {
            const { data, error } = await supabaseClient
                .from('patient_profiles')
                .select('*')
                .eq('patient_code', normalizedCode)
                .maybeSingle();
            if (error) throw error;
            profile = data;
        }
        if (!profile) {
            throw new Error('找不到此帳號名下的對應個案。');
        }

        const lockChecked = Boolean(document.getElementById('chk-kiosk-lock')?.checked);
        applySelectedPatientProfile(profile, { lockKiosk: lockChecked });
    } catch (error) {
        console.error('[Patient login] Could not select cloud patient profile:', error);
        alert('無法載入此個案資料，請重新選擇或新增個案。');
        await openLoginModal();
    }
}

// ====== 依「帳號＋單一個案」嚴格隔離之嗆咳紀錄管理 ======
function getActiveCoughStorageKey() {
    if (!window.ConnectionCore || typeof window.ConnectionCore.coughStorageKey !== 'function') return null;
    const ownerId = currentAuthUser && currentAuthUser.id;
    const patientCode = currentPatient && currentPatient.id ? currentPatient.patient_code : '';
    return window.ConnectionCore.coughStorageKey(ownerId, patientCode);
}

function getCoughRecords() {
    const key = getActiveCoughStorageKey();
    if (!key) return [];
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(item => item && item.patientCode === currentPatient.patient_code);
    } catch (_) {
        return [];
    }
}

function recordCoughEvent(typeStr, detailStr) {
    const key = getActiveCoughStorageKey();
    if (!key) return;
    const now = new Date();
    const timeStr = now.toLocaleTimeString('zh-TW', { hour12: false });
    const dateStr = `${now.getMonth() + 1}/${now.getDate()}`;
    const item = {
        id: Date.now(),
        ownerId: currentAuthUser.id,
        patientCode: currentPatient.patient_code,
        patientName: currentPatient.full_name,
        time: `${dateStr} ${timeStr}`,
        type: typeStr || '咳嗽偵測',
        detail: detailStr || '背景靜默紀錄，無警報干擾'
    };
    const logs = getCoughRecords();
    logs.unshift(item);
    if (logs.length > 100) logs.length = 100;
    try {
        localStorage.setItem(key, JSON.stringify(logs));
    } catch (_) {}
    updateCoughBadge();
}

function updateCoughBadge() {
    const logs = getCoughRecords();
    const badge = document.getElementById('header-cough-badge');
    if (badge) badge.textContent = String(logs.length);
    const foot = document.getElementById('footer-cough-count');
    if (foot) foot.textContent = String(logs.length);
}

function renderCoughRecords() {
    const logs = getCoughRecords();
    const listEl = document.getElementById('cough-record-list');
    const mealCntEl = document.getElementById('cough-modal-meal-count');
    const totalCntEl = document.getElementById('cough-modal-total-count');
    const patientInfoEl = document.getElementById('cough-modal-patient-info');

    if (patientInfoEl) {
        patientInfoEl.textContent = (currentPatient && currentPatient.id)
            ? `個案：${currentPatient.full_name} (${currentPatient.patient_code})`
            : '個案：尚未選擇';
    }
    if (mealCntEl) {
        mealCntEl.textContent = String((mealMetrics && mealMetrics.coughCount) ? mealMetrics.coughCount : 0);
    }
    if (totalCntEl) {
        totalCntEl.textContent = String(logs.length);
    }

    if (!listEl) return;
    listEl.replaceChildren();

    if (logs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'text-center py-8 text-slate-500 text-xs';
        empty.textContent = '🍵 目前此個案尚無任何嗆咳事件紀錄，進食狀況良好';
        listEl.appendChild(empty);
        return;
    }

    for (const item of logs) {
        const row = document.createElement('div');
        row.className = 'bg-slate-800/70 border border-slate-700/60 p-2.5 rounded-2xl flex items-center justify-between text-xs';

        const left = document.createElement('div');
        const headerRow = document.createElement('div');
        headerRow.className = 'flex items-center space-x-2';

        const typeSpan = document.createElement('span');
        typeSpan.className = 'font-bold text-rose-400';
        typeSpan.textContent = `⚠️ ${item.type || '咳嗽偵測'}`;

        const timeSpan = document.createElement('span');
        timeSpan.className = 'text-[10px] text-slate-400 font-mono';
        timeSpan.textContent = item.time || '';

        headerRow.append(typeSpan, timeSpan);

        const detailDiv = document.createElement('div');
        detailDiv.className = 'text-[11px] text-slate-400 mt-0.5';
        detailDiv.textContent = item.detail || '';

        left.append(headerRow, detailDiv);

        const savedBadge = document.createElement('span');
        savedBadge.className = 'text-[10px] bg-emerald-950/60 text-emerald-400 px-2 py-0.5 rounded-lg border border-emerald-800/40 shrink-0';
        savedBadge.textContent = '已隔離存檔';

        row.append(left, savedBadge);
        listEl.appendChild(row);
    }
}

function openCoughRecordModal() {
    if (!currentPatient || !currentPatient.id) return;
    renderCoughRecords();
    const modal = document.getElementById('cough-record-modal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.remove('hidden');
    }
}

function closeCoughRecordModal() {
    const modal = document.getElementById('cough-record-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
}

function clearAllCoughRecords() {
    const key = getActiveCoughStorageKey();
    if (!key) return;
    const label = `${currentPatient.full_name} (${currentPatient.patient_code})`;
    if (confirm(`確定要清除「${label}」在本機的嗆咳紀錄嗎？（不會影響其他個案或雲端歷史紀錄）`)) {
        try { localStorage.removeItem(key); } catch (_) {}
        if (mealMetrics) mealMetrics.coughCount = 0;
        renderCoughRecords();
        updateCoughBadge();
    }
}

// 🎯 全域 Window 顯式綁定
window.selectDiet = selectDiet;
window.openLoginModal = openLoginModal;
window.closeLoginModal = closeLoginModal;
window.loginAsPatient = loginAsPatient;
window._fullLoginAsPatient = loginAsPatient;
window.showAddPatientView = showAddPatientView;
window.showPatientListView = showPatientListView;
window.saveAndLoginNewPatient = saveAndLoginNewPatient;
window.getCoughRecords = getCoughRecords;
window.recordCoughEvent = recordCoughEvent;
window.openCoughRecordModal = openCoughRecordModal;
window.closeCoughRecordModal = closeCoughRecordModal;
window.clearAllCoughRecords = clearAllCoughRecords;
window.updateCoughBadge = updateCoughBadge;
window.isMealSessionActive = () => Boolean(isMealActive);
window.isPatientKioskLocked = () => Boolean(isKioskLocked);
window.startMealSession = startMealSession;
window.endMealSession = endMealSession;
window.dismissAlertOverlay = dismissAlertOverlay;

// 🎯 事件委派 (雲端個案按鈕點擊進入待機)
document.addEventListener('click', (evt) => {
    const btn = evt.target.closest('[data-patient-code]');
    if (btn) {
        const code = btn.getAttribute('data-patient-code');
        const name = btn.getAttribute('data-patient-name') || code;
        if (typeof window.loginAsPatient === 'function') {
            window.loginAsPatient(code, name);
        }
    }
});

async function initMediaPipe() {
    const aiStatus = document.getElementById('hud-ai-status');
    try {
        let Resolver = window.FilesetResolver || (window.tasksVision && window.tasksVision.FilesetResolver);
        let FaceL = window.FaceLandmarker || (window.tasksVision && window.tasksVision.FaceLandmarker);
        let HandL = window.HandLandmarker || (window.tasksVision && window.tasksVision.HandLandmarker);

        if (!Resolver || !FaceL || !HandL) {
            console.log('[MediaPipe] Dynamically importing Tasks Vision module...');
            const visionMod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0");
            window.tasksVision = visionMod;
            Resolver = visionMod.FilesetResolver;
            FaceL = visionMod.FaceLandmarker;
            HandL = visionMod.HandLandmarker;
        }

        if (!Resolver || !FaceL || !HandL) {
            console.warn('[MediaPipe] Tasks Vision symbols not available. Running without AI overlay.');
            if (aiStatus) {
                aiStatus.innerText = '⚠️ 純影像模式';
                aiStatus.className = 'font-bold text-slate-400';
            }
            return;
        }

        const vision = await Resolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
        );
        
        try {
            faceLandmarker = await FaceL.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
                    delegate: "GPU"
                },
                runningMode: "VIDEO",
                numFaces: 1
            });
        } catch (gpuErr) {
            console.warn('[MediaPipe] GPU delegate failed, falling back to CPU:', gpuErr);
            faceLandmarker = await FaceL.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
                    delegate: "CPU"
                },
                runningMode: "VIDEO",
                numFaces: 1
            });
        }

        try {
            handLandmarker = await HandL.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
                    delegate: "GPU"
                },
                runningMode: "VIDEO",
                numHands: 2
            });
        } catch (gpuErr) {
            console.warn('[MediaPipe] GPU delegate failed for hands, falling back to CPU:', gpuErr);
            handLandmarker = await HandL.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
                    delegate: "CPU"
                },
                runningMode: "VIDEO",
                numHands: 2
            });
        }

        console.log('[MediaPipe] Face & Hand Landmarkers initialized successfully.');
        if (aiStatus) {
            aiStatus.innerText = '🟢 已就緒';
            aiStatus.className = 'font-bold text-emerald-400';
        }
    } catch (e) {
        console.error('[MediaPipe] Vision initialization error:', e);
        if (aiStatus) {
            aiStatus.innerText = '⚠️ 模型載入受限';
            aiStatus.className = 'font-bold text-amber-400';
        }
    }
}

function setupCanvasAndVideo() {
    webcamVideo = document.getElementById('webcam-video');
    aiCanvas = document.getElementById('ai-canvas');
    aiCanvas.width = 640;
    aiCanvas.height = 480;
    aiCtx = aiCanvas.getContext('2d');
}

// 4b. 初始化 Google YAMNet AI 咳嗽與呼吸道聲紋辨識模型
async function initAudioClassifier() {
    const micLabel = document.getElementById('hud-mic-label');
    try {
        let AudioResolver = window.AudioFilesetResolver || (window.tasksAudio && window.tasksAudio.FilesetResolver);
        let ClassifierCls = window.AudioClassifier || (window.tasksAudio && window.tasksAudio.AudioClassifier);

        if (!AudioResolver || !ClassifierCls) {
            const audioMod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@0.10.0");
            window.tasksAudio = audioMod;
            AudioResolver = audioMod.FilesetResolver;
            ClassifierCls = audioMod.AudioClassifier;
        }

        if (!AudioResolver || !ClassifierCls) {
            throw new Error('MediaPipe Tasks Audio symbols unavailable');
        }

        const audioFileset = await AudioResolver.forAudioTasks(YAMNET_WASM_URL);
        audioClassifier = await ClassifierCls.createFromOptions(audioFileset, {
            baseOptions: { modelAssetPath: YAMNET_MODEL_URL },
            maxResults: 30,
            scoreThreshold: 0.01
        });

        isAudioClassifierReady = true;
        audioClassifierFailed = false;
        console.log('✅ [YAMNet] Google YAMNet AI 咳嗽聲辨識模型載入完成！');
        if (micLabel) {
            micLabel.innerText = isMealActive ? '🎤 AI聽診中' : '🎤 AI聽診就緒';
            micLabel.className = 'text-[10px] text-emerald-400 font-semibold';
        }
    } catch (err) {
        console.warn('⚠️ [YAMNet] AI 聲音模型載入失敗，退回高能量備援模式:', err);
        isAudioClassifierReady = false;
        audioClassifierFailed = true;
        if (micLabel) {
            micLabel.innerText = '🎤 音量備援';
            micLabel.className = 'text-[10px] text-amber-400';
        }
    }
}

// 5. 多階相機與麥克風容錯啟動 (3-Tier Fallback Camera Getter)
async function getWebcamStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("您的瀏覽器不支援 getUserMedia 存取相機！");
    }

    // Tier 1: 最佳畫質視訊 (1280x720) + 麥克風音訊
    try {
        return await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: true
        });
    } catch (e1) {
        console.warn('[Camera] Tier 1 (Ideal Video+Audio) failed, trying Tier 2...', e1);
    }

    // Tier 2: 基礎視訊 + 麥克風音訊
    try {
        return await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
    } catch (e2) {
        console.warn('[Camera] Tier 2 (Simple Video+Audio) failed, trying Tier 3 (Video ONLY)...', e2);
    }

    // Tier 3: 純視訊 (無麥克風/麥克風存取受限)
    try {
        return await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false
        });
    } catch (e3) {
        console.error('[Camera] Tier 3 (Video ONLY) failed:', e3);
        throw e3;
    }
}

async function startMealSession() {
    if (!currentPatient || !currentPatient.id) {
        openLoginModal();
        return;
    }
    if (isMealActive && webcamStream) {
        console.log('[Camera] Meal session already active.');
        return;
    }
    if (!mealStartLock.tryEnter()) {
        console.log('[Camera] Meal session startup is already in progress.');
        return;
    }
    chokeFaceLossWarningGuard.reset();
    chokeDangerAccumulator.reset();
    lastChokeVisibilityWarningAt = -Infinity;
    lastCoughTime = -Infinity;
    lastAiCoughTime = -Infinity;
    window._pendingAiCoughEvent = null;
    chokeSimultaneousStartTime = null;
    chokeSimultaneousDuration = 0.0;
    handsInDangerZoneCount = 0;

    try {
        webcamStream = await getWebcamStream();

        webcamVideo.srcObject = webcamStream;
        await webcamVideo.play();

        // 🎯 動態感知手機鏡頭真實像素尺寸 (直式 portrait 或 橫式 landscape)
        const vW = webcamVideo.videoWidth || 640;
        const vH = webcamVideo.videoHeight || 480;

        aiCanvas.width = vW;
        aiCanvas.height = vH;

        // 同步適應相機 Viewport 容器比例，完全解決手機直式拍攝畫面遭擠壓壓縮變形
        const container = document.getElementById('camera-container');
        if (container) {
            container.style.aspectRatio = `${vW} / ${vH}`;
        }

        // 嘗試綁定 Web Audio API 聲學分析 (若包含音軌)
        if (webcamStream.getAudioTracks().length > 0) {
            setupAudioAnalyzer(webcamStream);
        } else {
            console.warn('[Audio] No audio track available in camera stream.');
        }

        // 重設用餐指標
        mealMetrics = {
            startTime: new Date(),
            totalChews: 0,
            chewStartTime: null,
            chewDurations: [],
            lastJawY: null,
            jawVelocity: 0.0,
            jawStillTime: 0.0,
            currentBiteChews: 0,
            swallowCount: 0,
            coughCount: 0,
            coughCountL1: 0,
            coughCountL2: 0,
            chokingEventsL3: 0,
            pouchingEvents: 0,
            riskLevel: 'NORMAL'
        };
        window.mealMetrics = mealMetrics;

        isMealActive = true;
        setStandbyOverlayVisible(false);
        syncMealAndSwitchControls();

        const mealStatusText = document.getElementById('meal-status-text');
        if (mealStatusText) mealStatusText.innerText = '用餐中 🍽️';

        // 於背景建立 Supabase 用餐紀錄，不阻塞即時影像偵測
        if (supabaseClient) {
            currentMealSessionInsertPromise = mealSessionTracker.begin(async () => {
                const { data, error } = await supabaseClient.from('meal_sessions').insert([{
                    patient_id: currentPatient.id,
                    diet_type: currentDiet,
                    start_time: new Date().toISOString(),
                    risk_level: 'NORMAL',
                    event_schema_version: 2
                }]).select().single();
                if (error) throw error;
                return data?.id || null;
            }).catch(err => {
                console.warn('[Supabase] Meal session log bypassed; this meal will not be attached to a previous session:', err);
                return null;
            });
        } else {
            mealSessionTracker.clear();
            currentMealSessionInsertPromise = Promise.resolve(null);
        }

        // 開始影音串流與 WebRTC P2P
        setupWebRTCSignaling();

        // 啟動逐幀監測迴圈
        requestAnimationFrame(processVideoFrame);

    } catch (err) {
        console.error('Camera/Mic permission failed:', err);
        isMealActive = false;
        if (webcamStream) {
            const stream = webcamStream;
            webcamStream = null;
            window.ConnectionCore.stopMediaStream(stream);
        }
        if (webcamVideo) webcamVideo.srcObject = null;
        setStandbyOverlayVisible(
            true,
            '⚠️ 相機權限受限',
            '請允許瀏覽器存取攝影機與麥克風後，再次點擊下方「🍽️ 開始用餐」。',
            '📷'
        );
        syncMealAndSwitchControls();
        const isSecure = window.isSecureContext;
        let hintMsg = "無法取得相機權限！\n\n";
        if (!isSecure) {
            hintMsg += "💡 原因：瀏覽器規定存取相機必須使用【安全通道 (HTTPS 或 localhost)】！\n\n";
            hintMsg += "【解法建議】：\n";
            hintMsg += "1. 電腦端測試：請將網址改為 http://localhost:8080/index.html 開啟。\n";
            hintMsg += "2. 手機端測試：請使用 server.py 產生的 Cloudflare 綠色鎖頭 https://...trycloudflare.com 網址開啟。";
        } else {
            hintMsg += "請檢查您的瀏覽器網址列左側權限圖示，確認已允許開啟「攝影機」。";
        }
        
        const mealStatusText = document.getElementById('meal-status-text');
        if (mealStatusText) mealStatusText.innerText = '⚠️ 相機權限受限 (請允許後重試)';
        
        alert(hintMsg);
    } finally {
        mealStartLock.release();
    }
}

async function endMealSession() {
    if (!isMealActive) return;
    if (!mealStartLock.tryEnter()) {
        console.log('[Camera] Meal startup or shutdown is already in progress.');
        return;
    }

    const sessionInsertPromise = currentMealSessionInsertPromise;
    let durationSec = 0;
    let avgChewTime = currentPatient.baseline_chew;
    try {
        isMealActive = false;

        // 計算總用餐時長與平均咀嚼時間
        const endTime = new Date();
        durationSec = Math.round((endTime - mealMetrics.startTime) / 1000);
        avgChewTime = mealMetrics.chewDurations.length > 0
            ? (mealMetrics.chewDurations.reduce((a, b) => a + b, 0) / mealMetrics.chewDurations.length)
            : currentPatient.baseline_chew;

        // 關閉結束按鈕與身分切換，保持開始按鈕鎖定，避免結束流程尚未完成就開始下一餐或切換個案
        const btnStart = document.getElementById('btn-start-meal');
        const btnEnd = document.getElementById('btn-end-meal');
        const btnSwitch = document.getElementById('btn-login-modal');
        if (btnStart) {
            btnStart.disabled = true;
            btnStart.classList.add('opacity-50', 'cursor-not-allowed');
        }
        if (btnEnd) {
            btnEnd.disabled = true;
            btnEnd.classList.add('opacity-50', 'cursor-not-allowed');
        }
        if (btnSwitch) {
            btnSwitch.disabled = true;
        }
        document.getElementById('meal-status-text').innerText = '用餐結束，正在儲存紀錄…';

        await window.ConnectionCore.finalizeMealSession(
            sessionInsertPromise,
            async () => {
                // 先停止相機與信令，再等待資料庫 insert 完成
                if (webcamStream) {
                    const stream = webcamStream;
                    webcamStream = null;
                    stream.getTracks().forEach(track => {
                        try { track.stop(); } catch (err) { console.warn('[Camera] Track stop failed:', err); }
                    });
                }
                if (webcamVideo) webcamVideo.srcObject = null;
                clearCanvasFrame();
                if (peerConnection) {
                    const connection = peerConnection;
                    peerConnection = null;
                    try { connection.close(); } catch (err) { console.warn('[WebRTC] Peer close failed:', err); }
                }
                try {
                    await broadcastSystemState(true, true);
                } catch (err) {
                    console.warn('[Realtime] Failed to broadcast meal stop:', err);
                }
                if (supabaseChannel) {
                    const channel = supabaseChannel;
                    supabaseChannel = null;
                    try {
                        await channel.unsubscribe();
                    } catch (err) {
                        console.warn('[Realtime] Failed to unsubscribe after meal:', err);
                    }
                }
                patientRealtimeReady = false;
                activeNegotiationId = null;
                activePeerClientId = null;
                pendingPeerClientId = null;
                activeOfferPayload = null;
                peerOfferInProgress = false;
                resendOfferAfterCreation = false;
                remoteCandidateBuffer.clear();
                stopBuzzerSound();
                teardownAudioAnalyzer();
            },
            async sessionId => {
                if (!supabaseClient) return;
                const { error } = await supabaseClient.from('meal_sessions').update({
                    end_time: endTime.toISOString(),
                    total_duration_sec: durationSec,
                    total_chew_count: mealMetrics.totalChews,
                    total_swallow_count: mealMetrics.swallowCount || 0,
                    avg_chew_duration: parseFloat(avgChewTime.toFixed(2)),
                    cough_count_l1: mealMetrics.coughCountL1,
                    cough_count_l2: mealMetrics.coughCountL2,
                    choking_events_l3: mealMetrics.chokingEventsL3,
                    pouching_events: mealMetrics.pouchingEvents,
                    risk_level: mealMetrics.riskLevel
                }).eq('id', sessionId);
                if (error) throw error;

                // 更新個案個人化動態基準 (3餐自適應平均值)
                await updatePatientAdaptiveBaseline(avgChewTime);
            }
        );
    } catch (err) {
        console.warn('[Supabase] Failed to finalize meal session:', err);
    } finally {
        mealSessionTracker.clear();
        currentMealSessionInsertPromise = Promise.resolve(null);
        activeAlertLevel = null;
        activeAlertMessage = null;
        activeAlertBaseMessage = null;
        dismissAlertOverlay();
        setStandbyOverlayVisible(
            true,
            `用餐已結束：${currentPatient.full_name} (${currentPatient.patient_code})`,
            '紀錄已儲存並返回待機狀態。若要開始下一餐請點擊「🍽️ 開始用餐」，或點右上角切換個案。',
            isKioskLocked ? '🔒' : '✅'
        );
        syncMealAndSwitchControls();
        document.getElementById('meal-status-text').innerText = '用餐結束（待機中）⏹️';
        alert(`用餐完成！\n總時間: ${durationSec} 秒\n累積咀嚼: ${mealMetrics.totalChews} 次\n平均單次咀嚼耗時: ${avgChewTime.toFixed(2)} 秒`);
        mealStartLock.release();
    }
}

// 6. Web Audio API 聲學分析 ＋ Google YAMNet 1.05 秒滑動音訊環形緩衝區推論
function teardownAudioAnalyzer() {
    if (audioInferenceTimer) {
        clearInterval(audioInferenceTimer);
        audioInferenceTimer = null;
    }
    try { if (audioScriptNode) { audioScriptNode.onaudioprocess = null; audioScriptNode.disconnect(); } } catch (e) {}
    try { if (audioMuteGain) audioMuteGain.disconnect(); } catch (e) {}
    try { if (audioAnalyser) audioAnalyser.disconnect(); } catch (e) {}
    try { if (audioMediaSource) audioMediaSource.disconnect(); } catch (e) {}
    audioScriptNode = null;
    audioMuteGain = null;
    audioAnalyser = null;
    audioMediaSource = null;
    audioDataArray = null;
    audioRingBuffer = null;
    audioSamplesCollected = 0;
    try {
        if (audioCtx && audioCtx.state !== 'closed') {
            audioCtx.close().catch(() => {});
        }
    } catch (e) {}
    audioCtx = null;
}

function setupAudioAnalyzer(stream) {
    try {
        teardownAudioAnalyzer();
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }

        audioMediaSource = audioCtx.createMediaStreamSource(stream);
        audioAnalyser = audioCtx.createAnalyser();
        audioAnalyser.fftSize = 256;
        audioMediaSource.connect(audioAnalyser);
        audioDataArray = new Uint8Array(audioAnalyser.frequencyBinCount);

        const ringLength = Math.ceil(audioCtx.sampleRate * 1.05);
        audioRingBuffer = new Float32Array(ringLength);
        audioSamplesCollected = 0;

        audioScriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
        audioMuteGain = audioCtx.createGain();
        audioMuteGain.gain.value = 0.0;

        audioScriptNode.onaudioprocess = (event) => {
            if (!audioRingBuffer) return;
            const input = event.inputBuffer.getChannelData(0);
            const n = input.length;
            const total = audioRingBuffer.length;
            if (n >= total) {
                audioRingBuffer.set(input.subarray(n - total), 0);
                audioSamplesCollected = total;
            } else {
                audioRingBuffer.copyWithin(0, n);
                audioRingBuffer.set(input, total - n);
                audioSamplesCollected = Math.min(total, audioSamplesCollected + n);
            }
        };

        audioMediaSource.connect(audioScriptNode);
        audioScriptNode.connect(audioMuteGain);
        audioMuteGain.connect(audioCtx.destination);

        audioInferenceTimer = setInterval(runYamnetInference, YAMNET_HOP_MS);

        const micLabel = document.getElementById('hud-mic-label');
        if (micLabel) {
            if (isAudioClassifierReady) {
                micLabel.innerText = '🎤 AI聽診中';
                micLabel.className = 'text-[10px] text-emerald-400 font-semibold';
            } else if (!audioClassifierFailed) {
                micLabel.innerText = '🎤 AI載入中';
                micLabel.className = 'text-[10px] text-slate-400';
            }
        }
    } catch (e) {
        console.error('[Audio] Analyser & YAMNet stream setup error:', e);
    }
}

function updateMicHudBadge(nowSec = performance.now() / 1000.0) {
    const micPill = document.getElementById('hud-mic-pill');
    const micLabel = document.getElementById('hud-mic-label');
    if (!micLabel) return;

    if (!isAudioClassifierReady) {
        if (audioClassifierFailed) {
            micLabel.innerText = '🎤 音量備援';
            micLabel.className = 'text-[10px] text-amber-400';
        }
        return;
    }

    const recentCoughAge = nowSec - lastAiCoughTime;
    if (recentCoughAge >= 0 && recentCoughAge <= 2.5) {
        const pct = Math.min(99, Math.round(aiAudioState.lastPeakScore * 100));
        micLabel.innerText = `🎤 ${aiAudioState.topChokeLabelZh} ${pct}%`;
        micLabel.className = 'text-[10px] text-rose-300 font-bold animate-pulse';
        if (micPill) {
            micPill.className = 'absolute top-3 right-3 bg-rose-950/90 backdrop-blur px-2.5 py-1.5 rounded-xl border border-rose-500/80 flex items-center space-x-2 transition-colors duration-200 shadow-lg';
        }
    } else {
        micLabel.innerText = isMealActive ? '🎤 AI聽診中' : '🎤 AI聽診就緒';
        micLabel.className = 'text-[10px] text-emerald-400 font-semibold';
        if (micPill) {
            micPill.className = 'absolute top-3 right-3 bg-slate-900/80 backdrop-blur px-2.5 py-1.5 rounded-xl border border-slate-700/60 flex items-center space-x-2 transition-colors duration-200';
        }
    }
}

function runYamnetInference() {
    if (!isMealActive || !isAudioClassifierReady || !audioClassifier || !audioCtx || !audioRingBuffer) return;
    if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
        return;
    }
    if (audioSamplesCollected < Math.floor(audioCtx.sampleRate * 0.98)) return;
    if (audioBuzzerInterval !== null) return;

    const nowSec = performance.now() / 1000.0;
    let sumSq = 0.0;
    for (let i = 0; i < audioRingBuffer.length; i++) {
        const v = audioRingBuffer[i];
        sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / audioRingBuffer.length);
    aiAudioState.rmsEnergy = rms;

    if (rms < 0.004) {
        aiAudioState.chokeScore = 0.0;
        aiAudioState.rawCoughScore = 0.0;
        aiAudioState.speechScore = 0.0;
        aiAudioState.updatedAt = nowSec;
        updateMicHudBadge(nowSec);
        return;
    }

    try {
        const results = audioClassifier.classify(audioRingBuffer, audioCtx.sampleRate);
        let bestChokeScore = 0.0;
        let bestRawCough = 0.0;
        let bestSpeech = 0.0;
        let bestChokeCat = "";
        let topOverall = "-";

        if (Array.isArray(results)) {
            for (const res of results) {
                const clsList = res && res.classifications;
                if (!clsList || clsList.length === 0) continue;
                const cats = clsList[0].categories || [];
                if (cats.length > 0 && topOverall === "-") {
                    topOverall = cats[0].categoryName || cats[0].displayName || "-";
                }

                let chokeSum = 0.0;
                let speechSum = 0.0;
                let topChokeSingleScore = 0.0;
                let topChokeSingleName = "";

                for (const cat of cats) {
                    const rawName = (cat.categoryName || cat.displayName || "");
                    const nameLower = rawName.toLowerCase();
                    const sc = cat.score || 0.0;

                    if (YAMNET_CHOKE_KEYWORDS.some(k => nameLower.includes(k))) {
                        chokeSum += sc;
                        if (sc > topChokeSingleScore) {
                            topChokeSingleScore = sc;
                            topChokeSingleName = rawName;
                        }
                    }
                    if (YAMNET_SPEECH_KEYWORDS.some(k => nameLower.includes(k))) {
                        speechSum += sc;
                    }
                }

                const suppressedScore = Math.max(0.0, chokeSum - 0.5 * speechSum);
                if (suppressedScore >= bestChokeScore) {
                    bestChokeScore = suppressedScore;
                    bestRawCough = chokeSum;
                    bestSpeech = speechSum;
                    bestChokeCat = topChokeSingleName;
                }
            }
        }

        let zhLabel = "咳嗽聲";
        const lowerCat = bestChokeCat.toLowerCase();
        for (const [k, v] of Object.entries(YAMNET_LABEL_ZH)) {
            if (lowerCat.includes(k)) {
                zhLabel = v;
                break;
            }
        }

        aiAudioState.chokeScore = bestChokeScore;
        aiAudioState.rawCoughScore = bestRawCough;
        aiAudioState.speechScore = bestSpeech;
        aiAudioState.topChokeLabel = bestChokeCat;
        aiAudioState.topChokeLabelZh = zhLabel;
        aiAudioState.topOverallLabel = topOverall;
        aiAudioState.updatedAt = nowSec;

        if (bestChokeScore >= YAMNET_CHOKE_TH_FUSION) {
            lastAiCoughTime = nowSec;
            lastCoughTime = nowSec;
            aiAudioState.lastPeakScore = bestChokeScore;
        }

        const recordTh = (faceLostSince === null) ? YAMNET_COUGH_RECORD_TH : YAMNET_COUGH_SOLO_TH;
        if (bestChokeScore >= recordTh) {
            window._pendingAiCoughEvent = {
                time: nowSec,
                score: bestChokeScore,
                labelZh: zhLabel,
                rawLabel: bestChokeCat || "Cough"
            };
        }

        updateMicHudBadge(nowSec);
    } catch (err) {
        console.warn('[YAMNet] Audio classification inference warning:', err);
    }
}

// 7. 逐幀 AI 運算與原版 5 階段狀態機與多模態決策樹
let lastFrameTime = performance.now();
async function processVideoFrame(now) {
    if (!isMealActive || !webcamVideo) return;

    const fps = 1000 / (now - lastFrameTime);
    lastFrameTime = now;
    const currentTime = now / 1000.0;

    // 繪製視訊鏡頭畫面至 Canvas
    aiCtx.drawImage(webcamVideo, 0, 0, aiCanvas.width, aiCanvas.height);

    // A. 讀取聲音能量 (300-2500Hz 頻段)
    let audioEnergy = 0.0;
    if (audioAnalyser && audioDataArray) {
        audioAnalyser.getByteFrequencyData(audioDataArray);
        let sum = 0;
        for (let i = 0; i < audioDataArray.length; i++) sum += audioDataArray[i];
        audioEnergy = (sum / audioDataArray.length) / 255.0; // 歸一化 0.0 - 1.0
        document.getElementById('hud-mic-bar').style.width = `${Math.min(100, audioEnergy * 150)}%`;
    }

    // B. 執行 MediaPipe 臉部與手部偵測
    const timestampMs = performance.now();
    let faceResults = null;
    let handResults = null;
    if (faceLandmarker) {
        try { faceResults = faceLandmarker.detectForVideo(webcamVideo, timestampMs); } catch (e) {}
    }
    if (handLandmarker) {
        try { handResults = handLandmarker.detectForVideo(webcamVideo, timestampMs); } catch (e) {}
    }

    let faceLandmarks = (faceResults && faceResults.faceLandmarks && faceResults.faceLandmarks.length > 0) ? faceResults.faceLandmarks[0] : null;
    let handLandmarks = (handResults && handResults.landmarks && handResults.landmarks.length > 0) ? handResults.landmarks : [];

    let movementStd = 0.0;
    let mar = 0.0;
    let visionCough = false;
    let bodyShaking = false;
    const w = aiCanvas.width;
    const h = aiCanvas.height;

    if (faceLandmarks) {
        faceLostSince = null;
        faceLossVisibilityLogged = false;
        chokeFaceLossWarningGuard.update(true, false, currentTime);

        // 取出關鍵特徵點 (標號與原版 478 Mesh 對齊)
        const chin = faceLandmarks[152];
        const nose = faceLandmarks[4]; // 鼻尖 4
        const p13 = faceLandmarks[13];
        const p14 = faceLandmarks[14];
        const p78 = faceLandmarks[78];
        const p308 = faceLandmarks[308];
        const p33 = faceLandmarks[33];
        const p263 = faceLandmarks[263];

        const faceH = Math.abs(chin.y - nose.y);

        // 1. MAR (Mouth Aspect Ratio) 計算與 EMA 平滑化 (0.4 * raw + 0.6 * smooth)
        const vDist = Math.hypot((p13.x - p14.x) * w, (p13.y - p14.y) * h);
        const hDist = Math.hypot((p78.x - p308.x) * w, (p78.y - p308.y) * h);
        const marRaw = hDist > 0 ? (vDist / hDist) : 0.0;
        marSmooth = (marSmooth === null) ? marRaw : (0.4 * marRaw + 0.6 * marSmooth);
        mar = marSmooth;

        // 2. 眼距歸一化縮放 (REF_IOD_PX = 100.0) & Jaw Movement
        const iod = Math.hypot((p33.x - p263.x) * w, (p33.y - p263.y) * h);
        const scale = iod > 1.0 ? (100.0 / iod) : 1.0;
        const jawRaw = (chin.y - nose.y) * h * scale;
        jawSmooth = (jawSmooth === null) ? jawRaw : (0.5 * jawRaw + 0.5 * jawSmooth);
        const jawRelativeY = jawSmooth;

        mealMetrics.jawVelocity = (prevJawY !== null) ? (jawRelativeY - prevJawY) : 0.0;
        prevJawY = jawRelativeY;

        jawMovementHistory.push(jawRelativeY);
        if (jawMovementHistory.length > 30) jawMovementHistory.shift();

        if (jawMovementHistory.length >= 15) {
            const slice = jawMovementHistory.slice(-15);
            const avg = slice.reduce((a,b)=>a+b, 0) / slice.length;
            const variance = slice.reduce((a,b)=>a + Math.pow(b - avg, 2), 0) / slice.length;
            movementStd = Math.sqrt(variance);
        }

        // 快取錨點供低頭/臉短暫消失時手勢續用 (2.0s 快取)
        lastNose = { x: nose.x, y: nose.y };
        lastChin = { x: chin.x, y: chin.y };
        lastAnchorTs = currentTime;

        // 🎯 先計算身體掙扎晃動，若處於搖晃狀態則放寬手部感應關節點數 (>=1 點即生效，抗動態模糊)
        const faceSize = Math.hypot((nose.x - chin.x) * w, (nose.y - chin.y) * h);
        isBodyShakingContinuous = checkContinuousBodyShaking(nose, faceSize, currentTime, w, h);
        prevNose = { x: nose.x, y: nose.y };

        // 🎯 手抓喉嚨與上胸口拍胸手勢偵測 (與畫面疊圖幾何 100% 一致)
        const handCheck = handNearChestOrThroat(
            handLandmarks, nose, chin, w, h, isBodyShakingContinuous ? 1 : 2
        );
        isHandOnNeck = handCheck.isThroat;
        isHandOnChest = handCheck.isChest;
        isHandOnChestOrThroat = handCheck.near;
        handsInDangerZoneCount = handCheck.handsInZone;

        // 影像嗆咳跡象 (提高門檻至連續 6 幀確認，過濾咀嚼干擾)
        if (movementStd > 18.0 && Math.abs(mealMetrics.jawVelocity) > 10.0) {
            coughFrameCounter++;
        } else {
            coughFrameCounter = 0;
        }
        if (coughFrameCounter >= 6) {
            coughFrameCounter = 0;
            visionCough = true;
        }

        // ------------------------------------------------------------------
        // 🧠 原版五階段進食狀態機 (ST_IDLE, ST_INGEST, ST_CHEW, ST_SWALLOW, ST_CHECK)
        // ------------------------------------------------------------------
        if (currentState === ST_IDLE) {
            if (mar > 0.15) {
                currentState = ST_INGEST;
                stateStartTime = currentTime;
                mealMetrics.currentBiteChews = 0;
                console.log("【通知】偵測到張嘴:食物入口 🍛");
            }
        } else if (currentState === ST_INGEST) {
            if (mar < 0.06) {
                currentState = ST_CHEW;
                stateStartTime = currentTime;
                console.log("【通知】開始閉嘴咀嚼食物 🦷");
            }
        } else if (currentState === ST_CHEW) {
            // 方向反轉咀嚼計數 (d1 * d2 < 0 且 間隔 > 0.18s)
            if (movementStd > 2.0 && Math.abs(mealMetrics.jawVelocity) > 1.5) {
                if (jawMovementHistory.length >= 3) {
                    const d1 = jawMovementHistory[jawMovementHistory.length - 1] - jawMovementHistory[jawMovementHistory.length - 2];
                    const d2 = jawMovementHistory[jawMovementHistory.length - 2] - jawMovementHistory[jawMovementHistory.length - 3];
                    if (d1 * d2 < 0 && (currentTime - lastChewFlipTime) > 0.18) {
                        mealMetrics.totalChews += 0.5;
                        mealMetrics.currentBiteChews += 0.5;
                        lastChewFlipTime = currentTime;
                    }
                }
            }

            if (visionCough) {
                stateStartTime = currentTime;
            } else if (movementStd < 0.8 && jawMovementHistory.length >= 15) {
                currentState = ST_SWALLOW;
                stateStartTime = currentTime;
                console.log("【通知】咀嚼停止，下巴上提 (定格吞嚥中...)");
            }
        } else if (currentState === ST_SWALLOW) {
            if ((currentTime - stateStartTime) > 0.6) {
                currentState = ST_CHECK;
                stateStartTime = currentTime;
                mealMetrics.swallowCount = (mealMetrics.swallowCount || 0) + 1;
                console.log(`🎉【數據分析】吞嚥成功！本次咀嚼約 ${Math.floor(mealMetrics.currentBiteChews)} 次。進入安全期。`);
                playSwallowChimeSound();
            } else if (movementStd > 2.0) {
                currentState = ST_CHEW;
                console.log("【狀態回退】非吞嚥，恢復咀嚼。");
            }
        } else if (currentState === ST_CHECK) {
            if ((currentTime - stateStartTime) > 4.0) {
                console.log("💖【數據分析】安全通過進食觀察期。");
                currentState = ST_IDLE;
            }
        }

        // 獨立演算法: 嘴唇發紺分析
        try {
            const lipPx = Math.floor(((p13.x + p14.x) / 2) * w);
            const lipPy = Math.floor(((p13.y + p14.y) / 2) * h);
            const lipData = aiCtx.getImageData(lipPx, lipPy, 1, 1).data;
            const lipRGB = [lipData[0], lipData[1], lipData[2]];
            const bRatio = blueness(lipRGB);
            const cyanotic = isCyanotic(lipRGB, 0.38);

            const hudCyanosis = document.getElementById('hud-cyanosis');
            if (hudCyanosis) {
                hudCyanosis.innerText = `${bRatio.toFixed(2)} ${cyanotic ? '(發紺缺氧!)' : '(正常)'}`;
                hudCyanosis.className = cyanotic ? 'font-mono text-purple-400 font-bold animate-pulse' : 'font-mono text-emerald-400 font-bold';
            }
            if (cyanotic) evidenceFusion.observe("cyanosis", 0.7);
        } catch (e) {}

        // 僅保留證據紀錄分析，不單獨直接觸發 L4 警報
        evidenceFusion.observe("audio", (audioEnergy * 2.0));
        if (isHandOnNeck) evidenceFusion.observe("gesture", 0.6);
        if (mar > 0.15 && movementStd < 0.8) evidenceFusion.observe("still_open", 0.3);

        // 🎯 繪製原版 Detection Overlay (嘴部紅圈、關鍵特徵點、Throat Zone 紫色圈、Chest Zone、大字提示)
        drawOriginalDetectionOverlay(aiCtx, faceLandmarks, handLandmarks, w, h, currentState, mar, movementStd, mealMetrics.totalChews, isHandOnNeck, isHandOnChest, isBodyShakingContinuous, chokeSimultaneousDuration);

    } else {
        const l4CandidateAtFaceLoss = isMealActive && (
            (isBodyShakingContinuous && isHandOnChestOrThroat) ||
            (chokeSimultaneousStartTime !== null && chokeSimultaneousDuration > 0)
        );
        const visibilityWarningDue = chokeFaceLossWarningGuard.update(false, l4CandidateAtFaceLoss, currentTime);
        if (visibilityWarningDue && currentTime - lastChokeVisibilityWarningAt >= 10.0 && activeAlertLevel !== 'L4') {
            lastChokeVisibilityWarningAt = currentTime;
            faceLossVisibilityLogged = true;
            showChokeVisibilityWarning(
                '⚠️【疑似哽噎／視覺遮蔽警示】剛偵測到身體晃動與胸口／喉嚨手勢，但臉部畫面遮蔽，無法確認是否為哽噎；請立即目視確認個案。'
            );
        }

        // 人臉遺失快取處理 (2.0 秒錨點快取手勢)
        if (lastNose && (currentTime - lastAnchorTs) < ANCHOR_GRACE_SEC) {
            const anchorHandCheck = handNearChestOrThroat(handLandmarks, lastNose, lastChin, w, h, 2);
            isHandOnNeck = anchorHandCheck.isThroat;
            handsInDangerZoneCount = anchorHandCheck.handsInZone;
        } else {
            isHandOnNeck = false;
            handsInDangerZoneCount = 0;
        }
        isBodyShakingContinuous = false;
        isHandOnChest = false;
        isHandOnChestOrThroat = isHandOnNeck;
        bodyMotionHistory = [];
        prevNose = null;
        noseSpeedHistory = [];
        coughFrameCounter = 0;

        if (isMealActive && (currentState === ST_INGEST || currentState === ST_CHEW || currentState === ST_SWALLOW)) {
            if (faceLostSince === null) {
                faceLostSince = currentTime;
            } else if (currentTime - faceLostSince > FACE_LOST_ALERT_SEC) {
                const lostMsg = '⚠️【視覺遮蔽警示】進食過程中人臉消失，請目視確認個案狀況！';
                if (!faceLossVisibilityLogged && currentTime - lastChokeVisibilityWarningAt >= 10.0) {
                    lastChokeVisibilityWarningAt = currentTime;
                    showChokeVisibilityWarning(lostMsg, 'VISIBILITY_LOSS');
                    faceLossVisibilityLogged = true;
                }
                faceLostSince = currentTime;
            }
        }

        // 繪製 NO FACE DETECTED
        drawOriginalDetectionOverlay(aiCtx, null, handLandmarks, w, h, currentState, 0, 0, mealMetrics.totalChews, isHandOnNeck, isHandOnChest, isBodyShakingContinuous, chokeSimultaneousDuration);
    }

    // 咳嗽狀態追蹤 (結合 Google YAMNet AI 咳嗽聲紋 ＋ 影像頭部急抽動；同幀嗆咳立即賦能路徑 C)
    const pendingAiCough = (window._pendingAiCoughEvent && (currentTime - window._pendingAiCoughEvent.time) <= 1.2)
        ? window._pendingAiCoughEvent
        : null;
    const aiCoughNow = Boolean(pendingAiCough);
    const fallbackAudioCough = (!isAudioClassifierReady && audioClassifierFailed && audioEnergy > 0.35);

    if (visionCough || aiCoughNow || fallbackAudioCough) {
        lastCoughTime = currentTime;
        if (aiCoughNow) {
            window._pendingAiCoughEvent = null;
        }
        // 一般咳嗽與警報等級分開：只在背景留下 COUGH 事件，不當作 L1-L4 警報。
        if (currentTime - (window._lastCoughLogTime || 0) >= 3.0) {
            window._lastCoughLogTime = currentTime;
            mealMetrics.coughCount = (mealMetrics.coughCount || 0) + 1;
            let typeStr = "聽覺 YAMNet 咳嗽聲";
            let detailStr = "背景靜默紀錄 (無彈窗干擾)";
            if (visionCough && aiCoughNow) {
                const pct = Math.min(99, Math.round(pendingAiCough.score * 100));
                typeStr = `雙模態嗆咳 (影像＋AI${pendingAiCough.labelZh})`;
                detailStr = `YAMNet 辨識 ${pendingAiCough.labelZh} (${pct}%) ＋ 頭部急抽動 · 靜默紀錄`;
            } else if (aiCoughNow) {
                const pct = Math.min(99, Math.round(pendingAiCough.score * 100));
                typeStr = `AI 聽覺辨識 (${pendingAiCough.labelZh})`;
                detailStr = `Google YAMNet 聲紋信心度 ${pct}% · 已過濾講話語音 · 靜默紀錄`;
            } else if (visionCough) {
                typeStr = "影像頭部急抽動";
                detailStr = "視覺連續劇烈上下抽動 · 靜默紀錄 (無彈窗干擾)";
            } else {
                typeStr = "高能量突發聲響 (備援)";
                detailStr = "AI 聲學模型未就緒，以高音量門檻備援靜默紀錄";
            }
            logAnomalyToSupabase('COUGH', typeStr);
            if (typeof window.recordCoughEvent === 'function') {
                window.recordCoughEvent(typeStr, detailStr);
            }
            console.log(`🤫【靜默後台紀錄】${typeStr} | ${detailStr}`);
        }
    }

    // ------------------------------------------------------------------
    // 🚨 L4 急性哽噎決策邏輯 (漏桶漸進衰減 + 三路徑高特異性臨床觸發)
    //   - 路徑 A (3.0s): 身體掙扎晃動 ＋ 手部拍胸／抓喉
    //   - 路徑 B (2.5s): 雙手同時抓喉／撫胸窒息手勢
    //   - 路徑 C (2.5s): 嗆咳後 8 秒內持續抓喉／撫胸
    // ------------------------------------------------------------------
    const recentCoughForL4 = (currentTime - lastCoughTime) <= CHOKE_POST_COUGH_WINDOW_SEC;
    const l4Candidate = window.ConnectionCore.evaluateL4Candidate({
        bodyShaking: isBodyShakingContinuous,
        handInZone: isHandOnChestOrThroat,
        handsInZone: handsInDangerZoneCount,
        recentCough: recentCoughForL4
    });
    const l4State = chokeDangerAccumulator.update(l4Candidate, currentTime);
    chokeSimultaneousDuration = l4State.duration;
    chokeSimultaneousStartTime = l4State.active ? (currentTime - l4State.duration) : null;

    if (l4State.triggered) {
        if (currentTime - lastChokeAlertTime >= 10.0) {
            lastChokeAlertTime = currentTime;
            const reasonText = l4State.reason || '身體掙扎晃動＋手部拍胸／抓喉';
            triggerAlertLevel(
                'L4',
                `🚨【緊急・急性哽噎警報】偵測到「${reasonText}」累計達標（${CHOKE_SIMULTANEOUS_TRIGGER_SEC.toFixed(1)} 秒門檻）！請立即協助！`
            );
        }
        chokeDangerAccumulator.reset();
        chokeSimultaneousStartTime = null;
        chokeSimultaneousDuration = 0.0;
    }

    // 更新 HUD 即時資訊
    updateHudStats(currentState, mar, movementStd, mealMetrics.totalChews, mealMetrics.swallowCount || 0, mealMetrics.jawVelocity, evidenceFusion.score(), chokeSimultaneousDuration);
    
    // Level 1: 10秒 含飯發呆溫和提醒
    if (mealMetrics.jawStillTime >= CONFIG.BASELINES.POUCHING_HINT_SEC && mealMetrics.jawStillTime < (CONFIG.BASELINES.POUCHING_HINT_SEC + 0.5)) {
        triggerAlertLevel('L1', '🟡 含飯/發呆提醒：長者已靜止 10 秒未咀嚼');
    }

    // 廣播最新狀態至 WebRTC 與 Supabase
    broadcastSystemState();

    requestAnimationFrame(processVideoFrame);
}

// 8. 警報觸發與語音/聲光處理
function showChokeVisibilityWarning(msg, eventType = 'L3_VISIBILITY') {
    const update = window.ConnectionCore.resolveVisibilityAlert(
        activeAlertLevel,
        activeAlertBaseMessage,
        activeAlertMessage,
        msg,
        eventType
    );
    if (update.replacePrimary) {
        triggerAlertLevel(update.level, update.message, {
            countAsChoking: update.countAsChoking,
            eventType: update.eventType
        });
        return;
    }

    activeAlertBaseMessage = update.baseMessage;
    activeAlertMessage = update.message;
    showAlertOverlay(update.level, update.message);
    logAnomalyToSupabase(update.eventType, msg);
}

function triggerAlertLevel(level, msg, options = {}) {
    if (activeAlertLevel === level) return;
    if (!window.ConnectionCore.canReplaceAlertLevel(activeAlertLevel, level)) return;
    activeAlertLevel = level;
    activeAlertBaseMessage = msg;
    activeAlertMessage = msg;

    console.log(`[ALERT TRIGGERED] ${level}: ${msg}`);

    // 更新 Risk Level
    if (level === 'L4' || level === 'L2') mealMetrics.riskLevel = 'HIGH_RISK';
    else if (level === 'L3' && mealMetrics.riskLevel !== 'HIGH_RISK') mealMetrics.riskLevel = 'ATTENTION';

    updateRiskBadge();

    // Level 1: 播放溫和語音播報 ("請記得嚼一嚼吞下來喔")
    if (level === 'L1') {
        speakVoicePrompt("請記得嚼一嚼吞下來喔");
        mealMetrics.pouchingEvents++;
        logAnomalyToSupabase('L1', msg);
    }
    // Level 2 / L3 / L4: 彈窗 + 警示音 + 寫入 Supabase
    else {
        showAlertOverlay(level, msg);
        playBuzzerAlarm();
        if (level === 'L3' && options.countAsChoking !== false) mealMetrics.chokingEventsL3++;
        if (level === 'L2') mealMetrics.pouchingEvents++;

        // 紀錄日誌至 Supabase
        logAnomalyToSupabase(options.eventType || level, msg);
    }
}

function speakVoicePrompt(text) {
    if ('speechSynthesis' in window) {
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'zh-TW';
        window.speechSynthesis.speak(utter);
    }
}

function playSwallowChimeSound() {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, audioCtx.currentTime); // C5
        osc.frequency.setValueAtTime(659.25, audioCtx.currentTime + 0.12); // E5
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.3);
    } catch (e) {}
}

function showAlertOverlay(level, msg) {
    const overlay = document.getElementById('alert-overlay');
    const title = document.getElementById('alert-title');
    const desc = document.getElementById('alert-desc');

    title.innerText = level === 'L4' ? '🚨 L4 急性哽噎緊急警報' : (level === 'L2' ? '🔴 L2 嚴重卡喉發呆警報' : '⚠️ L3 需注意警示');
    desc.innerText = msg;
    overlay.classList.remove('hidden');
}

function dismissAlertOverlay() {
    document.getElementById('alert-overlay').classList.add('hidden');
    stopBuzzerSound();
    activeAlertLevel = null;
    activeAlertMessage = null;
    activeAlertBaseMessage = null;
}

function playBuzzerAlarm() {
    if (audioBuzzerInterval) return;
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        audioBuzzerInterval = setInterval(() => {
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
    if (audioBuzzerInterval) {
        clearInterval(audioBuzzerInterval);
        audioBuzzerInterval = null;
    }
}

function updateRiskBadge() {
    const badge = document.getElementById('risk-badge');
    if (mealMetrics.riskLevel === 'HIGH_RISK') {
        badge.className = 'font-bold text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/30';
        badge.innerText = '🔴 高風險';
    } else if (mealMetrics.riskLevel === 'ATTENTION') {
        badge.className = 'font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/30';
        badge.innerText = '🟡 需注意';
    } else {
        badge.className = 'font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30';
        badge.innerText = '🟢 正常';
    }
}

// 9. Supabase 日誌紀錄與動態基準更新
async function logAnomalyToSupabase(level, msg) {
    if (!supabaseClient || !isMealActive) return;
    const sessionInsertPromise = currentMealSessionInsertPromise;
    const eventMetrics = {
        jaw_velocity: parseFloat(mealMetrics.jawVelocity.toFixed(2)),
        audio_energy: 0.0,
        hands_on_neck: isHandOnNeck
    };
    let sessionId = mealSessionTracker.currentId;
    if (!sessionId) {
        try { sessionId = await sessionInsertPromise; }
        catch (e) { return; }
    }
    if (!sessionId || !supabaseClient) return;
    try {
        await supabaseClient.from('anomaly_logs').insert([{
            session_id: sessionId,
            event_type: level,
            ...eventMetrics,
            details: msg
        }]);
    } catch (e) {
        console.warn('[Supabase] Anomaly log bypassed:', e);
    }
}

async function updatePatientAdaptiveBaseline(newChewAvg) {
    if (!supabaseClient || !currentPatient.id) return;
    try {
        // 算出近3餐歷史平均
        const { data } = await supabaseClient.from('meal_sessions')
            .select('avg_chew_duration')
            .eq('patient_id', currentPatient.id)
            .order('created_at', { ascending: false })
            .limit(3);
        
        if (data && data.length >= 3) {
            const avg = data.reduce((sum, item) => sum + item.avg_chew_duration, 0) / data.length;
            await supabaseClient.from('patient_profiles').update({
                baseline_chew_duration: parseFloat(avg.toFixed(2))
            }).eq('id', currentPatient.id);
            console.log(`[Supabase] Dynamically updated patient baseline to ${avg.toFixed(2)}s`);
        }
    } catch (e) {
        console.warn('[Supabase] Adaptive baseline update failed:', e);
    }
}

// 10. WebRTC P2P 串流與 Supabase Realtime 信令
function setupWebRTCSignaling() {
    if (!supabaseClient || !currentPatient.id || !window.ConnectionCore) return;
    if (supabaseChannel) supabaseChannel.unsubscribe();
    patientRealtimeReady = false;
    remoteCandidateBuffer.clear();
    activeNegotiationId = null;
    activePeerClientId = null;
    pendingPeerClientId = null;
    activeOfferPayload = null;
    try {
        const topic = window.ConnectionCore.channelTopic(currentPatient.id);
        supabaseChannel = supabaseClient.channel(topic, window.ConnectionCore.privateChannelOptions());
        supabaseChannel
            .on('broadcast', { event: 'signal' }, async ({ payload }) => {
                if (payload.type === 'request_offer' && payload.profileId === currentPatient.id && payload.clientId) {
                    await startPeerConnection(payload.clientId);
                } else if (payload.type === 'answer' && peerConnection) {
                    if (payload.negotiationId !== activeNegotiationId || payload.clientId !== activePeerClientId) return;
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
                    activeOfferPayload = null;
                    await flushRemoteCandidates(peerConnection, activeNegotiationId, activePeerClientId);
                } else if (payload.type === 'candidate') {
                    await receiveRemoteCandidate(payload);
                }
            })
            .subscribe((status) => {
                patientRealtimeReady = status === 'SUBSCRIBED';
                if (status === 'SUBSCRIBED' && supabaseChannel) {
                    supabaseChannel.send({
                        type: 'broadcast',
                        event: 'signal',
                        payload: { type: 'patient_ready', profileId: currentPatient.id }
                    });
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                    console.warn('[Realtime] Patient channel status:', status);
                }
            });
    } catch (error) {
        patientRealtimeReady = false;
        console.error('[Realtime] Patient channel setup failed:', error);
    }
}

async function receiveRemoteCandidate(payload) {
    if (!payload?.candidate || !payload.negotiationId || payload.clientId !== activePeerClientId) return;
    if (activeNegotiationId && payload.negotiationId !== activeNegotiationId) return;
    if (!peerConnection || !peerConnection.remoteDescription) {
        remoteCandidateBuffer.enqueue(payload);
        return;
    }
    try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
    } catch (error) {
        console.warn('[WebRTC] Candidate was not accepted:', error);
    }
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

async function sendActiveOffer() {
    if (!supabaseChannel || !patientRealtimeReady || !activeOfferPayload) return;
    const status = await supabaseChannel.send({
        type: 'broadcast',
        event: 'signal',
        payload: activeOfferPayload
    });
    if (status !== 'ok') console.warn('[WebRTC] Offer send status:', status);
}

async function startPeerConnection(clientId) {
    if (!webcamStream || !supabaseChannel || !patientRealtimeReady || !clientId) return;
    if (peerOfferInProgress) {
        if (clientId === activePeerClientId) resendOfferAfterCreation = true;
        else pendingPeerClientId = clientId;
        return;
    }
    const connectionState = peerConnection && peerConnection.connectionState;
    const reusable = peerConnection && !['failed', 'closed', 'disconnected'].includes(connectionState);
    if (reusable && activePeerClientId === clientId) {
        if (activeOfferPayload) await sendActiveOffer();
        return;
    }

    if (peerConnection) peerConnection.close();
    remoteCandidateBuffer.clear();
    activePeerClientId = clientId;
    activeNegotiationId = crypto.randomUUID();
    activeOfferPayload = null;
    resendOfferAfterCreation = false;
    peerOfferInProgress = true;
    try {
        const negotiationId = activeNegotiationId;
        peerConnection = new RTCPeerConnection(CONFIG.RTC_CONFIG);
        webcamStream.getTracks().forEach(track => peerConnection.addTrack(track, webcamStream));

        peerConnection.onicecandidate = async (event) => {
            if (event.candidate && supabaseChannel && patientRealtimeReady) {
                await supabaseChannel.send({
                    type: 'broadcast',
                    event: 'signal',
                    payload: { type: 'candidate', candidate: event.candidate, negotiationId, clientId }
                });
            }
        };

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        activeOfferPayload = { type: 'offer', sdp: offer, negotiationId, clientId };
        await sendActiveOffer();
    } catch (error) {
        if (peerConnection) peerConnection.close();
        peerConnection = null;
        activeNegotiationId = null;
        activePeerClientId = null;
        activeOfferPayload = null;
        resendOfferAfterCreation = false;
        console.error('[WebRTC] PeerConnection offer error:', error);
    } finally {
        peerOfferInProgress = false;
        const pendingClient = pendingPeerClientId;
        pendingPeerClientId = null;
        if (pendingClient && pendingClient !== activePeerClientId) {
            await startPeerConnection(pendingClient);
            return;
        }
        if (resendOfferAfterCreation && activeOfferPayload) {
            resendOfferAfterCreation = false;
            await sendActiveOffer();
        }
    }
}

async function broadcastSystemState(force = false, sessionEnded = false) {
    if (!supabaseChannel || !patientRealtimeReady) return;
    const now = performance.now();
    if (!force && now - lastStateBroadcastAt < 250) return;
    lastStateBroadcastAt = now;
    try {
        await supabaseChannel.send({
            type: 'broadcast',
            event: 'state_update',
            payload: {
                patientCode: currentPatient.patient_code,
                patientName: currentPatient.full_name,
                dietType: currentDiet,
                totalChews: mealMetrics.totalChews,
                totalSwallows: mealMetrics.swallowCount || 0,
                jawVelocity: parseFloat(mealMetrics.jawVelocity.toFixed(2)),
                pouchingEvents: mealMetrics.pouchingEvents,
                coughEvents: (mealMetrics.coughCount || 0) + (mealMetrics.coughCountL2 || 0),
                activeAlertLevel: sessionEnded ? null : activeAlertLevel,
                activeAlertMessage: sessionEnded ? null : activeAlertMessage,
                isHandOnNeck: isHandOnNeck,
                sessionEnded
            }
        });
    } catch (error) {
        console.warn('[Realtime] State broadcast failed:', error);
    }
}

// =============================================================================
// 獨立核心偵測演算法模組 (Ported from Standalone Detection Core Module)
// =============================================================================

// 1. 手抓喉嚨與胸口拍胸手勢偵測 (與視覺疊圖 100% 共用同一組像素圓心與半徑)
function estimateThroat(nose, chin, extend = 0.50) {
    const tx = chin.x + extend * (chin.x - nose.x);
    const ty = chin.y + extend * (chin.y - nose.y);
    return { x: tx, y: ty };
}

function estimateChest(nose, chin, extend = 1.15) {
    const cx = chin.x + extend * (chin.x - nose.x);
    const cy = chin.y + extend * (chin.y - nose.y);
    return { x: cx, y: cy };
}

function getDangerZoneGeometry(nose, chin, w, h) {
    const faceV = Math.hypot((chin.x - nose.x) * w, (chin.y - nose.y) * h);
    const throat = estimateThroat(nose, chin, 0.50);
    const chest = estimateChest(nose, chin, 1.15);
    return {
        faceV,
        throatCenter: { x: throat.x * w, y: throat.y * h },
        throatRadius: Math.max(faceV * 0.65, 22.0),
        chestCenter: { x: chest.x * w, y: chest.y * h },
        chestRadius: Math.max(faceV * 1.15, 40.0)
    };
}

function handNearChestOrThroat(hands, nose, chin, w, h, minPts = 2) {
    if (!nose || !chin) {
        return { near: false, isChest: false, isThroat: false, handsInZone: 0, chestCenter: null, chestRadius: 0, throatCenter: null, throatRadius: 0 };
    }
    const geom = getDangerZoneGeometry(nose, chin, w, h);
    if (!hands || hands.length === 0) {
        return { near: false, isChest: false, isThroat: false, handsInZone: 0, ...geom };
    }

    const reqPts = Math.max(1, Math.floor(Number(minPts) || 2));
    let isThroat = false;
    let isChest = false;
    let handsInZone = 0;

    for (const hand of hands) {
        let ptsInThroat = 0;
        let ptsInChest = 0;
        let ptsInEither = 0;
        for (const pt of hand) {
            const px = pt.x * w;
            const py = pt.y * h;

            const inThroat = Math.hypot(px - geom.throatCenter.x, py - geom.throatCenter.y) < geom.throatRadius;
            const inChest = Math.hypot(px - geom.chestCenter.x, py - geom.chestCenter.y) < geom.chestRadius;
            if (inThroat) ptsInThroat++;
            if (inChest) ptsInChest++;
            if (inThroat || inChest) ptsInEither++;
        }
        if (ptsInThroat >= reqPts) isThroat = true;
        if (ptsInChest >= reqPts) isChest = true;
        if (ptsInEither >= reqPts) handsInZone++;
    }
    return {
        near: Boolean(isThroat || isChest || handsInZone > 0),
        isChest,
        isThroat,
        handsInZone,
        ...geom
    };
}

// 2. 身體持續掙扎晃動分析 (支援低幀率手機裝置，放寬至自然痛苦掙扎/俯仰幅度，同時過濾靜態微晃)
function checkContinuousBodyShaking(nose, faceSize, currentTime, w, h) {
    if (!nose || faceSize <= 0) return false;

    bodyMotionHistory.push({
        x: nose.x,
        y: nose.y,
        faceSize: faceSize,
        time: currentTime
    });

    // 保留最近 1.4 秒內的軌跡
    while (bodyMotionHistory.length > 0 && (currentTime - bodyMotionHistory[0].time > 1.4)) {
        bodyMotionHistory.shift();
    }

    // 修正低 FPS 裝置鎖死問題：最少 4 幀且時間跨度 >= 0.45 秒即可評估（5-8 FPS 手機亦能正常觸發）
    if (bodyMotionHistory.length < 4) {
        return false;
    }
    const windowSpanSec = bodyMotionHistory[bodyMotionHistory.length - 1].time - bodyMotionHistory[0].time;
    if (windowSpanSec < 0.45) {
        return false;
    }

    let minX = 1e9, maxX = -1e9;
    let minY = 1e9, maxY = -1e9;
    let minSize = 1e9, maxSize = -1e9;
    let totalSpeed = 0.0;

    for (let i = 0; i < bodyMotionHistory.length; i++) {
        const p = bodyMotionHistory[i];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        if (p.faceSize < minSize) minSize = p.faceSize;
        if (p.faceSize > maxSize) maxSize = p.faceSize;

        if (i > 0) {
            const prev = bodyMotionHistory[i - 1];
            const dx = (p.x - prev.x) * w;
            const dy = (p.y - prev.y) * h;
            const stepSpeed = Math.hypot(dx, dy) / p.faceSize;
            totalSpeed += stepSpeed;
        }
    }

    const xDirectionReversals = window.ConnectionCore.countDirectionReversals(
        bodyMotionHistory.map(point => point.x * w), 2.0
    );
    const yDirectionReversals = window.ConnectionCore.countDirectionReversals(
        bodyMotionHistory.map(point => point.y * h), 2.0
    );
    const xSpan = (maxX - minX) * w / faceSize;
    const ySpan = (maxY - minY) * h / faceSize;
    const sizeSpan = (maxSize - minSize) / faceSize;

    // 判定痛苦掙扎晃動／前後俯仰：
    // - 至少 1 次方向折返或明顯前後俯仰尺度變化 (sizeSpan > 0.14)
    // - 位移跨度達 0.12 倍臉長以上
    // - 視窗內累計無因次化速度 > 1.2
    const hasDirectionReversal = (xDirectionReversals >= 1 || yDirectionReversals >= 1 || sizeSpan > 0.14);
    const hasSignificantSpan = (xSpan > 0.12 || ySpan > 0.12 || sizeSpan > 0.12);
    const hasSustainedSpeed = (totalSpeed > 1.2);

    return (hasSignificantSpan && hasSustainedSpeed && hasDirectionReversal);
}

function handNearThroat(hands, nose, chin, w, h, radiusScale = 0.6) {
    const res = handNearChestOrThroat(hands, nose, chin, w, h);
    return res.isThroat;
}

// 3. 嘴部開合角度 (MAR)
function calculateMAR(lipTop, lipBottom, lipLeft, lipRight) {
    const vDist = Math.hypot(lipTop.x - lipBottom.x, lipTop.y - lipBottom.y);
    const hDist = Math.hypot(lipLeft.x - lipRight.x, lipLeft.y - lipRight.y);
    if (hDist <= 0) return 0.0;
    return vDist / hDist;
}

function calculateBodyShaking(noseHistory, faceSize) {
    return isBodyShakingContinuous ? 2.5 : 0.0;
}

// 3. 嘴唇藍光比率與發紺缺氧分析 (Cyanosis Detection)
function blueness(lipRGB) {
    const [r, g, b] = lipRGB;
    const s = r + g + b;
    if (s <= 0) return 0.0;
    return b / s;
}

function isCyanotic(lipRGB, blueTh = 0.38) {
    return blueness(lipRGB) >= blueTh;
}

// =============================================================================
// MediaPipe Face & Hand Skeleton Rendering Helpers
// =============================================================================

const FACE_OVAL_INDICES = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10];
const LIPS_OUTER_INDICES = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78, 61];
const LIPS_INNER_INDICES = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78];
const LEFT_EYE_INDICES = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 33];
const RIGHT_EYE_INDICES = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466, 263];
const LEFT_EYEBROW_INDICES = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
const RIGHT_EYEBROW_INDICES = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];
const NOSE_INDICES = [168, 6, 197, 195, 5, 4, 1, 19, 94, 2];

const HAND_CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [9,10],[10,11],[11,12],[0,9],
    [13,14],[14,15],[15,16],[0,13],
    [17,18],[18,19],[19,20],[0,17],
    [5,9],[9,13],[13,17]
];

function drawPath(ctx, landmarks, indices, color, lineWidth = 1.5, fillStyle = null) {
    if (!landmarks || indices.length === 0) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    let first = true;
    for (const idx of indices) {
        const pt = landmarks[idx];
        if (!pt) continue;
        const x = pt.x * ctx.canvas.width;
        const y = pt.y * ctx.canvas.height;
        if (first) {
            ctx.moveTo(x, y);
            first = false;
        } else {
            ctx.lineTo(x, y);
        }
    }
    if (fillStyle) {
        ctx.fillStyle = fillStyle;
        ctx.fill();
    }
    ctx.stroke();
}

function drawFaceMeshSkeleton(ctx, landmarks, w, h) {
    if (!landmarks) return;

    // 1. 臉廓、眼睛、眉毛、鼻子 (淡藍色細骨架)
    drawPath(ctx, landmarks, FACE_OVAL_INDICES, 'rgba(56, 189, 248, 0.5)', 1.2);
    drawPath(ctx, landmarks, LEFT_EYE_INDICES, 'rgba(56, 189, 248, 0.7)', 1.2);
    drawPath(ctx, landmarks, RIGHT_EYE_INDICES, 'rgba(56, 189, 248, 0.7)', 1.2);
    drawPath(ctx, landmarks, LEFT_EYEBROW_INDICES, 'rgba(56, 189, 248, 0.6)', 1.2);
    drawPath(ctx, landmarks, RIGHT_EYEBROW_INDICES, 'rgba(56, 189, 248, 0.6)', 1.2);
    drawPath(ctx, landmarks, NOSE_INDICES, 'rgba(56, 189, 248, 0.6)', 1.2);

    // 2. 嘴唇輪廓 (亮翡翠綠，高亮顯示咀嚼與 MAR 狀態)
    drawPath(ctx, landmarks, LIPS_OUTER_INDICES, '#34d399', 2.2, 'rgba(52, 211, 153, 0.15)');
    drawPath(ctx, landmarks, LIPS_INNER_INDICES, '#10b981', 1.8);

    // 3. 重點特徵亮點 (下巴 152、鼻尖 1、唇上下左右 13, 14, 61, 291)
    const keyIndices = [1, 152, 13, 14, 61, 291];
    for (const idx of keyIndices) {
        const pt = landmarks[idx];
        if (!pt) continue;
        const px = pt.x * w;
        const py = pt.y * h;
        ctx.fillStyle = (idx === 13 || idx === 14) ? '#fbbf24' : '#38bdf8';
        ctx.beginPath();
        ctx.arc(px, py, 3.5, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawHandSkeleton(ctx, handLandmarksList, w, h, isHandOnNeck = false) {
    if (!handLandmarksList || handLandmarksList.length === 0) return;

    for (const hand of handLandmarksList) {
        // 連線顏色：觸發手抓脖子為玫瑰紅 (#f43f5e)，正常為翡翠綠 (#34d399)
        const lineColor = isHandOnNeck ? '#f43f5e' : '#34d399';
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = isHandOnNeck ? 3.0 : 2.0;

        for (const conn of HAND_CONNECTIONS) {
            const p1 = hand[conn[0]];
            const p2 = hand[conn[1]];
            if (!p1 || !p2) continue;
            ctx.beginPath();
            ctx.moveTo(p1.x * w, p1.y * h);
            ctx.lineTo(p2.x * w, p2.y * h);
            ctx.stroke();
        }

        // 關節點 (亮白圓點)
        for (const pt of hand) {
            const px = pt.x * w;
            const py = pt.y * h;
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = lineColor;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(px, py, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    }
}

// =============================================================================
// 原版 UI Overlay 與 HUD 視覺繪製 Helper Functions
// =============================================================================

function updateHudStats(stateStr, marVal, jawStdVal, chewCnt, swallowCnt, jawVelVal, fusionScore, simultaneousDuration = 0.0) {
    const elState = document.getElementById('hud-state');
    if (elState) {
        elState.innerText = stateStr;
        if (stateStr === 'CHEW') elState.className = 'font-bold text-emerald-300 animate-pulse';
        else if (stateStr === 'SWALLOW') elState.className = 'font-bold text-blue-300 animate-bounce';
        else if (stateStr === 'INGEST') elState.className = 'font-bold text-amber-300';
        else elState.className = 'font-bold text-slate-300';
    }

    const elMar = document.getElementById('hud-mar');
    if (elMar) elMar.innerText = marVal.toFixed(2);

    const elJawStd = document.getElementById('hud-jaw-std');
    if (elJawStd) elJawStd.innerText = jawStdVal.toFixed(2);

    const elChews = document.getElementById('hud-chews');
    if (elChews) elChews.innerText = `${Math.floor(chewCnt)} 次`;

    const elSwallows = document.getElementById('hud-swallows');
    if (elSwallows) elSwallows.innerText = `${swallowCnt} 次`;

    const elJawVel = document.getElementById('hud-jaw-vel');
    if (elJawVel) elJawVel.innerText = jawVelVal.toFixed(2);

    const elFusion = document.getElementById('hud-fusion-score');
    if (elFusion) elFusion.innerText = `${fusionScore.toFixed(2)} / 1.0`;

    const elShake = document.getElementById('hud-shake-timer');
    if (elShake) {
        if (simultaneousDuration > 0) {
            elShake.innerText = `${simultaneousDuration.toFixed(1)}s / ${CHOKE_SIMULTANEOUS_TRIGGER_SEC.toFixed(1)}s`;
            elShake.className = simultaneousDuration >= 2.0 ? 'font-mono text-rose-400 font-bold animate-pulse' : 'font-mono text-amber-400 font-bold';
        } else {
            elShake.innerText = `0.0s / ${CHOKE_SIMULTANEOUS_TRIGGER_SEC.toFixed(1)}s (正常)`;
            elShake.className = 'font-mono text-emerald-400';
        }
    }
}

function drawOriginalDetectionOverlay(ctx, landmarks, handLandmarks, w, h, stateStr, marVal, jawStdVal, chewCnt, isHandOnNeck = false, isHandOnChest = false, isBodyShaking = false, simultaneousSec = 0.0) {
    if (landmarks) {
        // 🎯 1. 繪製 MediaPipe 臉部 3D 全骨架與特徵網格 (藍色面輪廓、眼睛、眉毛、雙唇)
        drawFaceMeshSkeleton(ctx, landmarks, w, h);

        const chin = landmarks[152];
        const nose = landmarks[4];
        const p13 = landmarks[13];
        const p14 = landmarks[14];
        const p78 = landmarks[78];
        const p308 = landmarks[308];
        const faceH = Math.abs(chin.y - nose.y);

        // 1. 繪製嘴部外圈紅線輪廓
        const outerIdx = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < outerIdx.length; i++) {
            const pt = landmarks[outerIdx[i]];
            if (i === 0) ctx.moveTo(pt.x * w, pt.y * h);
            else ctx.lineTo(pt.x * w, pt.y * h);
        }
        ctx.closePath();
        ctx.stroke();

        // 2. 繪製關鍵特徵點 (綠點: 13, 14, 78, 308, 4, 152)
        const greenDots = [13, 14, 78, 308, 4, 152];
        ctx.fillStyle = '#22c55e';
        for (const idx of greenDots) {
            const pt = landmarks[idx];
            if (!pt) continue;
            ctx.beginPath();
            ctx.arc(pt.x * w, pt.y * h, 4, 0, Math.PI * 2);
            ctx.fill();
        }

        // 藍色上下唇連線 (#13 to #14)
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p13.x * w, p13.y * h);
        ctx.lineTo(p14.x * w, p14.y * h);
        ctx.stroke();

        // 紅色臉部縱向主軸 (#4 to #152)
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        ctx.moveTo(nose.x * w, nose.y * h);
        ctx.lineTo(chin.x * w, chin.y * h);
        ctx.stroke();

        // 3 & 4. 繪製與碰撞判定 100% 同幾何的 Throat Zone 與 Chest Zone
        const zoneGeom = getDangerZoneGeometry(nose, chin, w, h);
        const throatX = zoneGeom.throatCenter.x;
        const throatY = zoneGeom.throatCenter.y;
        const throatR = zoneGeom.throatRadius;

        ctx.strokeStyle = isHandOnNeck ? '#f43f5e' : '#d946ef';
        ctx.lineWidth = isHandOnNeck ? 3.5 : 1.8;
        ctx.beginPath();
        ctx.arc(throatX, throatY, throatR, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = isHandOnNeck ? '#f43f5e' : '#d946ef';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText('Throat Zone (喉嚨)', throatX - 40, throatY - throatR - 5);

        const chestX = zoneGeom.chestCenter.x;
        const chestY = zoneGeom.chestCenter.y;
        const chestR = zoneGeom.chestRadius;

        ctx.strokeStyle = isHandOnChest ? '#f43f5e' : 'rgba(56, 189, 248, 0.7)';
        ctx.lineWidth = isHandOnChest ? 3.5 : 1.8;
        ctx.beginPath();
        ctx.arc(chestX, chestY, chestR, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = isHandOnChest ? '#f43f5e' : '#38bdf8';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText('Chest Zone (胸口)', chestX - 42, chestY - chestR - 5);

        // 5. 繪製手部 21 關節骨架 (若摸喉或拍胸均高亮為玫瑰紅)
        if (handLandmarks && handLandmarks.length > 0) {
            drawHandSkeleton(ctx, handLandmarks, w, h, (isHandOnNeck || isHandOnChest));
        }

        // 6. 吞嚥狀態大字提示 (SWALLOWING...)
        if (stateStr === 'SWALLOW') {
            ctx.fillStyle = '#ef4444';
            ctx.font = 'bold 28px sans-serif';
            ctx.fillText('SWALLOWING...', 20, h - 30);
        }

        // 🎯 7. L4 急性哽噎風險累積進度條 (3.0s 門檻 + 漸進衰減)
        if (simultaneousSec > 0) {
            const barW = Math.min(w * 0.85, 340);
            const barH = 34;
            const barX = (w - barW) / 2;
            const barY = 18;
            const progress = Math.min(1.0, simultaneousSec / CHOKE_SIMULTANEOUS_TRIGGER_SEC);

            ctx.save();
            // 背景外框
            ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
            ctx.strokeStyle = progress >= 0.75 ? '#ef4444' : '#f59e0b';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(barX, barY, barW, barH + 18, 12);
            } else {
                ctx.rect(barX, barY, barW, barH + 18);
            }
            ctx.fill();
            ctx.stroke();

            // 倒數文字
            ctx.fillStyle = '#fef08a';
            ctx.font = 'bold 13px sans-serif';
            ctx.fillText(
                `⚠️ 急性哽噎風險累積: ${simultaneousSec.toFixed(1)}s / ${CHOKE_SIMULTANEOUS_TRIGGER_SEC.toFixed(1)}s`,
                barX + 16,
                barY + 20
            );

            // 填滿進度條
            const fillW = (barW - 32) * progress;
            ctx.fillStyle = progress >= 0.75 ? '#ef4444' : '#f59e0b';
            ctx.fillRect(barX + 16, barY + 28, fillW, 8);
            ctx.restore();
        }

    } else {
        // 人臉遺失大字提示 (NO FACE DETECTED)
        ctx.fillStyle = '#ef4444';
        ctx.font = 'bold 24px sans-serif';
        ctx.fillText('NO FACE DETECTED', w * 0.25, h * 0.5);

        if (handLandmarks && handLandmarks.length > 0) {
            drawHandSkeleton(ctx, handLandmarks, w, h, isHandOnNeck);
        }
    }
}
