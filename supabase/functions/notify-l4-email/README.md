# L4 Email 通知（Edge Function 已部署）

## 部署狀態

- Supabase Edge Function `notify-l4-email` 已部署；Dashboard 程式碼已核對與本機來源一致。
- Edge Function Secrets 頁面列有 `RESEND_API_KEY` 與 `RESEND_FROM_EMAIL`；secret 值不存入程式庫或文件。
- 正式 Pages origin 的 CORS preflight 已回應 HTTP 204。
- 尚未以真實 L4 事件驗證 Resend 寄達；不要把部署或 preflight 驗證當成實際寄信測試。


## 行為

- 使用者端在已寫入 `anomaly_logs` 的新 `L4` 事件後，呼叫 `notify-l4-email`。
- Edge Function 以登入者 JWT 查驗事件、餐次與個案仍屬於該登入帳號；收件人取自登入者的 Supabase Auth Email，不接受前端指定的 Email。
- 只有 `event_type = 'L4'` 會寄信。照護者頁原有 Realtime 橫幅、音效與事件日誌維持不變；不修改 L4 偵測規則，也不啟用 L2。
- Resend 使用 anomaly log UUID 作為 idempotency key，減少重試造成的重複寄信。
- Email 只包含通用 L4 提醒；個案姓名、時間及事件細節留在需要登入的照護者頁面。

## 設定與後續驗證

1. 在 Resend 驗證寄件網域，準備寄件地址。
2. 確認 Supabase Edge Function Secrets 已設定 `RESEND_API_KEY` 與 `RESEND_FROM_EMAIL`。**不要把 API key 放進前端、Git 或聊天。**
3. 確認 `L4_EMAIL_ALLOWED_ORIGINS` 包含正式 Pages origin；本機測試預設允許 `http://127.0.0.1:8110` 與 `http://localhost:8110`。
4. 使用專用測試帳號／個案觸發一次受控 L4 事件，確認實際收件；未完成前不要宣稱寄信驗證成功。
