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

// 初始化啟動
document.addEventListener('DOMContentLoaded', () => {
    initSupabase();
    setupCanvasAndVideo();
    initMediaPipe();
    openLoginModal();
});

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
    document.getElementById('login-modal').classList.remove('hidden');
}

function closeLoginModal() {
    document.getElementById('login-modal').classList.add('hidden');
}

async function loginAsPatient(code, nameStr) {
    try {
        currentPatient.patient_code = code;
        currentPatient.full_name = nameStr;
        const label = document.getElementById('current-patient-label');
        if (label) label.innerText = `${nameStr} (${code})`;
        closeLoginModal();

        // 1. 立即啟動相機與用餐場次，確保在使用者點擊手勢 (Gesture Context) 內觸發 getUserMedia
        let cameraPromise = Promise.resolve();
        if (!isMealActive) {
            cameraPromise = startMealSession();
        }

        // 2. 背景非同步載入 Supabase 個案檔案與個人化基準
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

        // 3. 初始化 WebRTC 信令頻道
        setupWebRTCSignaling();

        await cameraPromise;
    } catch (e) {
        console.error('[Login] Error in loginAsPatient:', e);
        closeLoginModal();
    }
}

// 4. MediaPipe WebAssembly 非同步背景初始化
async function initMediaPipe() {
    const aiStatus = document.getElementById('hud-ai-status');
    try {
        const Resolver = window.FilesetResolver || (window.tasksVision && window.tasksVision.FilesetResolver);
        const FaceL = window.FaceLandmarker || (window.tasksVision && window.tasksVision.FaceLandmarker);
        const HandL = window.HandLandmarker || (window.tasksVision && window.tasksVision.HandLandmarker);

        if (!Resolver || !FaceL || !HandL) {
            console.warn('[MediaPipe] Tasks Vision global symbols not found. Falling back.');
            if (aiStatus) {
                aiStatus.innerText = '⚠️ 語音模擬模式';
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

// 5. 開始與結束用餐場次處理
async function startMealSession() {
    try {
        webcamStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, facingMode: "user" },
            audio: true
        });

        webcamVideo.srcObject = webcamStream;
        await webcamVideo.play();

        // 綁定 Web Audio API 聲學分析
        setupAudioAnalyzer(webcamStream);

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
        document.getElementById('btn-start-meal').disabled = true;
        document.getElementById('btn-start-meal').classList.add('opacity-50', 'cursor-not-allowed');
        document.getElementById('btn-end-meal').disabled = false;
        document.getElementById('btn-end-meal').classList.remove('opacity-50', 'cursor-not-allowed', 'bg-slate-800', 'text-slate-500');
        document.getElementById('btn-end-meal').classList.add('bg-rose-600', 'text-white', 'hover:bg-rose-500');
        document.getElementById('meal-status-text').innerText = '用餐中 🍽️';

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
        startPeerConnection();

        // 啟動逐幀監測迴圈
        requestAnimationFrame(processVideoFrame);

    } catch (err) {
        console.error('Camera/Mic permission failed:', err);
        const isSecure = window.isSecureContext;
        let hintMsg = "無法取得相機或麥克風權限！\n\n";
        if (!isSecure) {
            hintMsg += "💡 原因：瀏覽器規定存取相機必須使用【安全通道 (HTTPS 或 localhost)】！\n\n";
            hintMsg += "【解法建議】：\n";
            hintMsg += "1. 電腦端測試：請將網址改為 http://localhost:8080/index.html 開啟。\n";
            hintMsg += "2. 手機端測試：請使用 server.py 產生的 Cloudflare 綠色鎖頭 https://...trycloudflare.com 網址開啟。";
        } else {
            hintMsg += "請檢查您的瀏覽器網址列左側權限圖示，確認已允許開啟「攝影機」與「麥克風」。";
        }
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

// 7. 逐幀 AI 運算與 4 階異常判定主迴圈
let lastFrameTime = performance.now();
async function processVideoFrame(now) {
    if (!isMealActive || !webcamVideo) return;

    const fps = 1000 / (now - lastFrameTime);
    lastFrameTime = now;

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

    if (faceLandmarks) {
        // 取出下巴點 (#152) 與鼻尖點 (#1)
        const chin = faceLandmarks[152];
        const nose = faceLandmarks[1];
        const faceH = Math.abs(chin.y - nose.y);

        // 獨立演算法 1: 手抓喉嚨手勢偵測 (handNearThroat)
        isHandOnNeck = handNearThroat(handLandmarks, nose, chin, aiCanvas.width, aiCanvas.height, 0.6);

        // 🎯 繪製 MediaPipe 臉部 3D 骨架與特徵輪廓
        drawFaceMeshSkeleton(aiCtx, faceLandmarks, aiCanvas.width, aiCanvas.height);

        // 🎯 繪製 MediaPipe 手部 21 關節骨架連線
        if (handLandmarks && handLandmarks.length > 0) {
            drawHandSkeleton(aiCtx, handLandmarks, aiCanvas.width, aiCanvas.height, isHandOnNeck);
        }

        // 1. 計算下巴歸一化移動速度 (Jaw Velocity)
        if (mealMetrics.lastJawY !== null) {
            const deltaY = chin.y - mealMetrics.lastJawY;
            mealMetrics.jawVelocity = Math.abs((deltaY / faceH) * fps);
        }
        mealMetrics.lastJawY = chin.y;
        document.getElementById('hud-jaw-vel').innerText = mealMetrics.jawVelocity.toFixed(2);

        // 2. 計算 Mouth Aspect Ratio (MAR)
        const upperLip = faceLandmarks[13];
        const lowerLip = faceLandmarks[14];
        const leftLip = faceLandmarks[61];
        const rightLip = faceLandmarks[291];
        const mar = Math.abs(upperLip.y - lowerLip.y) / Math.abs(leftLip.x - rightLip.x);

        // 3. 咀嚼與物理吞嚥狀態機 (100% 依據實測基準數據)
        // 基準: MAR_chew 0.04-0.11 | 單次咀嚼耗時 0.68-1.03s | 物理吞嚥停頓 0.8-1.3s
        const hudActionState = document.getElementById('hud-action-state');
        const hudActionDot = document.getElementById('hud-action-dot');

        const isJawMoving = (mealMetrics.jawVelocity > 0.4) || (mar >= 0.04);

        if (isJawMoving) {
            // 👄 狀態 A: 咀嚼中 (Jaw 處於運動狀態)
            if (!mealMetrics.chewStartTime) mealMetrics.chewStartTime = now;
            mealMetrics.jawStillTime = 0.0; // 發呆/吞嚥停頓計時歸零
            mealMetrics.hasSwallowedThisPause = false;

            // 依據實測數據: 每耗時 ~0.68s ~ 1.03s 算為 1 次咀嚼
            const currentChewDur = (now - mealMetrics.chewStartTime) / 1000;
            if (currentChewDur >= 0.68) {
                mealMetrics.totalChews++;
                mealMetrics.currentBiteChews++;
                mealMetrics.chewDurations.push(currentChewDur);
                mealMetrics.chewStartTime = now; // 重設下一下時間
                document.getElementById('hud-chews').innerText = `${mealMetrics.totalChews} 次`;
            }

            if (hudActionState) {
                hudActionState.innerText = `👄 咀嚼中 (一口已咬 ${mealMetrics.currentBiteChews} 次 | 速度: ${mealMetrics.jawVelocity.toFixed(1)})`;
                hudActionState.className = 'font-bold text-xs text-emerald-300';
            }
            if (hudActionDot) hudActionDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse';

        } else {
            // 👄 狀態 B: 下巴靜止中 (靜止時間累積)
            mealMetrics.jawStillTime += (1 / fps);
            mealMetrics.chewStartTime = null;

            // 💧 物理吞嚥動作判定 (實測基準: 物理吞嚥停頓 0.8 秒 ~ 1.3 秒)
            if (mealMetrics.jawStillTime >= 0.8 && mealMetrics.jawStillTime <= 1.3 && !mealMetrics.hasSwallowedThisPause) {
                mealMetrics.hasSwallowedThisPause = true;
                mealMetrics.swallowCount = (mealMetrics.swallowCount || 0) + 1;
                mealMetrics.currentBiteChews = 0; // 成功吞嚥，當前一口咀嚼數重置

                // 更新 HUD 吞嚥次數
                const hudSwallows = document.getElementById('hud-swallows');
                if (hudSwallows) hudSwallows.innerText = `${mealMetrics.swallowCount} 次`;

                if (hudActionState) {
                    hudActionState.innerText = `💧 ✨ 物理吞嚥成功！(第 ${mealMetrics.swallowCount} 口，停頓 ${mealMetrics.jawStillTime.toFixed(1)}s)`;
                    hudActionState.className = 'font-bold text-xs text-blue-300';
                }
                if (hudActionDot) hudActionDot.className = 'w-2.5 h-2.5 rounded-full bg-blue-400 animate-bounce';

                // 播放柔和吞嚥雙重音
                playSwallowChimeSound();

            } else if (mealMetrics.jawStillTime > 1.3 && mealMetrics.jawStillTime < CONFIG.BASELINES.POUCHING_HINT_SEC) {
                // 🟡 狀態 C: 吞嚥完畢或停頓等待中
                if (hudActionState) {
                    hudActionState.innerText = `🟡 靜止等待中 (${mealMetrics.jawStillTime.toFixed(1)}s)...`;
                    hudActionState.className = 'font-bold text-xs text-amber-300';
                }
                if (hudActionDot) hudActionDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400';
            }
        }

        // 4. 繪製自適應粉紅喉嚨圈 (R = 0.6 * Face Height)
        const throatX = chin.x * aiCanvas.width;
        const throatY = (chin.y + faceH * 0.4) * aiCanvas.height;
        const throatR = faceH * 0.6 * 0.45 * aiCanvas.height;

        aiCtx.strokeStyle = isHandOnNeck ? '#f43f5e' : '#f472b6';
        aiCtx.lineWidth = isHandOnNeck ? 4 : 2;
        aiCtx.beginPath();
        aiCtx.arc(throatX, throatY, throatR, 0, Math.PI * 2);
        aiCtx.stroke();

        if (isHandOnNeck) {
            evidenceFusion.observe("hand_throat", 0.6);
        }

        // 獨立演算法 2: 身體無因次化劇烈晃動計算 (calculateBodyShaking)
        noseHistory.push({ x: nose.x * aiCanvas.width, y: nose.y * aiCanvas.height });
        if (noseHistory.length > 30) noseHistory.shift();
        const bodyShaking = calculateBodyShaking(noseHistory, faceH * aiCanvas.height);
        if (bodyShaking > 0.3) {
            evidenceFusion.observe("body_shaking", 0.5);
        }

        // 獨立演算法 5: 嘴唇藍光比率與發紺缺氧分析 (Cyanosis Detection)
        try {
            const lipPx = Math.floor(((upperLip.x + lowerLip.x) / 2) * aiCanvas.width);
            const lipPy = Math.floor(((upperLip.y + lowerLip.y) / 2) * aiCanvas.height);
            const lipData = aiCtx.getImageData(lipPx, lipPy, 1, 1).data;
            const lipRGB = [lipData[0], lipData[1], lipData[2]];
            const bRatio = blueness(lipRGB);
            const cyanotic = isCyanotic(lipRGB, 0.38);

            const hudCyanosis = document.getElementById('hud-cyanosis');
            if (hudCyanosis) {
                hudCyanosis.innerText = `${bRatio.toFixed(2)} ${cyanotic ? '(發紺缺氧!)' : '(正常)'}`;
                hudCyanosis.className = cyanotic ? 'font-mono text-purple-400 font-bold animate-pulse' : 'font-mono text-emerald-400 font-bold';
            }
            if (cyanotic) {
                evidenceFusion.observe("cyanosis", 0.4);
            }
        } catch (e) {}

        // 獨立演算法 3: 無聲窒息偵測 (SilentChokeDetector)
        const isSilentChoke = silentChokeDetector.update(mar, bodyShaking, audioEnergy, 0.3, 0.05, 0.1);
        if (isSilentChoke) {
            evidenceFusion.observe("silent_choke", 0.7);
            triggerAlertLevel('L4', '🚨 無聲窒息警報！連續3秒符合張嘴無聲且靜止特徵');
        }

        // ------------------------------------------------------------------
        // 🚨 4 階異常狀態機與多模態證據融合 (Evidence Fusion) 判定矩陣
        // ------------------------------------------------------------------

        // 獨立演算法 4: 證據融合分數計算與觸發 (Evidence Fusion Score)
        const fusionScore = evidenceFusion.score();
        const hudFusion = document.getElementById('hud-fusion-score');
        if (hudFusion) {
            hudFusion.innerText = `${fusionScore.toFixed(2)} / 1.0`;
        }

        if (evidenceFusion.check()) {
            triggerAlertLevel('L4', '🚨 多模態證據融合超標 (分數 >= 1.0) 觸發緊急窒息警報！');
        }
        // Level 4: 急劇嗆咳爆發警報 (Jaw Velocity >= 25.0 AND Audio Energy >= 0.18 OR Hands on neck)
        else if (mealMetrics.jawVelocity >= CONFIG.BASELINES.JAW_VELOCITY_CHOKE_THRESH && (audioEnergy >= CONFIG.BASELINES.AUDIO_BURST_THRESH || isHandOnNeck)) {
            triggerAlertLevel('L4', '🚨 急劇嗆咳爆發！偵測到下巴極速痙攣與聲學爆發');
        }
        // Level 3: 吞嚥前少咀嚼風險 (普通/軟食咀嚼少於 7 次即吞嚥 且 手扶頸部)
        else if (currentDiet !== 'pureed' && mealMetrics.currentBiteChews > 0 && mealMetrics.currentBiteChews < CONFIG.BASELINES.PREMATURE_SWALLOW_MIN_CHEW && mealMetrics.jawStillTime > 1.0 && isHandOnNeck) {
            triggerAlertLevel('L3', '⚠️ 咀嚼極度不充分！軟食/普通餐少於 7 下即試圖吞嚥');
        }
        // Level 2: 20~30秒 嚴重發呆/卡喉警報
        else if (mealMetrics.jawStillTime >= CONFIG.BASELINES.POUCHING_ALARM_SEC) {
            triggerAlertLevel('L2', '🔴 靜止超過 20 秒！疑似嚴重含飯發呆或卡喉');
        }
        // Level 1: 10秒 含飯發呆溫和提醒
        else if (mealMetrics.jawStillTime >= CONFIG.BASELINES.POUCHING_HINT_SEC && mealMetrics.jawStillTime < (CONFIG.BASELINES.POUCHING_HINT_SEC + 0.5)) {
            triggerAlertLevel('L1', '🟡 含飯/發呆提醒：長者已靜止 10 秒未咀嚼');
        }

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

// 1. 手抓喉嚨窒息手勢偵測 (Choke Gesture Detection - A1)
function estimateThroat(nose, chin, extend = 0.6) {
    const tx = chin.x + extend * (chin.x - nose.x);
    const ty = chin.y + extend * (chin.y - nose.y);
    return { x: tx, y: ty };
}

function handNearThroat(hands, nose, chin, w, h, radiusScale = 0.6) {
    if (!hands || hands.length === 0) return false;
    const throat = estimateThroat(nose, chin);
    const faceV = Math.hypot((chin.x - nose.x) * w, (chin.y - nose.y) * h);
    const radius = Math.max(faceV * radiusScale, 1.0);

    for (const hand of hands) {
        for (const pt of hand) {
            const dist = Math.hypot((pt.x - throat.x) * w, (pt.y - throat.y) * h);
            if (dist < radius) return true;
        }
    }
    return false;
}

// 2. 嘴部開合角度 (MAR) & 身體劇烈晃動無因次化計算
function calculateMAR(lipTop, lipBottom, lipLeft, lipRight) {
    const vDist = Math.hypot(lipTop.x - lipBottom.x, lipTop.y - lipBottom.y);
    const hDist = Math.hypot(lipLeft.x - lipRight.x, lipLeft.y - lipRight.y);
    if (hDist <= 0) return 0.0;
    return vDist / hDist;
}

function calculateBodyShaking(noseHistory, faceSize) {
    if (!noseHistory || noseHistory.length < 2 || faceSize <= 0) return 0.0;
    let totalDisp = 0.0;
    for (let i = 1; i < noseHistory.length; i++) {
        const dx = noseHistory[i].x - noseHistory[i - 1].x;
        const dy = noseHistory[i].y - noseHistory[i - 1].y;
        totalDisp += Math.hypot(dx, dy);
    }
    return totalDisp / faceSize;
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
