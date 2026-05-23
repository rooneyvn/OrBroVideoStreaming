"""FFmpeg relay tuning for CPU-only encoding (e.g. Docker on Apple Silicon)."""

import os
from dataclasses import dataclass
from typing import Optional


def _parse_bitrate_kbps(value: str) -> int:
    raw = (value or "256k").strip().lower()
    if raw.endswith("k"):
        return max(int(float(raw[:-1])), 1)
    if raw.endswith("m"):
        return max(int(float(raw[:-1]) * 1000), 1)
    return max(int(float(raw)), 1)


def _format_bitrate_kbps(kbps: int) -> str:
    kbps = max(int(kbps), 1)
    if kbps >= 1000 and kbps % 1000 == 0:
        return f"{kbps // 1000}M"
    return f"{kbps}k"


@dataclass(frozen=True)
class RelayProfile:
    default_width: int
    default_height: int
    default_fps: int
    bitrate: str
    preset: str
    threads: int
    x264_params: str
    scale_flags: str

    def effective_width(self, width: Optional[int]) -> int:
        return int(width) if width else self.default_width

    def effective_height(self, height: Optional[int]) -> int:
        return int(height) if height else self.default_height

    def effective_bitrate(self, width: int, height: int) -> str:
        """Scale target bitrate from RELAY_BITRATE (SD baseline) by pixel count."""
        base_k = _parse_bitrate_kbps(self.bitrate)
        base_px = self.default_width * self.default_height
        px = max(int(width), 160) * max(int(height), 120)
        scaled = int(base_k * px / base_px)
        min_k = _int_env("RELAY_BITRATE_MIN_K", 128)
        max_k = _int_env("RELAY_BITRATE_MAX_K", 4000)
        return _format_bitrate_kbps(max(min_k, min(scaled, max_k)))

    def effective_bufsize(self, width: int, height: int) -> str:
        kbps = _parse_bitrate_kbps(self.effective_bitrate(width, height))
        return _format_bitrate_kbps(kbps * 2)

    def effective_scale_flags(self, width: int, height: int) -> str:
        px = max(int(width), 160) * max(int(height), 120)
        if px > self.default_width * self.default_height:
            return os.getenv("RELAY_SCALE_FLAGS_HD", "bicubic")
        return self.scale_flags


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    return max(int(raw), 1)


def get_relay_profile() -> RelayProfile:
    return RelayProfile(
        default_width=_int_env("RELAY_WIDTH", 640),
        default_height=_int_env("RELAY_HEIGHT", 360),
        default_fps=_int_env("RELAY_DEFAULT_FPS", 10),
        bitrate=os.getenv("RELAY_BITRATE", "256k"),
        preset=os.getenv("RELAY_PRESET", "ultrafast"),
        threads=_int_env("RELAY_THREADS", 1),
        x264_params=os.getenv(
            "RELAY_X264_PARAMS",
            "ref=1:bframes=0:scenecut=0:rc-lookahead=0:sync-lookahead=0",
        ),
        scale_flags=os.getenv("RELAY_SCALE_FLAGS", "fast_bilinear"),
    )
