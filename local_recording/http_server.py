"""Loopback-only HTTP/static adapter for local recording; never a deployment server."""
from __future__ import annotations

import hashlib
import json
import secrets
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import cast
import re
from urllib.parse import parse_qs, unquote, urlsplit

from .server import APIError, LocalRecordingService, SupabaseREST

_LOCAL_JS = {"meal-recording.js", "local-recording-ui.js", "local-recording-panel.js", "bridge.js"}
_PAGES_ORIGIN = "https://951222-1.github.io"


def read_target_supabase_config(project_root):
    """Read only the existing public project URL/key; never prints or writes them."""
    config = Path(project_root) / "mobile" / "config.js"
    if not config.is_file():
        raise ValueError("找不到目標 mobile/config.js；不猜測 Supabase 專案設定。")
    text = config.read_text(encoding="utf-8")
    def extract(name):
        match = re.search(r"\b" + re.escape(name) + r"\s*:\s*['\"]([^'\"]+)['\"]", text)
        if not match:
            raise ValueError("無法從目標 config.js 解析必要的公開 Supabase 設定。")
        return match.group(1)
    return extract("SUPABASE_URL"), extract("SUPABASE_PUBLISHABLE_KEY")


class LocalRecordingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    project_root: Path
    mobile_root: Path
    local_recording_root: Path
    csrf_token: str
    service: LocalRecordingService
    ffmpeg_path: str | None
    ffprobe_path: str | None

    def __init__(self, server_address, handler, project_root, service):
        self.project_root = Path(project_root).resolve()
        self.mobile_root = self.project_root / 'mobile'
        if not self.mobile_root.is_dir():
            raise ValueError('目標 mobile 資料夾不存在。')
        self.local_recording_root = self.project_root / 'local_recording'
        self.csrf_token = secrets.token_urlsafe(32)
        self.service = service
        self._playback_sessions = {}
        self._playback_lock = threading.Lock()
        import shutil
        self.ffmpeg_path = shutil.which('ffmpeg')
        self.ffprobe_path = shutil.which('ffprobe')
        super().__init__(server_address, handler)

    def server_close(self):
        try:
            super().server_close()
        finally:
            self.service.close()

    def issue_playback_cookie(self, bearer_token, origin=None):
        owner_id=self.service.supabase.get_user_id(bearer_token)
        token=secrets.token_urlsafe(32)
        digest=hashlib.sha256(token.encode('utf-8')).hexdigest()
        expires=time.time()+300
        with self._playback_lock:
            self._playback_sessions={key:value for key,value in self._playback_sessions.items() if value[1]>time.time()}
            self._playback_sessions[digest]=(owner_id,expires)
        cookie_site='SameSite=None; Secure; Partitioned' if origin==_PAGES_ORIGIN else 'SameSite=Strict'
        return {'Set-Cookie':f'local-recording-session={token}; Path=/api/local/recordings; HttpOnly; {cookie_site}; Max-Age=300'}

    def playback_owner(self, cookie_header):
        cookie=SimpleCookie()
        try:
            cookie.load(cookie_header or '')
        except Exception:
            return None
        morsel=cookie.get('local-recording-session')
        if not morsel or not morsel.value:
            return None
        digest=hashlib.sha256(morsel.value.encode('utf-8')).hexdigest()
        with self._playback_lock:
            value=self._playback_sessions.get(digest)
            if not value:
                return None
            if value[1]<=time.time():
                self._playback_sessions.pop(digest,None)
                return None
            return value[0]

    def revoke_playback_sessions(self, owner_id):
        with self._playback_lock:
            keys=[key for key,value in self._playback_sessions.items() if value[0]==owner_id]
            for key in keys:
                self._playback_sessions.pop(key,None)
        return len(keys)


class LocalRecordingHandler(BaseHTTPRequestHandler):
    server_version = "LocalRecordingCompanion/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        # Never log query strings, patient IDs, headers, or bearer tokens.
        return

    @property
    def local_server(self) -> LocalRecordingHTTPServer:
        return cast(LocalRecordingHTTPServer, self.server)

    def _host_origin(self):
        host = self.headers.get("Host", "")
        try:
            parsed = urlsplit("http://" + host)
        except ValueError:
            return None
        if parsed.hostname not in ("localhost", "127.0.0.1") or parsed.port != self.local_server.server_port:
            return None
        return "http://" + host.lower()

    def _origin_allowed(self, origin):
        return bool(origin and (origin == self._host_origin() or origin == _PAGES_ORIGIN))

    def _cors_headers(self):
        origin=self.headers.get('Origin')
        if self._origin_allowed(origin):
            return {'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Credentials':'true',
                    'Access-Control-Expose-Headers':'Accept-Ranges, Content-Length, Content-Range','Vary':'Origin'}
        return {}

    def _corp_policy(self):
        return 'cross-origin' if self.headers.get('Origin')==_PAGES_ORIGIN else 'same-origin'

    def _guard(self, write=False):
        expected = self._host_origin()
        if not expected:
            self._reply(403, error={"code": "LOOPBACK_ONLY", "message": "本機錄影服務只接受 localhost 連線。"})
            return False
        origin = self.headers.get("Origin")
        if origin and not self._origin_allowed(origin):
            self._reply(403, error={"code": "ORIGIN_DENIED", "message": "來源不允許。"})
            return False
        if write:
            supplied = self.headers.get("X-Local-Token", "")
            if not self._origin_allowed(origin) or not secrets.compare_digest(supplied, self.local_server.csrf_token):
                self._reply(403, error={"code": "CSRF_DENIED", "message": "本機請求驗證失敗。"})
                return False
        return True

    def _reply(self, status, data=None, error=None, extra_headers=None):
        payload = {"data": data, "error": error}
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", self._corp_policy())
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        for key,value in self._cors_headers().items():
            self.send_header(key,value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, exc):
        if isinstance(exc, APIError):
            self._reply(exc.status, error={"code": exc.code, "message": exc.message})
        else:
            self._reply(500, error={"code": "LOCAL_RECORDING_ERROR", "message": "本機錄影服務發生錯誤；原警報功能不受影響。"})

    def _path(self):
        raw = urlsplit(self.path).path
        decoded = unquote(raw)
        if "\\" in decoded or "\x00" in decoded or any(part in (".", "..") for part in decoded.split("/")):
            raise APIError(400, "INVALID_PATH", "請求路徑錯誤。")
        return decoded

    def _read_json(self, limit=1024 * 1024):
        length = self.headers.get("Content-Length", "")
        if not length.isdigit():
            raise APIError(411, "CONTENT_LENGTH_REQUIRED", "請求長度缺少或格式錯誤。")
        size = int(length)
        if size > limit:
            raise APIError(413, "BODY_TOO_LARGE", "請求資料超過上限。")
        try:
            value = json.loads(self.rfile.read(size).decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError):
            raise APIError(400, "INVALID_JSON", "請求 JSON 格式錯誤。") from None
        if not isinstance(value, dict):
            raise APIError(400, "INVALID_BODY", "請求內容必須是物件。")
        return value

    def _bearer(self):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            raise APIError(401, "UNAUTHORIZED", "請先登入 Supabase 帳號。")
        return header[7:].strip()

    def _serve_file(self, target, html_injection=False):
        root = self.local_server.project_root.resolve()
        resolved = target.resolve()
        if root not in resolved.parents or not target.is_file() or target.is_symlink():
            raise APIError(404, "NOT_FOUND", "找不到本機資源。")
        content = target.read_bytes()
        lower_content = content.lower()
        needs_injection = (
            target.name == 'caregiver.html' and b'id="local-recording-connect"' not in lower_content
        ) or (
            target.name != 'caregiver.html' and b'bridge.js' not in lower_content
        )
        if html_injection and needs_injection:
            scripts = ("<script src=\"/local-recording/meal-recording.js\"></script>"
                       "<script src=\"/local-recording/local-recording-ui.js\"></script>"
                       "<script src=\"/local-recording/local-recording-panel.js\"></script>"
                       "<script src=\"/local-recording/bridge.js\"></script>")
            if target.name == 'caregiver.html':
                markup = ("<section id=\"local-recording-panel\" class=\"w-full max-w-7xl mx-auto px-4 sm:px-6 pb-6\" aria-labelledby=\"local-recording-heading\">"
                          "<div class=\"bg-slate-900 border border-slate-800 rounded-3xl p-5 sm:p-6 shadow-xl space-y-4\">"
                          "<div class=\"flex flex-wrap items-center justify-between gap-3\"><div><h2 id=\"local-recording-heading\" class=\"font-bold text-lg text-slate-100\">🎞️ 本機整餐錄影與回看</h2>"
                          "<p class=\"text-xs text-slate-400 mt-1\">無聲影片只儲存在這台電腦；不會上傳至 Supabase。嗆咳標記可從事件前 10 秒回看。</p></div>"
                          "<button id=\"local-recordings-refresh\" type=\"button\" class=\"rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200\">重新整理影片</button></div>"
                          "<label for=\"local-recording-consent-toggle\" class=\"flex items-start gap-3 rounded-2xl border border-slate-700 bg-slate-950 p-3 cursor-pointer\">"
                          "<input id=\"local-recording-consent-toggle\" type=\"checkbox\" disabled class=\"mt-1 h-5 w-5 accent-blue-500\">"
                          "<span class=\"text-xs leading-relaxed text-slate-200\"><strong class=\"block text-blue-300\">此個案同意在這台電腦進行整餐無聲錄影</strong>同意狀態只存在本機；關閉後不會自動刪除既有影片。</span></label>"
                          "<p id=\"local-recording-panel-status\" role=\"status\" aria-live=\"polite\" class=\"text-xs text-slate-300\" hidden></p>"
                          "<div id=\"local-recording-list\" class=\"grid grid-cols-1 md:grid-cols-2 gap-3\"></div>"
                          "<p id=\"local-recording-empty\" class=\"rounded-xl border border-slate-800 bg-slate-950 p-4 text-xs text-slate-400\">請先選取個案。</p>"
                          "<div class=\"border-t border-slate-800 pt-4 space-y-3\"><h3 id=\"local-recording-player-title\" class=\"font-semibold text-sm text-slate-200\"></h3>"
                          "<video id=\"local-recording-player\" class=\"w-full max-h-[60vh] rounded-2xl bg-black\" controls playsinline muted preload=\"metadata\" hidden></video>"
                          "<div id=\"local-recording-marks\" class=\"flex flex-wrap gap-2\"></div></div></div></section>")
            else:
                markup = ("" if b'id=\"local-recording-live\"' in content.lower() else
                          "<div id=\"local-recording-live\" hidden role=\"status\" aria-live=\"polite\" class=\"fixed bottom-24 right-4 z-[60] rounded-xl border border-rose-700 bg-rose-950/95 px-4 py-3 text-sm font-bold text-rose-100 shadow-xl\"></div>")
            marker = b"</body>"
            if marker not in content.lower():
                raise APIError(500, "HTML_INJECTION_POINT_MISSING", "本機頁面缺少安全掛載點，未啟用錄影。")
            index = content.lower().rfind(marker)
            content = content[:index] + (markup + scripts).encode("utf-8") + content[index:]
        mime = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".wasm": "application/wasm"}.get(target.suffix.lower(), "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def do_OPTIONS(self):
        if not self._guard(write=False):
            return
        origin = self.headers.get("Origin")
        if origin and self._origin_allowed(origin):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "authorization, content-type, range, x-local-token, x-recording-token")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Vary", "Origin")
            self.end_headers()
        else:
            self._reply(403, error={"code": "ORIGIN_DENIED", "message": "來源不允許。"})

    def _serve_video(self, recording_id):
        owner_id=self.local_server.playback_owner(self.headers.get('Cookie',''))
        record=self.local_server.service.store.get_recording(recording_id)
        if not owner_id or not record or record['owner_id']!=owner_id or record['status']!='ready':
            raise APIError(404,'RECORDING_NOT_FOUND','找不到本機錄影。')
        data_dir=self.local_server.service.store.data_dir.resolve()
        target=data_dir/'recordings'/recording_id/'normalized.mp4'
        try:
            resolved=target.resolve(strict=True)
        except OSError:
            raise APIError(404,'RECORDING_NOT_FOUND','找不到本機錄影。') from None
        if target.is_symlink() or resolved!=target or data_dir not in resolved.parents or not resolved.is_file():
            raise APIError(404,'RECORDING_NOT_FOUND','找不到本機錄影。')
        size=resolved.stat().st_size
        start,end=0,size-1
        status=200
        range_header=self.headers.get('Range')
        if range_header:
            match=re.fullmatch(r'bytes=(\d*)-(\d*)',range_header.strip())
            if not match or ',' in range_header or size<=0:
                self.send_response(416)
                self.send_header('Content-Range',f'bytes */{size}')
                self.send_header('Content-Length','0')
                self.send_header('Cache-Control','private, no-store')
                self.send_header('Cross-Origin-Resource-Policy',self._corp_policy())
                for key,value in self._cors_headers().items(): self.send_header(key,value)
                self.end_headers()
                return
            first,last=match.groups()
            try:
                if not first:
                    suffix=int(last)
                    if suffix<=0: raise ValueError
                    start=max(0,size-suffix)
                else:
                    start=int(first)
                    end=int(last) if last else size-1
                if start>=size or end<start: raise ValueError
                end=min(end,size-1)
            except ValueError:
                self.send_response(416)
                self.send_header('Content-Range',f'bytes */{size}')
                self.send_header('Content-Length','0')
                self.send_header('Cache-Control','private, no-store')
                self.send_header('Cross-Origin-Resource-Policy',self._corp_policy())
                for key,value in self._cors_headers().items(): self.send_header(key,value)
                self.end_headers()
                return
            status=206
        length=max(0,end-start+1)
        self.send_response(status)
        self.send_header('Content-Type','video/mp4')
        self.send_header('Content-Length',str(length))
        self.send_header('Accept-Ranges','bytes')
        self.send_header('Cache-Control','private, no-store')
        self.send_header('Content-Disposition','inline; filename="recording.mp4"')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Cross-Origin-Resource-Policy',self._corp_policy())
        for key,value in self._cors_headers().items(): self.send_header(key,value)
        if status==206:
            self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
        self.end_headers()
        if self.command!='HEAD' and length:
            with resolved.open('rb') as stream:
                stream.seek(start)
                remaining=length
                while remaining:
                    block=stream.read(min(64*1024,remaining))
                    if not block: break
                    self.wfile.write(block)
                    remaining-=len(block)

    def do_GET(self):
        if not self._guard():
            return
        try:
            path = self._path()
            video_match = re.fullmatch(r"/api/local/recordings/([0-9a-f-]{36})/video", path)
            if video_match:
                self._serve_video(video_match.group(1))
                return
            if path == "/api/local/config":
                self._reply(200, {"mode": "local-recording", "csrf_token": self.local_server.csrf_token,
                    "ffmpeg_available": bool(self.local_server.ffmpeg_path and self.local_server.ffprobe_path),
                    "max_recording_bytes": self.local_server.service.store.max_recording_bytes,
                    "max_storage_bytes": self.local_server.service.store.max_storage_bytes})
                return
            if path == "/api/local/consent":
                query = parse_qs(urlsplit(self.path).query, strict_parsing=True)
                patient_ids = query.get("patient_id", [])
                if len(patient_ids) != 1:
                    raise APIError(400, "INVALID_QUERY", "必須提供一個 patient_id。")
                self._reply(200, self.local_server.service.get_consent(self._bearer(), patient_ids[0]))
                return
            if path == "/api/local/recordings":
                query = parse_qs(urlsplit(self.path).query, strict_parsing=True)
                patient_ids = query.get("patient_id", [])
                if len(patient_ids) != 1:
                    raise APIError(400, "INVALID_QUERY", "必須提供一個 patient_id。")
                token = self._bearer()
                rows = self.local_server.service.list_recordings(token, patient_ids[0])
                self._reply(200, rows, extra_headers=self.local_server.issue_playback_cookie(token,self.headers.get('Origin')))
                return
            match = re.fullmatch(r"/api/local/recordings/([0-9a-f-]{36})", path)
            if match:
                token = self._bearer()
                detail = self.local_server.service.get_recording(token, match.group(1))
                self._reply(200, detail, extra_headers=self.local_server.issue_playback_cookie(token,self.headers.get('Origin')))
                return
            if path.startswith("/mobile/"):
                relative = path[len("/mobile/"):]
                target = self.local_server.mobile_root.joinpath(*PurePosixPath(relative).parts)
                self._serve_file(target, html_injection=relative in ("index.html", "caregiver.html"))
                return
            if path.startswith("/local-recording/") or path.startswith("/local_recording/"):
                filename = path.rsplit("/", 1)[-1]
                if filename not in _LOCAL_JS:
                    raise APIError(404, "NOT_FOUND", "找不到本機資源。")
                self._serve_file(self.local_server.local_recording_root / filename)
                return
            if path == "/":
                self.send_response(302)
                self.send_header("Location", "/mobile/index.html")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            raise APIError(404, "NOT_FOUND", "找不到本機資源。")
        except (APIError, OSError, ValueError) as exc:
            self._error(exc)

    def do_HEAD(self):
        self.do_GET()

    def do_PUT(self):
        if not self._guard(write=True):
            return
        try:
            path = self._path()
            if path == "/api/local/consent":
                body = self._read_json()
                if set(body) != {"patient_id", "enabled"}:
                    raise APIError(400, "INVALID_BODY", "同意更新資料不完整。")
                self._reply(200, self.local_server.service.set_consent(self._bearer(), body["patient_id"], body["enabled"]))
                return
            raise APIError(404, "NOT_FOUND", "找不到本機 API。")
        except (APIError, OSError, ValueError) as exc:
            self._error(exc)

    def do_POST(self):
        if not self._guard(write=True):
            return
        try:
            path = self._path()
            if path == "/api/local/playback-session/revoke":
                body = self._read_json()
                if body:
                    raise APIError(400, "INVALID_BODY", "登出撤銷請求不接受額外欄位。")
                owner_id = self.local_server.service.supabase.get_user_id(self._bearer())
                self.local_server.revoke_playback_sessions(owner_id)
                cookie_site='SameSite=None; Secure; Partitioned' if self.headers.get('Origin')==_PAGES_ORIGIN else 'SameSite=Strict'
                self._reply(200, {"revoked": True}, extra_headers={
                    "Set-Cookie": f"local-recording-session=; Path=/api/local/recordings; HttpOnly; {cookie_site}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
                })
                return
            if path == "/api/local/recordings":
                self._reply(201, self.local_server.service.create_recording(self._bearer(), self._read_json()))
                return
            chunk_match = re.fullmatch(r"/api/local/recordings/([0-9a-f-]{36})/chunks/([0-9]+)", path)
            if chunk_match:
                length = self.headers.get("Content-Length", "")
                if not length.isdigit() or int(length) <= 0:
                    raise APIError(411, "CONTENT_LENGTH_REQUIRED", "影片分塊長度缺少或錯誤。")
                if int(length) > 16 * 1024 * 1024:
                    self.close_connection = True
                    raise APIError(413, "CHUNK_SIZE_INVALID", "影片分塊超過 16 MiB 上限。")
                data = self.rfile.read(int(length))
                if len(data) != int(length):
                    raise APIError(400, "INCOMPLETE_CHUNK", "影片分塊未完整接收。")
                result = self.local_server.service.upload_chunk(self._bearer(), chunk_match.group(1),
                    self.headers.get("X-Recording-Token", ""), int(chunk_match.group(2)), data)
                self._reply(200, result)
                return
            finalize_match = re.fullmatch(r"/api/local/recordings/([0-9a-f-]{36})/finalize", path)
            if finalize_match:
                result = self.local_server.service.finalize_recording(self._bearer(), finalize_match.group(1),
                    self.headers.get("X-Recording-Token", ""), self._read_json())
                self._reply(202 if result.get('status') == 'processing' else 200, result)
                return
            cough_match = re.fullmatch(r"/api/local/recordings/([0-9a-f-]{36})/coughs", path)
            if cough_match:
                result = self.local_server.service.add_cough_marker(self._bearer(), cough_match.group(1),
                    self.headers.get("X-Recording-Token", ""), self._read_json())
                self._reply(200, result)
                return
            raise APIError(404, "NOT_FOUND", "找不到本機 API。")
        except (APIError, OSError, ValueError) as exc:
            self._error(exc)

    def do_DELETE(self):
        if not self._guard(write=True):
            return
        try:
            path = self._path()
            match = re.fullmatch(r"/api/local/recordings/([0-9a-f-]{36})", path)
            if match:
                self._reply(200, self.local_server.service.delete_recording(self._bearer(), match.group(1)))
                return
            raise APIError(404, "NOT_FOUND", "找不到本機 API。")
        except (APIError, OSError, ValueError) as exc:
            self._error(exc)


def create_local_server(project_root, data_dir, port=0, supabase=None, supabase_url=None, publishable_key=None,
                        normalizer=None, ffmpeg_path=None, ffprobe_path=None, max_recording_bytes=None,
                        max_storage_bytes=None, free_space_reserve_bytes=None):
    root = Path(project_root).resolve()
    if not root.is_dir() or root != Path(project_root).absolute():
        raise ValueError('Project root must be an existing real directory, not a link.')
    if not (root / 'mobile').is_dir():
        raise ValueError('Target mobile directory is missing.')
    if supabase is None:
        if not supabase_url or not publishable_key:
            supabase_url, publishable_key = read_target_supabase_config(root)
        supabase = SupabaseREST(supabase_url, publishable_key)
    if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
        raise ValueError('Port must be an integer from 0 to 65535; 0 selects an unused local port.')
    service_options={key:value for key,value in {
        'max_recording_bytes':max_recording_bytes,'max_storage_bytes':max_storage_bytes,
        'free_space_reserve_bytes':free_space_reserve_bytes
    }.items() if value is not None}
    service = LocalRecordingService(data_dir=data_dir, supabase=supabase, project_root=root,
        normalizer=normalizer, ffmpeg_path=ffmpeg_path, ffprobe_path=ffprobe_path, **service_options)
    try:
        return LocalRecordingHTTPServer(('127.0.0.1', port), LocalRecordingHandler, root, service)
    except BaseException:
        service.close()
        raise
