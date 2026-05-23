import os
import random
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

MEDIAMTX_RTSP_PORT = 8554


class MockVideoError(Exception):
    """Raised when a mock video file cannot be resolved."""


def video_dir() -> Path:
    return Path(os.getenv("MOCK_VIDEO_DIR", "/app/data/Video_BE.mp4"))


def list_mock_videos() -> list[Path]:
    root = video_dir()
    if root.is_dir():
        return sorted(root.glob("*.mp4"))
    data_root = Path(os.getenv("MOCK_VIDEO_DATA_ROOT", "/app/data"))
    return sorted(data_root.rglob("*.mp4"))


def list_mock_video_names() -> list[str]:
    return [path.name for path in list_mock_videos()]


def is_mock_source(source_rtsp: Optional[str]) -> bool:
    if not source_rtsp:
        return True
    parsed = urlparse(source_rtsp)
    if parsed.scheme != "rtsp":
        return False
    path = parsed.path.strip("/")
    return path == "source"


def _resolve_by_name(name: str) -> Path:
    base = Path(name).name
    if not base.lower().endswith(".mp4"):
        base = f"{base}.mp4"

    candidate = video_dir() / base
    if candidate.is_file():
        return candidate

    matches = sorted(video_dir().glob(base))
    if matches:
        return matches[0]

    raise MockVideoError(
        f"Mock video not found: {name}. Available: {', '.join(list_mock_video_names()) or '(none)'}"
    )


def resolve_mock_video(
    name: Optional[str] = None,
    pick: Optional[str] = None,
) -> Path:
    if name:
        return _resolve_by_name(name)

    videos = list_mock_videos()
    if not videos:
        raise MockVideoError(
            f"No .mp4 files under {video_dir()}. Add videos to data/Video_BE.mp4/"
        )

    mode = pick or os.getenv("MOCK_VIDEO_PICK", "random")
    if mode == "random":
        return random.choice(videos)
    if mode == "first":
        return videos[0]

    raise MockVideoError(f"Invalid mock_video_pick: {mode}. Use 'random' or 'first'.")
