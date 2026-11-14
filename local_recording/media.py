"""Local, integrity-checked recording chunk normalization."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


class MediaNormalizationError(RuntimeError):
    """Raised when chunks cannot be safely normalized into a verified MP4."""


def _run(runner: Callable[..., Any], args: list[str]) -> Any:
    try:
        result = runner(args, capture_output=True, text=True, check=False, shell=False)
    except (OSError, subprocess.SubprocessError) as exc:
        raise MediaNormalizationError(f"Unable to execute media tool: {exc}") from exc
    if result.returncode != 0:
        raise MediaNormalizationError(f"Media tool failed ({result.returncode}): {result.stderr}")
    return result


def _probe_json(result: Any) -> dict[str, Any]:
    try:
        value = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError) as exc:
        raise MediaNormalizationError("ffprobe returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise MediaNormalizationError("ffprobe returned an invalid document")
    return value


def _positive_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _has_faststart(path: Path) -> bool:
    """Check top-level ISO BMFF box ordering; moov must precede mdat."""
    size = path.stat().st_size
    offset = 0
    moov_at = None
    mdat_at = None
    with path.open("rb") as stream:
        while offset + 8 <= size:
            stream.seek(offset)
            header = stream.read(8)
            box_size = int.from_bytes(header[:4], "big")
            box_type = header[4:8]
            header_size = 8
            if box_size == 1:
                extended = stream.read(8)
                if len(extended) != 8:
                    return False
                box_size = int.from_bytes(extended, "big")
                header_size = 16
            elif box_size == 0:
                box_size = size - offset
            if box_size < header_size or offset + box_size > size:
                return False
            if box_type == b"moov":
                moov_at = offset
            elif box_type == b"mdat":
                mdat_at = offset
            offset += box_size
    return offset == size and moov_at is not None and mdat_at is not None and moov_at < mdat_at


def normalize_recording(
    data_dir: str | os.PathLike[str],
    recording_id: str,
    recording_metadata: Mapping[str, Any],
    chunk_rows: Sequence[Mapping[str, Any]],
    ffmpeg_path: str | os.PathLike[str] = "ffmpeg",
    ffprobe_path: str | os.PathLike[str] = "ffprobe",
    runner: Callable[..., Any] = subprocess.run,
) -> dict[str, Any]:
    """Join ordered WebM chunks, transcode video-only H.264 MP4, and verify it.

    The source chunks are never modified or deleted. The final file is published
    only after ffprobe and MP4 atom-order validation succeed.
    """
    try:
        parsed_id = uuid.UUID(str(recording_id))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("recording_id must be a canonical UUID") from exc
    if str(parsed_id) != recording_id:
        raise ValueError("recording_id must be a canonical UUID")
    if not isinstance(recording_metadata, Mapping):
        raise ValueError("recording_metadata must be a mapping")
    if not isinstance(chunk_rows, Sequence) or isinstance(chunk_rows, (str, bytes)) or not chunk_rows:
        raise ValueError("chunk_rows must be a non-empty sequence")

    root = Path(data_dir).expanduser().resolve(strict=True)
    verified: list[Path] = []
    for expected_sequence, row in enumerate(chunk_rows):
        if not isinstance(row, Mapping):
            raise ValueError("each chunk row must be a mapping")
        sequence, size, digest, relpath = (row.get(key) for key in ("sequence", "size", "sha256", "relpath"))
        if type(sequence) is not int or sequence != expected_sequence:
            raise ValueError("chunk sequences must be contiguous and start at zero")
        if type(size) is not int or size <= 0:
            raise ValueError("chunk size must be a positive integer")
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("chunk sha256 must be lowercase hexadecimal")
        if not isinstance(relpath, str) or not relpath:
            raise ValueError("chunk relpath must be a non-empty relative path")
        source = (root / relpath).resolve(strict=True)
        if not source.is_relative_to(root) or not source.is_file():
            raise ValueError("chunk path must be a file inside data_dir")
        actual_hash = hashlib.sha256()
        actual_size = 0
        with source.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                actual_size += len(block)
                actual_hash.update(block)
        if actual_size != size or actual_hash.hexdigest() != digest:
            raise ValueError(f"chunk {expected_sequence} size or sha256 mismatch")
        verified.append(source)

    output_dir = root / "recordings" / str(parsed_id)
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / "normalized.mp4"
    with tempfile.TemporaryDirectory(prefix=".normalize-", dir=output_dir) as work_dir:
        work = Path(work_dir)
        joined = work / "joined.webm"
        with joined.open("wb") as output:
            for source in verified:
                with source.open("rb") as chunk:
                    for block in iter(lambda: chunk.read(1024 * 1024), b""):
                        output.write(block)
        temporary_output = work / "normalized.mp4"
        ffmpeg_args = [
            str(ffmpeg_path), "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(joined), "-map", "0:v:0", "-an", "-sn", "-dn",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-vf", "scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2",
            "-fps_mode", "passthrough", "-movflags", "+faststart",
        ]
        max_output_bytes=recording_metadata.get('_max_output_bytes')
        if max_output_bytes is not None:
            if type(max_output_bytes) is not int or max_output_bytes<=0:
                raise ValueError('_max_output_bytes must be a positive integer when provided')
            ffmpeg_args.extend(['-fs',str(max_output_bytes)])
        ffmpeg_args.append(str(temporary_output))
        _run(runner, ffmpeg_args)
        if not temporary_output.is_file() or temporary_output.stat().st_size == 0:
            raise MediaNormalizationError("ffmpeg did not produce an MP4")
        probe_args = [
            str(ffprobe_path), "-v", "error", "-count_frames", "-show_streams", "-show_format",
            "-of", "json", str(temporary_output),
        ]
        probe = _probe_json(_run(runner, probe_args))
        streams = probe.get("streams")
        if not isinstance(streams, list) or len(streams) != 1 or streams[0].get("codec_type") != "video":
            raise MediaNormalizationError("output must contain exactly one video stream and no other streams")
        video = streams[0]
        width, height = video.get("width"), video.get("height")
        if video.get("codec_name") != "h264":
            raise MediaNormalizationError("output video codec is not H.264")
        if type(width) is not int or type(height) is not int or not (0 < width <= 640 and 0 < height <= 640):
            raise MediaNormalizationError("output dimensions are invalid or exceed 640x640")
        duration = _positive_number(video.get("duration")) or _positive_number(probe.get("format", {}).get("duration"))
        frame_count = video.get("nb_read_frames") or video.get("nb_frames")
        try:
            frame_count = int(frame_count)
        except (TypeError, ValueError):
            frame_count = 0
        if duration is None or frame_count <= 0:
            raise MediaNormalizationError("output must have positive duration and frame count")
        expected_duration=_positive_number(recording_metadata.get('duration_sec'))
        if expected_duration is not None:
            duration_tolerance=min(2.0,max(0.25,expected_duration*0.05))
            if abs(duration-expected_duration)>duration_tolerance:
                raise MediaNormalizationError('normalized output duration does not match the captured recording within tolerance')
        expected_frames=recording_metadata.get('frame_count')
        if type(expected_frames) is int and expected_frames>0 and frame_count<max(1,(expected_frames+1)//2):
            # Encoder frame drops are possible, but a clip with less than half the captured frames is truncated.
            raise MediaNormalizationError('normalized output frame count is materially below the captured recording')
        if not _has_faststart(temporary_output):
            raise MediaNormalizationError("MP4 moov atom must precede mdat")
        os.replace(temporary_output, destination)

    return {
        "ready": True,
        "recording_id": str(parsed_id),
        "path": str(destination),
        "codec": "h264",
        "width": width,
        "height": height,
        "duration": duration,
        "frame_count": frame_count,
    }
