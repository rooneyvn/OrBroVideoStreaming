import logging
import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

STARTUP_VERIFY_SECONDS = 2.0
RESTART_SETTLE_SECONDS = 1.5
SYNC_START_RETRIES = 3
SYNC_STALE_SECONDS = 45.0
MEDIAMTX_RTSP_PORT = 8554


class StreamStatus(str, Enum):
    STARTING = "STARTING"
    RUNNING = "RUNNING"
    STOPPING = "STOPPING"
    STOPPED = "STOPPED"
    FAILED = "FAILED"


class StreamError(Exception):
    """Base exception for StreamManager."""


class StreamNotFoundError(StreamError):
    def __init__(self, camera_id: str):
        self.camera_id = camera_id
        super().__init__(f"Stream not found: {camera_id}")


class StreamStartError(StreamError):
    def __init__(self, camera_id: str, message: str):
        self.camera_id = camera_id
        super().__init__(f"Failed to start stream {camera_id}: {message}")


@dataclass
class StreamConfig:
    camera_id: str
    source_rtsp: str
    fps: int = 15
    width: Optional[int] = None
    height: Optional[int] = None
    bitrate: str = "500k"
    preset: str = "ultrafast"
    local_video_path: Optional[str] = None
    mock_video_name: Optional[str] = None


@dataclass
class StreamHandle:
    config: StreamConfig
    process: Optional[subprocess.Popen] = None
    passthrough: bool = False
    playback_path: Optional[str] = None
    status: StreamStatus = StreamStatus.STARTING
    started_at: float = field(default_factory=time.time)
    last_error: Optional[str] = None
    reconnect_count: int = 0
    _stderr_thread: Optional[threading.Thread] = field(default=None, repr=False)
    _stderr_lines: list[str] = field(default_factory=list, repr=False)


class StreamManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._registry: dict[str, StreamHandle] = {}
        self._camera_locks: dict[str, threading.Lock] = {}
        self._generations: dict[str, int] = {}
        self._syncing: dict[str, float] = {}

    def is_syncing(self, camera_id: str) -> bool:
        with self._lock:
            started = self._syncing.get(camera_id)
            if started is None:
                return False
            age = time.time() - started
            if age > SYNC_STALE_SECONDS:
                del self._syncing[camera_id]
                logger.warning(
                    "Cleared stale sync lock for cam %s (%.0fs)",
                    camera_id,
                    age,
                )
                return False
            return True

    def _begin_sync(self, camera_id: str) -> None:
        with self._lock:
            self._syncing[camera_id] = time.time()

    def _end_sync(self, camera_id: str) -> None:
        with self._lock:
            self._syncing.pop(camera_id, None)

    def _camera_lock(self, camera_id: str) -> threading.Lock:
        with self._lock:
            lock = self._camera_locks.get(camera_id)
            if lock is None:
                lock = threading.Lock()
                self._camera_locks[camera_id] = lock
            return lock

    def _bump_generation(self, camera_id: str) -> int:
        with self._lock:
            gen = self._generations.get(camera_id, 0) + 1
            self._generations[camera_id] = gen
            return gen

    def _current_generation(self, camera_id: str) -> int:
        with self._lock:
            return self._generations.get(camera_id, 0)

    def _generation_valid(self, camera_id: str, generation: int) -> bool:
        with self._lock:
            return self._generations.get(camera_id, 0) == generation

    def cancel_camera(self, camera_id: str) -> None:
        """Stop stream and invalidate any in-flight start for this camera."""
        handle: Optional[StreamHandle] = None
        with self._camera_lock(camera_id):
            self._bump_generation(camera_id)
            handle = self._pop_handle(camera_id)

        if handle and not handle.passthrough:
            self._cleanup_handle(handle)
        logger.info("Cancelled stream for cam %s", camera_id)

    def start_stream(self, config: StreamConfig) -> None:
        camera_id = config.camera_id
        old: Optional[StreamHandle] = None
        cmd: list[str] = []
        settle = False
        generation = 0

        with self._camera_lock(camera_id):
            generation = self._current_generation(camera_id)
            had_existing = self._has_handle(camera_id)
            old = self._pop_handle(camera_id)

            if not self._generation_valid(camera_id, generation):
                logger.info("Skip start for cam %s (cancelled)", camera_id)
                return

            playback_path = self._passthrough_path(config.source_rtsp)
            if playback_path and not config.local_video_path:
                handle = StreamHandle(
                    config=config,
                    passthrough=True,
                    playback_path=playback_path,
                    status=StreamStatus.RUNNING,
                )
                self._set_handle(camera_id, handle)
                logger.info(
                    "Passthrough cam %s using mediamtx path %s",
                    camera_id,
                    playback_path,
                )
                return

            if config.local_video_path:
                cmd = self._build_ffmpeg_cmd_from_file(config)
            else:
                cmd = self._build_ffmpeg_cmd(config)

            placeholder = StreamHandle(
                config=config,
                playback_path=f"live/cam_{camera_id}",
                status=StreamStatus.STARTING,
            )
            self._set_handle(camera_id, placeholder)
            settle = had_existing and RESTART_SETTLE_SECONDS > 0

        if old and not old.passthrough:
            self._cleanup_handle(old)

        if settle:
            time.sleep(RESTART_SETTLE_SECONDS)

        with self._camera_lock(camera_id):
            if not self._generation_valid(camera_id, generation):
                self._pop_handle(camera_id)
                logger.info(
                    "Skip start for cam %s (cancelled during settle)",
                    camera_id,
                )
                return

        self._start_ffmpeg(config, cmd, generation)

        if config.local_video_path:
            logger.info(
                "Mock file stream for cam %s from %s at %s FPS %sx%s",
                camera_id,
                config.mock_video_name or config.local_video_path,
                config.fps,
                config.width or "auto",
                config.height or "auto",
            )

    def _start_ffmpeg(
        self, config: StreamConfig, cmd: list[str], generation: int
    ) -> None:
        camera_id = config.camera_id
        with self._camera_lock(camera_id):
            if not self._generation_valid(camera_id, generation):
                return

        try:
            process = subprocess.Popen(
                cmd,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
        except FileNotFoundError as exc:
            with self._camera_lock(camera_id):
                self._mark_failed(camera_id, "ffmpeg executable not found")
            raise StreamStartError(
                camera_id, "ffmpeg executable not found"
            ) from exc
        except OSError as exc:
            with self._camera_lock(camera_id):
                self._mark_failed(camera_id, str(exc))
            raise StreamStartError(camera_id, str(exc)) from exc

        handle = StreamHandle(
            config=config,
            process=process,
            playback_path=f"live/cam_{camera_id}",
            status=StreamStatus.STARTING,
        )

        try:
            self._wait_alive(handle, STARTUP_VERIFY_SECONDS)
        except StreamStartError:
            self._cleanup_handle(handle)
            with self._camera_lock(camera_id):
                self._mark_failed(
                    camera_id, handle.last_error or "ffmpeg exited"
                )
            raise

        with self._camera_lock(camera_id):
            if not self._generation_valid(camera_id, generation):
                self._cleanup_handle(handle)
                self._pop_handle(camera_id)
                logger.info(
                    "Aborted start for cam %s (superseded)", camera_id
                )
                return

            watcher = threading.Thread(
                target=self._watch_stderr,
                args=(handle,),
                name=f"ffmpeg-stderr-{camera_id}",
                daemon=True,
            )
            handle._stderr_thread = watcher
            watcher.start()

            handle.status = StreamStatus.RUNNING
            handle.started_at = time.time()
            self._set_handle(camera_id, handle)
            logger.info(
                "Started relay stream for cam %s at %s FPS %sx%s mode=relay mock=%s",
                camera_id,
                config.fps,
                config.width or "auto",
                config.height or "auto",
                config.mock_video_name or "-",
            )

    def stop_stream(self, camera_id: str) -> None:
        handle: Optional[StreamHandle] = None
        with self._camera_lock(camera_id):
            self._bump_generation(camera_id)
            handle = self._pop_handle(camera_id)

        if handle and not handle.passthrough:
            self._cleanup_handle(handle)
        logger.info("Stopped stream for cam %s", camera_id)

    def sync_stream(self, config: StreamConfig) -> None:
        """Stop then start so encoding/source changes always take effect."""
        camera_id = config.camera_id
        self._begin_sync(camera_id)
        try:
            last_error: Optional[StreamStartError] = None
            for attempt in range(1, SYNC_START_RETRIES + 1):
                self.stop_stream(camera_id)
                delay = (
                    RESTART_SETTLE_SECONDS
                    if attempt == 1
                    else RESTART_SETTLE_SECONDS * attempt
                )
                time.sleep(delay)
                try:
                    self.start_stream(config)
                    return
                except StreamStartError as exc:
                    last_error = exc
                    logger.warning(
                        "Start attempt %s/%s failed for cam %s: %s",
                        attempt,
                        SYNC_START_RETRIES,
                        camera_id,
                        exc,
                    )
            if last_error:
                raise last_error
        finally:
            self._end_sync(camera_id)

    def change_encoding(
        self,
        camera_id: str,
        *,
        fps: Optional[int] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
    ) -> None:
        with self._camera_lock(camera_id):
            handle = self._get_handle(camera_id)
            if not handle:
                raise StreamNotFoundError(camera_id)
            if handle.passthrough:
                raise StreamStartError(
                    camera_id, "Encoding change not supported for passthrough streams"
                )

            new_fps = int(fps if fps is not None else handle.config.fps)
            new_width = width if width is not None else handle.config.width
            new_height = height if height is not None else handle.config.height

            if (
                handle.config.fps == new_fps
                and handle.config.width == new_width
                and handle.config.height == new_height
            ):
                return

            config = replace(
                handle.config,
                fps=new_fps,
                width=new_width,
                height=new_height,
            )

        self.start_stream(config)

    def change_fps(self, camera_id: str, fps: int) -> None:
        self.change_encoding(camera_id, fps=int(fps))

    def restart_stream(self, camera_id: str) -> None:
        with self._camera_lock(camera_id):
            handle = self._get_handle(camera_id)
            if not handle:
                raise StreamNotFoundError(camera_id)
            config = handle.config
            handle.reconnect_count += 1
            reconnect_count = handle.reconnect_count
        logger.info(
            "Restarting stream for cam %s (attempt %s)",
            camera_id,
            reconnect_count,
        )
        self.start_stream(config)

    def stop_all(self) -> None:
        with self._lock:
            camera_ids = list(self._registry.keys())
        for camera_id in camera_ids:
            self.stop_stream(camera_id)
        logger.info("Stopped all streams")

    def is_running(self, camera_id: str) -> bool:
        with self._lock:
            handle = self._registry.get(camera_id)
            if not handle:
                return False
            if handle.passthrough:
                return handle.status == StreamStatus.RUNNING
            return (
                handle.status == StreamStatus.RUNNING
                and handle.process is not None
                and handle.process.poll() is None
            )

    def get_status(self, camera_id: str) -> Optional[StreamStatus]:
        with self._lock:
            handle = self._registry.get(camera_id)
            if not handle:
                return None
            if handle.passthrough:
                return handle.status
            if (
                handle.status == StreamStatus.RUNNING
                and handle.process is not None
                and handle.process.poll() is not None
            ):
                handle.status = StreamStatus.FAILED
            return handle.status

    def get_uptime(self, camera_id: str) -> float:
        with self._lock:
            handle = self._registry.get(camera_id)
            if not handle or handle.status != StreamStatus.RUNNING:
                return 0.0
            return time.time() - handle.started_at

    def get_runtime_info(self, camera_id: str) -> Optional[dict]:
        with self._lock:
            handle = self._registry.get(camera_id)
            if not handle:
                return None
            status = handle.status
            if (
                not handle.passthrough
                and status == StreamStatus.RUNNING
                and handle.process is not None
                and handle.process.poll() is not None
            ):
                status = StreamStatus.FAILED
            cfg = handle.config
            return {
                "status": status.value,
                "running": status == StreamStatus.RUNNING,
                "uptime_seconds": time.time() - handle.started_at
                if status == StreamStatus.RUNNING
                else 0.0,
                "stream_fps": cfg.fps,
                "stream_width": cfg.width,
                "stream_height": cfg.height,
                "fps": cfg.fps,
                "width": cfg.width,
                "height": cfg.height,
                "last_error": handle.last_error,
                "reconnect_count": handle.reconnect_count,
                "playback_path": handle.playback_path,
                "mode": "passthrough" if handle.passthrough else "relay",
                "mock_video_name": cfg.mock_video_name,
            }

    def list_active(self) -> list[str]:
        with self._lock:
            return list(self._registry.keys())

    def config_matches(self, desired: StreamConfig) -> bool:
        handle = self._get_handle(desired.camera_id)
        if not handle:
            return False
        current = handle.config
        if handle.passthrough:
            return (
                current.source_rtsp == desired.source_rtsp
                and current.local_video_path == desired.local_video_path
            )
        return (
            current.fps == desired.fps
            and current.width == desired.width
            and current.height == desired.height
            and current.source_rtsp == desired.source_rtsp
            and current.local_video_path == desired.local_video_path
            and (current.mock_video_name or "") == (desired.mock_video_name or "")
        )

    def _resolve_handle_status(self, handle: StreamHandle) -> StreamStatus:
        status = handle.status
        if (
            not handle.passthrough
            and status == StreamStatus.RUNNING
            and handle.process is not None
            and handle.process.poll() is not None
        ):
            status = StreamStatus.FAILED
        return status

    def _handle_is_running(self, handle: StreamHandle) -> bool:
        return self._resolve_handle_status(handle) == StreamStatus.RUNNING

    @property
    def active_count(self) -> int:
        """Number of streams that are actually RUNNING (ffmpeg alive)."""
        with self._lock:
            return sum(
                1 for handle in self._registry.values() if self._handle_is_running(handle)
            )

    def stream_stats(self) -> dict:
        with self._lock:
            counts = {
                "running": 0,
                "starting": 0,
                "failed": 0,
                "stopping": 0,
                "registered": len(self._registry),
            }
            streams: list[dict] = []
            for camera_id, handle in self._registry.items():
                status = self._resolve_handle_status(handle)
                key = status.value.lower()
                if key in counts:
                    counts[key] += 1
                cfg = handle.config
                streams.append(
                    {
                        "camera_id": camera_id,
                        "status": status.value,
                        "running": status == StreamStatus.RUNNING,
                        "fps": cfg.fps,
                        "width": cfg.width,
                        "height": cfg.height,
                        "mode": "passthrough" if handle.passthrough else "relay",
                        "mock_video_name": cfg.mock_video_name,
                        "uptime_seconds": round(time.time() - handle.started_at, 1)
                        if status == StreamStatus.RUNNING
                        else 0.0,
                    }
                )
        return {
            "active_streams": counts["running"],
            "registered_streams": counts["registered"],
            "starting_streams": counts["starting"],
            "failed_streams": counts["failed"],
            "streams": streams,
        }

    def log_stream_health(
        self,
        expected_active: int | None = None,
        expected_ids: list[str] | None = None,
        expected_fps: dict[str, int] | None = None,
    ) -> None:
        stats = self.stream_stats()
        running = stats["active_streams"]
        registered = stats["registered_streams"]
        registered_ids = {item["camera_id"] for item in stats["streams"]}

        fps_drift = []
        if expected_fps:
            for item in stats["streams"]:
                if not item["running"]:
                    continue
                db_fps = expected_fps.get(item["camera_id"])
                if db_fps is not None and db_fps != item["fps"]:
                    fps_drift.append(
                        f"{item['camera_id'][-6:]}:stream={item['fps']} db={db_fps}"
                    )

        if expected_active is not None and (
            running != expected_active or registered < expected_active
        ):
            missing = []
            if expected_ids:
                missing = [
                    cam_id[-6:]
                    for cam_id in expected_ids
                    if cam_id not in registered_ids
                ]
            logger.warning(
                "[stream-health] mismatch db_active=%s live=%s registered=%s "
                "missing=%s",
                expected_active,
                running,
                registered,
                ",".join(missing) if missing else "-",
            )

        if fps_drift:
            logger.warning(
                "[stream-health] fps drift (will restart): %s",
                "; ".join(fps_drift),
            )

        if registered == 0:
            if expected_active:
                logger.info(
                    "[stream-health] no registered streams (db_active=%s)",
                    expected_active,
                )
            else:
                logger.info("[stream-health] no registered streams")
            return

        parts = []
        for item in stats["streams"]:
            if not item["running"]:
                parts.append(f"{item['camera_id'][-6:]}={item['status']}")
                continue
            res = (
                f"{item['width']}x{item['height']}"
                if item["width"] and item["height"]
                else "auto"
            )
            mock = item["mock_video_name"] or "-"
            db_fps = (
                expected_fps.get(item["camera_id"]) if expected_fps else None
            )
            if db_fps is not None:
                fps_label = f"{item['fps']}fps db={db_fps}"
            else:
                fps_label = f"{item['fps']}fps"
            parts.append(
                f"{item['camera_id'][-6:]}={fps_label}/{res} "
                f"up={item['uptime_seconds']:.0f}s mock={mock}"
            )

        logger.info(
            "[stream-health] live=%s registered=%s starting=%s failed=%s "
            "db_active=%s | %s",
            running,
            registered,
            stats["starting_streams"],
            stats["failed_streams"],
            expected_active if expected_active is not None else "-",
            "; ".join(parts),
        )

    def _is_current_handle(self, handle: StreamHandle) -> bool:
        with self._lock:
            return self._registry.get(handle.config.camera_id) is handle

    def _has_handle(self, camera_id: str) -> bool:
        with self._lock:
            return camera_id in self._registry

    def _get_handle(self, camera_id: str) -> Optional[StreamHandle]:
        with self._lock:
            return self._registry.get(camera_id)

    def _pop_handle(self, camera_id: str) -> Optional[StreamHandle]:
        with self._lock:
            handle = self._registry.pop(camera_id, None)
            if handle:
                handle.status = StreamStatus.STOPPING
            return handle

    def _set_handle(self, camera_id: str, handle: StreamHandle) -> None:
        with self._lock:
            self._registry[camera_id] = handle

    def _mark_failed(self, camera_id: str, message: str) -> None:
        with self._lock:
            handle = self._registry.get(camera_id)
            if handle:
                handle.status = StreamStatus.FAILED
                handle.last_error = message

    def _internal_mediamtx_hosts(self) -> set[str]:
        media_host = os.getenv("MEDIA_SERVER_HOST", "localhost")
        return {media_host, "mediamtx", "localhost", "127.0.0.1"}

    def _passthrough_path(self, source_rtsp: str) -> Optional[str]:
        parsed = urlparse(source_rtsp)
        if parsed.scheme != "rtsp":
            return None
        host = parsed.hostname or ""
        port = parsed.port or MEDIAMTX_RTSP_PORT
        if host not in self._internal_mediamtx_hosts() or port != MEDIAMTX_RTSP_PORT:
            return None
        path = parsed.path.lstrip("/")
        if not path or path.startswith("live/cam_"):
            return None
        return path

    def _video_filter(self, config: StreamConfig) -> str:
        parts: list[str] = []
        if config.width and config.height:
            parts.append(f"scale={int(config.width)}:{int(config.height)}")
        fps = max(int(config.fps), 1)
        parts.append(f"fps={fps}")
        return ",".join(parts)

    def _video_encode_args(self, config: StreamConfig) -> list[str]:
        fps = max(int(config.fps), 1)
        return [
            "-an",
            "-vf",
            self._video_filter(config),
            "-vsync",
            "cfr",
            "-c:v",
            "libx264",
            "-preset",
            config.preset,
            "-tune",
            "zerolatency",
            "-r",
            str(fps),
            "-g",
            str(fps),
            "-keyint_min",
            str(fps),
            "-b:v",
            config.bitrate,
        ]

    def _build_ffmpeg_cmd_from_file(self, config: StreamConfig) -> list[str]:
        media_host = os.getenv("MEDIA_SERVER_HOST", "localhost")
        output_rtsp = f"rtsp://{media_host}:8554/live/cam_{config.camera_id}"
        return [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-stream_loop",
            "-1",
            "-re",
            "-i",
            config.local_video_path,
            *self._video_encode_args(config),
            "-f",
            "rtsp",
            "-rtsp_transport",
            "tcp",
            output_rtsp,
        ]

    def _build_ffmpeg_cmd(self, config: StreamConfig) -> list[str]:
        media_host = os.getenv("MEDIA_SERVER_HOST", "localhost")
        output_rtsp = f"rtsp://{media_host}:8554/live/cam_{config.camera_id}"
        return [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-rtsp_transport",
            "tcp",
            "-i",
            config.source_rtsp,
            *self._video_encode_args(config),
            "-f",
            "rtsp",
            output_rtsp,
        ]

    def _cleanup_handle(self, handle: StreamHandle) -> None:
        if handle.process is None:
            return
        proc = handle.process
        self._terminate_process(proc)
        handle.process = None
        watcher = handle._stderr_thread
        if watcher and watcher.is_alive():
            watcher.join(timeout=1.0)

    def _terminate_process(self, proc: subprocess.Popen) -> None:
        if proc.poll() is not None:
            return

        pid = proc.pid
        try:
            proc.kill()
        except ProcessLookupError:
            return
        except OSError:
            if hasattr(os, "killpg"):
                try:
                    pgid = os.getpgid(pid)
                    if pgid == pid:
                        os.killpg(pgid, signal.SIGKILL)
                    else:
                        os.kill(pid, signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    pass

        try:
            proc.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            pass

    def _wait_alive(self, handle: StreamHandle, timeout: float) -> None:
        if handle.process is None:
            return
        deadline = time.time() + timeout
        while time.time() < deadline:
            if handle.process.poll() is not None:
                stderr_output = self._drain_stderr(handle.process)
                handle.last_error = stderr_output
                raise StreamStartError(handle.config.camera_id, stderr_output)
            time.sleep(0.1)

    def _drain_stderr(self, proc: subprocess.Popen) -> str:
        if not proc.stderr:
            return "ffmpeg exited immediately"
        try:
            data = proc.stderr.read()
            return data.decode(errors="replace").strip() or "ffmpeg exited immediately"
        except Exception:
            return "ffmpeg exited immediately"

    def _watch_stderr(self, handle: StreamHandle) -> None:
        proc = handle.process
        if proc is None or not proc.stderr:
            return
        try:
            for line in iter(proc.stderr.readline, b""):
                msg = line.decode(errors="replace").strip()
                if msg:
                    handle.last_error = msg
                    handle._stderr_lines.append(msg)
                    logger.error(
                        "[cam=%s ffmpeg] %s",
                        handle.config.camera_id,
                        msg,
                    )
        except (ValueError, OSError):
            pass
        except Exception:
            logger.exception(
                "stderr watcher failed for cam %s",
                handle.config.camera_id,
            )
        finally:
            if (
                handle.status == StreamStatus.RUNNING
                and self._is_current_handle(handle)
            ):
                handle.status = StreamStatus.FAILED
                logger.warning(
                    "Stream %s died unexpectedly",
                    handle.config.camera_id,
                )


stream_manager = StreamManager()
