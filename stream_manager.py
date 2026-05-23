"""Backward-compatible re-export. Prefer app.core.stream_manager."""

from app.core.stream_manager import (
    StreamConfig,
    StreamError,
    StreamHandle,
    StreamManager,
    StreamNotFoundError,
    StreamStartError,
    StreamStatus,
    stream_manager,
)

__all__ = [
    "StreamConfig",
    "StreamError",
    "StreamHandle",
    "StreamManager",
    "StreamNotFoundError",
    "StreamStartError",
    "StreamStatus",
    "stream_manager",
]
