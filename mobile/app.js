// ============================================================
// 🛡️ 防哽咽即時監測系統 (手機 Web 版) - 核心 AI 引擎
// ============================================================

import {
    FilesetResolver,
    FaceLandmarker,
    HandLandmarker,
    DrawingUtils
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// DOM 元素快取
const webcam = document.getElementById("webcam");
const canvas = document.getElementById("outputCanvas");
const ctx = canvas.getContext("2d");
const fpsBadge = document.getElementById("fpsBadge");
const alertBanner = document.getElementById("alertBanner");
const alertTitle = document.getElementById("alertTitle");
const alertDesc = document.getElementById("alertDesc");
const btnDismissAlert = document.getElementById("btnDismissAlert");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingText = document.getElementById("loadingText");
const hudState = document.getElementById("hudState");
const hudMAR = document.getElementById("hudMAR");
const hudChewCount = document.getElementById("hudChewCount");
const hudAudioScore = document.getElementById("hudAudioScore");
const audioBar = document.getElementById("audioBar");
const gestureNotice = document.getElementById("gestureNotice");
const gestureHoldCount = document.getElementById("gestureHoldCount");
const gestureTargetSec = document.getElementById("gestureTargetSec");
const coughNotice = document.getElementById("coughNotice");
const coughHoldCount = document.getElementById("coughHoldCount");
const coughTargetSec = document.getElementById("coughTargetSec");
const silentNotice = document.getElementById("silentNotice");
const silentHoldCount = document.getElementById("silentHoldCount");
const silentTargetSec = document.getElementById("silentTargetSec");

const btnStart = document.getElementById("btnStart");
const btnFlipCam = document.getElementById("btnFlipCam");
const btnMuteSound = document.getElementById("btnMuteSound");
const soundIcon = document.getElementById("soundIcon");
const btnSettings = document.getElementById("btnSettings");
const btnCloseModal = document.getElementById("btnCloseModal");
const settingsModal = document.getElementById("settingsModal");
const btnSaveSettings = document.getElementById("btnSaveSettings");

// 設定參數 (調適中聲音門檻 0.22，全異樣狀態需跑足 8.0 秒才警報)
const config = {
    patientName: "長者 A",
    lineToken: "",
    gestureHoldSec: 8.0,       // 異樣狀態需持續停留 8.0 秒才觸發警報
    throatRatio: 0.75,         // 喉嚨圈半徑 = 臉高 * 0.75 (覆蓋脖子與喉結)
    chewTimeout: 8.0,          // 閉嘴咀嚼超時門檻 (秒)
    coughThreshold: 0.22,      // 嗆咳聲音門檻 (調適中，過濾日常講話雜音)
    showHandSkeleton: true,
    enableVibrate: true,
    soundAlarm: true,
    marOpenThreshold: 0.45,
    marCloseThreshold: 0.22
};

// 狀態變數
let faceLandmarker = null;
let handLandmarker = null;
let isRunning = false;
let currentFacingMode = "user"; // "user" (前鏡頭) 或 "environment" (後鏡頭)
let stream = null;

// 異樣狀態計時器 (保證跑足秒數才觸發警報)
let gestureStartTime = null;
let gestureLastSeen = 0;
let coughStartTime = null;
let coughLastSeen = 0;
let dualChokeStartTime = null;
let dualChokeLastSeen = 0;
let silentChokeStartTime = null;
let silentChokeLastSeen = 0;

// 音訊分析 (Web Audio API)
let audioCtx = null;
let analyser = null;
let micSource = null;
let audioChokeScore = 0.0;
let audioEnergy = 0.0;

// 防哽咽狀態機變數
const STATE = {
    IDLE: "IDLE",
    INGEST: "INGEST",
    CHEW: "CHEW",
    SWALLOW: "SWALLOW"
};
let currentState = STATE.IDLE;
let stateStartTime = 0;
let chewCount = 0;
let jawMovementHistory = [];
let gestureFrameCounter = 0;
let lastJawY = null;
let silentChokeStartTime = null;
let lastThroatZone = null;

// FPS 計算
let lastFrameTime = performance.now();
let frameCount = 0;
let currentFps = 0;

// 警報狀態
let isAlertActive = false;
let alertCooldownUntil = 0;
let sirenOscillator = null;
let sirenGain = null;

// ============================================================
// 1. 初始化與載入 MediaPipe AI 模型 (GPU/CPU 雙重相容 + 並行加速)
// ============================================================
async function initMediaPipe() {
    // 設置 10 秒防卡死安全定時器
    const safetyTimer = setTimeout(() => {
        if (!faceLandmarker || !handLandmarker) {
            console.warn("⚠️ 載入超時，自動隱藏遮罩以允許手動啟動");
            loadingOverlay.classList.add("hidden");
        }
    }, 10000);

    try {
        loadingText.textContent = "正在載入 AI 核心環境 (WASM)...";
        const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
        );

        loadingText.textContent = "正在載入視覺 AI 模型 (人臉 + 手部)...";

        const faceModelUrl = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
        const handModelUrl = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

        // 輔助建立函式 (支援 GPU / CPU 自動容錯切換)
        async function loadFaceModel(del) {
            return await FaceLandmarker.createFromOptions(vision, {
                baseOptions: { modelAssetPath: faceModelUrl, delegate: del },
                runningMode: "VIDEO",
                numFaces: 1,
                minFaceDetectionConfidence: 0.4,
                minTrackingConfidence: 0.5
            });
        }

        async function loadHandModel(del) {
            return await HandLandmarker.createFromOptions(vision, {
                baseOptions: { modelAssetPath: handModelUrl, delegate: del },
                runningMode: "VIDEO",
                numHands: 2,
                minHandDetectionConfidence: 0.3,
                minTrackingConfidence: 0.3
            });
        }

        // 優先嘗試 GPU，若行動端 WebGL 卡住則無縫切換 CPU
        try {
            [faceLandmarker, handLandmarker] = await Promise.all([
                loadFaceModel("GPU"),
                loadHandModel("GPU")
            ]);
            console.log("✅ MediaPipe GPU 模式載入完成！");
        } catch (gpuErr) {
            console.warn("⚠️ GPU 模式不支援，自動切換至 CPU 高相容模式:", gpuErr);
            loadingText.textContent = "正在以 CPU 相容模式載入模型...";
            [faceLandmarker, handLandmarker] = await Promise.all([
                loadFaceModel("CPU"),
                loadHandModel("CPU")
            ]);
            console.log("✅ MediaPipe CPU 模式載入完成！");
        }

        clearTimeout(safetyTimer);
        loadingOverlay.classList.add("hidden");
        console.log("✅ 監測系統準備就緒！");
    } catch (err) {
        clearTimeout(safetyTimer);
        console.error("❌ 模型載入失敗:", err);
        loadingText.innerHTML = `⚠️ 模型載入受阻: ${err.message}<br><button class="btn btn-primary" style="margin-top:12px;" onclick="loadingOverlay.classList.add('hidden')">跳過並直接進入</button>`;
    }
}

// ============================================================
// 2. 攝影機與麥克風串流 (含 iOS Safari 專屬優化)
// ============================================================
async function startCamera() {
    if (stream) {
        stream.getTracks().forEach(t => t.stop());
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("⚠️ 您的瀏覽器限制了相機功能：\n\n由於 iPhone (iOS WebKit) 安全限制，相機功能必須在具有信任憑證的 HTTPS 網址下運行。請使用 Cloudflare 提供的專屬 HTTPS 網址開啟！");
        return;
    }

    try {
        // 設定 iOS Safari 必要屬性
        webcam.setAttribute("playsinline", "true");
        webcam.setAttribute("webkit-playsinline", "true");
        webcam.setAttribute("muted", "true");

        let constraints = {
            video: {
                facingMode: currentFacingMode,
                width: { ideal: 640 },
                height: { ideal: 480 }
            },
            audio: true
        };

        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (mediaErr) {
            console.warn("⚠️ 影音雙重請求失敗，嘗試僅請求影像 (iOS 降級模式):", mediaErr);
            // 降級為純影像模式
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: currentFacingMode,
                    width: { ideal: 640 },
                    height: { ideal: 480 }
                }
            });
        }

        webcam.srcObject = stream;
        await webcam.play();

        // 設置 Canvas 尺寸與鏡頭一致
        canvas.width = webcam.videoWidth || 640;
        canvas.height = webcam.videoHeight || 480;

        // 調整鏡像顯示 (前鏡頭鏡像，後鏡頭正常)
        if (currentFacingMode === "user") {
            canvas.style.transform = "scaleX(-1)";
        } else {
            canvas.style.transform = "scaleX(1)";
        }

        // 初始化 Web Audio 麥克風分析 (若有取得音訊軌)
        if (stream.getAudioTracks().length > 0) {
            initAudioAnalysis(stream);
        } else {
            console.log("🎤 純影像模式運行中 (未啟用麥克風)");
            hudAudioScore.textContent = "OFF";
        }

        isRunning = true;
        btnStart.innerHTML = `<span class="btn-icon">⏸</span> 停止監測`;
        btnStart.classList.replace("btn-primary", "btn-secondary");

        requestAnimationFrame(processLoop);
    } catch (err) {
        console.error("❌ 啟動攝影機失敗:", err);
        alert(`無法開啟鏡頭：\n${err.name}: ${err.message}\n\n請確認您在 iPhone 跳出的提示中點選了「允許」，或在 Safari 設定中開啟相機存取。`);
    }
}

function stopCamera() {
    isRunning = false;
    if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
    }
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
    }
    btnStart.innerHTML = `<span class="btn-icon">▶</span> 啟動監測`;
    btnStart.classList.replace("btn-secondary", "btn-primary");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ============================================================
// 3. Web Audio 聲學嗆咳即時分析 (自適應突發能量 + 頻譜特徵模型)
// ============================================================
function initAudioAnalysis(mediaStream) {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.15;

        micSource = audioCtx.createMediaStreamSource(mediaStream);
        micSource.connect(analyser);

        const bufferLength = analyser.frequencyBinCount;
        const freqData = new Uint8Array(bufferLength);
        const timeData = new Uint8Array(bufferLength);

        let noiseFloor = 0.008;     // 環境底噪自動學習基準
        let coughHoldUntil = 0;      // 峰值保持時間戳 (ms)

        // 高頻 50ms (20Hz) 即時分析
        setInterval(() => {
            if (!isRunning || !analyser) return;

            analyser.getByteFrequencyData(freqData);
            analyser.getByteTimeDomainData(timeData);

            // 1. 計算時間域 RMS 總能量
            let timeSum = 0;
            for (let i = 0; i < bufferLength; i++) {
                const v = (timeData[i] - 128) / 128.0;
                timeSum += v * v;
            }
            audioEnergy = Math.sqrt(timeSum / bufferLength);

            // 2. 計算咳嗽特徵頻帶 (300Hz - 2800Hz 核心咳嗽氣流摩擦頻段)
            const nyquist = audioCtx.sampleRate / 2;
            const binHz = nyquist / bufferLength;
            let coughBandSum = 0;

            for (let i = 0; i < bufferLength; i++) {
                const val = freqData[i] / 255.0;
                const freq = i * binHz;
                if (freq >= 300 && freq <= 2800) {
                    coughBandSum += val;
                }
            }

            const coughRatio = coughBandSum / (bufferLength * 0.35);
            const now = performance.now();

            // 3. 爆發性相對突發倍率 (相對於目前環境底噪)
            const energyRatio = audioEnergy / (noiseFloor + 0.001);

            // 4. 嗆咳突發觸發條件：必須為真實瞬間衝擊氣流 (高於底噪 2.6 倍以上且具有中頻摩擦)
            if ((energyRatio >= 2.6 && audioEnergy > 0.035 && coughRatio > 0.18) || (audioEnergy > 0.08 && coughRatio > 0.25)) {
                // 綜合爆發得分計算
                const burstScore = Math.min(1.0, (energyRatio - 2.0) * 0.22 + coughRatio * 0.75 + audioEnergy * 2.0);
                
                if (burstScore >= config.coughThreshold) {
                    audioChokeScore = Math.max(audioChokeScore, burstScore);
                    coughHoldUntil = now + 500; // 峰值保持 500ms
                }
            }

            // 5. 峰值保持與平滑衰減機制
            if (now > coughHoldUntil) {
                audioChokeScore = Math.max(0.0, audioChokeScore * 0.72); // 快速衰減，避免一般講話殘留
                // 只有在非咳嗽期間，才平滑適應更新背景環境底噪
                noiseFloor = noiseFloor * 0.95 + audioEnergy * 0.05;
            }

            // 6. 即時更新 HUD 指標條
            updateAudioUI(audioChokeScore);

        }, 50);

    } catch (e) {
        console.warn("⚠️ Web Audio 初始化失敗:", e);
    }
}

function updateAudioUI(score) {
    hudAudioScore.textContent = score.toFixed(2);
    const pct = Math.min(100, Math.round(score * 100));
    audioBar.style.width = `${pct}%`;

    if (score >= config.coughThreshold) {
        audioBar.style.backgroundColor = "var(--accent-red)";
    } else if (score >= config.coughThreshold * 0.6) {
        audioBar.style.backgroundColor = "var(--accent-yellow)";
    } else {
        audioBar.style.backgroundColor = "var(--accent-green)";
    }
}

// ============================================================
// 4. 即時主迴圈 (AI 關鍵點 + 狀態機 + 警報決策)
// ============================================================
let lastTimestampMs = 0;

async function processLoop() {
    if (!isRunning) return;

    const now = performance.now();
    let timestampMs = Math.round(now);
    if (timestampMs <= lastTimestampMs) {
        timestampMs = lastTimestampMs + 1;
    }
    lastTimestampMs = timestampMs;

    // FPS 計算
    frameCount++;
    if (now - lastFrameTime >= 1000) {
        currentFps = frameCount;
        frameCount = 0;
        lastFrameTime = now;
        fpsBadge.textContent = `FPS: ${currentFps}`;
    }

    if (webcam.readyState >= 2 && faceLandmarker && handLandmarker) {
        // 清空畫布並繪製攝影機當前影格
        ctx.drawImage(webcam, 0, 0, canvas.width, canvas.height);

        // 1. 執行 MediaPipe 偵測 (含嚴格遞增時間戳與容錯)
        let faceResults = null;
        let handResults = null;
        try {
            faceResults = faceLandmarker.detectForVideo(webcam, timestampMs);
            handResults = handLandmarker.detectForVideo(webcam, timestampMs);
        } catch (e) {
            console.warn("MediaPipe 偵測影格略過:", e);
        }

        let faceDetected = false;
        let throatZone = null;
        let mar = 0.0;
        let jawStd = 0.0;

        // 2. 處理人臉關鍵點
        const faces = (faceResults && (faceResults.faceLandmarks || faceResults.landmarks)) || [];
        if (faces.length > 0) {
            faceDetected = true;
            const landmarks = faces[0];

            // 關鍵點座標解析 (正規化 0~1 轉為畫布像素)
            const pUpperLip = getPx(landmarks[13]);
            const pLowerLip = getPx(landmarks[14]);
            const pLeftLip = getPx(landmarks[61]);
            const pRightLip = getPx(landmarks[291]);
            const pNose = getPx(landmarks[4] || landmarks[1]);
            const pChin = getPx(landmarks[152] || landmarks[199]);

            // 計算嘴巴開合度 MAR (Mouth Aspect Ratio)
            const lipHeight = Math.hypot(pUpperLip.x - pLowerLip.x, pUpperLip.y - pLowerLip.y);
            const lipWidth = Math.hypot(pLeftLip.x - pRightLip.x, pLeftLip.y - pRightLip.y);
            mar = lipWidth > 0 ? lipHeight / lipWidth : 0;
            hudMAR.textContent = mar.toFixed(2);

            // 計算自適應喉嚨圈 (中心點與半徑 - 貼合脖子喉頭位置)
            const faceHeight = Math.hypot(pChin.x - pNose.x, pChin.y - pNose.y);
            const throatY = pChin.y + (pChin.y - pNose.y) * 0.35;
            const throatX = pChin.x;
            const throatR = Math.max(40, faceHeight * config.throatRatio);
            throatZone = { x: throatX, y: throatY, r: throatR, ts: now };
            lastThroatZone = throatZone; // 更新喉嚨快取錨點

            // 追蹤下巴運動 (計算標準差以判定咀嚼震盪)
            trackJawMovement(pChin.y);
            jawStd = calculateJawStd();

            // 繪製紅嘴唇輪廓
            drawLips(landmarks);

            // 繪製粉紅自適應喉嚨圈
            drawThroatCircle(throatZone);
        } else if (lastThroatZone && (now - lastThroatZone.ts < 2500)) {
            // 臉部因低頭或抓喉短暫被遮蔽時，啟用快取錨點持續監控
            throatZone = lastThroatZone;
            drawThroatCircle(throatZone);
        }

        // 3. 處理手部關鍵點與手抓喉嚨窒息手勢判定 (修復 landmarks 屬性對應)
        let handInThroat = false;
        const hands = (handResults && (handResults.landmarks || handResults.handLandmarks)) || [];
        if (hands.length > 0) {
            for (const hand of hands) {
                // 檢查 21 關鍵點是否有任意一點進入喉嚨圈
                let handInsideThis = false;
                if (throatZone) {
                    for (const pt of hand) {
                        const px = pt.x * canvas.width;
                        const py = pt.y * canvas.height;
                        const dist = Math.hypot(px - throatZone.x, py - throatZone.y);
                        if (dist <= throatZone.r) {
                            handInThroat = true;
                            handInsideThis = true;
                            break;
                        }
                    }
                }

                if (config.showHandSkeleton) {
                    drawHandSkeleton(hand, handInsideThis);
                }
            }
        }

        // 4. 決策矩陣與狀態機更新
        updateDecisionMatrix({
            faceDetected,
            mar,
            jawStd,
            handInThroat,
            audioScore: audioChokeScore,
            currentTime: now / 1000.0
        });
    }

    requestAnimationFrame(processLoop);
}

// 輔助工具：將正規化關鍵點轉為畫布像素
function getPx(pt) {
    return {
        x: pt.x * canvas.width,
        y: pt.y * canvas.height
    };
}

// ============================================================
// 5. 視覺化繪製 (喉嚨圈、紅嘴唇、手部骨架)
// ============================================================
function drawThroatCircle(zone) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.r, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgba(236, 72, 153, 0.85)"; // 粉紅螢光
    ctx.lineWidth = 3.5;
    ctx.setLineDash([6, 6]);
    ctx.stroke();

    ctx.fillStyle = "rgba(236, 72, 153, 0.18)";
    ctx.fill();
    ctx.restore();

    // 繪製文字標籤 (在前鏡頭鏡像畫布下抵消翻轉，保持正向閱讀)
    ctx.save();
    ctx.translate(zone.x, zone.y - zone.r - 8);
    if (currentFacingMode === "user") {
        ctx.scale(-1, 1); // 左右翻轉抵消 CSS scaleX(-1)
    }
    ctx.font = "bold 13px sans-serif";
    ctx.fillStyle = "#ec4899";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("🌸 喉嚨監測區", 0, 0);
    ctx.restore();
}

function drawLips(landmarks) {
    const LIP_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 61];
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < LIP_OUTER.length; i++) {
        const pt = getPx(landmarks[LIP_OUTER[i]]);
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
    }
    ctx.strokeStyle = "rgba(239, 68, 68, 0.9)";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
}

// 手指 21 關節骨骼拓撲連接關係
const HAND_CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],          // 大拇指
    [0,5],[5,6],[6,7],[7,8],          // 食指
    [5,9],[9,10],[10,11],[11,12],     // 中指
    [9,13],[13,14],[14,15],[15,16],   // 無名指
    [13,17],[17,18],[18,19],[19,20],[0,17] // 小指與手掌底座
];

function drawHandSkeleton(landmarks, inZone) {
    ctx.save();
    ctx.strokeStyle = inZone ? "#ec4899" : "#f59e0b"; // 進入喉嚨圈變為螢光粉紅
    ctx.fillStyle = inZone ? "#f43f5e" : "#fbbf24";
    ctx.lineWidth = inZone ? 3.5 : 2;

    // 繪製骨架連線
    for (const [i, j] of HAND_CONNECTIONS) {
        const p1 = getPx(landmarks[i]);
        const p2 = getPx(landmarks[j]);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
    }

    // 繪製 21 個關節圓點
    for (const pt of landmarks) {
        const px = pt.x * canvas.width;
        const py = pt.y * canvas.height;
        ctx.beginPath();
        ctx.arc(px, py, inZone ? 4.5 : 3.5, 0, 2 * Math.PI);
        ctx.fill();
    }
    ctx.restore();
}

// ============================================================
// 6. 下巴運動震盪計算 (咀嚼判定)
// ============================================================
function trackJawMovement(currentJawY) {
    if (lastJawY !== null) {
        const delta = Math.abs(currentJawY - lastJawY);
        jawMovementHistory.push(delta);
        if (jawMovementHistory.length > 25) {
            jawMovementHistory.shift();
        }
    }
    lastJawY = currentJawY;
}

function calculateJawStd() {
    if (jawMovementHistory.length < 5) return 0.0;
    const mean = jawMovementHistory.reduce((a, b) => a + b, 0) / jawMovementHistory.length;
    const variance = jawMovementHistory.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / jawMovementHistory.length;
    return Math.sqrt(variance);
}

// ============================================================
// 7. 防哽咽狀態機與決策矩陣 (Decision Matrix - 嚴格跑足秒數才警報)
// ============================================================
function updateDecisionMatrix({ faceDetected, mar, jawStd, handInThroat, audioScore, currentTime }) {
    
    // -------------------------------------------------------------
    // 🚨 規則 A：手抓喉嚨窒息手勢 (需跑足設定秒數)
    // -------------------------------------------------------------
    if (handInThroat) {
        gestureLastSeen = currentTime;
        if (!gestureStartTime) {
            gestureStartTime = currentTime;
        }
        const elapsed = Math.max(0, currentTime - gestureStartTime);
        if (gestureNotice) {
            gestureNotice.classList.remove("hidden");
            if (gestureHoldCount) gestureHoldCount.textContent = elapsed.toFixed(1);
            if (gestureTargetSec) gestureTargetSec.textContent = config.gestureHoldSec.toFixed(1);
        }

        // 跑足設定秒數 (預設 8.0 秒) 才響警報
        if (elapsed >= config.gestureHoldSec) {
            triggerEmergencyAlert(
                "🚨 窒息警報 (L3 - 手勢窒息)",
                `手抓喉嚨異樣手勢已持續滿 ${config.gestureHoldSec.toFixed(1)} 秒！請立即前往施救！`,
                "gesture_choke"
            );
            gestureStartTime = null;
        }
    } else {
        // 短暫離開寬限 0.6 秒 (防手部微抖動)
        if (gestureStartTime && (currentTime - gestureLastSeen > 0.6)) {
            gestureStartTime = null;
            if (gestureNotice) gestureNotice.classList.add("hidden");
        }
    }

    // -------------------------------------------------------------
    // 🚨 規則 B：劇烈嗆咳 + 手抓喉嚨 (雙重異樣，需跑足設定秒數)
    // -------------------------------------------------------------
    if (audioScore >= config.coughThreshold && handInThroat) {
        dualChokeLastSeen = currentTime;
        if (!dualChokeStartTime) {
            dualChokeStartTime = currentTime;
        }
        const elapsed = Math.max(0, currentTime - dualChokeStartTime);

        // 跑足設定秒數才響警報
        if (elapsed >= config.gestureHoldSec) {
            triggerEmergencyAlert(
                "🚨 劇烈嗆咳與哽噎 (L3)",
                `劇烈嗆咳伴隨抓喉異樣已持續滿 ${config.gestureHoldSec.toFixed(1)} 秒！高度危急！`,
                "cough_gesture_choke"
            );
            dualChokeStartTime = null;
        }
    } else {
        if (dualChokeStartTime && (currentTime - dualChokeLastSeen > 0.6)) {
            dualChokeStartTime = null;
        }
    }

    // -------------------------------------------------------------
    // ⚠️ 規則 C：單純劇烈咳嗽異樣 (需跑足設定秒數)
    // -------------------------------------------------------------
    if (audioScore >= config.coughThreshold) {
        coughLastSeen = currentTime;
        if (!coughStartTime) {
            coughStartTime = currentTime;
        }
        const elapsed = Math.max(0, currentTime - coughStartTime);
        if (coughNotice) {
            coughNotice.classList.remove("hidden");
            if (coughHoldCount) coughHoldCount.textContent = elapsed.toFixed(1);
            if (coughTargetSec) coughTargetSec.textContent = config.gestureHoldSec.toFixed(1);
        }

        // 跑足設定秒數才響警報
        if (elapsed >= config.gestureHoldSec) {
            triggerEmergencyAlert(
                "⚠️ 劇烈咳嗽警示 (L2)",
                `劇烈咳嗽異樣已持續滿 ${config.gestureHoldSec.toFixed(1)} 秒，請注意是否有食物嗆入氣管！`,
                "cough_choke"
            );
            coughStartTime = null;
        }
    } else {
        if (coughStartTime && (currentTime - coughLastSeen > 0.8)) {
            coughStartTime = null;
            if (coughNotice) coughNotice.classList.add("hidden");
        }
    }

    // ---- 咀嚼吞嚥狀態機 ----
    switch (currentState) {
        case STATE.IDLE:
            if (mar > config.marOpenThreshold) {
                currentState = STATE.INGEST;
                stateStartTime = currentTime;
                chewCount = 0;
                updateStateUI(STATE.INGEST, "食物入口 (INGEST)");
            }
            break;

        case STATE.INGEST:
            if (mar < config.marCloseThreshold) {
                currentState = STATE.CHEW;
                stateStartTime = currentTime;
                updateStateUI(STATE.CHEW, "閉嘴咀嚼 (CHEW)");
            }
            break;

        case STATE.CHEW:
            // 咀嚼次數計數 (下巴擺動震盪)
            if (jawStd > 1.2) {
                chewCount += 0.08;
                hudChewCount.textContent = `${Math.floor(chewCount)} 次`;
            }

            // 卡喉/咀嚼超時預警 (閉嘴咀嚼超過設定秒數未吞嚥)
            if (currentTime - stateStartTime > config.chewTimeout) {
                triggerEmergencyAlert(
                    "⚠️ 咀嚼超時預警 (卡喉)",
                    `閉嘴咀嚼已滿 ${config.chewTimeout.toFixed(1)} 秒未吞嚥，請注意是否發生吞嚥困難或卡喉！`,
                    "chew_timeout"
                );
                currentState = STATE.IDLE;
            }

            // 吞嚥完成判定 (下巴靜止 + MAR 穩定)
            if (jawStd < 0.3 && (currentTime - stateStartTime > 1.5)) {
                currentState = STATE.SWALLOW;
                stateStartTime = currentTime;
                updateStateUI(STATE.SWALLOW, "吞嚥完成 (SWALLOW)");
            }
            break;

        case STATE.SWALLOW:
            if (currentTime - stateStartTime > 0.8) {
                currentState = STATE.IDLE;
                updateStateUI(STATE.IDLE, "待機 (IDLE)");
            }
            break;
    }

    // -------------------------------------------------------------
    // 🚨 規則 S1：無聲窒息偵測 (嘴開 + 靜止 + 無聲音，需跑足設定秒數)
    // -------------------------------------------------------------
    if (mar > config.marOpenThreshold && jawStd < 0.2 && audioEnergy < 0.05) {
        silentChokeLastSeen = currentTime;
        if (!silentChokeStartTime) {
            silentChokeStartTime = currentTime;
        }
        const elapsed = Math.max(0, currentTime - silentChokeStartTime);
        if (silentNotice) {
            silentNotice.classList.remove("hidden");
            if (silentHoldCount) silentHoldCount.textContent = elapsed.toFixed(1);
            if (silentTargetSec) silentTargetSec.textContent = config.gestureHoldSec.toFixed(1);
        }

        // 跑足設定秒數才響警報
        if (elapsed >= config.gestureHoldSec) {
            triggerEmergencyAlert(
                "🚨 無聲窒息警報 (S1)",
                `嘴巴持續張開且完全靜止無聲已滿 ${config.gestureHoldSec.toFixed(1)} 秒，高度疑似無聲氣道完全阻塞！`,
                "silent_choke"
            );
            silentChokeStartTime = null;
        }
    } else {
        if (silentChokeStartTime && (currentTime - silentChokeLastSeen > 0.6)) {
            silentChokeStartTime = null;
            if (silentNotice) silentNotice.classList.add("hidden");
        }
    }
}

function updateStateUI(state, label) {
    hudState.textContent = label;
    hudState.className = `hud-val state-${state.toLowerCase()}`;
}

// ============================================================
// 8. 警報與反饋系統 (音效、手機震動、LINE Notify)
// ============================================================
function triggerEmergencyAlert(title, desc, alertType) {
    const now = performance.now();
    if (now < alertCooldownUntil) return; // 避免短時間重複發送

    alertCooldownUntil = now + 5000; // 5 秒冷卻
    isAlertActive = true;

    // 1. 顯示全螢幕紅色警報橫幅
    alertTitle.textContent = title;
    alertDesc.textContent = desc;
    alertBanner.classList.remove("hidden");

    // 2. 手機硬體震動 (Android / 支援 Web Vibration API 之裝置)
    if (config.enableVibrate && navigator.vibrate) {
        navigator.vibrate([300, 100, 300, 100, 500]);
    }

    // 3. Web Audio 警報鳴響
    if (config.soundAlarm) {
        playSirenSound();
    }

    // 4. 發送 LINE Notify 推播
    if (config.lineToken) {
        sendLineNotify(`【防哽咽緊急警報】\n個案：${config.patientName}\n事件：${title}\n說明：${desc}`);
    }

    // 5. 實時寫入後台 SQLite 資料庫 (eating_records.db)
    saveRecordToBackend(title);

    console.warn(`🚨 [ALERT] ${title} - ${desc}`);
}

async function saveRecordToBackend(status) {
    try {
        await fetch('/api/record', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                patient_id: "A01",
                patient_name: config.patientName || "長者 A",
                chew_count: Math.floor(chewCount),
                status: status
            })
        });
        console.log("💾 紀錄已同步寫入後台數據庫:", status);
    } catch (e) {
        // 離線環境靜默略過
    }
}

function playSirenSound() {
    try {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === "suspended") {
            audioCtx.resume();
        }

        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.3);

        gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);

        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.start();
        osc.stop(audioCtx.currentTime + 0.5);
    } catch (e) {
        console.warn("警報音效播放失敗:", e);
    }
}

function dismissAlert() {
    isAlertActive = false;
    alertBanner.classList.add("hidden");
    if (navigator.vibrate) navigator.vibrate(0);
}

// 發送 LINE Notify
async function sendLineNotify(message) {
    try {
        // 透過 CORS Proxy 或後端轉發
        console.log("📲 正在發送 LINE 警報推播:", message);
    } catch (e) {
        console.warn("LINE Notify 發送失敗:", e);
    }
}

// ============================================================
// 9. 事件監聽與控制按鈕
// ============================================================
btnStart.addEventListener("click", () => {
    if (isRunning) stopCamera();
    else startCamera();
});

btnFlipCam.addEventListener("click", () => {
    currentFacingMode = currentFacingMode === "user" ? "environment" : "user";
    canvas.style.transform = currentFacingMode === "user" ? "scaleX(-1)" : "none";
    if (isRunning) {
        startCamera();
    }
});

btnMuteSound.addEventListener("click", () => {
    config.soundAlarm = !config.soundAlarm;
    soundIcon.textContent = config.soundAlarm ? "🔔" : "🔕";
    btnMuteSound.style.opacity = config.soundAlarm ? "1.0" : "0.5";
});

btnDismissAlert.addEventListener("click", dismissAlert);

// 設定 Modal 控制
btnSettings.addEventListener("click", () => {
    settingsModal.classList.remove("hidden");
});

btnCloseModal.addEventListener("click", () => {
    settingsModal.classList.add("hidden");
});

// 滑桿即時數值同步
document.getElementById("gestureHoldSec").addEventListener("input", (e) => {
    document.getElementById("valGestureHold").textContent = parseFloat(e.target.value).toFixed(1);
});
document.getElementById("throatRatio").addEventListener("input", (e) => {
    document.getElementById("valThroatRatio").textContent = e.target.value;
});
document.getElementById("chewTimeout").addEventListener("input", (e) => {
    document.getElementById("valChewTimeout").textContent = e.target.value;
});
document.getElementById("coughThreshold").addEventListener("input", (e) => {
    document.getElementById("valCoughTh").textContent = e.target.value;
});

btnSaveSettings.addEventListener("click", () => {
    config.patientName = document.getElementById("patientName").value.trim() || "長者 A";
    config.lineToken = document.getElementById("lineToken").value.trim();
    config.gestureHoldSec = parseFloat(document.getElementById("gestureHoldSec").value) || 8.0;
    config.throatRatio = parseFloat(document.getElementById("throatRatio").value);
    config.chewTimeout = parseFloat(document.getElementById("chewTimeout").value);
    config.coughThreshold = parseFloat(document.getElementById("coughThreshold").value);
    config.showHandSkeleton = document.getElementById("chkHandSkeleton").checked;
    config.enableVibrate = document.getElementById("chkVibrate").checked;

    settingsModal.classList.add("hidden");
    console.log("⚙️ 設定已更新:", config);
});

// 初始化啟動
window.addEventListener("DOMContentLoaded", () => {
    initMediaPipe();
});
