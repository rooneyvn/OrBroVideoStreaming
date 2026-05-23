import logging
import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

STARTUP_VERIFY_SECONDS = 3.0
TERMINATE_TIMEOUT_SECONDS = 5.0
KILL_WAIT_SECONDS = 2.0
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


class StreamManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._registry: dict[str, StreamHandle] = {}
        self._fps_sync_pending: set[str] = set()

    def start_stream(self, config: StreamConfig) -> None:
        with self._lock:
            self._stop_unlocked(config.camera_id)

            playback_path = self._passthrough_path(config.source_rtsp)
            if playback_path and not config.local_video_path:
                handle = StreamHandle(
                    config=config,
                    passthrough=True,
                    playback_path=playback_path,
                    status=StreamStatus.RUNNING,
                )
                self._registry[config.camera_id] = handle
                logger.info(
                    "Passthrough cam %s using mediamtx path %s",
                    config.camera_id,
                    playback_path,
                )
                return

            if config.local_video_path:
                cmd = self._build_ffmpeg_cmd_from_file(config)
            else:
                cmd = self._build_ffmpeg_cmd(config)

        self._start_ffmpeg(config, cmd)
        if config.local_video_path:
            logger.info(
                "Mock file stream for cam %s from %s at %s FPS",
                config.camera_id,
                config.mock_video_name or config.local_video_path,
                config.fps,
            )

    def _start_ffmpeg(self, config: StreamConfig, cmd: list[str]) -> None:
        try:
            process = subprocess.Popen(
                cmd,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
        except FileNotFoundError as exc:
            raise StreamStartError(
                config.camera_id, "ffmpeg executable not found"
            ) from exc
        except OSError as exc:
            raise StreamStartError(config.camera_id, str(exc)) from exc

        handle = StreamHandle(
            config=config,
            process=process,
            playback_path=f"live/cam_{config.camera_id}",
        )
        watcher = threading.Thread(
            target=self._watch_stderr,
            args=(handle,),
            name=f"ffmpeg-stderr-{config.camera_id}",
            daemon=True,
        )
        handle._stderr_thread = watcher
        watcher.start()

        try:
            self._wait_alive(handle, STARTUP_VERIFY_SECONDS)
        except StreamStartError:
            self._cleanup_handle(handle)
            raise

        handle.status = StreamStatus.RUNNING
        with self._lock:
            self._registry[config.camera_id] = handle
        logger.info(
            "Started relay stream for cam %s at %s FPS",
            config.camera_id,
            config.fps,
        )

    def stop_stream(self, camera_id: str) -> None:
        with self._lock:
            self._stop_unlocked(camera_id)

    def change_fps(self, camera_id: str, fps: int) -> None:
        fps = int(fps)
        with self._lock:
            handle = self._registry.get(camera_id)
            if not handle:
                raise StreamNotFoundError(camera_id)
            if handle.passthrough:
                raise StreamStartError(
                    camera_id, "FPS change not supported for passthrough streams"
                )
            if handle.config.fps == fps:
                return
            config = StreamConfig(
                camera_id=camera_id,
                source_rtsp=handle.config.source_rtsp,
                fps=fps,
                bitrate=handle.config.bitrate,
                preset=handle.config.preset,
                local_video_path=handle.config.local_video_path,
                mock_video_name=handle.config.mock_video_name,
            )
        self.start_stream(config)

    def request_fps_sync(self, camera_id: str, configured_fps: int) -> None:
        """Restart stream when DB FPS differs from the active FFmpeg config."""
        configured_fps = int(configured_fps)
        with self._lock:
            handle = self._registry.get(camera_id)
            if not handle or handle.passthrough:
                return
            if handle.config.fps == configured_fps:
                return
            if camera_id in self._fps_sync_pending:
                return
            previous_fps = handle.config.fps
            self._fps_sync_pending.add(camera_id)

        def _sync() -> None:
            try:
                self.change_fps(camera_id, configured_fps)
                logger.info(
                    "Synced stream FPS for cam %s to %s (was %s)",
                    camera_id,
                    configured_fps,
                    previous_fps,
                )
            except StreamError as exc:
                logger.warning("FPS sync failed for cam %s: %s", camera_id, exc)
            finally:
                with self._lock:
                    self._fps_sync_pending.discard(camera_id)

        threading.Thread(target=_sync, daemon=True, name=f"fps-sync-{camera_id}").start()

    def restart_stream(self, camera_id: str) -> None:
        with self._lock:
            handle = self._registry.get(camera_id)
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
                self._stop_unlocked(camera_id)
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
            stream_fps = handle.config.fps
            return {
                "status": status.value,
                "running": status == StreamStatus.RUNNING,
                "uptime_seconds": time.time() - handle.started_at
                if status == StreamStatus.RUNNING
                else 0.0,
                "stream_fps": stream_fps,
                "fps": stream_fps,
                "last_error": handle.last_error,
                "reconnect_count": handle.reconnect_count,
                "playback_path": handle.playback_path,
                "mode": "passthrough" if handle.passthrough else "relay",
                "mock_video_name": handle.config.mock_video_name,
            }

    def list_active(self) -> list[str]:
        with self._lock:
            return list(self._registry.keys())

    @property
    def active_count(self) -> int:
        with self._lock:
            return len(self._registry)

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

    def _video_encode_args(self, config: StreamConfig) -> list[str]:
        fps = max(int(config.fps), 1)
        return [
            "-an",
            "-vf",
            f"fps={fps}",
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

    def _stop_unlocked(self, camera_id: str) -> None:
        handle = self._registry.pop(camera_id, None)
        if not handle:
            return
        handle.status = StreamStatus.STOPPING
        if not handle.passthrough:
            self._cleanup_handle(handle)
        handle.status = StreamStatus.STOPPED
        logger.info("Stopped stream for cam %s", camera_id)

    def _cleanup_handle(self, handle: StreamHandle) -> None:
        if handle.process is None:
            return
        if handle._stderr_thread and handle._stderr_thread.is_alive():
            handle._stderr_thread.join(timeout=2)
        if handle.process.stderr:
            try:
                handle.process.stderr.close()
            except Exception:
                pass
        self._terminate_process(handle.process)

    def _terminate_process(
        self, proc: subprocess.Popen, timeout: float = TERMINATE_TIMEOUT_SECONDS
    ) -> None:
        if proc.poll() is not None:
            return

        proc.terminate()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            if hasattr(os, "killpg"):
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    proc.kill()
            else:
                proc.kill()
            try:
                proc.wait(timeout=KILL_WAIT_SECONDS)
            except subprocess.TimeoutExpired:
                logger.warning("Process %s did not exit after kill", proc.pid)

    def _wait_alive(self, handle: StreamHandle, timeout: float) -> None:
        if handle.process is None:
            return
        deadline = time.time() + timeout
        while time.time() < deadline:
            if handle.process.poll() is not None:
                stderr_output = self._read_process_stderr(handle.process)
                raise StreamStartError(handle.config.camera_id, stderr_output)
            time.sleep(0.1)

    def _read_process_stderr(self, proc: subprocess.Popen) -> str:
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
                    logger.error(
                        "[cam=%s ffmpeg] %s",
                        handle.config.camera_id,
                        msg,
                    )
        except Exception:
            logger.exception(
                "stderr watcher failed for cam %s",
                handle.config.camera_id,
            )
        finally:
            if handle.status == StreamStatus.RUNNING:
                handle.status = StreamStatus.FAILED
                logger.warning(
                    "Stream %s died unexpectedly",
                    handle.config.camera_id,
                )


stream_manager = StreamManager()
