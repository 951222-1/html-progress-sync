import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_recording.server import APIError, create_local_server

OWNER='11111111-1111-4111-8111-111111111111'
PATIENT='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
SESSION='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
EVENT='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

if os.environ.get('TMPDIR'):
    TEST_SCRATCH=Path(os.environ['TMPDIR'])
elif os.name=='nt':
    TEST_SCRATCH=Path.home()/'AppData'/'Local'/'hermes'/'cache'/'scratch'
else:
    TEST_SCRATCH=Path(tempfile.gettempdir())
TEST_SCRATCH.mkdir(parents=True,exist_ok=True)


class FakeSupabase:
    def get_user_id(self, token):
        if token!='jwt-synthetic': raise APIError(401,'UNAUTHORIZED','synthetic auth denied')
        return OWNER
    def owns_patient(self, token, patient_id):
        return token=='jwt-synthetic' and patient_id==PATIENT
    def owns_session(self, token, patient_id, session_id):
        return token=='jwt-synthetic' and patient_id==PATIENT and session_id==SESSION
    def owns_cough_event(self, token, session_id, event_id):
        return token=='jwt-synthetic' and session_id==SESSION and event_id==EVENT


def api_json(url, method='GET', payload=None, headers=None):
    data=json.dumps(payload).encode('utf-8') if payload is not None else None
    request=Request(url,data=data,headers=headers or {},method=method)
    with urlopen(request,timeout=20) as response:
        raw=response.read()
        return response.status,json.loads(raw.decode('utf-8')),response.headers


class LocalRecordingHttpMediaE2ETests(unittest.TestCase):
    def test_synthetic_webm_round_trips_through_http_normalization_range_playback_and_delete(self):
        ffmpeg,ffprobe=shutil.which('ffmpeg'),shutil.which('ffprobe')
        if not ffmpeg or not ffprobe:
            self.skipTest('ffmpeg and ffprobe are required for local recording HTTP media E2E')
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as scratch:
            root=Path(__file__).resolve().parents[1]
            work=Path(scratch)
            source=work/'synthetic-input.webm'
            encode=subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-f','lavfi','-i',
                'testsrc2=size=160x120:rate=12:duration=14','-c:v','libvpx','-deadline','realtime','-cpu-used','8',
                '-an','-f','webm',str(source)],capture_output=True,text=True,check=False,shell=False)
            if encode.returncode:
                self.skipTest('installed FFmpeg cannot encode the synthetic WebM fixture')
            server=create_local_server(root,work/'private-data',port=0,supabase=FakeSupabase(),ffmpeg_path=ffmpeg,ffprobe_path=ffprobe)
            thread=threading.Thread(target=server.serve_forever,daemon=True)
            thread.start()
            active_server=True
            base=f'http://127.0.0.1:{server.server_port}'
            write_headers={'Origin':base,'Authorization':'Bearer jwt-synthetic','Content-Type':'application/json'}
            try:
                _,config,_=api_json(base+'/api/local/config')
                csrf=config['data']['csrf_token']
                write_headers['X-Local-Token']=csrf
                _,consent,_=api_json(base+'/api/local/consent','PUT',{'patient_id':PATIENT,'enabled':True},write_headers)
                self.assertTrue(consent['data']['recording_enabled'])
                _,created,_=api_json(base+'/api/local/recordings','POST',{
                    'patient_id':PATIENT,'session_id':SESSION,'started_at':'2026-11-14T12:00:00Z',
                    'mime_type':'video/webm;codecs=vp8','width':160,'height':120
                },write_headers)
                row=created['data'];self.assertEqual(row['status'],'recording')
                self.assertNotIn('owner_id',row)
                capability=row['recording_token']
                chunk_headers={**write_headers,'X-Recording-Token':capability,'Content-Type':'application/octet-stream'}
                content=source.read_bytes()
                self.assertLessEqual(len(content),16*1024*1024)
                with urlopen(Request(base+f"/api/local/recordings/{row['id']}/chunks/0",data=content,headers=chunk_headers,method='POST'),timeout=20) as response:
                    chunk=json.loads(response.read().decode('utf-8'))['data']
                self.assertEqual(chunk['sequence'],0)
                _,marker,_=api_json(base+f"/api/local/recordings/{row['id']}/coughs",'POST',{
                    'event_id':EVENT,'session_id':SESSION,'offset_sec':12.0,
                    'occurred_at':'2026-11-14T12:00:12Z','kind':'疑似嗆咳'
                },chunk_headers)
                self.assertEqual(marker['data']['event_id'],EVENT)
                status,finalized,_=api_json(base+f"/api/local/recordings/{row['id']}/finalize",'POST',{
                    'session_id':SESSION,'duration_sec':14.0,'frame_count':168,'effective_fps':12.0,
                    'width':160,'height':120,'mime_type':'video/webm;codecs=vp8','ended_at':'2026-11-14T12:00:14Z'
                },chunk_headers)
                self.assertIn(status,(200,202))
                self.assertIn(finalized['data']['status'],('processing','ready'))
                server.shutdown()
                thread.join(timeout=10)
                server.server_close()  # Wait for FFmpeg/ffprobe before opening the same private test database again.
                active_server=False
                server=create_local_server(root,work/'private-data',port=0,supabase=FakeSupabase(),ffmpeg_path=ffmpeg,ffprobe_path=ffprobe)
                thread=threading.Thread(target=server.serve_forever,daemon=True)
                thread.start()
                active_server=True
                base=f'http://127.0.0.1:{server.server_port}'
                _,restarted_config,_=api_json(base+'/api/local/config')
                csrf=restarted_config['data']['csrf_token']
                _,detail,_=api_json(base+f"/api/local/recordings/{row['id']}",headers={'Authorization':'Bearer jwt-synthetic'})
                ready=detail['data']
                self.assertEqual(ready['status'],'ready')
                self.assertEqual(ready['metadata']['codec'],'h264')
                self.assertFalse(ready['metadata']['has_audio'])
                self.assertEqual(len(ready['cough_markers']),1)
                duration=float(ready['metadata']['encoded_duration_sec'])
                captured_duration=float(ready['duration_sec'])
                offset=float(ready['cough_markers'][0]['offset_sec'])
                self.assertGreaterEqual(duration,13.5)
                self.assertAlmostEqual(captured_duration,14.0,places=3)
                self.assertGreaterEqual(offset,0)
                self.assertLessEqual(offset,duration)
                self.assertEqual(max(0.0,offset-10.0),2.0)
                output=work/'private-data'/'recordings'/row['id']/'normalized.mp4'
                probe=subprocess.run([ffprobe,'-v','error','-show_streams','-show_format','-of','json',str(output)],
                    capture_output=True,text=True,check=True,shell=False)
                media=json.loads(probe.stdout)
                videos=[stream for stream in media['streams'] if stream.get('codec_type')=='video']
                self.assertEqual(len(videos),1)
                self.assertEqual(videos[0]['codec_name'],'h264')
                self.assertLessEqual(videos[0]['width'],640);self.assertLessEqual(videos[0]['height'],640)
                self.assertFalse(any(stream.get('codec_type')=='audio' for stream in media['streams']))
                _,listed,list_headers=api_json(base+f'/api/local/recordings?patient_id={PATIENT}',headers={'Authorization':'Bearer jwt-synthetic'})
                self.assertEqual(listed['data'][0]['id'],row['id'])
                # Listing issues the short-lived, HttpOnly playback cookie.
                cookie_header=list_headers.get('Set-Cookie','').split(';',1)[0]
                self.assertTrue(cookie_header.startswith('local-recording-session='))
                with urlopen(Request(base+ready['playback_url'],headers={'Cookie':cookie_header,'Range':'bytes=0-31'}),timeout=20) as response:
                    self.assertEqual(response.status,206)
                    self.assertEqual(response.headers.get('Content-Range', '').split('/')[0],'bytes 0-31')
                    self.assertEqual(len(response.read()),32)
                _,deleted,_=api_json(base+f"/api/local/recordings/{row['id']}",'DELETE',headers={
                    'Origin':base,'Authorization':'Bearer jwt-synthetic','X-Local-Token':csrf
                })
                self.assertTrue(deleted['data']['deleted'])
                self.assertFalse(output.exists())
                self.assertTrue(source.exists(),'the original synthetic fixture remains outside private recording storage')
            finally:
                if active_server:
                    server.shutdown()
                    thread.join(timeout=10)
                    server.server_close()


if __name__=='__main__':
    unittest.main()
