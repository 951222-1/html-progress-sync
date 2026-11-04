(function () {
    'use strict';

    function addStyles() {
        if (document.getElementById('supabase-auth-styles')) return;
        const style = document.createElement('style');
        style.id = 'supabase-auth-styles';
        style.textContent = `
            #supabase-auth-gate { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; padding: 20px; background: rgba(2,6,23,.92); color: #e2e8f0; font-family: system-ui, sans-serif; }
            #supabase-auth-gate * { box-sizing: border-box; }
            #supabase-auth-gate .auth-card { width: min(100%, 420px); padding: 26px; border: 1px solid #334155; border-radius: 20px; background: #0f172a; box-shadow: 0 24px 80px rgba(0,0,0,.45); }
            #supabase-auth-gate h2 { margin: 0 0 8px; font-size: 22px; }
            #supabase-auth-gate p { color: #94a3b8; line-height: 1.55; font-size: 14px; }
            #supabase-auth-gate label { display:block; margin: 14px 0 6px; color:#cbd5e1; font-size:13px; }
            #supabase-auth-gate input { width:100%; padding:12px 13px; border:1px solid #475569; border-radius:10px; background:#020617; color:#f8fafc; font-size:16px; }
            #supabase-auth-gate button { cursor:pointer; border:0; border-radius:10px; padding:12px 14px; font-size:15px; font-weight:700; }
            #supabase-auth-submit { width:100%; margin-top:18px; background:#2563eb; color:white; }
            #supabase-auth-submit:disabled { opacity:.55; cursor:wait; }
            #supabase-auth-mode { margin-top:12px; background:transparent; color:#93c5fd; padding:8px 0 !important; }
            #supabase-auth-message { min-height:24px; margin:12px 0 0; font-size:13px; color:#fbbf24; }
            #supabase-auth-logout { position:fixed; right:12px; bottom:12px; z-index:9000; border:1px solid #475569; border-radius:10px; padding:8px 11px; background:rgba(15,23,42,.92); color:#cbd5e1; font:600 12px system-ui,sans-serif; }
        `;
        document.head.appendChild(style);
    }

    function renderGate(client, pageLabel) {
        addStyles();
        const existing = document.getElementById('supabase-auth-gate');
        if (existing) existing.remove();
        const gate = document.createElement('div');
        gate.id = 'supabase-auth-gate';
        gate.setAttribute('role', 'dialog');
        gate.setAttribute('aria-modal', 'true');
        gate.innerHTML = `
            <form class="auth-card" id="supabase-auth-form">
                <h2>連結使用者端與照護者端</h2>
                <p>兩端使用同一個帳號登入，才能安全同步個案與即時狀態。第一次使用請先建立帳號；建立後在另一端以相同信箱與密碼登入。</p>
                <p style="margin-bottom:4px;color:#cbd5e1">目前頁面：${pageLabel}</p>
                <label for="supabase-auth-email">電子郵件</label>
                <input id="supabase-auth-email" name="email" type="email" autocomplete="email" required>
                <label for="supabase-auth-password">密碼（至少 8 個字元）</label>
                <input id="supabase-auth-password" name="password" type="password" autocomplete="current-password" minlength="8" required>
                <button id="supabase-auth-submit" type="submit">登入</button>
                <button id="supabase-auth-mode" type="button">第一次使用？建立帳號</button>
                <p id="supabase-auth-message" role="status" aria-live="polite"></p>
            </form>`;
        document.body.appendChild(gate);

        const form = gate.querySelector('#supabase-auth-form');
        const submit = gate.querySelector('#supabase-auth-submit');
        const modeButton = gate.querySelector('#supabase-auth-mode');
        const message = gate.querySelector('#supabase-auth-message');
        const passwordInput = gate.querySelector('#supabase-auth-password');
        let mode = 'signin';
        let done = false;
        let subscription = null;

        const finish = (user) => {
            if (done || !user) return;
            done = true;
            if (subscription) subscription.unsubscribe();
            gate.remove();
            renderLogout(client);
            window.dispatchEvent(new CustomEvent('supabase-auth-ready', { detail: { user } }));
        };

        const authListener = client.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN' && session && session.user) finish(session.user);
        });
        subscription = authListener && authListener.data && authListener.data.subscription;

        modeButton.addEventListener('click', () => {
            mode = mode === 'signin' ? 'signup' : 'signin';
            submit.textContent = mode === 'signup' ? '建立帳號' : '登入';
            modeButton.textContent = mode === 'signup' ? '已經有帳號？返回登入' : '第一次使用？建立帳號';
            passwordInput.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
            message.textContent = '';
        });

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const email = gate.querySelector('#supabase-auth-email').value.trim();
            const password = passwordInput.value;
            if (password.length < 8) {
                message.textContent = '密碼至少需要 8 個字元。';
                return;
            }
            submit.disabled = true;
            message.textContent = mode === 'signup' ? '正在建立帳號…' : '正在登入…';
            try {
                if (mode === 'signup') {
                    const { data, error } = await client.auth.signUp({
                        email,
                        password,
                        options: { emailRedirectTo: `${location.origin}${location.pathname}` }
                    });
                    if (error) throw error;
                    if (data.session && data.user) {
                        finish(data.user);
                    } else {
                        message.textContent = '帳號已送出。請開啟確認信中的連結，再回到此頁登入。';
                    }
                } else {
                    const { data, error } = await client.auth.signInWithPassword({ email, password });
                    if (error) throw error;
                    if (data.user) finish(data.user);
                }
            } catch (error) {
                message.textContent = error && error.message ? error.message : '登入失敗，請檢查信箱與密碼後重試。';
            } finally {
                submit.disabled = false;
            }
        });
        return gate;
    }

    function renderLogout(client) {
        addStyles();
        let button = document.getElementById('supabase-auth-logout');
        if (button) return;
        button = document.createElement('button');
        button.id = 'supabase-auth-logout';
        button.type = 'button';
        button.textContent = '登出帳號';
        button.addEventListener('click', async () => {
            button.disabled = true;
            await client.auth.signOut();
            location.reload();
        });
        document.body.appendChild(button);
    }

    async function requireAuth(client, pageLabel) {
        const { data, error } = await client.auth.getSession();
        if (error) throw error;
        if (data.session && data.session.user) {
            renderLogout(client);
            return data.session.user;
        }
        return new Promise((resolve) => {
            const gate = renderGate(client, pageLabel);
            window.addEventListener('supabase-auth-ready', (event) => resolve(event.detail.user), { once: true });
            const emailField = gate.querySelector('#supabase-auth-email');
            if (emailField) emailField.focus();
        });
    }

    function showSetupError(message) {
        addStyles();
        const gate = document.createElement('div');
        gate.id = 'supabase-auth-gate';
        gate.setAttribute('role', 'alert');
        gate.innerHTML = `<div class="auth-card"><h2>線上連線尚未設定</h2><p>${message}</p></div>`;
        document.body.appendChild(gate);
    }

    window.AuthUI = Object.freeze({ requireAuth, showSetupError });
})();
