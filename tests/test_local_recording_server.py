import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_recording.server import APIError, LocalRecordingService, SupabaseREST, create_local_server

OWNER_A = '11111111-1111-4111-8111-111111111111'
OWNER_B = '22222222-2222-4222-8222-222222222222'
PATIENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
PATIENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
SESSION_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
SESSION_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
EVENT_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

if os.environ.get('TMPDIR'):
    TEST_SCRATCH = Path(os.environ['TMPDIR'])
elif os.name == 'nt':
    TEST_SCRATCH = Path.home() / 'AppData' / 'Local' / 'hermes' / 'cache' / 'scratch'
else:
    TEST_SCRATCH = Path(tempfile.gettempdir())
TEST_SCRATCH.mkdir(parents=True, exist_ok=True)


class FakeSupabase:
    def __init__(self):
        self.users = {'jwt-a': OWNER_A, 'jwt-b': OWNER_B}
        self.patients = {OWNER_A: {PATIENT_A}, OWNER_B: {PATIENT_B}}
        self.sessions = {OWNER_A: {SESSION_A: PATIENT_A}, OWNER_B: {SESSION_B: PATIENT_B}}
        self.events = {OWNER_A: {EVENT_A: SESSION_A}}

    def get_user_id(self, token):
        if token not in self.users:
            raise APIError(401, 'UNAUTHORIZED', '登入狀態無效，請重新登入。')
        return self.users[token]

    def owns_patient(self, token, patient_id):
        owner = self.get_user_id(token)
        return patient_id in self.patients.get(owner, set())

    def owns_session(self, token, patient_id, session_id):
        owner = self.get_user_id(token)
        return self.sessions.get(owner, {}).get(session_id) == patient_id

    def owns_cough_event(self, token, session_id, event_id):
        owner = self.get_user_id(token)
        return self.events.get(owner, {}).get(event_id) == session_id


def create_service(tmp_path, supabase=None, **options):
    return LocalRecordingService(data_dir=tmp_path, supabase=supabase or FakeSupabase(), project_root=Path(__file__).resolve().parents[1], **options)


class LocalRecordingConsentTests(unittest.TestCase):
    def test_consent_defaults_off_and_is_scoped_to_owner_and_patient(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            service = create_service(Path(folder))
            self.addCleanup(service.close)
            self.assertFalse(service.get_consent('jwt-a', PATIENT_A)['recording_enabled'])
            enabled = service.set_consent('jwt-a', PATIENT_A, True)
            self.assertTrue(enabled['recording_enabled'])
            self.assertFalse(service.get_consent('jwt-b', PATIENT_B)['recording_enabled'])
            with self.assertRaises(APIError) as error:
                service.get_consent('jwt-b', PATIENT_A)
            self.assertEqual(error.exception.status, 404)

    def test_consent_requires_an_explicit_boolean(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            service = create_service(Path(folder))
            self.addCleanup(service.close)
            for value in (1, 'true', None):
                with self.subTest(value=value), self.assertRaises(APIError) as error:
                    service.set_consent('jwt-a', PATIENT_A, value)
                self.assertEqual(error.exception.status, 400)
            self.assertFalse(service.get_consent('jwt-a', PATIENT_A)['recording_enabled'])


class LocalRecordingAuthorizationTests(unittest.TestCase):
    def test_recording_creation_requires_owner_opt_in_and_verified_session_link(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            service = create_service(Path(folder))
            self.addCleanup(service.close)
            payload = {
                'patient_id': PATIENT_A,
                'session_id': SESSION_A,
                'started_at': '2026-11-13T09:00:00Z',
                'mime_type': 'video/webm;codecs=vp8',
                'width': 640,
                'height': 360
            }
            with self.assertRaises(APIError) as error:
                service.create_recording('jwt-a', payload)
            self.assertEqual(error.exception.code, 'RECORDING_CONSENT_REQUIRED')
            service.set_consent('jwt-a', PATIENT_A, True)
            record = service.create_recording('jwt-a', payload)
            self.assertEqual(record['status'], 'recording')
            self.assertEqual(record['patient_id'], PATIENT_A)
            self.assertTrue(record['recording_token'])
            self.assertNotIn('owner_id', record)
            with self.assertRaises(APIError) as error:
                service.create_recording('jwt-b', payload)
            self.assertIn(error.exception.status, (403, 404))
            wrong_session = {**payload, 'session_id': SESSION_B}
            with self.assertRaises(APIError):
                service.create_recording('jwt-a', wrong_session)

    def test_local_recording_token_is_stored_only_as_a_hash(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            data_dir = Path(folder)
            service = create_service(data_dir)
            self.addCleanup(service.close)
            service.set_consent('jwt-a', PATIENT_A, True)
            record = service.create_recording('jwt-a', {
                'patient_id': PATIENT_A,
                'session_id': SESSION_A,
                'started_at': '2026-11-13T09:00:00Z',
                'mime_type': 'video/webm;codecs=vp8',
                'width': 640,
                'height': 360
            })
            stored = (data_dir / 'local.sqlite3').read_bytes()
            self.assertNotIn(record['recording_token'].encode('utf-8'), stored)

    def test_chunk_upload_requires_the_scoped_recording_token_and_is_idempotent(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            data_dir = Path(folder)
            service = create_service(data_dir)
            self.addCleanup(service.close)
            service.set_consent('jwt-a', PATIENT_A, True)
            record = service.create_recording('jwt-a', {
                'patient_id': PATIENT_A, 'session_id': SESSION_A,
                'started_at': '2026-11-13T09:00:00Z', 'mime_type': 'video/webm;codecs=vp8',
                'width': 640, 'height': 360
            })
            with self.assertRaises(APIError) as error:
                service.upload_chunk('jwt-a', record['id'], 'wrong-token', 0, b'chunk-one')
            self.assertEqual(error.exception.status, 403)
            first = service.upload_chunk('jwt-a', record['id'], record['recording_token'], 0, b'chunk-one')
            duplicate = service.upload_chunk('jwt-a', record['id'], record['recording_token'], 0, b'chunk-one')
            self.assertFalse(first['duplicate'])
            self.assertTrue(duplicate['duplicate'])
            with self.assertRaises(APIError) as error:
                service.upload_chunk('jwt-a', record['id'], record['recording_token'], 0, b'different')
            self.assertEqual(error.exception.code, 'CHUNK_CONFLICT')
            chunk_path = data_dir / 'recordings' / record['id'] / 'chunks' / 'chunk-00000000.webm'
            self.assertTrue(chunk_path.is_file())
            self.assertEqual(chunk_path.read_bytes(), b'chunk-one')
            self.assertTrue(chunk_path.resolve().is_relative_to(data_dir.resolve()))

    def test_recording_data_directory_must_not_be_inside_the_web_project(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            project_root = Path(folder) / 'project'
            project_root.mkdir()
            with self.assertRaises(ValueError):
                LocalRecordingService(data_dir=project_root / 'mobile' / 'recordings', supabase=FakeSupabase(), project_root=project_root)

    def test_recording_details_and_lists_are_owner_scoped_and_hide_owner_id(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            service = create_service(Path(folder))
            self.addCleanup(service.close)
            service.set_consent('jwt-a', PATIENT_A, True)
            record = service.create_recording('jwt-a', {
                'patient_id': PATIENT_A, 'session_id': SESSION_A,
                'started_at': '2026-11-13T09:00:00Z', 'mime_type': 'video/webm;codecs=vp8',
                'width': 640, 'height': 360
            })
            detail = service.get_recording('jwt-a', record['id'])
            self.assertEqual(detail['id'], record['id'])
            self.assertNotIn('owner_id', detail)
            rows = service.list_recordings('jwt-a', PATIENT_A)
            self.assertEqual([row['id'] for row in rows], [record['id']])
            self.assertNotIn('owner_id', rows[0])
            self.assertEqual(service.list_recordings('jwt-b', PATIENT_B), [])
            with self.assertRaises(APIError) as error:
                service.get_recording('jwt-b', record['id'])
            self.assertEqual(error.exception.status, 404)

    def test_finalize_runs_normalizer_in_background_and_publishes_only_verified_output(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            entered = threading.Event()
            def normalizer(data_dir, recording_id, metadata, chunks, ffmpeg_path, ffprobe_path):
                entered.set()
                self.assertEqual([row['sequence'] for row in chunks], [0])
                target = Path(data_dir)/'recordings'/recording_id/'normalized.mp4'
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b'synthetic-verified-mp4')
                return {'ready':True,'path':str(target),
                    'codec':'h264','width':640,'height':360,'duration':1.0,'frame_count':10}
            service = create_service(Path(folder), normalizer=normalizer, ffmpeg_path='fake-ffmpeg', ffprobe_path='fake-ffprobe')
            self.addCleanup(service.close)
            service.set_consent('jwt-a', PATIENT_A, True)
            record = service.create_recording('jwt-a', {
                'patient_id': PATIENT_A, 'session_id': SESSION_A,
                'started_at': '2026-11-13T09:00:00Z', 'mime_type': 'video/webm;codecs=vp8',
                'width': 640, 'height': 360
            })
            service.upload_chunk('jwt-a', record['id'], record['recording_token'], 0, b'synthetic-webm')
            final = service.finalize_recording('jwt-a', record['id'], record['recording_token'], {
                'session_id':SESSION_A,'duration_sec':1.0,'frame_count':10,'effective_fps':10.0,
                'width':640,'height':360,'mime_type':'video/webm;codecs=vp8','ended_at':'2026-11-13T09:00:01Z'
            })
            self.assertEqual(final['status'], 'processing')
            self.assertTrue(entered.wait(2))
            service.close()
            ready = service.get_recording('jwt-a', record['id'])
            if ready is None:
                self.fail('recording row disappeared after normalization')
            self.assertEqual(ready['status'], 'ready')
            self.assertEqual(ready['metadata']['codec'], 'h264')
            self.assertTrue((Path(folder)/'recordings'/record['id']/'chunks'/'chunk-00000000.webm').is_file())

    def test_finalize_failure_marks_failed_and_preserves_uploaded_chunks(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            def normalizer(*_args):
                raise RuntimeError('synthetic ffmpeg failure')
            service = create_service(Path(folder), normalizer=normalizer, ffmpeg_path='fake-ffmpeg', ffprobe_path='fake-ffprobe')
            self.addCleanup(service.close)
            service.set_consent('jwt-a', PATIENT_A, True)
            record = service.create_recording('jwt-a', {
                'patient_id': PATIENT_A, 'session_id': SESSION_A,
                'started_at': '2026-11-13T09:00:00Z', 'mime_type': 'video/webm;codecs=vp8',
                'width': 640, 'height': 360
            })
            service.upload_chunk('jwt-a', record['id'], record['recording_token'], 0, b'synthetic-webm')
            service.finalize_recording('jwt-a', record['id'], record['recording_token'], {
                'session_id':SESSION_A,'duration_sec':1.0,'frame_count':10,'effective_fps':10.0,
                'width':640,'height':360,'mime_type':'video/webm;codecs=vp8','ended_at':'2026-11-13T09:00:01Z'
            })
            service.close()
            failed = service.get_recording('jwt-a', record['id'])
            self.assertEqual(failed['status'], 'failed')
            self.assertNotIn('synthetic ffmpeg failure', failed.get('error_message',''))
            self.assertTrue((Path(folder)/'recordings'/record['id']/'chunks'/'chunk-00000000.webm').is_file())

    def test_delete_is_owner_scoped_and_never_removes_active_recording(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            data_dir = Path(folder)
            service = create_service(data_dir)
            self.addCleanup(service.close)
            service.set_consent('jwt-a', PATIENT_A, True)
            def create_one():
                return service.create_recording('jwt-a', {
                    'patient_id': PATIENT_A, 'session_id': SESSION_A,
                    'started_at': '2026-11-13T09:00:00Z', 'mime_type': 'video/webm;codecs=vp8',
                    'width': 640, 'height': 360
                })
            active = create_one()
            ready = create_one()
            with self.assertRaises(APIError) as error:
                service.delete_recording('jwt-a', active['id'])
            self.assertEqual(error.exception.status, 409)
            service.store.set_processing(ready['id'], {
                'session_id': SESSION_A, 'duration_sec': 1.0, 'frame_count': 10, 'effective_fps': 10.0,
                'width': 640, 'height': 360, 'mime_type': 'video/webm;codecs=vp8',
                'ended_at': '2026-11-13T09:00:01Z'
            })
            service.store.mark_ready(ready['id'], {'codec': 'h264', 'has_audio': False})
            with self.assertRaises(APIError) as error:
                service.delete_recording('jwt-b', ready['id'])
            self.assertEqual(error.exception.status, 404)
            result = service.delete_recording('jwt-a', ready['id'])
            self.assertTrue(result['deleted'])
            self.assertFalse((data_dir / 'recordings' / ready['id']).exists())
            self.assertIsNotNone(service.store.get_recording(active['id']))

    def test_existing_recording_rechecks_supabase_patient_ownership_before_upload_and_finalize(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            fake=FakeSupabase()
            service=create_service(Path(folder),supabase=fake)
            self.addCleanup(service.close)
            service.set_consent('jwt-a',PATIENT_A,True)
            record=service.create_recording('jwt-a',{
                'patient_id':PATIENT_A,'started_at':'2026-11-13T09:00:00Z',
                'mime_type':'video/webm;codecs=vp8','width':320,'height':240
            })
            service.upload_chunk('jwt-a',record['id'],record['recording_token'],0,b'synthetic-webm')
            fake.patients[OWNER_A].remove(PATIENT_A)
            with self.assertRaises(APIError) as upload_error:
                service.upload_chunk('jwt-a',record['id'],record['recording_token'],1,b'more-webm')
            self.assertEqual(upload_error.exception.status,404)
            with self.assertRaises(APIError) as finalize_error:
                service.finalize_recording('jwt-a',record['id'],record['recording_token'],{
                    'duration_sec':1.0,'frame_count':10,'effective_fps':10.0,'width':320,'height':240,
                    'mime_type':'video/webm;codecs=vp8','ended_at':'2026-11-13T09:00:01Z'
                })
            self.assertEqual(finalize_error.exception.status,404)

    def test_configured_per_recording_and_total_storage_limits_reject_before_writing(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            data_dir=Path(folder)
            service=create_service(data_dir,max_recording_bytes=8,max_storage_bytes=10,free_space_reserve_bytes=0)
            self.addCleanup(service.close)
            service.set_consent('jwt-a',PATIENT_A,True)
            def create_one():
                return service.create_recording('jwt-a',{
                    'patient_id':PATIENT_A,'session_id':SESSION_A,'started_at':'2026-11-13T09:00:00Z',
                    'mime_type':'video/webm;codecs=vp8','width':320,'height':240
                })
            first=create_one()
            service.upload_chunk('jwt-a',first['id'],first['recording_token'],0,b'12345678')
            with self.assertRaises(APIError) as recording_limit:
                service.upload_chunk('jwt-a',first['id'],first['recording_token'],1,b'x')
            self.assertEqual(recording_limit.exception.code,'RECORDING_SIZE_LIMIT')
            second=create_one()
            with self.assertRaises(APIError) as total_limit:
                service.upload_chunk('jwt-a',second['id'],second['recording_token'],0,b'abc')
            self.assertEqual(total_limit.exception.code,'STORAGE_QUOTA_EXCEEDED')
            self.assertFalse((data_dir/'recordings'/second['id']/'chunks'/'chunk-00000000.webm').exists())

    def test_global_storage_quota_counts_normalized_mp4_as_well_as_source_chunks(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            service=create_service(Path(folder),max_recording_bytes=10,max_storage_bytes=10,free_space_reserve_bytes=0)
            self.addCleanup(service.close)
            service.set_consent('jwt-a',PATIENT_A,True)
            def create_one():
                return service.create_recording('jwt-a',{
                    'patient_id':PATIENT_A,'session_id':SESSION_A,'started_at':'2026-11-13T09:00:00Z',
                    'mime_type':'video/webm;codecs=vp8','width':320,'height':240
                })
            first=create_one()
            service.upload_chunk('jwt-a',first['id'],first['recording_token'],0,b'123')
            service.store.set_processing(first['id'],{
                'session_id':SESSION_A,'duration_sec':1.0,'frame_count':10,'effective_fps':10.0,
                'width':320,'height':240,'mime_type':'video/webm;codecs=vp8','ended_at':'2026-11-13T09:00:01Z'
            })
            self.assertTrue(service.store.mark_ready(first['id'],{'codec':'h264'},5))
            second=create_one()
            with self.assertRaises(APIError) as error:
                service.upload_chunk('jwt-a',second['id'],second['recording_token'],0,b'abc')
            self.assertEqual(error.exception.code,'STORAGE_QUOTA_EXCEEDED')

    def test_normalizer_output_cannot_exceed_the_recording_quota_or_be_published(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            data_dir=Path(folder)
            def too_large_normalizer(data_dir,recording_id,metadata,chunks,ffmpeg_path,ffprobe_path):
                target=Path(data_dir)/'recordings'/recording_id/'normalized.mp4'
                target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(b'oversized-normalized-output')
                return {'ready':True,'path':str(target),'codec':'h264','width':320,'height':240,'duration':1.0,'frame_count':10}
            service=create_service(data_dir,normalizer=too_large_normalizer,ffmpeg_path='fake',ffprobe_path='fake',
                max_recording_bytes=8,max_storage_bytes=20,free_space_reserve_bytes=0)
            self.addCleanup(service.close)
            service.set_consent('jwt-a',PATIENT_A,True)
            record=service.create_recording('jwt-a',{
                'patient_id':PATIENT_A,'session_id':SESSION_A,'started_at':'2026-11-13T09:00:00Z',
                'mime_type':'video/webm;codecs=vp8','width':320,'height':240
            })
            service.upload_chunk('jwt-a',record['id'],record['recording_token'],0,b'1234')
            service.finalize_recording('jwt-a',record['id'],record['recording_token'],{
                'session_id':SESSION_A,'duration_sec':1.0,'frame_count':10,'effective_fps':10.0,
                'width':320,'height':240,'mime_type':'video/webm;codecs=vp8','ended_at':'2026-11-13T09:00:01Z'
            })
            service.close()
            failed=service.get_recording('jwt-a',record['id'])
            if failed is None:
                self.fail('recording row disappeared after quota failure')
            self.assertEqual(failed['status'],'failed')
            self.assertIn('容量上限',failed['error_message'])
            self.assertTrue((data_dir/'recordings'/record['id']/'chunks'/'chunk-00000000.webm').is_file())
            self.assertFalse((data_dir/'recordings'/record['id']/'normalized.mp4').exists())

    def test_service_does_not_publish_normalizer_output_that_is_shorter_than_capture_metadata(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            data_dir=Path(folder)
            def truncated_normalizer(data_dir,recording_id,metadata,chunks,ffmpeg_path,ffprobe_path):
                target=Path(data_dir)/'recordings'/recording_id/'normalized.mp4'
                target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b'valid-looking-mp4')
                return {'ready':True,'path':str(target),'codec':'h264','width':320,'height':240,'duration':2.2,'frame_count':27}
            service=create_service(data_dir,normalizer=truncated_normalizer,ffmpeg_path='fake',ffprobe_path='fake')
            self.addCleanup(service.close)
            service.set_consent('jwt-a',PATIENT_A,True)
            record=service.create_recording('jwt-a',{
                'patient_id':PATIENT_A,'session_id':SESSION_A,'started_at':'2026-11-13T09:00:00Z',
                'mime_type':'video/webm;codecs=vp8','width':320,'height':240
            })
            service.upload_chunk('jwt-a',record['id'],record['recording_token'],0,b'synthetic-webm')
            service.finalize_recording('jwt-a',record['id'],record['recording_token'],{
                'session_id':SESSION_A,'duration_sec':20.0,'frame_count':240,'effective_fps':12.0,
                'width':320,'height':240,'mime_type':'video/webm;codecs=vp8','ended_at':'2026-11-13T09:00:20Z'
            })
            service.close()
            result=service.get_recording('jwt-a',record['id'])
            if result is None:
                self.fail('recording row disappeared after failed normalization')
            self.assertEqual(result['status'],'failed')
            self.assertTrue((data_dir/'recordings'/record['id']/'chunks'/'chunk-00000000.webm').is_file())
            self.assertFalse((data_dir/'recordings'/record['id']/'normalized.mp4').exists())

    def test_cough_marker_must_reference_a_persisted_owner_scoped_event(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            service = create_service(Path(folder))
            self.addCleanup(service.close)
            service.set_consent('jwt-a', PATIENT_A, True)
            record = service.create_recording('jwt-a', {
                'patient_id': PATIENT_A,
                'session_id': SESSION_A,
                'started_at': '2026-11-13T09:00:00Z',
                'mime_type': 'video/webm;codecs=vp8',
                'width': 640,
                'height': 360
            })
            with self.assertRaises(APIError):
                service.add_cough_marker('jwt-a', record['id'], record['recording_token'], {
                    'event_id': EVENT_A, 'offset_sec': 0.5, 'occurred_at': '2026-11-13T09:00:01Z', 'kind': '疑似嗆咳'
                })
            marker = service.add_cough_marker('jwt-a', record['id'], record['recording_token'], {
                'event_id': EVENT_A, 'session_id': SESSION_A, 'offset_sec': 0.5,
                'occurred_at': '2026-11-13T09:00:01Z', 'kind': '疑似嗆咳'
            })
            self.assertEqual(marker['event_id'], EVENT_A)
            with self.assertRaises(APIError):
                service.add_cough_marker('jwt-b', record['id'], record['recording_token'], {
                    'event_id': EVENT_A, 'session_id': SESSION_A, 'offset_sec': 0.5,
                    'occurred_at': '2026-11-13T09:00:01Z', 'kind': '疑似嗆咳'
                })


class FakeRESTResponse:
    def __init__(self, value, status=200):
        self.status = status
        self._body = json.dumps(value).encode('utf-8')

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self._body


class FakeSupabaseTransport:
    def __init__(self, fail_auth=False):
        self.calls = []
        self.fail_auth = fail_auth

    def __call__(self, request, timeout):
        from email.message import Message
        from io import BytesIO
        from urllib.parse import parse_qs, urlsplit
        from urllib.error import HTTPError
        self.calls.append(request)
        parsed = urlsplit(request.full_url)
        query = parse_qs(parsed.query)
        if parsed.path == '/auth/v1/user':
            if self.fail_auth:
                raise HTTPError(request.full_url, 401, 'unauthorized', Message(), BytesIO(b'dummy upstream body'))
            return FakeRESTResponse({'id': OWNER_A})
        if parsed.path == '/rest/v1/patient_profiles':
            return FakeRESTResponse([{'id': PATIENT_A}] if query.get('id') == ['eq.' + PATIENT_A] else [])
        if parsed.path == '/rest/v1/meal_sessions':
            ok = query.get('id') == ['eq.' + SESSION_A] and query.get('patient_id') == ['eq.' + PATIENT_A]
            return FakeRESTResponse([{'id': SESSION_A}] if ok else [])
        if parsed.path == '/rest/v1/anomaly_logs':
            ok = query.get('id') == ['eq.' + EVENT_A] and query.get('session_id') == ['eq.' + SESSION_A] and query.get('event_type') == ['eq.COUGH']
            return FakeRESTResponse([{'id': EVENT_A}] if ok else [])
        raise AssertionError('Unexpected Supabase route: ' + parsed.path)


class SupabaseRESTTests(unittest.TestCase):
    def test_auth_and_rls_checks_use_only_the_user_jwt_and_publishable_key(self):
        transport = FakeSupabaseTransport()
        client = SupabaseREST('https://project.example.supabase.co', 'sb_publishable_test', transport=transport)
        token = 'unit-user-token'
        self.assertEqual(client.get_user_id(token), OWNER_A)
        self.assertTrue(client.owns_patient(token, PATIENT_A))
        self.assertFalse(client.owns_patient(token, PATIENT_B))
        self.assertTrue(client.owns_session(token, PATIENT_A, SESSION_A))
        self.assertFalse(client.owns_session(token, PATIENT_A, SESSION_B))
        self.assertTrue(client.owns_cough_event(token, SESSION_A, EVENT_A))
        for request in transport.calls:
            headers = dict(request.header_items())
            self.assertEqual(headers.get('Authorization'), 'Bearer ' + token)
            self.assertEqual(headers.get('Apikey'), 'sb_publishable_test')
            self.assertNotIn('service_role', str(headers).lower())

    def test_privileged_keys_are_rejected_and_auth_errors_do_not_echo_tokens(self):
        with self.assertRaises(ValueError):
            SupabaseREST('https://project.example.supabase.co', 'sb_secret_dummy')
        token = 'do-not-echo-this-unit-token'
        client = SupabaseREST('https://project.example.supabase.co', 'sb_publishable_test', transport=FakeSupabaseTransport(fail_auth=True))
        with self.assertRaises(APIError) as error:
            client.get_user_id(token)
        self.assertEqual(error.exception.status, 401)
        self.assertNotIn(token, error.exception.message)


class LocalHTTPTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir=TEST_SCRATCH)
        self.data_dir = Path(self.folder.name) / 'private-recordings'
        self.project_root = Path(__file__).resolve().parents[1]
        self.index_path = self.project_root / 'mobile' / 'index.html'
        self.caregiver_path = self.project_root / 'mobile' / 'caregiver.html'
        self.index_before = self.index_path.read_bytes()
        self.caregiver_before = self.caregiver_path.read_bytes()
        def fake_normalizer(data_dir, recording_id, metadata, chunks, ffmpeg_path, ffprobe_path):
            output = Path(data_dir) / 'recordings' / recording_id / 'normalized.mp4'
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b'synthetic-mp4')
            return {'ready':True,'path':str(output),'codec':'h264','width':640,'height':360,'duration':1.0,'frame_count':10}
        self.server = create_local_server(self.project_root, self.data_dir, port=0, supabase=FakeSupabase(), normalizer=fake_normalizer, ffmpeg_path='fake-ffmpeg', ffprobe_path='fake-ffprobe')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        with urlopen(self.base + '/api/local/config', timeout=5) as response:
            envelope = json.loads(response.read().decode('utf-8'))
        self.csrf = envelope['data']['csrf_token']

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()
        self.folder.cleanup()

    def test_pages_logout_revocation_expires_partitioned_playback_cookie(self):
        response=urlopen(Request(self.base + '/api/local/playback-session/revoke', data=b'{}', headers={
            'Origin':'https://951222-1.github.io','X-Local-Token':self.csrf,
            'Authorization':'Bearer jwt-a','Content-Type':'application/json'
        }, method='POST'), timeout=5)
        with response:
            cookie=response.headers.get('Set-Cookie','')
            self.assertEqual(response.status,200)
        self.assertIn('SameSite=None',cookie)
        self.assertIn('Secure',cookie)
        self.assertIn('Partitioned',cookie)
        self.assertIn('Max-Age=0',cookie)

    def test_pages_preflight_allows_exact_origin_credentials_and_required_headers(self):
        origin='https://951222-1.github.io'
        request=Request(self.base+'/api/local/recordings',headers={
            'Origin':origin,
            'Access-Control-Request-Method':'POST',
            'Access-Control-Request-Headers':'authorization,content-type,x-local-token,x-recording-token'
        },method='OPTIONS')
        with urlopen(request,timeout=5) as response:
            self.assertEqual(response.status,204)
            self.assertEqual(response.headers.get('Access-Control-Allow-Origin'),origin)
            self.assertEqual(response.headers.get('Access-Control-Allow-Credentials'),'true')
            allowed=response.headers.get('Access-Control-Allow-Headers','').lower()
            for name in ('authorization','content-type','x-local-token','x-recording-token'):
                self.assertIn(name,allowed)
            self.assertNotEqual(response.headers.get('Access-Control-Allow-Origin'),'*')
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.base+'/api/local/config',headers={'Origin':'https://evil.invalid'},method='OPTIONS'),timeout=5)
        self.assertEqual(error.exception.code,403)
        error.exception.close()

    def test_pages_cors_config_and_credentials_cookie_support_cross_origin_range_playback(self):
        origin='https://951222-1.github.io'
        read_headers={'Origin':origin,'Authorization':'Bearer jwt-a'}
        with urlopen(Request(self.base+'/api/local/config',headers={'Origin':origin}),timeout=5) as response:
            self.assertEqual(response.headers.get('Access-Control-Allow-Origin'),origin)
            self.assertEqual(response.headers.get('Access-Control-Allow-Credentials'),'true')
            self.assertEqual(response.headers.get('Cross-Origin-Resource-Policy'),'cross-origin')
        write_headers={'Origin':origin,'Authorization':'Bearer jwt-a','X-Local-Token':self.csrf,'Content-Type':'application/json'}
        consent=json.dumps({'patient_id':PATIENT_A,'enabled':True}).encode('utf-8')
        with urlopen(Request(self.base+'/api/local/consent',data=consent,headers=write_headers,method='PUT'),timeout=5): pass
        create=json.dumps({'patient_id':PATIENT_A,'session_id':SESSION_A,'started_at':'2026-11-14T09:00:00Z',
            'mime_type':'video/webm;codecs=vp8','width':320,'height':240}).encode('utf-8')
        with urlopen(Request(self.base+'/api/local/recordings',data=create,headers=write_headers,method='POST'),timeout=5) as response:
            created=json.loads(response.read().decode('utf-8'))['data']
        chunk_headers={**write_headers,'Content-Type':'application/octet-stream','X-Recording-Token':created['recording_token']}
        with urlopen(Request(self.base+f"/api/local/recordings/{created['id']}/chunks/0",data=b'synthetic-chunk',headers=chunk_headers,method='POST'),timeout=5): pass
        finalize=json.dumps({'session_id':SESSION_A,'duration_sec':1.0,'frame_count':10,'effective_fps':10.0,
            'width':320,'height':240,'mime_type':'video/webm;codecs=vp8','ended_at':'2026-11-14T09:00:01Z'}).encode('utf-8')
        with urlopen(Request(self.base+f"/api/local/recordings/{created['id']}/finalize",data=finalize,headers=chunk_headers,method='POST'),timeout=5): pass
        self.server.service.close()
        with urlopen(Request(self.base+f"/api/local/recordings?patient_id={PATIENT_A}",headers=read_headers),timeout=5) as response:
            rows=json.loads(response.read().decode('utf-8'))['data']
            cookie=response.headers.get('Set-Cookie','')
            self.assertEqual(response.headers.get('Access-Control-Allow-Origin'),origin)
            self.assertEqual(response.headers.get('Access-Control-Allow-Credentials'),'true')
        self.assertIn('SameSite=None',cookie)
        self.assertIn('Secure',cookie)
        self.assertIn('Partitioned',cookie)
        row=rows[0]
        self.assertEqual(row['status'],'ready')
        cookie_pair=cookie.split(';',1)[0]
        with urlopen(Request(self.base+row['playback_url'],headers={'Origin':origin,'Cookie':cookie_pair,'Range':'bytes=0-4'}),timeout=5) as response:
            self.assertEqual(response.status,206)
            self.assertEqual(response.read(),b'synth')
            self.assertEqual(response.headers.get('Access-Control-Allow-Origin'),origin)
            self.assertEqual(response.headers.get('Access-Control-Allow-Credentials'),'true')
            self.assertEqual(response.headers.get('Cross-Origin-Resource-Policy'),'cross-origin')
    def test_config_is_local_only_and_does_not_disclose_data_directory_or_owner(self):
        with urlopen(self.base + '/api/local/config', timeout=5) as response:
            body = json.loads(response.read().decode('utf-8'))
        self.assertEqual(body['data']['mode'], 'local-recording')
        self.assertTrue(body['data']['csrf_token'])
        self.assertNotIn('owner_id', body['data'])
        self.assertNotIn('storage_dir', body['data'])
        self.assertGreater(body['data']['max_recording_bytes'],0)
        self.assertGreaterEqual(body['data']['max_storage_bytes'],body['data']['max_recording_bytes'])
        self.assertNotIn(str(self.data_dir), json.dumps(body))

    def test_static_recording_ui_is_served_without_duplicate_injection(self):
        with urlopen(self.base + '/mobile/index.html', timeout=5) as response:
            html = response.read().decode('utf-8')
        self.assertEqual(response.status, 200)
        self.assertIn('../local_recording/meal-recording.js?v=localrec-1', html)
        self.assertIn('../local_recording/bridge.js?v=localrec-1', html)
        self.assertIn('id="local-recording-connect"', html)
        self.assertEqual(html.count('id="local-recording-status"'), 1)
        self.assertEqual(self.index_path.read_bytes(), self.index_before)
        self.assertEqual(html.encode('utf-8'), self.index_before)
        with urlopen(self.base + '/mobile/caregiver.html', timeout=5) as response:
            caregiver_html = response.read().decode('utf-8')
        self.assertIn('本機整餐影片', caregiver_html)
        self.assertIn('id="local-recording-connect"', caregiver_html)
        self.assertIn('id="local-recording-consent-toggle"', caregiver_html)
        self.assertIn('id="local-recording-player"', caregiver_html)
        self.assertEqual(caregiver_html.count('id="local-recording-connect"'), 1)
        self.assertEqual(self.caregiver_path.read_bytes(), self.caregiver_before)
        self.assertEqual(caregiver_html.encode('utf-8'), self.caregiver_before)

    def test_local_recording_modules_are_served_only_from_the_allowlisted_local_route(self):
        for name in ('meal-recording.js','local-recording-ui.js','local-recording-panel.js','bridge.js'):
            with urlopen(self.base + '/local-recording/' + name, timeout=5) as response:
                body = response.read().decode('utf-8')
            self.assertEqual(response.status,200)
            self.assertTrue(body)
        with self.assertRaises(HTTPError) as error:
            urlopen(self.base + '/local-recording/server.py', timeout=5)
        self.assertEqual(error.exception.code,404)
        error.exception.close()

    def test_local_consent_api_requires_same_origin_csrf_and_existing_supabase_owner(self):
        query = f'/api/local/consent?patient_id={PATIENT_A}'
        with urlopen(Request(self.base + query, headers={'Authorization': 'Bearer jwt-a'}), timeout=5) as response:
            body = json.loads(response.read().decode('utf-8'))
        self.assertFalse(body['data']['recording_enabled'])
        payload = json.dumps({'patient_id': PATIENT_A, 'enabled': True}).encode('utf-8')
        headers = {'Origin': self.base, 'X-Local-Token': self.csrf, 'Authorization': 'Bearer jwt-a', 'Content-Type': 'application/json'}
        with urlopen(Request(self.base + '/api/local/consent', data=payload, headers=headers, method='PUT'), timeout=5) as response:
            saved = json.loads(response.read().decode('utf-8'))
        self.assertTrue(saved['data']['recording_enabled'])
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.base + '/api/local/consent', data=payload, headers={**headers, 'Origin':'https://evil.invalid'}, method='PUT'), timeout=5)
        self.assertEqual(error.exception.code, 403)
        error.exception.close()
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.base + '/api/local/consent', data=payload, headers={k:v for k,v in headers.items() if k!='X-Local-Token'}, method='PUT'), timeout=5)
        self.assertEqual(error.exception.code, 403)
        error.exception.close()

    def test_http_create_list_and_chunk_upload_stay_owner_scoped(self):
        common = {'Origin': self.base, 'X-Local-Token': self.csrf, 'Authorization': 'Bearer jwt-a'}
        consent = json.dumps({'patient_id': PATIENT_A, 'enabled': True}).encode('utf-8')
        with urlopen(Request(self.base + '/api/local/consent', data=consent, headers={**common, 'Content-Type':'application/json'}, method='PUT'), timeout=5):
            pass
        create_body = json.dumps({
            'patient_id': PATIENT_A, 'session_id': SESSION_A, 'started_at': '2026-11-13T09:00:00Z',
            'mime_type': 'video/webm;codecs=vp8', 'width': 640, 'height': 360
        }).encode('utf-8')
        with urlopen(Request(self.base + '/api/local/recordings', data=create_body, headers={**common, 'Content-Type':'application/json'}, method='POST'), timeout=5) as response:
            created = json.loads(response.read().decode('utf-8'))['data']
        self.assertEqual(created['status'], 'recording')
        self.assertNotIn('owner_id', created)
        self.assertTrue(created['recording_token'])
        with urlopen(Request(self.base + f'/api/local/recordings?patient_id={PATIENT_A}', headers={'Authorization':'Bearer jwt-a'}), timeout=5) as response:
            listed = json.loads(response.read().decode('utf-8'))['data']
        self.assertEqual([row['id'] for row in listed], [created['id']])
        chunk_headers = {**common, 'X-Recording-Token':created['recording_token'], 'Content-Type':'application/octet-stream'}
        with urlopen(Request(self.base + f"/api/local/recordings/{created['id']}/chunks/0", data=b'synthetic-webm-chunk', headers=chunk_headers, method='POST'), timeout=5) as response:
            chunk = json.loads(response.read().decode('utf-8'))['data']
        self.assertEqual(chunk['sequence'], 0)
        self.assertFalse(chunk['duplicate'])
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.base + f"/api/local/recordings/{created['id']}/chunks/1", data=b'wrong-owner', headers={**chunk_headers, 'Authorization':'Bearer jwt-b'}, method='POST'), timeout=5)
        self.assertEqual(error.exception.code, 404)
        error.exception.close()
        finalize_body = json.dumps({
            'session_id':SESSION_A,'duration_sec':1.0,'frame_count':10,'effective_fps':10.0,
            'width':640,'height':360,'mime_type':'video/webm;codecs=vp8','ended_at':'2026-11-13T09:00:01Z'
        }).encode('utf-8')
        with urlopen(Request(self.base + f"/api/local/recordings/{created['id']}/finalize", data=finalize_body,
                headers={**chunk_headers,'Content-Type':'application/json'}, method='POST'), timeout=5) as response:
            self.assertEqual(response.status, 202)
            finalized = json.loads(response.read().decode('utf-8'))['data']
        self.assertEqual(finalized['status'], 'processing')
        self.server.service.close()
        with urlopen(Request(self.base + f"/api/local/recordings/{created['id']}", headers={'Authorization':'Bearer jwt-a'}), timeout=5) as response:
            ready = json.loads(response.read().decode('utf-8'))['data']
            cookie = response.headers.get('Set-Cookie', '')
        self.assertEqual(ready['status'], 'ready')
        self.assertTrue(ready['playback_url'].endswith('/video'))
        self.assertIn('local-recording-session=', cookie)
        cookie_pair = cookie.split(';',1)[0]
        range_request = Request(self.base + ready['playback_url'], headers={'Cookie':cookie_pair,'Range':'bytes=0-4'})
        with urlopen(range_request, timeout=5) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.read(), b'synth')
        with urlopen(Request(self.base + '/api/local/playback-session/revoke', data=b'{}',
                headers={**common,'Content-Type':'application/json'}, method='POST'), timeout=5) as response:
            revoked = json.loads(response.read().decode('utf-8'))['data']
            expired_cookie = response.headers.get('Set-Cookie','')
        self.assertTrue(revoked['revoked'])
        self.assertIn('Max-Age=0',expired_cookie)
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.base + ready['playback_url'], headers={'Cookie':cookie_pair,'Range':'bytes=0-4'}), timeout=5)
        self.assertEqual(error.exception.code,404)
        error.exception.close()
        with self.assertRaises(HTTPError) as error:
            urlopen(self.base + ready['playback_url'], timeout=5)
        self.assertEqual(error.exception.code, 404)
        error.exception.close()
        with urlopen(Request(self.base + f"/api/local/recordings/{created['id']}", headers={**common}, method='DELETE'), timeout=5) as response:
            deleted = json.loads(response.read().decode('utf-8'))['data']
        self.assertTrue(deleted['deleted'])

    def test_non_loopback_host_is_rejected(self):
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.base + '/api/local/config', headers={'Host':'attacker.invalid'}), timeout=5)
        self.assertEqual(error.exception.code, 403)
        error.exception.close()


if __name__ == '__main__':
    unittest.main()
