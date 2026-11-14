import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_recording.media import MediaNormalizationError, normalize_recording


RECORDING_ID = "11111111-1111-4111-8111-111111111111"

if os.environ.get("TMPDIR"):
    TEST_SCRATCH = Path(os.environ["TMPDIR"])
elif os.name == "nt":
    TEST_SCRATCH = Path.home() / "AppData" / "Local" / "hermes" / "cache" / "scratch"
else:
    TEST_SCRATCH = Path(tempfile.gettempdir())
TEST_SCRATCH.mkdir(parents=True, exist_ok=True)


class FakeRunner:
    def __init__(self, probe=None, fail_ffmpeg=False):
        self.calls = []
        self.fail_ffmpeg = fail_ffmpeg
        self.probe = probe or {
            "streams": [{"codec_type": "video", "codec_name": "h264", "width": 320, "height": 240,
                         "duration": "1.0", "nb_frames": "24"}],
            "format": {"duration": "1.0"},
        }

    def __call__(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args[0] == "ffmpeg-test" and self.fail_ffmpeg:
            return SimpleNamespace(returncode=1, stdout="", stderr="synthetic ffmpeg failure")
        if "-version" not in args and args[0] == "ffmpeg-test":
            output = Path(args[-1])
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"\x00\x00\x00\x08ftyp\x00\x00\x00\x08moov\x00\x00\x00\x08mdat")
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        return SimpleNamespace(returncode=0, stdout=json.dumps(self.probe), stderr="")


def make_chunk(data_dir, sequence=0, content=b"synthetic webm bytes", relpath=None):
    relative = relpath or f"recordings/{RECORDING_ID}/chunks/chunk-{sequence:08d}.webm"
    path = data_dir / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return {"sequence": sequence, "size": len(content), "sha256": hashlib.sha256(content).hexdigest(), "relpath": relative}


class RecordingMediaTests(unittest.TestCase):
    def test_rejects_malformed_recording_id_before_running_tools(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            data_dir = Path(folder)
            chunk = make_chunk(data_dir)
            runner = FakeRunner()

            with self.assertRaises(ValueError):
                normalize_recording(data_dir, "../not-a-uuid", {}, [chunk], "ffmpeg-test", "ffprobe-test", runner)

            self.assertFalse(runner.calls)

    def test_normalizes_synthetic_webm_when_ffmpeg_can_encode_it(self):
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if not ffmpeg or not ffprobe:
            self.skipTest("ffmpeg and ffprobe are required for the integration test")
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            data_dir = Path(folder)
            synthetic = data_dir / "synthetic.webm"
            encoded = subprocess.run(
                [ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                 "color=c=blue:s=160x120:r=12:d=1", "-c:v", "libvpx", "-an", "-f", "webm", str(synthetic)],
                capture_output=True, text=True, check=False, shell=False,
            )
            if encoded.returncode != 0:
                self.skipTest("installed ffmpeg cannot encode synthetic WebM")
            chunk_data = synthetic.read_bytes()
            chunk = make_chunk(data_dir, content=chunk_data)

            result = normalize_recording(data_dir, RECORDING_ID, {"mime_type": "video/webm"}, [chunk], ffmpeg, ffprobe)

            self.assertTrue(result["ready"])
            self.assertEqual(result["codec"], "h264")
            self.assertGreater(result["frame_count"], 0)
            self.assertLessEqual(result["width"], 640)
            self.assertLessEqual(result["height"], 640)

    def test_enforces_a_configured_ffmpeg_output_size_ceiling(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            data_dir=Path(folder)
            chunk=make_chunk(data_dir)
            runner=FakeRunner()
            normalize_recording(data_dir,RECORDING_ID,{'_max_output_bytes':1024},[chunk],'ffmpeg-test','ffprobe-test',runner)
            args,_=next(call for call in runner.calls if call[0][0]=='ffmpeg-test')
            self.assertIn('-fs',args)
            self.assertEqual(args[args.index('-fs')+1],'1024')

    def test_rejects_valid_but_truncated_output_before_marking_recording_ready(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            data_dir=Path(folder)
            chunk=make_chunk(data_dir)
            runner=FakeRunner(probe={
                'streams':[{'codec_type':'video','codec_name':'h264','width':320,'height':240,
                    'duration':'2.2','nb_frames':'27','nb_read_frames':'27'}],
                'format':{'duration':'2.2'}
            })
            with self.assertRaises(MediaNormalizationError):
                normalize_recording(data_dir,RECORDING_ID,{'duration_sec':20.0},[chunk],'ffmpeg-test','ffprobe-test',runner)
            self.assertTrue((data_dir/chunk['relpath']).is_file())
            self.assertFalse((data_dir/'recordings'/RECORDING_ID/'normalized.mp4').exists())

    def test_rejects_materially_under_counted_video_even_when_duration_matches(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            data_dir=Path(folder)
            chunk=make_chunk(data_dir)
            runner=FakeRunner(probe={
                'streams':[{'codec_type':'video','codec_name':'h264','width':320,'height':240,
                    'duration':'20.0','nb_frames':'27','nb_read_frames':'27'}],
                'format':{'duration':'20.0'}
            })
            with self.assertRaises(MediaNormalizationError):
                normalize_recording(data_dir,RECORDING_ID,{'duration_sec':20.0,'frame_count':240},[chunk],
                    'ffmpeg-test','ffprobe-test',runner)
            self.assertTrue((data_dir/chunk['relpath']).is_file())
            self.assertFalse((data_dir/'recordings'/RECORDING_ID/'normalized.mp4').exists())

    def test_ffmpeg_failure_preserves_chunks_and_does_not_publish_output(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            data_dir = Path(folder)
            chunk = make_chunk(data_dir)
            runner = FakeRunner(fail_ffmpeg=True)

            with self.assertRaises(MediaNormalizationError):
                normalize_recording(data_dir, RECORDING_ID, {}, [chunk], "ffmpeg-test", "ffprobe-test", runner)

            self.assertTrue((data_dir / chunk["relpath"]).is_file())
            self.assertFalse((data_dir / "recordings" / RECORDING_ID / "normalized.mp4").exists())
            self.assertEqual(len(runner.calls), 1)

    def test_rejects_outputs_with_non_video_streams_and_preserves_chunks(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            data_dir = Path(folder)
            chunk = make_chunk(data_dir)
            runner = FakeRunner(probe={
                "streams": [
                    {"codec_type": "video", "codec_name": "h264", "width": 320, "height": 240,
                     "duration": "1.0", "nb_frames": "24"},
                    {"codec_type": "audio", "codec_name": "aac"},
                ],
                "format": {"duration": "1.0"},
            })

            with self.assertRaises(MediaNormalizationError):
                normalize_recording(data_dir, RECORDING_ID, {}, [chunk], "ffmpeg-test", "ffprobe-test", runner)

            self.assertTrue((data_dir / chunk["relpath"]).is_file())
            self.assertFalse((data_dir / "recordings" / RECORDING_ID / "normalized.mp4").exists())

    def test_refuses_chunk_symlink_or_path_outside_data_dir(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder, tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as outside:
            data_dir = Path(folder)
            external = Path(outside) / "outside.webm"
            external.write_bytes(b"outside")
            chunk = make_chunk(data_dir)
            chunk.update({
                "relpath": os.path.relpath(external, data_dir),
                "size": len(b"outside"),
                "sha256": hashlib.sha256(b"outside").hexdigest(),
            })
            runner = FakeRunner()

            with self.assertRaises(ValueError):
                normalize_recording(data_dir, RECORDING_ID, {}, [chunk], "ffmpeg-test", "ffprobe-test", runner)

            self.assertFalse(runner.calls)

    def test_rejects_chunk_hash_mismatch_before_running_ffmpeg_and_preserves_source(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            data_dir = Path(folder)
            chunk = make_chunk(data_dir)
            chunk["sha256"] = "0" * 64
            source = data_dir / chunk["relpath"]
            runner = FakeRunner()

            with self.assertRaises(ValueError):
                normalize_recording(data_dir, RECORDING_ID, {}, [chunk], "ffmpeg-test", "ffprobe-test", runner)

            self.assertTrue(source.exists())
            self.assertFalse(runner.calls)

    def test_normalizes_verified_sequential_chunks_and_checks_media_output(self):
        with tempfile.TemporaryDirectory(dir=TEST_SCRATCH) as folder:
            data_dir = Path(folder)
            chunk = make_chunk(data_dir)
            runner = FakeRunner()

            result = normalize_recording(
                data_dir=data_dir,
                recording_id=RECORDING_ID,
                recording_metadata={"mime_type": "video/webm;codecs=vp8", "width": 320, "height": 240},
                chunk_rows=[chunk],
                ffmpeg_path="ffmpeg-test",
                ffprobe_path="ffprobe-test",
                runner=runner,
            )

            self.assertTrue(result["ready"])
            self.assertEqual(result["codec"], "h264")
            self.assertEqual((result["width"], result["height"]), (320, 240))
            self.assertTrue(Path(result["path"]).is_file())
            ffmpeg_args, kwargs = next(call for call in runner.calls if call[0][0] == "ffmpeg-test")
            self.assertIsInstance(ffmpeg_args, list)
            self.assertNotIn("-r", ffmpeg_args)
            self.assertIn("-map", ffmpeg_args)
            self.assertIn("0:v:0", ffmpeg_args)
            self.assertIn("-an", ffmpeg_args)
            self.assertIn("-sn", ffmpeg_args)
            self.assertIn("-dn", ffmpeg_args)
            self.assertIn("passthrough", ffmpeg_args)
            self.assertIn("+faststart", ffmpeg_args)
            self.assertEqual(kwargs.get("shell"), False)
            probe_args, probe_kwargs = next(call for call in runner.calls if call[0][0] == "ffprobe-test")
            self.assertIsInstance(probe_args, list)
            self.assertEqual(probe_kwargs.get("shell"), False)


if __name__ == "__main__":
    unittest.main()
