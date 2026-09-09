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
let currentPatient = { id: null, patient_code: 'P001', full_name: '王爺爺', diet_type: 'soft', baseline_chew: 0.85, baseline_swallow: 1.10 };
let currentDiet = 'soft'; // regular, soft, pureed
let isMealActive = false;
let currentSessionId = null;

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

let lastCoughTime = 0.0;
let handOnNeckStartTime = null;
let handOnNeckDuration = 0.0;
let lastChokeAlertTime = 0.0;

let prevNose = null;
let noseSpeedHistory = []; // max len 30
let lastChewFlipTime = 0.0;
let coughFrameCounter = 0;
let faceLostSince = null;

let lastNose = null;
let lastChin = null;
let lastAnchorTs = 0.0;
const ANCHOR_GRACE_SEC = 2.0;
const FACE_LOST_ALERT_SEC = 3.0;

// 🎯 身體晃動與拍胸五秒哽噎判定狀態 (防止晃動過敏，嚴格要求同時持續5秒)
let bodyMotionHistory = []; // { x, y, faceSize, time }
let isBodyShakingContinuous = false;
let isHandOnChest = false;
let isHandOnChestOrThroat = false;
let chokeSimultaneousStartTime = null;
let chokeSimultaneousDuration = 0.0;
let chokeGraceStartTime = null;
const CHOKE_SIMULTANEOUS_TRIGGER_SEC = 5.0; // 必須同時持續滿 5 秒

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
    coughCountL1: 0,
    coughCountL2: 0,
    chokingEventsL3: 0,
    pouchingEvents: 0,
    riskLevel: 'NORMAL'
};

// 手部與脖子狀態
let isHandOnNeck = false;
let activeAlertLevel = null;
let audioBuzzerInterval = null;

// 獨立核心偵測演算法模組實例 (Standalone Detection Core)
let noseHistory = [];
const silentChokeDetector = new SilentChokeDetector(3.0);
const evidenceFusion = new EvidenceFusion(5.0, 1.0, 10.0);

// WebRTC 串流連線變數
let peerConnection = null;
let supabaseChannel = null;

// 初始化啟動 (安全支援 DOMContentLoaded 與已就緒狀態)
function startApp() {
    initSupabase();
    setupCanvasAndVideo();
    initMediaPipe();
    openLoginModal();
    if (window._selectedPatient) {
        loginAsPatient(window._selectedPatient.code, window._selectedPatient.nameStr);
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
        if (window.supabase && CONFIG.SUPABASE_URL && !CONFIG.SUPABASE_URL.includes('xyzcompany')) {
            supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
            console.log('[Supabase] Successfully connected to live backend.');
        } else {
            console.warn('[Supabase] Running in Standalone / Fallback mode.');
        }
    } catch (e) {
        console.error('[Supabase] Initialization error:', e);
    }
}

// 3. UI 互動與質地切換
function selectDiet(dietKey) {
    currentDiet = dietKey;
    document.querySelectorAll('.diet-btn').forEach(btn => btn.classList.remove('active', 'bg-blue-600', 'text-white'));
    const activeBtn = document.getElementById(`btn-diet-${dietKey}`);
    if (activeBtn) {
        activeBtn.classList.add('active', 'bg-blue-600', 'text-white');
    }
    const dietInfo = CONFIG.DIET_PROFILES[dietKey];
    document.getElementById('hud-diet').innerText = dietInfo ? dietInfo.name : dietKey;
}

function openLoginModal() {
    const modal = document.getElementById('login-modal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.remove('hidden');
    }
}

function closeLoginModal() {
    const modal = document.getElementById('login-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
}

function loginAsPatient(code, nameStr) {
    try {
        console.log(`[Login] Selected patient: ${nameStr} (${code})`);
        currentPatient.patient_code = code;
        currentPatient.full_name = nameStr;
        
        const label = document.getElementById('current-patient-label');
        if (label) label.innerText = `${nameStr} (${code})`;

        // 1. 立即關閉對話框與更新選單 UI (絕不安靜卡死)
        closeLoginModal();

        // 2. 異步非阻塞啟動相機
        setTimeout(() => {
            if (!isMealActive) {
                startMealSession().catch(err => {
                    console.warn('[Camera] Gracefully handled startup error:', err);
                });
            }
        }, 30);

        // 3. 背景非同步載入 Supabase 個案檔案與個人化基準
        if (supabaseClient) {
            supabaseClient
                .from('patient_profiles')
                .select('*')
                .eq('patient_code', code)
                .single()
                .then(({ data }) => {
                    if (data) {
                        currentPatient.id = data.id;
                        currentPatient.diet_type = data.diet_type || 'soft';
                        currentPatient.baseline_chew = data.baseline_chew_duration || 0.85;
                        currentPatient.baseline_swallow = data.baseline_swallow_pause || 1.10;
                        selectDiet(currentPatient.diet_type);
                        console.log(`[Supabase] Loaded patient baseline: chew=${data.baseline_chew_duration}s`);
                    }
                })
                .catch((err) => {
                    console.warn('[Supabase] Could not fetch profile, using local defaults:', err);
                });
        }

        // 4. 初始化 WebRTC 信令頻道
        setupWebRTCSignaling();

    } catch (e) {
        console.error('[Login] Error in loginAsPatient:', e);
        closeLoginModal();
    }
}

// 🎯 全域 Window 顯式綁定 (全瀏覽器與載入時序雙重保險)
window.selectDiet = selectDiet;
window.openLoginModal = openLoginModal;
window.closeLoginModal = closeLoginModal;
window.loginAsPatient = loginAsPatient;
window._fullLoginAsPatient = loginAsPatient;
window.startMealSession = startMealSession;
window.endMealSession = endMealSession;
window.dismissAlertOverlay = dismissAlertOverlay;

// 🎯 事件委派 (Event Delegation Backup) - 防止舊快取或內聯 onclick 失敗
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
    if (isMealActive && webcamStream) {
        console.log('[Camera] Meal session already active.');
        return;
    }

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
            coughCountL1: 0,
            coughCountL2: 0,
            chokingEventsL3: 0,
            pouchingEvents: 0,
            riskLevel: 'NORMAL'
        };

        isMealActive = true;
        const btnStart = document.getElementById('btn-start-meal');
        const btnEnd = document.getElementById('btn-end-meal');

        if (btnStart) {
            btnStart.disabled = true;
            btnStart.classList.add('opacity-50', 'cursor-not-allowed');
        }
        if (btnEnd) {
            btnEnd.disabled = false;
            btnEnd.classList.remove('opacity-50', 'cursor-not-allowed', 'bg-slate-800', 'text-slate-500');
            btnEnd.classList.add('bg-rose-600', 'text-white', 'hover:bg-rose-500');
        }

        const mealStatusText = document.getElementById('meal-status-text');
        if (mealStatusText) mealStatusText.innerText = '用餐中 🍽️';

        // 於 Supabase 寫入新用餐紀錄
        if (supabaseClient) {
            try {
                const { data } = await supabaseClient.from('meal_sessions').insert([{
                    patient_id: currentPatient.id,
                    diet_type: currentDiet,
                    start_time: new Date().toISOString(),
                    risk_level: 'NORMAL'
                }]).select().single();
                if (data) currentSessionId = data.id;
            } catch (err) {
                console.warn('[Supabase] Meal session log insert bypassed:', err);
            }
        }

        // 開始影音串流與 WebRTC P2P
        setupWebRTCSignaling();

        // 啟動逐幀監測迴圈
        requestAnimationFrame(processVideoFrame);

    } catch (err) {
        console.error('Camera/Mic permission failed:', err);
        isMealActive = false;
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
    }
}

async function endMealSession() {
    if (!isMealActive) return;
    isMealActive = false;

    // 計算總用餐時長與平均咀嚼時間
    const endTime = new Date();
    const durationSec = Math.round((endTime - mealMetrics.startTime) / 1000);
    const avgChewTime = mealMetrics.chewDurations.length > 0 
        ? (mealMetrics.chewDurations.reduce((a,b)=>a+b, 0) / mealMetrics.chewDurations.length) 
        : currentPatient.baseline_chew;

    // 更新 UI 狀態
    document.getElementById('btn-start-meal').disabled = false;
    document.getElementById('btn-start-meal').classList.remove('opacity-50', 'cursor-not-allowed');
    document.getElementById('btn-end-meal').disabled = true;
    document.getElementById('btn-end-meal').classList.add('opacity-50', 'cursor-not-allowed');
    document.getElementById('meal-status-text').innerText = '用餐結束 ⏹️';

    // 寫入 Supabase 用餐場次總結與更新動態校正基準
    if (supabaseClient && currentSessionId) {
        try {
            await supabaseClient.from('meal_sessions').update({
                end_time: endTime.toISOString(),
                total_duration_sec: durationSec,
                total_chew_count: mealMetrics.totalChews,
                avg_chew_duration: parseFloat(avgChewTime.toFixed(2)),
                cough_count_l1: mealMetrics.coughCountL1,
                cough_count_l2: mealMetrics.coughCountL2,
                choking_events_l3: mealMetrics.chokingEventsL3,
                pouching_events: mealMetrics.pouchingEvents,
                risk_level: mealMetrics.riskLevel
            }).eq('id', currentSessionId);

            // 更新個案個人化動態基準 (3餐自適應平均值)
            await updatePatientAdaptiveBaseline(avgChewTime);
        } catch (err) {
            console.warn('[Supabase] Failed to update session completion:', err);
        }
    }

    // 關閉相機與 WebRTC
    if (webcamStream) {
        webcamStream.getTracks().forEach(t => t.stop());
        webcamStream = null;
    }
    stopBuzzerSound();
    alert(`用餐完成！\n總時間: ${durationSec} 秒\n累積咀嚼: ${mealMetrics.totalChews} 次\n平均單次咀嚼耗時: ${avgChewTime.toFixed(2)} 秒`);
}

// 6. Web Audio API 聲學分析
function setupAudioAnalyzer(stream) {
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(stream);
        audioAnalyser = audioCtx.createAnalyser();
        audioAnalyser.fftSize = 256;
        source.connect(audioAnalyser);

        audioDataArray = new Uint8Array(audioAnalyser.frequencyBinCount);
    } catch (e) {
        console.error('[Audio] Analyser setup error:', e);
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

        // 🎯 手抓喉嚨與胸口拍胸手勢偵測
        const handCheck = handNearChestOrThroat(handLandmarks, nose, chin, w, h);
        isHandOnNeck = handCheck.isThroat;
        isHandOnChest = handCheck.isChest;
        isHandOnChestOrThroat = handCheck.near;

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

        // 🎯 身體持續前後左右晃動分析 (嚴格過濾一般日常微幅晃動與進食咀嚼)
        const faceSize = Math.hypot((nose.x - chin.x) * w, (nose.y - chin.y) * h);
        isBodyShakingContinuous = checkContinuousBodyShaking(nose, faceSize, currentTime, w, h);
        prevNose = { x: nose.x, y: nose.y };

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
            } else if ((currentTime - stateStartTime) > 4.0) {
                const warnMsg = "⚠️【哽噎預警】咀嚼超過 4 秒仍未吞嚥，請注意！";
                console.warn(warnMsg);
                triggerAlertLevel('L2', warnMsg);
                stateStartTime = currentTime; // 重置避免連續洗版
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

        // S1. 無聲窒息偵測
        if (silentChokeDetector.update(mar, movementStd, audioEnergy, 0.15, 0.8, 0.02)) {
            triggerAlertLevel('L4', '【緊急】疑似無聲窒息！嘴張開、靜止且無聲音持續，請立即確認呼吸道！');
        }

        // S3. 多模態證據融合
        evidenceFusion.observe("audio", (audioEnergy * 2.0));
        if (isHandOnNeck) evidenceFusion.observe("gesture", 0.6);
        if (mar > 0.15 && movementStd < 0.8) evidenceFusion.observe("still_open", 0.3);

        if (evidenceFusion.check()) {
            triggerAlertLevel('L4', '【緊急・多模態】綜合證據(聲音/手勢/嘴開靜止)達警戒，高度疑似窒息！');
        }

        // 🎯 繪製原版 Detection Overlay (嘴部紅圈、關鍵特徵點、Throat Zone 紫色圈、Chest Zone、大字提示)
        drawOriginalDetectionOverlay(aiCtx, faceLandmarks, handLandmarks, w, h, currentState, mar, movementStd, mealMetrics.totalChews, isHandOnNeck, isHandOnChest, isBodyShakingContinuous, chokeSimultaneousDuration);

    } else {
        // 人臉遺失快取處理 (2.0 秒錨點快取手勢)
        if (lastNose && (currentTime - lastAnchorTs) < ANCHOR_GRACE_SEC) {
            isHandOnNeck = handNearThroat(handLandmarks, lastNose, lastChin, w, h, 0.6);
        } else {
            isHandOnNeck = false;
        }
        prevNose = null;
        noseSpeedHistory = [];
        coughFrameCounter = 0;

        if (isMealActive && (currentState === ST_INGEST || currentState === ST_CHEW || currentState === ST_SWALLOW)) {
            if (faceLostSince === null) {
                faceLostSince = currentTime;
            } else if (currentTime - faceLostSince > FACE_LOST_ALERT_SEC) {
                triggerAlertLevel('L3', '⚠️【異常警報】進食過程中人臉消失，請確認個案狀況！');
                faceLostSince = currentTime;
            }
        }

        // 繪製 NO FACE DETECTED
        drawOriginalDetectionOverlay(aiCtx, null, handLandmarks, w, h, currentState, 0, 0, mealMetrics.totalChews, isHandOnNeck, isHandOnChest, isBodyShakingContinuous, chokeSimultaneousDuration);
    }

    // ------------------------------------------------------------------
    // 🚨 哽噎與拍胸晃動 5 秒決策邏輯 (核心規則：晃動 + 拍胸 同時持續 5 秒才觸發警報)
    // ------------------------------------------------------------------
    const isSimultaneous = isBodyShakingContinuous && isHandOnChestOrThroat;

    if (isSimultaneous) {
        if (chokeSimultaneousStartTime === null) {
            chokeSimultaneousStartTime = currentTime;
        }
        chokeGraceStartTime = null;
        chokeSimultaneousDuration = currentTime - chokeSimultaneousStartTime;

        // 🎯 兩者同時持續做滿 5 秒才觸發警報！(嚴格遵守使用者指示，防晃動過敏)
        if (chokeSimultaneousDuration >= CHOKE_SIMULTANEOUS_TRIGGER_SEC) {
            if (currentTime - lastChokeAlertTime >= 10.0) {
                lastChokeAlertTime = currentTime;
                triggerAlertLevel('L4', '🚨【緊急・劇烈哽噎警報】身體持續前後左右晃動且手部在胸口拍胸持續滿 5 秒！請立即協助！');
                chokeSimultaneousStartTime = null;
                chokeSimultaneousDuration = 0.0;
            }
        }
    } else {
        // 給予 0.6 秒短暫辨識抖動緩衝，若中斷超過 0.6 秒則歸零重計
        if (chokeSimultaneousStartTime !== null) {
            if (chokeGraceStartTime === null) {
                chokeGraceStartTime = currentTime;
            } else if (currentTime - chokeGraceStartTime > 0.6) {
                chokeSimultaneousStartTime = null;
                chokeSimultaneousDuration = 0.0;
                chokeGraceStartTime = null;
            }
        }
    }

    // 輔助哽噎判斷：手抓握喉嚨持續 5 秒且伴隨咳嗽
    let coughDetectedThisFrame = visionCough;
    if (audioEnergy > 0.20) coughDetectedThisFrame = true;
    if (coughDetectedThisFrame) lastCoughTime = currentTime;

    if (isHandOnNeck) {
        if (handOnNeckStartTime === null) handOnNeckStartTime = currentTime;
        handOnNeckDuration = currentTime - handOnNeckStartTime;
    } else {
        handOnNeckStartTime = null;
        handOnNeckDuration = 0.0;
    }

    if (handOnNeckDuration >= 5.0 && (currentTime - lastCoughTime <= 5.0)) {
        if (currentTime - lastChokeAlertTime >= 10.0) {
            lastChokeAlertTime = currentTime;
            triggerAlertLevel('L4', '🚨【緊急・哽噎警報】手部抓握喉嚨持續 5 秒且伴隨咳嗽，判定為哽噎！請立即前往協助！');
            handOnNeckStartTime = null;
            handOnNeckDuration = 0.0;
        }
    } else if (visionCough || audioEnergy > 0.25) {
        // L1 / L2 合併為「嗆咳」 (靜默後台紀錄：取消劇烈晃動強制綁定，不跳 UI 彈窗、不閃紅橫幅)
        if (currentTime - (window._lastCoughLogTime || 0) >= 3.0) {
            window._lastCoughLogTime = currentTime;
            mealMetrics.coughCount = (mealMetrics.coughCount || 0) + 1;
            console.log("🤫【靜默後台紀錄】偵測到嗆咳（聲音咳嗽或影像頭部抽動），背景靜默紀錄，無彈窗、不閃紅橫幅。");
        }
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
function triggerAlertLevel(level, msg) {
    if (activeAlertLevel === level) return;
    activeAlertLevel = level;

    console.log(`[ALERT TRIGGERED] ${level}: ${msg}`);

    // 更新 Risk Level
    if (level === 'L4' || level === 'L2') mealMetrics.riskLevel = 'HIGH_RISK';
    else if (level === 'L3' && mealMetrics.riskLevel !== 'HIGH_RISK') mealMetrics.riskLevel = 'ATTENTION';

    updateRiskBadge();

    // Level 1: 播放溫和語音播報 ("請記得嚼一嚼吞下來喔")
    if (level === 'L1') {
        speakVoicePrompt("請記得嚼一嚼吞下來喔");
        mealMetrics.pouchingEvents++;
    }
    // Level 2 / L3 / L4: 彈窗 + 警示音 + 寫入 Supabase
    else {
        showAlertOverlay(level, msg);
        playBuzzerAlarm();
        if (level === 'L4') mealMetrics.coughCountL2++;
        if (level === 'L3') mealMetrics.chokingEventsL3++;
        if (level === 'L2') mealMetrics.pouchingEvents++;

        // 紀錄日誌至 Supabase
        logAnomalyToSupabase(level, msg);
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

    title.innerText = level === 'L4' ? '🚨 L4 急劇嗆咳爆發警報' : (level === 'L2' ? '🔴 L2 嚴重卡喉發呆警報' : '⚠️ L3 吞嚥前少咀嚼預警');
    desc.innerText = msg;
    overlay.classList.remove('hidden');
}

function dismissAlertOverlay() {
    document.getElementById('alert-overlay').classList.add('hidden');
    stopBuzzerSound();
    activeAlertLevel = null;
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
    if (!supabaseClient || !currentSessionId) return;
    try {
        await supabaseClient.from('anomaly_logs').insert([{
            session_id: currentSessionId,
            event_type: level,
            jaw_velocity: parseFloat(mealMetrics.jawVelocity.toFixed(2)),
            audio_energy: 0.0,
            hands_on_neck: isHandOnNeck,
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
    if (!supabaseClient) return;
    try {
        supabaseChannel = supabaseClient.channel(`webrtc-${currentPatient.patient_code}`);
        supabaseChannel
            .on('broadcast', { event: 'signal' }, async ({ payload }) => {
                if (payload.type === 'answer' && peerConnection) {
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
                } else if (payload.type === 'candidate' && peerConnection) {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
                }
            })
            .subscribe();
    } catch (e) {}
}

async function startPeerConnection() {
    try {
        peerConnection = new RTCPeerConnection(CONFIG.RTC_CONFIG);
        
        if (webcamStream) {
            webcamStream.getTracks().forEach(track => peerConnection.addTrack(track, webcamStream));
        }

        peerConnection.onicecandidate = (event) => {
            if (event.candidate && supabaseChannel) {
                supabaseChannel.send({
                    type: 'broadcast',
                    event: 'signal',
                    payload: { type: 'candidate', candidate: event.candidate }
                });
            }
        };

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        if (supabaseChannel) {
            supabaseChannel.send({
                type: 'broadcast',
                event: 'signal',
                payload: { type: 'offer', sdp: offer }
            });
        }
    } catch (e) {
        console.warn('[WebRTC] PeerConnection offer error:', e);
    }
}

function broadcastSystemState() {
    if (!supabaseChannel) return;
    try {
        supabaseChannel.send({
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
                coughEvents: mealMetrics.coughCountL2 + mealMetrics.chokingEventsL3,
                activeAlertLevel: activeAlertLevel,
                isHandOnNeck: isHandOnNeck
            }
        });
    } catch (e) {}
}

// =============================================================================
// 獨立核心偵測演算法模組 (Ported from Standalone Detection Core Module)
// =============================================================================

// 1. 手抓喉嚨與胸口拍胸手勢偵測 (Choke Gesture & Chest Patting Detection)
function estimateThroat(nose, chin, extend = 0.5) {
    const tx = chin.x + extend * (chin.x - nose.x);
    const ty = chin.y + extend * (chin.y - nose.y);
    return { x: tx, y: ty };
}

function estimateChest(nose, chin, extend = 1.35) {
    const cx = chin.x + extend * (chin.x - nose.x);
    const cy = chin.y + extend * (chin.y - nose.y);
    return { x: cx, y: cy };
}

function handNearChestOrThroat(hands, nose, chin, w, h) {
    if (!hands || hands.length === 0) {
        return { near: false, isChest: false, isThroat: false, chestCenter: null, chestRadius: 0, throatCenter: null, throatRadius: 0 };
    }
    const faceV = Math.hypot((chin.x - nose.x) * w, (chin.y - nose.y) * h);
    
    // 喉嚨圈 (半徑約 0.55 倍臉長)
    const throat = estimateThroat(nose, chin, 0.5);
    const throatR = Math.max(faceV * 0.55, 15.0);
    
    // 胸口區域 (從下巴往下延伸 1.35 倍臉長，半徑 1.1 倍臉長，範圍寬廣涵蓋長者拍胸、捶胸動作)
    const chest = estimateChest(nose, chin, 1.35);
    const chestR = Math.max(faceV * 1.1, 35.0);

    let isThroat = false;
    let isChest = false;

    for (const hand of hands) {
        for (const pt of hand) {
            const px = pt.x * w;
            const py = pt.y * h;
            
            const distThroat = Math.hypot(px - throat.x * w, py - throat.y * h);
            if (distThroat < throatR) isThroat = true;

            const distChest = Math.hypot(px - chest.x * w, py - chest.y * h);
            if (distChest < chestR) isChest = true;
        }
    }
    return {
        near: (isThroat || isChest),
        isChest: isChest,
        isThroat: isThroat,
        chestCenter: { x: chest.x * w, y: chest.y * h },
        chestRadius: chestR,
        throatCenter: { x: throat.x * w, y: throat.y * h },
        throatRadius: throatR
    };
}

// 2. 身體持續前後左右晃動分析 (嚴格過濾日常微小擺動、咀嚼與正常進食姿態)
function checkContinuousBodyShaking(nose, faceSize, currentTime, w, h) {
    if (!nose || faceSize <= 0) return false;

    bodyMotionHistory.push({
        x: nose.x,
        y: nose.y,
        faceSize: faceSize,
        time: currentTime
    });

    // 保留最近 1.2 秒內的軌跡 (大約 30-36 幀)
    while (bodyMotionHistory.length > 0 && (currentTime - bodyMotionHistory[0].time > 1.2)) {
        bodyMotionHistory.shift();
    }

    if (bodyMotionHistory.length < 10) {
        return false;
    }

    let minX = 1e9, maxX = -1e9;
    let minY = 1e9, maxY = -1e9;
    let minSize = 1e9, maxSize = -1e9;
    let totalSpeed = 0.0;
    let xDirectionReversals = 0;
    let yDirectionReversals = 0;
    let prevDx = 0;
    let prevDy = 0;

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

            if (i > 1) {
                if (dx * prevDx < 0 && Math.abs(dx) > 1.5) xDirectionReversals++;
                if (dy * prevDy < 0 && Math.abs(dy) > 1.5) yDirectionReversals++;
            }
            prevDx = dx;
            prevDy = dy;
        }
    }

    const xSpan = (maxX - minX) * w / faceSize;
    const ySpan = (maxY - minY) * h / faceSize;
    const sizeSpan = (maxSize - minSize) / faceSize;

    // 判定前後左右劇烈持續晃動：
    // - 左右橫向擺動幅度 > 0.16 (橫向大幅擺動) 或 前後/俯仰幅度 > 0.16 或 臉距大小縮放 > 0.15
    // - 且在 1.2 秒內累積速度 > 2.0 (排除靜止慢速轉頭)
    // - 且有至少 2 次方向反轉 (證明為來回擺動/晃動，非單純側頭)
    const hasDirectionReversal = (xDirectionReversals >= 2 || yDirectionReversals >= 2);
    const hasSignificantSpan = (xSpan > 0.16 || ySpan > 0.16 || sizeSpan > 0.15);
    const hasSustainedSpeed = (totalSpeed > 2.0);

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
            elShake.innerText = `${simultaneousDuration.toFixed(1)}s / 5.0s`;
            elShake.className = simultaneousDuration >= 3.5 ? 'font-mono text-rose-400 font-bold animate-pulse' : 'font-mono text-amber-400 font-bold';
        } else {
            elShake.innerText = '0.0s / 5.0s (正常)';
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

        // 3. 繪製 Throat Zone (喉嚨自適應圈圈)
        const throatX = (chin.x + 0.5 * (chin.x - nose.x)) * w;
        const throatY = (chin.y + 0.5 * (chin.y - nose.y)) * h;
        const throatR = Math.max(faceH * 0.55 * w, 15.0);

        ctx.strokeStyle = isHandOnNeck ? '#f43f5e' : '#d946ef';
        ctx.lineWidth = isHandOnNeck ? 3.5 : 1.8;
        ctx.beginPath();
        ctx.arc(throatX, throatY, throatR, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = isHandOnNeck ? '#f43f5e' : '#d946ef';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText('Throat Zone (喉嚨)', throatX - 40, throatY - throatR - 5);

        // 🎯 4. 繪製 Chest Zone (胸口拍胸區域圈圈)
        const chestX = (chin.x + 1.35 * (chin.x - nose.x)) * w;
        const chestY = (chin.y + 1.35 * (chin.y - nose.y)) * h;
        const chestR = Math.max(faceH * 1.1 * w, 35.0);

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

        // 🎯 7. 拍胸＋前後左右晃動 5 秒即時倒數 HUD 進度條
        if (simultaneousSec > 0) {
            const barW = Math.min(w * 0.85, 340);
            const barH = 34;
            const barX = (w - barW) / 2;
            const barY = 18;

            ctx.save();
            // 背景外框
            ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
            ctx.strokeStyle = simultaneousSec >= 4.0 ? '#ef4444' : '#f59e0b';
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
            ctx.fillText(`⚠️ 拍胸＋前後左右晃動: ${simultaneousSec.toFixed(1)}s / 5.0s`, barX + 16, barY + 20);

            // 填滿進度條
            const progress = Math.min(1.0, simultaneousSec / 5.0);
            const fillW = (barW - 32) * progress;
            ctx.fillStyle = progress >= 0.8 ? '#ef4444' : '#f59e0b';
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
