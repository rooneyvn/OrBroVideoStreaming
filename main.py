import asyncio
import logging
import os
from pathlib import Path

import psutil
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.cameras import _stream_config_from_doc, router as cameras_router
from app.core.mongodb import close_client, init_client
from app.core.stream_manager import (
    StreamStartError,
    StreamStatus,
    stream_manager,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="OrBro Video Streaming", redirect_slashes=False)
STATIC_DIR = Path(__file__).resolve().parent / "static"

camera_status: dict[str, str] = {}


async def restore_active_streams(db) -> None:
    cursor = db.cameras.find({"active": True})
    async for cam in cursor:
        cam_id = str(cam["_id"])
        doc = dict(cam)
        try:
            config = _stream_config_from_doc(cam_id, doc)
            await asyncio.to_thread(stream_manager.start_stream, config)
            camera_status[cam_id] = "CONNECTED"
        except StreamStartError as exc:
            camera_status[cam_id] = "DISCONNECTED"
            logger.error("Failed to restore cam %s: %s", cam_id, exc)


async def _ensure_camera_stream(cam_id: str, doc: dict) -> None:
    desired = _stream_config_from_doc(cam_id, doc)
    status = stream_manager.get_status(cam_id)

    if stream_manager.is_syncing(cam_id):
        if status in (StreamStatus.RUNNING, StreamStatus.STARTING):
            if status == StreamStatus.STARTING:
                camera_status[cam_id] = "RECONNECTING"
            return
        logger.info(
            "Sync in progress for cam %s without live handle, waiting",
            cam_id,
        )
        return

    if status == StreamStatus.RUNNING and stream_manager.config_matches(desired):
        camera_status[cam_id] = "CONNECTED"
        return
    if status == StreamStatus.STARTING and stream_manager.config_matches(desired):
        camera_status[cam_id] = "RECONNECTING"
        return

    camera_status[cam_id] = "RECONNECTING"
    if status == StreamStatus.RUNNING:
        runtime = stream_manager.get_runtime_info(cam_id) or {}
        logger.warning(
            "Config drift for cam %s: stream_fps=%s db_fps=%s, syncing",
            cam_id,
            runtime.get("fps"),
            desired.fps,
        )
        await asyncio.to_thread(stream_manager.sync_stream, desired)
    elif status is None:
        logger.info(
            "Starting missing stream for cam %s at %s FPS", cam_id, desired.fps
        )
        await asyncio.to_thread(stream_manager.start_stream, desired)
    else:
        logger.warning(
            "Recovering stream for cam %s (status=%s, db_fps=%s)",
            cam_id,
            status.value if status else "NONE",
            desired.fps,
        )
        await asyncio.to_thread(stream_manager.start_stream, desired)

    camera_status[cam_id] = "CONNECTED"


async def monitor_streams(db) -> None:
    """Keep every active DB camera in sync with the stream registry."""

    async def _ensure_one(cam_id: str, doc: dict) -> None:
        try:
            await _ensure_camera_stream(cam_id, doc)
        except StreamStartError as exc:
            camera_status[cam_id] = "DISCONNECTED"
            logger.error("Stream ensure failed for cam %s: %s", cam_id, exc)
        except Exception as exc:
            camera_status[cam_id] = "DISCONNECTED"
            logger.error("Unexpected ensure error for cam %s: %s", cam_id, exc)

    while True:
        active_docs: list[tuple[str, dict]] = []
        async for cam in db.cameras.find({"active": True}):
            active_docs.append((str(cam["_id"]), dict(cam)))

        active_ids = {cam_id for cam_id, _ in active_docs}

        if active_docs:
            await asyncio.gather(
                *(_ensure_one(cam_id, doc) for cam_id, doc in active_docs)
            )

        for cam_id in stream_manager.list_active():
            if cam_id not in active_ids:
                logger.info("Removing orphan stream for cam %s", cam_id)
                await asyncio.to_thread(stream_manager.cancel_camera, cam_id)
                camera_status.pop(cam_id, None)

        await asyncio.to_thread(
            stream_manager.log_stream_health,
            len(active_docs),
            list(active_ids),
            {
                cam_id: int(doc.get("fps") or 15)
                for cam_id, doc in active_docs
            },
        )
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
    asyncio.create_task(monitor_streams(app.state.db))


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
        "hls_port": int(os.getenv("MEDIA_SERVER_HLS_PORT", "8888")),
        "webrtc_port": int(os.getenv("MEDIA_SERVER_WEBRTC_PORT", "8889")),
        "max_channels": int(os.getenv("MAX_CHANNELS", "32")),
        "playback": os.getenv("DASHBOARD_PLAYBACK", "hls"),
    }


@app.get("/api/system/metrics")
async def get_system_metrics(request: Request):
    db = request.app.state.db
    stats = stream_manager.stream_stats()
    db_active = await db.cameras.count_documents({"active": True})
    return {
        "cpu_percent": psutil.cpu_percent(interval=0.1),
        "memory_percent": psutil.virtual_memory().percent,
        "active_streams": stats["active_streams"],
        "registered_streams": stats["registered_streams"],
        "starting_streams": stats["starting_streams"],
        "failed_streams": stats["failed_streams"],
        "db_active_cameras": db_active,
        "streams": stats["streams"],
    }


@app.get("/api/system/camera-status")
def get_camera_status():
    return camera_status
