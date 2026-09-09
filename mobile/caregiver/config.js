/**
 * 🛡️ 防哽咽即時監測系統 - 全域設定檔 (Config)
 */

const CONFIG = {
    // 1. Supabase 設定 (預設載入示範用或可自訂)
    SUPABASE_URL: window.ENV_SUPABASE_URL || "https://xyzcompany.supabase.co",
    SUPABASE_ANON_KEY: window.ENV_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5emNvbXBhbnkiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTY3MjUwMDAwMCwiZXhwIjoxOTg4MDY0MDAwfQ.sample_key",

    // 2. WebRTC STUN 伺服器設定
    RTC_CONFIG: {
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" }
        ]
    },

    // 3. 預設演算法基準門檻 (套用實測數據)
    BASELINES: {
        MAR_CHEW_MIN: 0.04,
        MAR_CHEW_MAX: 0.11,
        NORMAL_CHEW_DURATION: [0.68, 1.03], // 正常單次咀嚼時間(s)
        NORMAL_SWALLOW_PAUSE: [0.8, 1.3],   // 物理吞嚥停頓(s)
        
        // 4 階異常門檻
        POUCHING_HINT_SEC: 10.0,            // 10s 含飯發呆提醒
        POUCHING_ALARM_SEC: 20.0,           // 20-30s 嚴重發呆警報
        PREMATURE_SWALLOW_MIN_CHEW: 7,      // 普通/軟食少於7次咀嚼即吞嚥判定為預警
        JAW_VELOCITY_CHOKE_THRESH: 25.0,    // 下巴速度衝破 +-25 判定為急劇嗆咳
        AUDIO_BURST_THRESH: 0.18            // 聲學能量突發門檻 (300-2500Hz)
    },

    // 4. 質地咀嚼參考數據 (普通/軟食/碎食)
    DIET_PROFILES: {
        regular: { name: '普通餐食', minChewsPerBite: 10, maxChewsPerBite: 20, speedSec: 0.68 },
        soft:    { name: '軟食餐盒', minChewsPerBite: 16, maxChewsPerBite: 18, speedSec: 0.55 },
        pureed:  { name: '碎食餐',   minChewsPerBite: 3,  maxChewsPerBite: 10, speedSec: 0.55 }
    }
};

window.CONFIG = CONFIG;
