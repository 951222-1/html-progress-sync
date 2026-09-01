# ⚡ 跨電腦 HTML 工作進度同步網頁與 AI 資料庫系統

本專案是一個基於 **GitHub Repository + GitHub Pages** 的工作進度同步系統。能夠讓您在上傳工作進度 HTML 檔案時自動獲得遞增序號（如 `#0001`, `#0002`），並維護 JSON 索引庫，同時供**另一台電腦的 AI** 前往下載與同步最新進度。

---

## 📁 專案目錄結構

```text
資料同步/
├── index.html                   # 網頁儀表板 UI (瀏覽、預覽、線上上傳進度)
├── app.js                       # 前端邏輯 (GitHub REST API 整合、自動序號生成)
├── styles.css                   # 現代化樣式表
├── ai_sync.py                   # 給另一台電腦 AI / 腳本使用的自動同步 CLI 工具
├── data/
│   ├── index.json               # 資料庫主索引檔 (記錄所有序號、時間戳、狀態與 URL)
│   └── html/                    # 存放所有原始 HTML 工作進度報告檔案
│       └── 0001_sample_progress.html
└── README.md                    # 本說明文件與 AI 提示詞
```

---

## 🚀 部署與設定步驟

### 1. 將本專案推送到您的 GitHub Repository
在終端機中執行：
```bash
git init
git add .
git commit -m "Initialize HTML progress sync site"
git branch -M main
git remote add origin https://github.com/<YOUR_USERNAME>/<YOUR_REPO_NAME>.git
git push -u origin main
```

### 2. 開啟 GitHub Pages（發布網站）
1. 進入您的 GitHub Repository 設定頁面 (`Settings` -> `Pages`)。
2. 在 **Build and deployment** 下的 `Source` 選擇 `Deploy from a branch`。
3. `Branch` 選擇 `main` / `/ (root)`，按下 **Save**。
4. 數分鐘後即可取得免費發布的網址：`https://<YOUR_USERNAME>.github.io/<YOUR_REPO_NAME>/`

### 3. 設定 Personal Access Token (PAT)
由於網頁與 API 上傳寫入 GitHub 需要權限：
1. 前往 GitHub 點擊頭像 -> **Settings** -> **Developer Settings** -> **Personal Access Tokens (Tokens classic)**。
2. 點擊 **Generate new token**，名稱自訂，勾選 `repo` 權限。
3. 複製產生的 `ghp_xxxxxxxxxxxx` Token。
4. 開啟您的網頁儀表板，點擊右上角 **⚙️ GitHub 設定**，輸入您的 Owner、Repo 名稱與 Token 即可！

---

## 🤖 給另一台電腦 AI 的操作提示詞 (AI Prompt)

當您在另一台電腦使用 AI（例如 Google Antigravity, ChatGPT, Claude 或 Custom Agent）時，您可以將以下提示詞貼給該 AI：

```markdown
我有一個 GitHub 跨電腦工作進度庫，網址與 API 如下：
- Repository: https://github.com/<YOUR_USERNAME>/<YOUR_REPO_NAME>
- 索引檔 API: https://raw.githubusercontent.com/<YOUR_USERNAME>/<YOUR_REPO_NAME>/main/data/index.json

請你幫我執行以下同步動作：
1. 讀取 data/index.json 獲取最新的工作進度序號 (last_id)。
2. 將所有序號對應的 HTML 檔案 (位於 data/html/ 下) 下載或閱讀。
3. 根據最新的進度報告，回答我的問題或接續完成下一個工作項目。
4. 完成後，生成一份 HTML 格式的進度報告，並使用原本的 ai_sync.py 或 GitHub API 上傳並遞增序號。
```

---

## 🛠️ CLI 工具使用方式 (`ai_sync.py`)

另一台電腦也可直接透過 Python 腳本進行同步（不需要安裝第三方套件）：

### 1. 列出所有工作進度與序號
```bash
python ai_sync.py list --owner <YOUR_USERNAME> --repo <YOUR_REPO_NAME>
```

### 2. 下載並同步所有 HTML 報告到本地 `synced_html/`
```bash
python ai_sync.py pull --owner <YOUR_USERNAME> --repo <YOUR_REPO_NAME> --output ./synced_html
```

### 3. 從本地上傳新的 HTML 報告並自動遞增序號
```bash
python ai_sync.py push --owner <YOUR_USERNAME> --repo <YOUR_REPO_NAME> --token <YOUR_TOKEN> --title "完成了數據分析模組" --file my_report.html --status completed --summary "新增分析圖表與產出演算法"
```
