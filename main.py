import asyncio
import logging
import os
import time
from datetime import datetime
from pathlib import Path

import psutil
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.api.cameras import _stream_config_from_doc, router as cameras_router
from app.core.mongodb import close_client, init_client
from app.core.relay_profile import get_relay_profile
from app.core.event_simulator import (
    SIMULATION_SCENARIOS,
    build_simulation_extra,
    scenario_message,
)
from app.core.stream_events import ALERT_EVENT_TYPES, log_stream_event
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
_client_stall_at: dict[str, float] = {}
_failure_event_at: dict[str, float] = {}
RECOVER_LOG_INTERVAL = float(os.getenv("RECOVER_LOG_INTERVAL_SECONDS", "60"))
CLIENT_STALL_LOG_INTERVAL = float(os.getenv("CLIENT_STALL_LOG_INTERVAL_SECONDS", "60"))
FAILURE_LOG_INTERVAL = float(os.getenv("FAILURE_LOG_INTERVAL_SECONDS", "60"))


class ClientStallReport(BaseModel):
    camera_id: str
    message: str | None = None


class SimulateEventRequest(BaseModel):
    event_type: str
    camera_id: str = "sim-test-camera"
    message: str | None = None


class SimulateAllRequest(BaseModel):
    camera_id: str = "sim-test-camera"
    alerts_only: bool = False


SIMULATABLE_EVENT_TYPES = frozenset(SIMULATION_SCENARIOS.keys())


def _simulation_enabled() -> bool:
    return os.getenv("ALLOW_EVENT_SIMULATION", "").lower() in ("1", "true", "yes")


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


async def _log_failure_event(
    db, cam_id: str, event_type: str, message: str
) -> None:
    """Debounce stream_failed/stream_error while monitor keeps retrying."""
    now = time.time()
    key = f"{cam_id}:{event_type}"
    last = _failure_event_at.get(key, 0.0)
    if now - last < FAILURE_LOG_INTERVAL:
        return
    _failure_event_at[key] = now
    await log_stream_event(db, event_type, message, camera_id=cam_id)


def _clear_failure_debounce(cam_id: str) -> None:
    for event_type in ("stream_failed", "stream_error"):
        _failure_event_at.pop(f"{cam_id}:{event_type}", None)


async def _persist_stream_health(
    db,
    cam_id: str,
    *,
    status: str | None = None,
    last_error: str | None = None,
    reconnect_count: int | None = None,
) -> None:
    from bson import ObjectId

    try:
        oid = ObjectId(cam_id)
    except Exception:
        return

    updates: dict = {"last_stream_at": datetime.utcnow()}
    if status is not None:
        updates["last_stream_status"] = status
    if last_error is not None:
        updates["last_stream_error"] = str(last_error)[:2000]
    if reconnect_count is not None:
        updates["reconnect_count"] = int(reconnect_count)
    await db.cameras.update_one({"_id": oid}, {"$set": updates})


async def _persist_reconnect_count(db, cam_id: str, count: int) -> None:
    await _persist_stream_health(db, cam_id, reconnect_count=count)


async def _flush_pending_events(db) -> None:
    for event in await asyncio.to_thread(stream_manager.drain_pending_events):
        cam_id = event.get("camera_id")
        await log_stream_event(
            db,
            event["type"],
            event["message"],
            camera_id=cam_id,
        )
        if cam_id:
            await _persist_stream_health(
                db,
                cam_id,
                status=event.get("status", "FAILED"),
                last_error=event.get("message"),
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
            await _persist_stream_health(
                db, cam_id, status="DISCONNECTED", last_error=str(exc)
            )
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
        await _persist_stream_health(db, cam_id, status="RECONNECTING")
        return

    status = stream_manager.get_status(cam_id)
    prev_failed = status == StreamStatus.FAILED
    prev_stalled = status == StreamStatus.STALL

    if status == StreamStatus.RUNNING and stream_manager.config_matches(desired):
        camera_status[cam_id] = "CONNECTED"
        runtime = stream_manager.get_runtime_info(cam_id) or {}
        rc = runtime.get("reconnect_count")
        await _persist_stream_health(
            db,
            cam_id,
            status="CONNECTED",
            reconnect_count=int(rc) if rc is not None else None,
        )
        return

    if status in (StreamStatus.STARTING, StreamStatus.STOPPING):
        camera_status[cam_id] = "RECONNECTING"
        await _persist_stream_health(db, cam_id, status="RECONNECTING")
        return

    camera_status[cam_id] = "RECONNECTING"
    await _persist_stream_health(db, cam_id, status="RECONNECTING")
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
                "stream_stall_recover",
                "Restarting relay after frame stall",
                camera_id=cam_id,
            )
        await _log_recover_event(db, cam_id, status, desired.fps)
        await asyncio.to_thread(stream_manager.start_stream, desired)

    if prev_failed or prev_stalled or status in (StreamStatus.FAILED, None):
        runtime = stream_manager.get_runtime_info(cam_id) or {}
        if runtime.get("running"):
            _recover_event_at.pop(cam_id, None)
            _clear_failure_debounce(cam_id)
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
    rt_status = runtime.get("status")
    if runtime.get("running"):
        camera_status[cam_id] = "CONNECTED"
        mem_rc = int(runtime.get("reconnect_count") or 0)
        await _persist_stream_health(
            db, cam_id, status="CONNECTED", reconnect_count=mem_rc
        )
        doc_rc = int(doc.get("reconnect_count") or 0)
        if mem_rc > doc_rc:
            await log_stream_event(
                db,
                "stream_reconnect",
                f"Reconnect count increased to {mem_rc}",
                camera_id=cam_id,
                reconnect_count=mem_rc,
            )
    elif rt_status in ("STARTING", "STOPPING") or stream_manager.is_syncing(cam_id):
        camera_status[cam_id] = "RECONNECTING"
        await _persist_stream_health(db, cam_id, status="RECONNECTING")
    else:
        camera_status[cam_id] = "DISCONNECTED"
        await _persist_stream_health(
            db,
            cam_id,
            status="DISCONNECTED",
            last_error=runtime.get("last_error"),
            reconnect_count=int(runtime.get("reconnect_count") or 0),
        )


async def monitor_streams(db) -> None:
    """Keep every active DB camera in sync with the stream registry."""

    async def _ensure_one(cam_id: str, doc: dict) -> None:
        try:
            await _ensure_camera_stream(db, cam_id, doc)
        except StreamStartError as exc:
            camera_status[cam_id] = "DISCONNECTED"
            logger.error("Stream ensure failed for cam %s: %s", cam_id, exc)
            await _persist_stream_health(
                db, cam_id, status="DISCONNECTED", last_error=str(exc)
            )
            await _log_failure_event(db, cam_id, "stream_failed", str(exc))
        except Exception as exc:
            camera_status[cam_id] = "DISCONNECTED"
            logger.error("Unexpected ensure error for cam %s: %s", cam_id, exc)
            await _log_failure_event(db, cam_id, "stream_error", str(exc))

    profile = get_relay_profile()

    while True:
        active_docs: list[tuple[str, dict]] = []
        async for cam in db.cameras.find({"active": True}):
            active_docs.append((str(cam["_id"]), dict(cam)))

        active_ids = {cam_id for cam_id, _ in active_docs}

        await _prune_camera_status(db)
        await _flush_pending_events(db)
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


@app.get("/logs")
async def logs_page():
    logs = STATIC_DIR / "logs.html"
    if not logs.is_file():
        return {"message": "Logs page not found"}
    return FileResponse(logs)


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
        "event_simulation_enabled": _simulation_enabled(),
    }


@app.post("/api/system/client-stall")
async def report_client_stall(request: Request, payload: ClientStallReport):
    """Browser reports HLS decoder stall (no advancing frames)."""
    db = request.app.state.db
    message = payload.message or "Client HLS playback stalled (no frames)"
    now = time.time()
    last = _client_stall_at.get(payload.camera_id, 0.0)
    should_log = now - last >= CLIENT_STALL_LOG_INTERVAL
    if should_log:
        _client_stall_at[payload.camera_id] = now
        await log_stream_event(
            db,
            "client_stall",
            message,
            camera_id=payload.camera_id,
        )
    await _persist_stream_health(
        db,
        payload.camera_id,
        status="STALL",
        last_error=message,
    )
    return {"logged": should_log}


@app.post("/api/system/simulate-event")
async def simulate_stream_event(request: Request, payload: SimulateEventRequest):
    """Inject a test stream event (dev only). Set ALLOW_EVENT_SIMULATION=1."""
    if not _simulation_enabled():
        raise HTTPException(
            status_code=403,
            detail="Event simulation disabled. Set ALLOW_EVENT_SIMULATION=1",
        )
    if payload.event_type not in SIMULATABLE_EVENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown event_type. Valid: {sorted(SIMULATABLE_EVENT_TYPES)}",
        )

    db = request.app.state.db
    message = scenario_message(payload.event_type, payload.message)
    extra = build_simulation_extra(payload.event_type)
    await log_stream_event(
        db,
        payload.event_type,
        message,
        camera_id=payload.camera_id,
        **extra,
    )
    return {
        "simulated": True,
        "event_type": payload.event_type,
        "camera_id": payload.camera_id,
        "message": message,
    }


@app.post("/api/system/simulate-event/all")
async def simulate_all_stream_events(request: Request, payload: SimulateAllRequest):
    """Fire every (or alert-only) simulated event type in sequence."""
    if not _simulation_enabled():
        raise HTTPException(
            status_code=403,
            detail="Event simulation disabled. Set ALLOW_EVENT_SIMULATION=1",
        )

    from app.core.event_simulator import ALERT_SCENARIOS

    db = request.app.state.db
    types = sorted(
        ALERT_SCENARIOS if payload.alerts_only else SIMULATABLE_EVENT_TYPES
    )
    fired = []
    for event_type in types:
        message = scenario_message(event_type)
        extra = build_simulation_extra(event_type)
        await log_stream_event(
            db,
            event_type,
            message,
            camera_id=payload.camera_id,
            **extra,
        )
        fired.append({"event_type": event_type, "message": message})

    return {"simulated": True, "count": len(fired), "events": fired}


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


@app.get("/api/system/event-types")
async def list_event_types():
    from app.core.event_simulator import SIMULATION_SCENARIOS

    known = sorted(set(SIMULATION_SCENARIOS.keys()) | set(ALERT_EVENT_TYPES))
    return {
        "types": known,
        "alert_types": sorted(ALERT_EVENT_TYPES),
        "simulation_enabled": _simulation_enabled(),
        "simulation_types": sorted(SIMULATION_SCENARIOS.keys()),
    }


def _parse_iso_datetime(value: str) -> datetime:
    raw = value.strip().replace("Z", "+00:00")
    if len(raw) == 10:
        return datetime.fromisoformat(f"{raw}T00:00:00")
    return datetime.fromisoformat(raw)


@app.get("/api/system/events")
async def list_stream_events(
    request: Request,
    camera_id: str | None = None,
    event_type: str | None = None,
    types: str | None = Query(None, description="Comma-separated event types"),
    q: str | None = Query(None, description="Search in message"),
    alerts_only: bool = False,
    from_ts: str | None = Query(None, description="ISO date/datetime (inclusive)"),
    to_ts: str | None = Query(None, description="ISO date/datetime (inclusive)"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    limit: int | None = Query(None, ge=1, le=200, deprecated=True),
):
    db = request.app.state.db
    query: dict = {}

    if camera_id:
        query["camera_id"] = camera_id
    if event_type:
        query["type"] = event_type
    elif types:
        type_list = [t.strip() for t in types.split(",") if t.strip()]
        if type_list:
            query["type"] = {"$in": type_list}
    elif alerts_only:
        query["type"] = {"$in": list(ALERT_EVENT_TYPES)}
    if q:
        query["message"] = {"$regex": q, "$options": "i"}

    created_range: dict = {}
    if from_ts:
        try:
            created_range["$gte"] = _parse_iso_datetime(from_ts)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid from_ts")
    if to_ts:
        try:
            dt = _parse_iso_datetime(to_ts)
            if len(to_ts.strip()) == 10:
                dt = dt.replace(hour=23, minute=59, second=59)
            created_range["$lte"] = dt
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid to_ts")
    if created_range:
        query["created_at"] = created_range

    effective_page_size = limit if limit is not None else page_size
    effective_page = 1 if limit is not None else page
    skip = (effective_page - 1) * effective_page_size

    total = await db.stream_events.count_documents(query)
    cursor = (
        db.stream_events.find(query)
        .sort("created_at", -1)
        .skip(skip)
        .limit(effective_page_size)
    )
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

    total_pages = max(1, (total + effective_page_size - 1) // effective_page_size)
    return {
        "events": events,
        "page": effective_page,
        "page_size": effective_page_size,
        "total": total,
        "total_pages": total_pages,
        "count": len(events),
    }


@app.get("/api/system/camera-status")
async def get_camera_status(request: Request):
    await _prune_camera_status(request.app.state.db)
    return dict(camera_status)
