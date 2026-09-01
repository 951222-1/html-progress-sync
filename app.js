// Antigravity HTML Progress Sync Engine
const DEFAULT_CONFIG = {
    owner: '951222-1',
    repo: 'html-progress-sync',
    branch: 'main',
    token: ''
};

let config = { ...DEFAULT_CONFIG };
let database = { last_id: 0, updated_at: '', items: [] };

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    bindEvents();
    loadDatabase();
});

// Load settings from localStorage
function loadSettings() {
    const saved = localStorage.getItem('ag_sync_config');
    if (saved) {
        try {
            config = { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
            document.getElementById('repoOwner').value = config.owner || '';
            document.getElementById('repoName').value = config.repo || '';
            document.getElementById('repoBranch').value = config.branch || 'main';
            document.getElementById('patToken').value = config.token || '';
        } catch (e) {
            console.error("Failed to parse saved config", e);
        }
    }
}

// Save settings
function saveSettings(e) {
    if (e) e.preventDefault();
    config.owner = document.getElementById('repoOwner').value.trim();
    config.repo = document.getElementById('repoName').value.trim();
    config.branch = document.getElementById('repoBranch').value.trim() || 'main';
    config.token = document.getElementById('patToken').value.trim();

    localStorage.setItem('ag_sync_config', JSON.stringify(config));
    showToast('設定已成功儲存！', 'success');
    toggleSettingsPanel(false);
    loadDatabase();
}

function toggleSettingsPanel(show) {
    const panel = document.getElementById('settingsPanel');
    if (show === undefined) {
        panel.classList.toggle('hidden');
    } else if (show) {
        panel.classList.remove('hidden');
    } else {
        panel.classList.add('hidden');
    }
}

// Bind DOM Events
function bindEvents() {
    document.getElementById('btnToggleSettings').addEventListener('click', () => toggleSettingsPanel());
    document.getElementById('settingsForm').addEventListener('submit', saveSettings);
    document.getElementById('uploadForm').addEventListener('submit', handleUpload);
    document.getElementById('btnRefresh').addEventListener('click', loadDatabase);
    document.getElementById('searchInput').addEventListener('input', filterItems);
    document.getElementById('statusFilter').addEventListener('change', filterItems);
    
    // File upload mode switch
    const fileInput = document.getElementById('htmlFile');
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (evt) => {
                document.getElementById('htmlContent').value = evt.target.result;
            };
            reader.readAsText(file);
        }
    });

    // Close Modal
    document.getElementById('btnCloseModal').addEventListener('click', closeModal);
    document.getElementById('previewModal').addEventListener('click', (e) => {
        if (e.target.id === 'previewModal') closeModal();
    });
}

// Load Database (data/index.json)
async function loadDatabase() {
    showToast('載入進度索引中...', 'info');
    try {
        let indexData = null;

        // If GitHub config is provided, try GitHub API first for live data
        if (config.owner && config.repo) {
            const apiUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/data/index.json?ref=${config.branch}`;
            const headers = { 'Accept': 'application/vnd.github.v3+json' };
            if (config.token) headers['Authorization'] = `token ${config.token}`;

            const response = await fetch(apiUrl, { headers });
            if (response.ok) {
                const json = await response.json();
                const contentStr = decodeURIComponent(escape(atob(json.content)));
                indexData = JSON.parse(contentStr);
                indexData._sha = json.sha; // Store SHA for updating later
            }
        }

        // Fallback to local fetch (relative path) if GitHub API not set or failed
        if (!indexData) {
            const localRes = await fetch('data/index.json?t=' + Date.now());
            if (localRes.ok) {
                indexData = await localRes.json();
            }
        }

        if (indexData) {
            database = indexData;
            updateStats();
            renderItems(database.items || []);
            showToast('進度索引載入完成', 'success');
        } else {
            showToast('尚無進度索引檔案，請先設定 GitHub 設定或上傳進度', 'warning');
        }
    } catch (err) {
        console.error("Load database error:", err);
        showToast('無法讀取 data/index.json，請檢查網路或 GitHub 設定', 'error');
    }
}

// Update Stats UI
function updateStats() {
    document.getElementById('statTotal').innerText = database.items ? database.items.length : 0;
    const lastIdStr = database.last_id ? `#${String(database.last_id).padStart(4, '0')}` : '#0000';
    document.getElementById('statLastId').innerText = lastIdStr;
    document.getElementById('statUpdated').innerText = database.updated_at ? new Date(database.updated_at).toLocaleTimeString() : '無';
}

// Render Progress Cards
function renderItems(items) {
    const listContainer = document.getElementById('itemsList');
    listContainer.innerHTML = '';

    if (!items || items.length === 0) {
        listContainer.innerHTML = '<div style="text-align:center; padding: 40px; color:#64748b;">暫無任何工作進度記錄</div>';
        return;
    }

    // Sort descending by ID
    const sorted = [...items].sort((a, b) => parseInt(b.id) - parseInt(a.id));

    sorted.forEach(item => {
        const card = document.createElement('div');
        card.className = 'item-card';
        
        const statusClass = `badge-${item.status || 'pending'}`;
        const dateStr = new Date(item.timestamp).toLocaleString();

        card.innerHTML = `
            <div class="item-header">
                <span class="item-id">#${item.id}</span>
                <span class="item-title">${escapeHtml(item.title)}</span>
                <span class="badge-status ${statusClass}">${item.status || 'pending'}</span>
            </div>
            <div class="item-meta">
                <span>👤 ${escapeHtml(item.author || 'AI/User')}</span>
                <span>🕒 ${dateStr}</span>
            </div>
            <div class="item-summary">${escapeHtml(item.summary || '無摘要說明')}</div>
            <div class="item-actions">
                <button class="btn btn-outline btn-sm" onclick="previewHtml('${item.download_url}')">👁️ 線上預覽</button>
                <button class="btn btn-primary btn-sm" onclick="downloadHtml('${item.download_url}', '${item.filename}')">📥 下載 HTML</button>
            </div>
        `;
        listContainer.appendChild(card);
    });
}

// Filter Items
function filterItems() {
    const query = document.getElementById('searchInput').value.toLowerCase();
    const status = document.getElementById('statusFilter').value;

    if (!database.items) return;

    const filtered = database.items.filter(item => {
        const matchQuery = item.title.toLowerCase().includes(query) || 
                           item.id.includes(query) || 
                           (item.summary && item.summary.toLowerCase().includes(query));
        const matchStatus = status === 'all' || item.status === status;
        return matchQuery && matchStatus;
    });

    renderItems(filtered);
}

// Handle Upload Form Submit
async function handleUpload(e) {
    e.preventDefault();

    if (!config.owner || !config.repo || !config.token) {
        showToast('上傳需設定 GitHub 帳號、Repo 與 Personal Access Token (PAT)', 'warning');
        toggleSettingsPanel(true);
        return;
    }

    const title = document.getElementById('taskTitle').value.trim();
    const author = document.getElementById('taskAuthor').value.trim() || 'AI Assistant';
    const status = document.getElementById('taskStatus').value;
    const summary = document.getElementById('taskSummary').value.trim();
    const htmlContent = document.getElementById('htmlContent').value;

    if (!title || !htmlContent) {
        showToast('請填寫標題並上傳或貼上 HTML 內文！', 'warning');
        return;
    }

    showToast('正上傳至 GitHub 並生成序號...', 'info');

    try {
        // Calculate new ID
        const nextId = (database.last_id || 0) + 1;
        const formattedId = String(nextId).padStart(4, '0');
        const safeTitle = title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').substring(0, 30);
        const filename = `${formattedId}_${safeTitle}.html`;
        const filePath = `data/html/${filename}`;

        // 1. Upload HTML file to GitHub
        const htmlBase64 = btoa(unescape(encodeURIComponent(htmlContent)));
        const htmlUploadUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${filePath}`;
        
        const htmlRes = await fetch(htmlUploadUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${config.token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: `Add progress #${formattedId}: ${title}`,
                content: htmlBase64,
                branch: config.branch
            })
        });

        if (!htmlRes.ok) {
            const errData = await htmlRes.json();
            throw new Error(`HTML 上傳失敗: ${errData.message}`);
        }

        // 2. Update data/index.json
        const newItem = {
            id: formattedId,
            title: title,
            author: author,
            status: status,
            timestamp: new Date().toISOString(),
            summary: summary,
            filename: filename,
            download_url: filePath
        };

        const updatedItems = database.items ? [...database.items, newItem] : [newItem];
        const updatedIndex = {
            last_id: nextId,
            updated_at: new Date().toISOString(),
            items: updatedItems
        };

        const indexJsonStr = JSON.stringify(updatedIndex, null, 2);
        const indexBase64 = btoa(unescape(encodeURIComponent(indexJsonStr)));
        const indexUploadUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/data/index.json`;

        // Get latest index SHA first
        const getShaRes = await fetch(`${indexUploadUrl}?ref=${config.branch}`, {
            headers: { 'Authorization': `token ${config.token}` }
        });
        let currentSha = database._sha;
        if (getShaRes.ok) {
            const shaJson = await getShaRes.json();
            currentSha = shaJson.sha;
        }

        const putIndexBody = {
            message: `Update progress index for #${formattedId}`,
            content: indexBase64,
            branch: config.branch
        };
        if (currentSha) putIndexBody.sha = currentSha;

        const indexRes = await fetch(indexUploadUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${config.token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(putIndexBody)
        });

        if (!indexRes.ok) {
            const errData = await indexRes.json();
            throw new Error(`索引庫更新失敗: ${errData.message}`);
        }

        showToast(`成功建立進度 #${formattedId}！`, 'success');
        document.getElementById('uploadForm').reset();
        loadDatabase();

    } catch (err) {
        console.error("Upload error:", err);
        showToast(err.message || '上傳失敗，請檢查權限與 Token', 'error');
    }
}

// Modal HTML Preview
async function previewHtml(url) {
    const modal = document.getElementById('previewModal');
    const iframe = document.getElementById('previewFrame');
    
    try {
        let content = '';
        if (config.owner && config.repo) {
            const apiUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${url}?ref=${config.branch}`;
            const headers = { 'Accept': 'application/vnd.github.v3+json' };
            if (config.token) headers['Authorization'] = `token ${config.token}`;

            const response = await fetch(apiUrl, { headers });
            if (response.ok) {
                const json = await response.json();
                content = decodeURIComponent(escape(atob(json.content)));
            }
        }

        if (!content) {
            const res = await fetch(url);
            content = await res.text();
        }

        iframe.srcdoc = content;
        modal.classList.add('active');

    } catch (e) {
        showToast('無法預覽該 HTML 檔案', 'error');
    }
}

function closeModal() {
    document.getElementById('previewModal').classList.remove('active');
    document.getElementById('previewFrame').srcdoc = '';
}

// Download HTML file
async function downloadHtml(url, filename) {
    try {
        let content = '';
        if (config.owner && config.repo) {
            const apiUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${url}?ref=${config.branch}`;
            const headers = { 'Accept': 'application/vnd.github.v3+json' };
            if (config.token) headers['Authorization'] = `token ${config.token}`;

            const response = await fetch(apiUrl, { headers });
            if (response.ok) {
                const json = await response.json();
                content = decodeURIComponent(escape(atob(json.content)));
            }
        }

        if (!content) {
            const res = await fetch(url);
            content = await res.text();
        }

        const blob = new Blob([content], { type: 'text/html' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename || 'progress.html';
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (e) {
        showToast('下載 HTML 失敗', 'error');
    }
}

// Toast Notifications
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
