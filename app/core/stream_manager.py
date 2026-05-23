import logging
import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

logger = logging.getLogger(__name__)

STARTUP_VERIFY_SECONDS = 3.0
TERMINATE_TIMEOUT_SECONDS = 5.0
KILL_WAIT_SECONDS = 2.0


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


@dataclass
class StreamHandle:
    config: StreamConfig
    process: subprocess.Popen
    status: StreamStatus = StreamStatus.STARTING
    started_at: float = field(default_factory=time.time)
    last_error: Optional[str] = None
    reconnect_count: int = 0
    _stderr_thread: Optional[threading.Thread] = field(default=None, repr=False)


class StreamManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._registry: dict[str, StreamHandle] = {}

    def start_stream(self, config: StreamConfig) -> None:
        with self._lock:
            self._stop_unlocked(config.camera_id)

            cmd = self._build_ffmpeg_cmd(config)
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

            handle = StreamHandle(config=config, process=process)
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
            self._registry[config.camera_id] = handle
            logger.info(
                "Started stream for cam %s at %s FPS",
                config.camera_id,
                config.fps,
            )

    def stop_stream(self, camera_id: str) -> None:
        with self._lock:
            self._stop_unlocked(camera_id)

    def change_fps(self, camera_id: str, fps: int) -> None:
        with self._lock:
            handle = self._registry.get(camera_id)
            if not handle:
                raise StreamNotFoundError(camera_id)
            if handle.config.fps == fps:
                return
            config = StreamConfig(
                camera_id=camera_id,
                source_rtsp=handle.config.source_rtsp,
                fps=fps,
                bitrate=handle.config.bitrate,
                preset=handle.config.preset,
            )
        self.start_stream(config)

    def restart_stream(self, camera_id: str) -> None:
        with self._lock:
            handle = self._registry.get(camera_id)
            if not handle:
                raise StreamNotFoundError(camera_id)
            config = handle.config
            handle.reconnect_count += 1
        logger.info(
            "Restarting stream for cam %s (attempt %s)",
            camera_id,
            handle.reconnect_count,
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
            return (
                handle.status == StreamStatus.RUNNING
                and handle.process.poll() is None
            )

    def get_status(self, camera_id: str) -> Optional[StreamStatus]:
        with self._lock:
            handle = self._registry.get(camera_id)
            if not handle:
                return None
            if (
                handle.status == StreamStatus.RUNNING
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
            if status == StreamStatus.RUNNING and handle.process.poll() is not None:
                status = StreamStatus.FAILED
            return {
                "status": status.value,
                "running": status == StreamStatus.RUNNING,
                "uptime_seconds": time.time() - handle.started_at
                if status == StreamStatus.RUNNING
                else 0.0,
                "fps": handle.config.fps,
                "last_error": handle.last_error,
                "reconnect_count": handle.reconnect_count,
            }

    def list_active(self) -> list[str]:
        with self._lock:
            return list(self._registry.keys())

    @property
    def active_count(self) -> int:
        with self._lock:
            return len(self._registry)

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
            "-c:v",
            "libx264",
            "-preset",
            config.preset,
            "-tune",
            "zerolatency",
            "-r",
            str(config.fps),
            "-b:v",
            config.bitrate,
            "-f",
            "rtsp",
            output_rtsp,
        ]

    def _stop_unlocked(self, camera_id: str) -> None:
        handle = self._registry.pop(camera_id, None)
        if not handle:
            return
        handle.status = StreamStatus.STOPPING
        self._cleanup_handle(handle)
        handle.status = StreamStatus.STOPPED
        logger.info("Stopped stream for cam %s", camera_id)

    def _cleanup_handle(self, handle: StreamHandle) -> None:
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
        if not proc.stderr:
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
