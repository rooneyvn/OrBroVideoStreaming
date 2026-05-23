import asyncio
import logging
import os
from pathlib import Path

import psutil
from bson import ObjectId
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.cameras import router as cameras_router
from app.core.mongodb import close_client, init_client
from app.core.stream_manager import (
    StreamConfig,
    StreamStartError,
    StreamStatus,
    stream_manager,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="OrBro Video Streaming")
STATIC_DIR = Path(__file__).resolve().parent / "static"

camera_status: dict[str, str] = {}


async def restore_active_streams(db) -> None:
    cursor = db.cameras.find({"active": True})
    async for cam in cursor:
        cam_id = str(cam["_id"])
        config = StreamConfig(
            camera_id=cam_id,
            source_rtsp=cam["source_rtsp"],
            fps=cam.get("fps", 15),
        )
        try:
            await asyncio.to_thread(stream_manager.start_stream, config)
            camera_status[cam_id] = "CONNECTED"
        except StreamStartError as exc:
            camera_status[cam_id] = "DISCONNECTED"
            logger.error("Failed to restore cam %s: %s", cam_id, exc)


async def monitor_streams() -> None:
    """Background loop: detect dead FFmpeg processes and auto-reconnect."""
    while True:
        for cam_id in stream_manager.list_active():
            status = stream_manager.get_status(cam_id)
            if status == StreamStatus.FAILED:
                camera_status[cam_id] = "RECONNECTING"
                logger.warning(
                    "Camera %s stream died. Attempting reconnect...",
                    cam_id,
                )
                try:
                    await asyncio.to_thread(stream_manager.restart_stream, cam_id)
                    camera_status[cam_id] = "CONNECTED"
                except Exception as exc:
                    camera_status[cam_id] = "DISCONNECTED"
                    logger.error("Reconnect failed for cam %s: %s", cam_id, exc)
            elif status == StreamStatus.RUNNING:
                camera_status[cam_id] = "CONNECTED"
            else:
                camera_status[cam_id] = status.value if status else "DISCONNECTED"

        await asyncio.sleep(5)


@app.on_event("startup")
async def startup_event() -> None:
    mongo_uri = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
    client = init_client(mongo_uri)
    app.state.db = client["camstream"]
    app.include_router(cameras_router)
    if STATIC_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    await restore_active_streams(app.state.db)
    asyncio.create_task(monitor_streams())


@app.on_event("shutdown")
async def shutdown_event() -> None:
    await asyncio.to_thread(stream_manager.stop_all)
    close_client()


@app.get("/")
async def dashboard():
    index = STATIC_DIR / "index.html"
    if not index.is_file():
        return {"message": "Dashboard not found. API docs at /docs"}
    return FileResponse(index)


@app.get("/api/system/config")
def get_system_config():
    return {
        "webrtc_port": int(os.getenv("MEDIA_SERVER_WEBRTC_PORT", "8889")),
        "max_channels": int(os.getenv("MAX_CHANNELS", "32")),
    }


@app.get("/api/system/metrics")
def get_system_metrics():
    return {
        "cpu_percent": psutil.cpu_percent(interval=0.1),
        "memory_percent": psutil.virtual_memory().percent,
        "active_streams": stream_manager.active_count,
    }


@app.get("/api/system/camera-status")
def get_camera_status():
    return camera_status
