"""Local-only recording persistence for the Supabase-authenticated companion.

No Supabase rows are written here. The caller's existing JWT is verified by an
injected Supabase adapter; recording consent metadata and video files stay in a
caller-chosen data directory outside the static web project.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import secrets
import shutil
import sqlite3
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import re

UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)
MAX_CHUNK_BYTES = 16 * 1024 * 1024
DEFAULT_MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024
DEFAULT_MAX_STORAGE_BYTES = 20 * 1024 * 1024 * 1024
DEFAULT_FREE_SPACE_RESERVE_BYTES = 512 * 1024 * 1024


class APIError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class SupabaseREST:
    """Read-only Supabase Auth/PostgREST verifier using the caller's JWT and public key."""
    def __init__(self, supabase_url, publishable_key, transport=None, timeout=8.0):
        if not isinstance(supabase_url, str) or not supabase_url.startswith('https://'):
            raise ValueError('Supabase URL must use HTTPS.')
        if not isinstance(publishable_key, str) or not publishable_key.startswith('sb_publishable_'):
            raise ValueError('Supabase publishable key is required; privileged keys are refused.')
        self.base_url = supabase_url.rstrip('/')
        self.publishable_key = publishable_key
        self.transport = transport or urlopen
        self.timeout = timeout

    def _request_json(self, path, access_token):
        if not isinstance(access_token, str) or not access_token.strip():
            raise APIError(401, 'UNAUTHORIZED', '請先登入 Supabase 帳號。')
        request = Request(self.base_url + path, headers={
            'apikey': self.publishable_key,
            'Authorization': 'Bearer ' + access_token,
            'Accept': 'application/json',
            'Cache-Control': 'no-store',
        }, method='GET')
        try:
            response = self.transport(request, timeout=self.timeout)
            with response:
                status = getattr(response, 'status', 200)
                raw = response.read()
        except HTTPError as error:
            status = error.code
            error.close()
            if status in (401, 403):
                raise APIError(401, 'UNAUTHORIZED', 'Supabase 登入狀態已失效，請重新登入。') from None
            if status == 404:
                return None
            raise APIError(503, 'SUPABASE_UNAVAILABLE', 'Supabase 身分驗證未成功；本機錄影未變更。') from None
        except (URLError, TimeoutError, OSError):
            raise APIError(503, 'SUPABASE_UNAVAILABLE', '無法連線驗證 Supabase 身分；本機錄影未變更。') from None
        if status < 200 or status >= 300:
            raise APIError(503, 'SUPABASE_UNAVAILABLE', 'Supabase 身分驗證未成功；本機錄影未變更。')
        try:
            return json.loads(raw.decode('utf-8'))
        except (UnicodeError, json.JSONDecodeError):
            raise APIError(503, 'SUPABASE_RESPONSE_INVALID', 'Supabase 回應無法驗證；本機錄影未變更。') from None

    def get_user_id(self, access_token):
        user = self._request_json('/auth/v1/user', access_token)
        try:
            return require_uuid(user.get('id'), 'Supabase user id') if isinstance(user, dict) else None
        except APIError:
            raise APIError(401, 'UNAUTHORIZED', 'Supabase 登入狀態無效，請重新登入。') from None

    def _visible_rows(self, table, filters, access_token):
        query = {'select': 'id'}
        query.update({key: 'eq.' + value for key, value in filters.items()})
        return self._request_json(f'/rest/v1/{table}?{urlencode(query)}', access_token)

    def owns_patient(self, access_token, patient_id):
        patient_id = require_uuid(patient_id, 'patient_id')
        rows = self._visible_rows('patient_profiles', {'id': patient_id}, access_token)
        return isinstance(rows, list) and any(isinstance(row, dict) and row.get('id') == patient_id for row in rows)

    def owns_session(self, access_token, patient_id, session_id):
        patient_id = require_uuid(patient_id, 'patient_id')
        session_id = require_uuid(session_id, 'session_id')
        rows = self._visible_rows('meal_sessions', {'id': session_id, 'patient_id': patient_id}, access_token)
        return isinstance(rows, list) and any(isinstance(row, dict) and row.get('id') == session_id for row in rows)

    def owns_cough_event(self, access_token, session_id, event_id):
        session_id = require_uuid(session_id, 'session_id')
        event_id = require_uuid(event_id, 'event_id')
        query = {'select': 'id', 'id': 'eq.' + event_id, 'session_id': 'eq.' + session_id, 'event_type': 'eq.COUGH'}
        rows = self._request_json('/rest/v1/anomaly_logs?' + urlencode(query), access_token)
        return isinstance(rows, list) and any(isinstance(row, dict) and row.get('id') == event_id for row in rows)


def require_uuid(value, field='id'):
    if not isinstance(value, str) or not UUID_RE.fullmatch(value):
        raise APIError(400, 'INVALID_UUID', f'{field} 格式錯誤。')
    return value


def require_iso(value, field):
    if not isinstance(value, str):
        raise APIError(400, 'INVALID_TIME', f'{field} 必須是含時區的 ISO 時間。')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError
    except (ValueError, OverflowError):
        raise APIError(400, 'INVALID_TIME', f'{field} 必須是含時區的 ISO 時間。') from None
    return value


def require_finite_number(value, field, minimum=0.0):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise APIError(400, 'INVALID_NUMBER', f'{field} 數值錯誤。')
    result = float(value)
    if not math.isfinite(result) or result < minimum:
        raise APIError(400, 'INVALID_NUMBER', f'{field} 數值錯誤。')
    return result


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


class RecordingStore:
    """Local SQLite records contain IDs/metadata only, never copied patient rows."""
    def __init__(self, data_dir, project_root, max_recording_bytes=DEFAULT_MAX_RECORDING_BYTES,
                 max_storage_bytes=DEFAULT_MAX_STORAGE_BYTES, free_space_reserve_bytes=DEFAULT_FREE_SPACE_RESERVE_BYTES):
        for name,value in (('max_recording_bytes',max_recording_bytes),('max_storage_bytes',max_storage_bytes)):
            if type(value) is not int or value<=0:
                raise ValueError(f'{name} must be a positive integer.')
        if type(free_space_reserve_bytes) is not int or free_space_reserve_bytes<0:
            raise ValueError('free_space_reserve_bytes must be a non-negative integer.')
        if max_recording_bytes>max_storage_bytes:
            raise ValueError('max_recording_bytes must not exceed max_storage_bytes.')
        self.max_recording_bytes=max_recording_bytes
        self.max_storage_bytes=max_storage_bytes
        self.free_space_reserve_bytes=free_space_reserve_bytes
        self.data_dir = Path(data_dir).expanduser().absolute()
        self.project_root = Path(project_root).resolve()
        if self.data_dir.resolve() != self.data_dir:
            raise ValueError('錄影資料目錄不可是 symlink/junction。')
        if self.data_dir == self.project_root or self.project_root in self.data_dir.parents:
            raise ValueError('錄影資料目錄必須位於網站專案之外。')
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.recordings_dir = self.data_dir / 'recordings'
        self.recordings_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.data_dir / 'local.sqlite3'
        with self._connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS recording_consents (
                    owner_id TEXT NOT NULL, patient_id TEXT NOT NULL,
                    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), updated_at TEXT NOT NULL,
                    PRIMARY KEY(owner_id,patient_id));
                CREATE TABLE IF NOT EXISTS recordings (
                    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, patient_id TEXT NOT NULL,
                    session_id TEXT, status TEXT NOT NULL CHECK(status IN ('recording','processing','ready','failed')),
                    started_at TEXT NOT NULL, ended_at TEXT, mime_type TEXT NOT NULL,
                    width INTEGER NOT NULL, height INTEGER NOT NULL, duration_sec REAL,
                    frame_count INTEGER, effective_fps REAL, metadata TEXT NOT NULL DEFAULT '{}',
                    error_message TEXT, normalized_size_bytes INTEGER NOT NULL DEFAULT 0,
                    token_hash TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS recordings_owner_patient_created_idx
                    ON recordings(owner_id,patient_id,created_at DESC);
                CREATE TABLE IF NOT EXISTS recording_chunks (
                    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
                    sequence INTEGER NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, relpath TEXT NOT NULL,
                    PRIMARY KEY(recording_id,sequence));
                CREATE TABLE IF NOT EXISTS cough_markers (
                    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
                    event_id TEXT NOT NULL, session_id TEXT NOT NULL, offset_sec REAL NOT NULL,
                    occurred_at TEXT NOT NULL, kind TEXT NOT NULL,
                    PRIMARY KEY(recording_id,event_id));
            ''')
            columns={row['name'] for row in db.execute('PRAGMA table_info(recordings)')}
            if 'normalized_size_bytes' not in columns:
                db.execute('ALTER TABLE recordings ADD COLUMN normalized_size_bytes INTEGER NOT NULL DEFAULT 0')

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.db_path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def get_consent(self, owner_id, patient_id):
        with self._connect() as db:
            row = db.execute('SELECT enabled FROM recording_consents WHERE owner_id=? AND patient_id=?', (owner_id, patient_id)).fetchone()
        return bool(row['enabled']) if row else False

    def set_consent(self, owner_id, patient_id, enabled):
        with self._connect() as db:
            db.execute('''INSERT INTO recording_consents(owner_id,patient_id,enabled,updated_at)
                VALUES(?,?,?,?) ON CONFLICT(owner_id,patient_id) DO UPDATE SET
                enabled=excluded.enabled,updated_at=excluded.updated_at''',
                (owner_id, patient_id, int(enabled), now_iso()))

    def create_recording(self, owner_id, payload):
        recording_id = str(uuid.uuid4())
        recording_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(recording_token.encode('utf-8')).hexdigest()
        folder = self._recording_dir(recording_id, create=True)
        row = {'id':recording_id,'owner_id':owner_id,'patient_id':payload['patient_id'],
            'session_id':payload.get('session_id'),'status':'recording','started_at':payload['started_at'],
            'ended_at':None,'mime_type':payload['mime_type'],'width':payload['width'],'height':payload['height'],
            'duration_sec':None,'frame_count':None,'effective_fps':None,'metadata':{},
            'error_message':None,'created_at':now_iso()}
        try:
            with self._connect() as db:
                db.execute('''INSERT INTO recordings(id,owner_id,patient_id,session_id,status,started_at,ended_at,
                    mime_type,width,height,duration_sec,frame_count,effective_fps,metadata,error_message,token_hash,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                    (row['id'],row['owner_id'],row['patient_id'],row['session_id'],row['status'],row['started_at'],
                     row['ended_at'],row['mime_type'],row['width'],row['height'],row['duration_sec'],row['frame_count'],
                     row['effective_fps'],json.dumps(row['metadata']),row['error_message'],token_hash,row['created_at']))
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        return row, recording_token

    def _recording_dir(self, recording_id, create=False):
        require_uuid(recording_id, 'recording_id')
        path = self.recordings_dir / recording_id
        if self.recordings_dir.resolve() not in path.resolve().parents:
            raise APIError(403, 'UNSAFE_STORAGE', '本機錄影路徑驗證失敗。')
        if create:
            path.mkdir(parents=True, exist_ok=False)
        return path

    def get_recording(self, recording_id):
        require_uuid(recording_id, 'recording_id')
        with self._connect() as db:
            row=db.execute('SELECT * FROM recordings WHERE id=?',(recording_id,)).fetchone()
            if not row:return None
            result=dict(row)
            result['metadata']=json.loads(result['metadata'] or '{}')
            result['cough_markers']=[dict(item) for item in db.execute(
                'SELECT event_id,session_id,offset_sec,occurred_at,kind FROM cough_markers WHERE recording_id=? ORDER BY offset_sec',(recording_id,))]
        result.pop('token_hash',None)
        return result

    def list_recordings(self, owner_id, patient_id):
        with self._connect() as db:
            ids = [row['id'] for row in db.execute(
                'SELECT id FROM recordings WHERE owner_id=? AND patient_id=? ORDER BY started_at DESC LIMIT 500',
                (owner_id, patient_id))]
        return [self.get_recording(recording_id) for recording_id in ids]

    def token_matches(self, recording_id, token):
        if not isinstance(token,str) or not token:return False
        require_uuid(recording_id,'recording_id')
        with self._connect() as db:
            row=db.execute('SELECT token_hash FROM recordings WHERE id=?',(recording_id,)).fetchone()
        if not row:return False
        return hmac.compare_digest(hashlib.sha256(token.encode('utf-8')).hexdigest(),row['token_hash'])

    def list_chunks(self, recording_id):
        require_uuid(recording_id, 'recording_id')
        with self._connect() as db:
            return [dict(row) for row in db.execute(
                'SELECT sequence,size,sha256,relpath FROM recording_chunks WHERE recording_id=? ORDER BY sequence',
                (recording_id,))]

    def set_processing(self, recording_id, payload):
        with self._connect() as db:
            row=db.execute('SELECT status FROM recordings WHERE id=?',(recording_id,)).fetchone()
            if not row:
                raise APIError(404,'RECORDING_NOT_FOUND','找不到本機錄影。')
            if row['status']!='recording':
                raise APIError(409,'RECORDING_NOT_ACTIVE','錄影已結束或已提交轉存。')
            db.execute('''UPDATE recordings SET status='processing',session_id=?,ended_at=?,duration_sec=?,frame_count=?,
                effective_fps=?,width=?,height=?,metadata=? WHERE id=?''',
                (payload.get('session_id'),payload['ended_at'],payload['duration_sec'],payload['frame_count'],
                 payload['effective_fps'],payload['width'],payload['height'],json.dumps(payload,allow_nan=False),recording_id))

    def mark_ready(self, recording_id, encoded_metadata, normalized_size_bytes=0):
        if type(normalized_size_bytes) is not int or normalized_size_bytes<0:
            raise ValueError('normalized_size_bytes must be a non-negative integer')
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT metadata,status FROM recordings WHERE id=?',(recording_id,)).fetchone()
            if not row or row['status']!='processing':
                return False
            chunks=db.execute('SELECT COALESCE(SUM(size),0) FROM recording_chunks').fetchone()[0]
            videos=db.execute('SELECT COALESCE(SUM(normalized_size_bytes),0) FROM recordings').fetchone()[0]
            if chunks+videos+normalized_size_bytes>self.max_storage_bytes:
                return False
            metadata=json.loads(row['metadata'] or '{}')
            metadata.update(encoded_metadata)
            db.execute("UPDATE recordings SET status='ready',metadata=?,normalized_size_bytes=?,error_message=NULL WHERE id=? AND status='processing'",
                (json.dumps(metadata,allow_nan=False),normalized_size_bytes,recording_id))
            return True

    def mark_failed(self, recording_id, public_message):
        with self._connect() as db:
            db.execute("UPDATE recordings SET status='failed',error_message=? WHERE id=? AND status='processing'",
                (str(public_message)[:300],recording_id))

    def total_storage_bytes(self):
        with self._connect() as db:
            chunks=db.execute('SELECT COALESCE(SUM(size),0) AS n FROM recording_chunks').fetchone()['n']
            videos=db.execute('SELECT COALESCE(SUM(normalized_size_bytes),0) AS n FROM recordings').fetchone()['n']
        return int(chunks)+int(videos)

    def delete_recording(self, owner_id, recording_id):
        require_uuid(recording_id,'recording_id')
        record=self.get_recording(recording_id)
        if not record or record['owner_id']!=owner_id:
            raise APIError(404,'RECORDING_NOT_FOUND','找不到本機錄影。')
        if record['status'] not in ('ready','failed'):
            raise APIError(409,'RECORDING_ACTIVE','錄影處理中或尚未結束，不能刪除。')
        recordings_root=self.data_dir/'recordings'
        directory=self._recording_dir(recording_id)
        if recordings_root.is_symlink() or directory.is_symlink() or directory.resolve().parent!=recordings_root.resolve():
            raise APIError(403,'UNSAFE_STORAGE','錄影路徑驗證失敗，未刪除檔案。')
        if directory.exists():
            if any(path.is_symlink() for path in directory.rglob('*')):
                raise APIError(403,'UNSAFE_STORAGE','錄影目錄含有連結檔，未刪除檔案。')
            shutil.rmtree(directory)
        with self._connect() as db:
            cursor=db.execute("DELETE FROM recordings WHERE id=? AND owner_id=? AND status IN ('ready','failed')",
                (recording_id,owner_id))
            if cursor.rowcount!=1:
                raise APIError(409,'RECORDING_STATE_CHANGED','錄影狀態已變更，請重新整理。')
        return {'deleted':True,'id':recording_id}

    def upload_chunk(self, recording_id, recording_token, sequence, data):
        if not self.token_matches(recording_id, recording_token):
            raise APIError(403, 'RECORDING_TOKEN_INVALID', '錄影上傳授權無效。')
        if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 0 or sequence > 1_000_000:
            raise APIError(400, 'INVALID_SEQUENCE', '影片分塊序號錯誤。')
        if not isinstance(data, (bytes, bytearray)) or not data or len(data) > MAX_CHUNK_BYTES:
            raise APIError(413, 'CHUNK_SIZE_INVALID', '影片分塊為空或超過 16 MiB 上限。')
        record = self.get_recording(recording_id)
        if not record or record['status'] != 'recording':
            raise APIError(409, 'RECORDING_NOT_ACTIVE', '錄影目前不能再接收分塊。')
        chunk_dir = self._recording_dir(recording_id) / 'chunks'
        chunk_dir.mkdir(parents=True, exist_ok=True)
        if chunk_dir.resolve().parent != self._recording_dir(recording_id).resolve():
            raise APIError(403, 'UNSAFE_STORAGE', '影片分塊目錄驗證失敗。')
        target = chunk_dir / f'chunk-{sequence:08d}.webm'
        if target.resolve().parent != chunk_dir.resolve() or target.is_symlink():
            raise APIError(403, 'UNSAFE_STORAGE', '影片分塊路徑驗證失敗。')
        digest = hashlib.sha256(data).hexdigest()
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            existing = db.execute('SELECT size,sha256 FROM recording_chunks WHERE recording_id=? AND sequence=?', (recording_id, sequence)).fetchone()
            if existing:
                if existing['size'] == len(data) and existing['sha256'] == digest:
                    return {'recording_id':recording_id,'sequence':sequence,'duplicate':True}
                raise APIError(409, 'CHUNK_CONFLICT', '同一序號已收到不同影片資料。')
            recording_bytes=db.execute('SELECT COALESCE(SUM(size),0) FROM recording_chunks WHERE recording_id=?',(recording_id,)).fetchone()[0]
            if recording_bytes+len(data)>self.max_recording_bytes:
                raise APIError(413,'RECORDING_SIZE_LIMIT','此餐錄影已達本機單次容量上限；已接收片段仍保留。')
            total_chunks=db.execute('SELECT COALESCE(SUM(size),0) FROM recording_chunks').fetchone()[0]
            total_videos=db.execute('SELECT COALESCE(SUM(normalized_size_bytes),0) FROM recordings').fetchone()[0]
            if total_chunks+total_videos+len(data)>self.max_storage_bytes:
                raise APIError(507,'STORAGE_QUOTA_EXCEEDED','本機錄影資料夾已達設定容量上限；未接收此分塊。')
            if shutil.disk_usage(self.data_dir).free < len(data) + self.free_space_reserve_bytes:
                raise APIError(507, 'STORAGE_FULL', '本機磁碟空間不足；未接收此分塊。')
            temporary = target.with_suffix('.webm.tmp')
            try:
                with temporary.open('xb') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, target)
                db.execute('INSERT INTO recording_chunks(recording_id,sequence,size,sha256,relpath) VALUES(?,?,?,?,?)',
                    (recording_id,sequence,len(data),digest,str(target.relative_to(self.data_dir))))
            except Exception:
                try: temporary.unlink(missing_ok=True)
                except OSError: pass
                try: target.unlink(missing_ok=True)
                except OSError: pass
                raise
        return {'recording_id':recording_id,'sequence':sequence,'duplicate':False}

    def add_cough_marker(self, recording_id, event_id, session_id, offset_sec, occurred_at, kind):
        with self._connect() as db:
            record=db.execute('SELECT session_id FROM recordings WHERE id=?',(recording_id,)).fetchone()
            if not record:raise APIError(404,'RECORDING_NOT_FOUND','找不到本機錄影。')
            if record['session_id'] and record['session_id']!=session_id:raise APIError(403,'SESSION_MISMATCH','事件不屬於此錄影餐次。')
            db.execute('INSERT OR IGNORE INTO cough_markers VALUES(?,?,?,?,?,?)',(recording_id,event_id,session_id,offset_sec,occurred_at,kind))
            row=db.execute('SELECT event_id,session_id,offset_sec,occurred_at,kind FROM cough_markers WHERE recording_id=? AND event_id=?',(recording_id,event_id)).fetchone()
        return dict(row)

    def close(self):
        return None


class LocalRecordingService:
    """Business rules; `supabase` must enforce owner-scoped RLS for every lookup."""
    def __init__(self, data_dir, supabase, project_root, normalizer=None, ffmpeg_path=None, ffprobe_path=None,
                 max_recording_bytes=DEFAULT_MAX_RECORDING_BYTES, max_storage_bytes=DEFAULT_MAX_STORAGE_BYTES,
                 free_space_reserve_bytes=DEFAULT_FREE_SPACE_RESERVE_BYTES):
        self.store=RecordingStore(data_dir,project_root,max_recording_bytes,max_storage_bytes,free_space_reserve_bytes)
        self.supabase=supabase
        self.ffmpeg_path=shutil.which('ffmpeg') if ffmpeg_path is None else ffmpeg_path
        self.ffprobe_path=shutil.which('ffprobe') if ffprobe_path is None else ffprobe_path
        if normalizer is None:
            from .media import normalize_recording
            normalizer=normalize_recording
        self.normalizer=normalizer
        self._jobs=ThreadPoolExecutor(max_workers=1,thread_name_prefix='local-recording-media')
        self._job_lock=threading.Lock()
        self._pending_jobs=set()


    def _owned_patient(self, token, patient_id):
        patient_id=require_uuid(patient_id,'patient_id')
        owner_id=self.supabase.get_user_id(token)
        if not self.supabase.owns_patient(token,patient_id):
            raise APIError(404,'PATIENT_NOT_FOUND','此帳號無法存取該個案。')
        return owner_id,patient_id

    def get_consent(self, token, patient_id):
        owner_id,patient_id=self._owned_patient(token,patient_id)
        return {'patient_id':patient_id,'recording_enabled':self.store.get_consent(owner_id,patient_id)}

    def set_consent(self, token, patient_id, enabled):
        if type(enabled) is not bool:raise APIError(400,'INVALID_CONSENT','錄影同意必須是明確的 true 或 false。')
        owner_id,patient_id=self._owned_patient(token,patient_id)
        self.store.set_consent(owner_id,patient_id,enabled)
        return {'patient_id':patient_id,'recording_enabled':enabled}

    def create_recording(self, token, payload):
        required={'patient_id','started_at','mime_type','width','height'};optional={'session_id'}
        if not isinstance(payload,dict) or not required<=set(payload) or set(payload)-required-optional:
            raise APIError(400,'INVALID_BODY','錄影建立資料不完整。')
        owner_id,patient_id=self._owned_patient(token,payload['patient_id'])
        if not self.store.get_consent(owner_id,patient_id):
            raise APIError(403,'RECORDING_CONSENT_REQUIRED','此個案尚未明確啟用本機錄影。')
        session_id=payload.get('session_id')
        if session_id is not None:
            session_id=require_uuid(session_id,'session_id')
            if not self.supabase.owns_session(token,patient_id,session_id):
                raise APIError(404,'SESSION_NOT_FOUND','找不到此個案的用餐紀錄。')
        started_at=require_iso(payload['started_at'],'started_at')
        mime=payload['mime_type']
        if not isinstance(mime,str) or not mime.startswith('video/webm'):
            raise APIError(415,'UNSUPPORTED_MIME','本機錄影只接受 WebM 影像。')
        width,height=payload['width'],payload['height']
        if type(width) is not int or type(height) is not int or not (2<=width<=640 and 2<=height<=640):
            raise APIError(400,'INVALID_DIMENSIONS','錄影尺寸必須不超過 640×640。')
        row,recording_token=self.store.create_recording(owner_id,{**payload,'patient_id':patient_id,'session_id':session_id,'started_at':started_at})
        public_row={key:value for key,value in row.items() if key!='owner_id'}
        public_row['recording_token']=recording_token
        return public_row

    @staticmethod
    def _public_recording(record):
        if not record:
            return None
        result = {key:value for key,value in record.items() if key != 'owner_id'}
        if result.get('status') == 'ready':
            result['playback_url'] = '/api/local/recordings/' + result['id'] + '/video'
        return result

    def finalize_recording(self, token, recording_id, recording_token, payload):
        owner_id=self.supabase.get_user_id(token)
        record=self.store.get_recording(recording_id)
        if not record or record['owner_id']!=owner_id:
            raise APIError(404,'RECORDING_NOT_FOUND','找不到本機錄影。')
        if not self.supabase.owns_patient(token,record['patient_id']):
            raise APIError(404,'PATIENT_NOT_FOUND','此帳號無法存取該個案。')
        if not self.store.token_matches(recording_id,recording_token):
            raise APIError(403,'RECORDING_TOKEN_INVALID','錄影上傳授權無效。')
        required={'duration_sec','frame_count','effective_fps','width','height','mime_type','ended_at'}
        if not isinstance(payload,dict) or not required<=set(payload) or set(payload)-required-{'session_id'}:
            raise APIError(400,'INVALID_BODY','影片完成資料不完整。')
        duration=require_finite_number(payload['duration_sec'],'duration_sec',minimum=0.001)
        effective_fps=require_finite_number(payload['effective_fps'],'effective_fps')
        frame_count=payload['frame_count']
        if type(frame_count) is not int or frame_count<1:
            raise APIError(400,'INVALID_FRAME_COUNT','影片至少要有一個畫面。')
        width,height=payload['width'],payload['height']
        if type(width) is not int or type(height) is not int or not (2<=width<=640 and 2<=height<=640) or width!=record['width'] or height!=record['height']:
            raise APIError(400,'INVALID_DIMENSIONS','影片尺寸必須與錄影建立資料一致，且不超過 640×640。')
        mime_type=payload['mime_type']
        if not isinstance(mime_type,str) or mime_type.split(';',1)[0]!='video/webm' or mime_type.split(';',1)[0]!=record['mime_type'].split(';',1)[0]:
            raise APIError(415,'UNSUPPORTED_MIME','影片格式與錄影建立資料不一致。')
        ended_at=require_iso(payload['ended_at'],'ended_at')
        start_dt=datetime.fromisoformat(record['started_at'].replace('Z','+00:00'))
        end_dt=datetime.fromisoformat(ended_at.replace('Z','+00:00'))
        if end_dt<start_dt:
            raise APIError(400,'INVALID_TIME','用餐結束時間早於開始時間。')
        session_id=payload.get('session_id') or record.get('session_id')
        if record.get('session_id') and session_id!=record['session_id']:
            raise APIError(409,'SESSION_MISMATCH','不能替換原錄影餐次。')
        if session_id is not None:
            session_id=require_uuid(session_id,'session_id')
            if not self.supabase.owns_session(token,record['patient_id'],session_id):
                raise APIError(404,'SESSION_NOT_FOUND','找不到此個案的用餐紀錄。')
        chunks=self.store.list_chunks(recording_id)
        if not chunks:
            raise APIError(409,'NO_CHUNKS','錄影沒有已儲存的影片分塊。')
        if [row['sequence'] for row in chunks]!=list(range(len(chunks))):
            raise APIError(409,'CHUNK_ORDER','影片分塊序號不連續。')
        finalize_payload={
            'session_id':session_id,'duration_sec':duration,'frame_count':frame_count,
            'effective_fps':effective_fps,'width':width,'height':height,
            'mime_type':mime_type,'ended_at':ended_at
        }
        if record['status']=='processing' or record['status']=='ready':
            return self._public_recording(record)
        if record['status']!='recording':
            raise APIError(409,'INVALID_RECORDING_STATE','錄影不能再完成。')
        self.store.set_processing(recording_id,finalize_payload)
        if not self.ffmpeg_path or not self.ffprobe_path:
            self.store.mark_failed(recording_id,'FFmpeg/ffprobe unavailable; source chunks preserved.')
            return self._public_recording(self.store.get_recording(recording_id))
        future=self._jobs.submit(self._normalize_recording,recording_id,finalize_payload,chunks)
        with self._job_lock:
            self._pending_jobs.add(future)
        future.add_done_callback(lambda done:self._discard_job(done))
        return self._public_recording(self.store.get_recording(recording_id))

    def _discard_job(self, future):
        with self._job_lock:
            self._pending_jobs.discard(future)

    def _normalize_recording(self, recording_id, finalize_payload, chunks):
        output=None
        try:
            ffmpeg_path=self.ffmpeg_path
            ffprobe_path=self.ffprobe_path
            if not ffmpeg_path or not ffprobe_path:
                raise RuntimeError('FFmpeg and ffprobe are unavailable')
            source_bytes=sum(row['size'] for row in chunks)
            total_bytes=self.store.total_storage_bytes()
            available_disk=shutil.disk_usage(self.store.data_dir).free-self.store.free_space_reserve_bytes-source_bytes
            max_output_bytes=min(self.store.max_recording_bytes-source_bytes,
                self.store.max_storage_bytes-total_bytes,available_disk)
            if max_output_bytes<=0:
                self.store.mark_failed(recording_id,'本機錄影容量上限已達；原始分塊保留。')
                return
            normalization_metadata={**finalize_payload,'_max_output_bytes':int(max_output_bytes)}
            result=self.normalizer(self.store.data_dir,recording_id,normalization_metadata,chunks,ffmpeg_path,ffprobe_path)
            if not isinstance(result,dict) or result.get('ready') is not True:
                raise RuntimeError('Normalizer did not confirm ready output')
            output=Path(result.get('path','')).resolve(strict=True)
            expected=(self.store.data_dir/'recordings'/recording_id/'normalized.mp4').resolve()
            if output!=expected or output.is_symlink() or not output.is_file():
                raise RuntimeError('Normalizer output path is invalid')
            normalized_size=output.stat().st_size
            if normalized_size<=0 or normalized_size>max_output_bytes:
                output.unlink(missing_ok=True)
                self.store.mark_failed(recording_id,'本機錄影容量上限已達；原始分塊保留。')
                return
            codec=result.get('codec')
            width,height=result.get('width'),result.get('height')
            duration=require_finite_number(result.get('duration'),'encoded_duration',minimum=0.001)
            frame_count=result.get('frame_count')
            expected_duration=finalize_payload['duration_sec']
            duration_tolerance=min(2.0,max(0.25,expected_duration*0.05))
            if abs(duration-expected_duration)>duration_tolerance:
                raise RuntimeError('Normalized duration differs from captured duration')
            expected_frames=finalize_payload['frame_count']
            if type(frame_count) is not int or frame_count<max(1,(expected_frames+1)//2):
                raise RuntimeError('Normalized frame count is materially below captured frame count')
            if codec!='h264' or type(width) is not int or type(height) is not int or not (1<=width<=640 and 1<=height<=640):
                raise RuntimeError('Normalized output did not pass media validation')
            metadata={
                'codec':'h264','has_audio':False,'encoded_width':width,'encoded_height':height,
                'encoded_duration_sec':duration,'encoded_frame_count':frame_count,'encoded_size_bytes':normalized_size
            }
            if not self.store.mark_ready(recording_id,metadata,normalized_size):
                output.unlink(missing_ok=True)
                self.store.mark_failed(recording_id,'本機錄影資料夾容量上限已達；原始分塊保留。')
        except Exception:
            if output is not None:
                try:
                    expected=(self.store.data_dir/'recordings'/recording_id/'normalized.mp4').resolve()
                    if output==expected and output.exists() and not output.is_symlink():
                        output.unlink(missing_ok=True)
                except OSError:
                    pass
            # Do not expose local paths, FFmpeg logs, or internal details in the caregiver UI.
            self.store.mark_failed(recording_id,'影片轉存失敗；原始分塊保留於本機，請檢查服務記錄。')

    def delete_recording(self, token, recording_id):
        owner_id=self.supabase.get_user_id(token)
        record=self.store.get_recording(recording_id)
        if not record or record['owner_id']!=owner_id:
            raise APIError(404,'RECORDING_NOT_FOUND','找不到本機錄影。')
        if not self.supabase.owns_patient(token,record['patient_id']):
            raise APIError(404,'PATIENT_NOT_FOUND','此帳號無法存取該個案。')
        return self.store.delete_recording(owner_id,recording_id)

    def get_recording(self, token, recording_id):

        owner_id = self.supabase.get_user_id(token)
        record = self.store.get_recording(recording_id)
        if not record or record['owner_id'] != owner_id:
            raise APIError(404, 'RECORDING_NOT_FOUND', '找不到本機錄影。')
        if not self.supabase.owns_patient(token, record['patient_id']):
            raise APIError(404, 'PATIENT_NOT_FOUND', '此帳號無法存取該個案。')
        return self._public_recording(record)

    def list_recordings(self, token, patient_id):
        owner_id, patient_id = self._owned_patient(token, patient_id)
        return [self._public_recording(record) for record in self.store.list_recordings(owner_id, patient_id)]

    def upload_chunk(self, token, recording_id, recording_token, sequence, data):
        owner_id=self.supabase.get_user_id(token)
        record=self.store.get_recording(recording_id)
        if not record or record['owner_id']!=owner_id:
            raise APIError(404,'RECORDING_NOT_FOUND','找不到本機錄影。')
        if not self.supabase.owns_patient(token,record['patient_id']):
            raise APIError(404,'PATIENT_NOT_FOUND','此帳號無法存取該個案。')
        return self.store.upload_chunk(recording_id,recording_token,sequence,data)

    def add_cough_marker(self, token, recording_id, recording_token, marker):
        owner_id=self.supabase.get_user_id(token)
        record=self.store.get_recording(recording_id)
        if not record or record['owner_id']!=owner_id:raise APIError(404,'RECORDING_NOT_FOUND','找不到本機錄影。')
        if not self.supabase.owns_patient(token,record['patient_id']):raise APIError(404,'PATIENT_NOT_FOUND','此帳號無法存取該個案。')
        if record['status']!='recording':raise APIError(409,'RECORDING_NOT_ACTIVE','錄影已結束，不能再新增嗆咳標記。')
        if not self.store.token_matches(recording_id,recording_token):raise APIError(403,'RECORDING_TOKEN_INVALID','錄影上傳授權無效。')
        required={'event_id','session_id','offset_sec','occurred_at','kind'}
        if not isinstance(marker,dict) or set(marker)!=required:raise APIError(400,'INVALID_BODY','嗆咳標記資料不完整。')
        event_id=require_uuid(marker['event_id'],'event_id');session_id=require_uuid(marker['session_id'],'session_id')
        if not self.supabase.owns_session(token,record['patient_id'],session_id):raise APIError(404,'SESSION_NOT_FOUND','找不到此個案的用餐紀錄。')
        if record['session_id'] and record['session_id']!=session_id:raise APIError(403,'SESSION_MISMATCH','事件不屬於此錄影餐次。')
        if not self.supabase.owns_cough_event(token,session_id,event_id):raise APIError(404,'COUGH_EVENT_NOT_FOUND','找不到已儲存的嗆咳事件。')
        offset=require_finite_number(marker['offset_sec'],'offset_sec')
        occurred_at=require_iso(marker['occurred_at'],'occurred_at')
        kind=marker['kind']
        if not isinstance(kind,str) or not kind.strip() or len(kind)>120:raise APIError(400,'INVALID_KIND','嗆咳標記種類錯誤。')
        return self.store.add_cough_marker(recording_id,event_id,session_id,offset,occurred_at,kind)

    def close(self):
        self._jobs.shutdown(wait=True, cancel_futures=False)
        self.store.close()


def create_local_server(project_root, data_dir, port=0, supabase=None, supabase_url=None, publishable_key=None, **options):
    from .http_server import create_local_server as factory
    return factory(project_root, data_dir, port, supabase, supabase_url, publishable_key, **options)

