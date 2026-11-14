# 本機錄影 companion（隔離測試版）

此分支只整合本機整餐無聲錄影 UI 與 loopback companion；不取代原研究系統。`mobile/index.html`、`mobile/caregiver.html` 靜態載入錄影模組；companion 提供本機 API、驗證與影片服務。既有登入、警報、趨勢、偵測程式與遠端 schema 不在本次修改範圍。

## 已核准的隔離測試目標

- 錄影資料目錄：使用者明確指定、且位於網站專案根目錄之外的本機資料夾（實際路徑只保存在本機，不記入公開網站程式碼）
- 監聽位址與 port：`127.0.0.1:18765`
- 公開 Pages 只提供 UI；本機 companion 須另行安裝及啟動，這不會自動開始錄影或上傳影片。

## 啟停方式（僅供後續另行核准啟動）

本機 runner 應放在公開網站根目錄之外。它要求明確提供網站根目錄、資料夾、固定 port，以及三項容量限制；不會默默套用交接包的資料夾、port 或容量預設值。公開 repo 不包含已填入私人路徑的啟動命令。

```text
python3 "<本機 runner 路徑>\run_companion.py" --project-root "<本機網站專案根目錄>" --data-dir "<網站專案外的本機資料夾>" --port 18765 --max-recording-mib <待核准> --max-storage-mib <待核准> --free-space-reserve-mib <待核准>
```

上面是**尚不可直接執行的命令範本**：三項容量限制須由使用者核准，而且啟動還需要另行明確核准。啟動後按 `Ctrl+C` 停止。`--dry-run` 僅檢查參數，不會啟動服務或建立錄影資料夾。

## 儲存與權限

- companion 僅綁定 `127.0.0.1`，不公開到 LAN 或網際網路；跨來源 Pages 請求只允許 `https://951222-1.github.io`。
- Supabase JWT 僅用於既有登入者與個案／餐次／嗆咳事件的讀取驗證；不新增遠端 schema、不寫影片或同意狀態至 Supabase。
- 同意狀態、metadata、分塊與 MP4 都留在明確指定的本機資料目錄；同意預設關閉，關閉同意不會刪除舊影片。
- 影片只含影像；轉成 H.264 MP4 前檢查雜湊、codec/streams/faststart、尺寸、時長與畫面數。回看採 owner-scoped 短效權限及 Range；既有 Supabase 登出會撤銷本機播放權杖。
- 來源原型的 2,048/20,480/512 MiB 容量值沒有被視為此電腦的核准設定；啟動器要求三項限制明確指定。

## 驗證範圍

Node/Python 測試包含精確 Pages Origin 的 CORS/preflight、bridge 權限閘門、靜態頁連結與警報回歸。Python 合成端到端測試以 14 秒 WebM 經實際 FFmpeg/ffprobe 正規化，檢查無音軌、H.264、尺寸、嗆咳標記時間軸、前 10 秒回看位置、HTTP Range 回讀、服務重啟後留存及指定刪除。這不是實機相機、真實 Supabase 帳號、真實個案或長時間錄影驗證。
