import asyncio
import logging
import os
import time
from datetime import datetime
from pathlib import Path

import psutil
from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.cameras import _stream_config_from_doc, router as cameras_router
from app.core.mongodb import close_client, init_client
from app.core.relay_profile import get_relay_profile
from app.core.stream_events import log_stream_event
from app.core.stream_manager import (
    StreamStartError,
    StreamStatus,
    stream_manager,
)
from app.core.system_metrics import read_gpu_utilization

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="OrBro Video Streaming", redirect_slashes=False)
STATIC_DIR = Path(__file__).resolve().parent / "static"

camera_status: dict[str, str] = {}
_recover_event_at: dict[str, float] = {}
RECOVER_LOG_INTERVAL = float(os.getenv("RECOVER_LOG_INTERVAL_SECONDS", "60"))


async def _log_recover_event(db, cam_id: str, status, desired_fps: int) -> None:
    """Debounce stream_recover events to avoid spam while FAILED persists."""
    now = time.time()
    last = _recover_event_at.get(cam_id, 0.0)
    if now - last < RECOVER_LOG_INTERVAL:
        return
    _recover_event_at[cam_id] = now
    await log_stream_event(
        db,
        "stream_recover",
        f"Recovering from {status.value if status else 'NONE'}",
        camera_id=cam_id,
        fps=desired_fps,
    )


async def _persist_reconnect_count(db, cam_id: str, count: int) -> None:
    from bson import ObjectId

    try:
        oid = ObjectId(cam_id)
    except Exception:
        return
    await db.cameras.update_one(
        {"_id": oid},
        {"$set": {"reconnect_count": int(count)}},
    )


async def _prune_camera_status(db) -> None:
    """Remove stale entries when cameras were deleted from MongoDB."""
    db_ids: set[str] = set()
    async for doc in db.cameras.find({}, {"_id": 1}):
        db_ids.add(str(doc["_id"]))

    for cam_id in list(camera_status.keys()):
        if cam_id not in db_ids:
            camera_status.pop(cam_id, None)
            if cam_id in stream_manager.list_active():
                logger.info(
                    "Removing orphan stream for deleted cam %s", cam_id
                )
                await asyncio.to_thread(stream_manager.cancel_camera, cam_id)


async def restore_active_streams(db) -> None:
    stagger_ms = float(os.getenv("STREAM_START_STAGGER_MS", "250"))
    idx = 0
    async for cam in db.cameras.find({"active": True}):
        if idx > 0 and stagger_ms > 0:
            await asyncio.sleep(stagger_ms / 1000.0)
        idx += 1
        cam_id = str(cam["_id"])
        doc = dict(cam)
        try:
            config = _stream_config_from_doc(cam_id, doc)
            await asyncio.to_thread(stream_manager.start_stream, config)
            camera_status[cam_id] = "CONNECTED"
        except StreamStartError as exc:
            camera_status[cam_id] = "DISCONNECTED"
            logger.error("Failed to restore cam %s: %s", cam_id, exc)
            await log_stream_event(
                db,
                "stream_start_failed",
                str(exc),
                camera_id=cam_id,
                phase="restore",
            )


async def _ensure_camera_stream(db, cam_id: str, doc: dict) -> None:
    desired = _stream_config_from_doc(cam_id, doc)

    if stream_manager.is_syncing(cam_id):
        camera_status[cam_id] = "RECONNECTING"
        return

    status = stream_manager.get_status(cam_id)
    prev_failed = status == StreamStatus.FAILED
    prev_stalled = status == StreamStatus.STALL

    if status == StreamStatus.RUNNING and stream_manager.config_matches(desired):
        camera_status[cam_id] = "CONNECTED"
        runtime = stream_manager.get_runtime_info(cam_id) or {}
        if runtime.get("reconnect_count") is not None:
            await _persist_reconnect_count(db, cam_id, runtime["reconnect_count"])
        return

    if status in (StreamStatus.STARTING, StreamStatus.STOPPING):
        camera_status[cam_id] = "RECONNECTING"
        return

    camera_status[cam_id] = "RECONNECTING"
    if status == StreamStatus.RUNNING:
        runtime = stream_manager.get_runtime_info(cam_id) or {}
        logger.warning(
            "Config drift for cam %s: stream=%sx%s@%sfps db=%sx%s@%sfps, syncing",
            cam_id,
            runtime.get("stream_width"),
            runtime.get("stream_height"),
            runtime.get("stream_fps"),
            desired.width,
            desired.height,
            desired.fps,
        )
        await asyncio.to_thread(stream_manager.sync_stream, desired)
    elif status is None:
        logger.info(
            "Starting missing stream for cam %s at %s FPS", cam_id, desired.fps
        )
        await log_stream_event(
            db,
            "stream_missing",
            "Starting missing stream",
            camera_id=cam_id,
            fps=desired.fps,
        )
        await asyncio.to_thread(stream_manager.start_stream, desired)
    else:
        logger.warning(
            "Recovering stream for cam %s (status=%s, db_fps=%s)",
            cam_id,
            status.value if status else "NONE",
            desired.fps,
        )
        if prev_stalled:
            await log_stream_event(
                db,
                "stream_stall",
                "No encoded frames within stall threshold; restarting relay",
                camera_id=cam_id,
            )
        await _log_recover_event(db, cam_id, status, desired.fps)
        await asyncio.to_thread(stream_manager.start_stream, desired)

    if prev_failed or prev_stalled or status in (StreamStatus.FAILED, None):
        runtime = stream_manager.get_runtime_info(cam_id) or {}
        if runtime.get("running"):
            _recover_event_at.pop(cam_id, None)
            count = runtime.get("reconnect_count", 0)
            await _persist_reconnect_count(db, cam_id, count)
            await log_stream_event(
                db,
                "stream_recovered",
                "Stream running after recovery",
                camera_id=cam_id,
                reconnect_count=count,
            )

    runtime = stream_manager.get_runtime_info(cam_id) or {}
    if runtime.get("running"):
        camera_status[cam_id] = "CONNECTED"
        doc_rc = int(doc.get("reconnect_count") or 0)
        mem_rc = int(runtime.get("reconnect_count") or 0)
        if mem_rc > doc_rc:
            await _persist_reconnect_count(db, cam_id, mem_rc)
            await log_stream_event(
                db,
                "stream_reconnect",
                f"Reconnect count increased to {mem_rc}",
                camera_id=cam_id,
                reconnect_count=mem_rc,
            )
    else:
        camera_status[cam_id] = "DISCONNECTED"


async def monitor_streams(db) -> None:
    """Keep every active DB camera in sync with the stream registry."""

    async def _ensure_one(cam_id: str, doc: dict) -> None:
        try:
            await _ensure_camera_stream(db, cam_id, doc)
        except StreamStartError as exc:
            camera_status[cam_id] = "DISCONNECTED"
            logger.error("Stream ensure failed for cam %s: %s", cam_id, exc)
            await log_stream_event(
                db,
                "stream_failed",
                str(exc),
                camera_id=cam_id,
            )
        except Exception as exc:
            camera_status[cam_id] = "DISCONNECTED"
            logger.error("Unexpected ensure error for cam %s: %s", cam_id, exc)
            await log_stream_event(
                db,
                "stream_error",
                str(exc),
                camera_id=cam_id,
            )

    profile = get_relay_profile()

    while True:
        active_docs: list[tuple[str, dict]] = []
        async for cam in db.cameras.find({"active": True}):
            active_docs.append((str(cam["_id"]), dict(cam)))

        active_ids = {cam_id for cam_id, _ in active_docs}

        await _prune_camera_status(db)
        stall_threshold = float(os.getenv("FRAME_STALL_SECONDS", "10"))
        await asyncio.to_thread(stream_manager.mark_stalled_streams, stall_threshold)

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
                cam_id: int(doc.get("fps") or profile.default_fps)
                for cam_id, doc in active_docs
            },
            {
                cam_id: (
                    int(doc.get("width") or profile.default_width),
                    int(doc.get("height") or profile.default_height),
                )
                for cam_id, doc in active_docs
            },
        )
        await asyncio.sleep(5)


@app.on_event("startup")
async def startup_event() -> None:
    mongo_uri = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
    client = init_client(mongo_uri)
    app.state.db = client["camstream"]
    app.state.camera_status = camera_status
    await app.state.db.stream_events.create_index([("created_at", -1)])
    await app.state.db.stream_events.create_index([("camera_id", 1), ("created_at", -1)])
    app.include_router(cameras_router)
    if STATIC_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    camera_status.clear()
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
        "default_fps": get_relay_profile().default_fps,
        "default_resolution": {
            "width": get_relay_profile().default_width,
            "height": get_relay_profile().default_height,
        },
        "playback": os.getenv("DASHBOARD_PLAYBACK", "hls"),
        "frame_stall_seconds": int(os.getenv("FRAME_STALL_SECONDS", "10")),
    }


@app.get("/api/system/metrics")
async def get_system_metrics(request: Request):
    db = request.app.state.db
    stats = stream_manager.stream_stats()
    db_active = await db.cameras.count_documents({"active": True})
    gpu = read_gpu_utilization()
    return {
        "cpu_percent": psutil.cpu_percent(interval=0.1),
        "memory_percent": psutil.virtual_memory().percent,
        "gpu_percent": gpu,
        "gpu_available": gpu is not None,
        "active_streams": stats["active_streams"],
        "registered_streams": stats["registered_streams"],
        "starting_streams": stats["starting_streams"],
        "failed_streams": stats["failed_streams"],
        "db_active_cameras": db_active,
        "streams": stats["streams"],
    }


@app.get("/api/system/events")
async def list_stream_events(
    request: Request,
    camera_id: str | None = None,
    limit: int = Query(50, ge=1, le=200),
):
    db = request.app.state.db
    query = {"camera_id": camera_id} if camera_id else {}
    cursor = db.stream_events.find(query).sort("created_at", -1).limit(limit)
    events = []
    async for doc in cursor:
        events.append(
            {
                "id": str(doc["_id"]),
                "camera_id": doc.get("camera_id"),
                "type": doc.get("type"),
                "message": doc.get("message"),
                "extra": doc.get("extra") or {},
                "created_at": doc.get("created_at"),
            }
        )
    return {"events": events, "count": len(events)}


@app.get("/api/system/camera-status")
async def get_camera_status(request: Request):
    await _prune_camera_status(request.app.state.db)
    return dict(camera_status)
