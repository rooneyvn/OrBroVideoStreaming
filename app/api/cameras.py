import asyncio
import logging
import os
from datetime import datetime
from typing import List, Optional

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query, Request

from app.core.mock_video import (
    MockVideoError,
    is_mock_source,
    list_mock_video_names,
    resolve_mock_video,
)
from app.core.relay_profile import get_relay_profile
from app.core.stream_manager import (
    StreamConfig,
    StreamStartError,
    StreamStatus,
    stream_manager,
)
from app.models.camera import (
    CameraCreate,
    CameraFpsUpdate,
    CameraResolutionUpdate,
    CameraUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/cameras", tags=["cameras"])

ENCODING_FIELDS = frozenset({"fps", "width", "height"})
SOURCE_FIELDS = frozenset({"source_rtsp", "mock_video_name", "mock_video_pick"})
MAX_GRID_SLOTS = 32
MAX_CAMERAS = int(os.getenv("MAX_CHANNELS", "32"))


def _display_status(doc: dict, runtime: dict | None) -> str:
    if not doc.get("active", True):
        return "INACTIVE"
    if not runtime:
        return "DISCONNECTED"
    raw = runtime.get("status") or "STOPPED"
    if raw in ("RUNNING", "CONNECTED"):
        return "CONNECTED"
    if raw in ("STARTING", "RECONNECTING"):
        return "RECONNECTING"
    if raw in ("FAILED", "STALL"):
        return "DISCONNECTED"
    if raw == "STOPPED":
        return "DISCONNECTED"
    return raw


async def _used_grid_slots(db) -> set[int]:
    used: set[int] = set()
    async for doc in db.cameras.find({"grid_slot": {"$ne": None}}, {"grid_slot": 1}):
        slot = doc.get("grid_slot")
        if slot is not None:
            used.add(int(slot))
    return used


async def _next_free_grid_slot(db) -> int | None:
    used = await _used_grid_slots(db)
    for slot in range(MAX_GRID_SLOTS):
        if slot not in used:
            return slot
    return None


async def _grid_slot_taken(db, slot: int, exclude_id: str | None = None) -> bool:
    query: dict = {"grid_slot": slot}
    if exclude_id:
        query["_id"] = {"$ne": ObjectId(exclude_id)}
    existing = await db.cameras.find_one(query)
    return existing is not None


def _obj_to_dict(doc):
    if not doc:
        return None
    doc = dict(doc)
    _id = doc.pop("_id")
    doc["_id"] = str(_id)
    return doc


def _payload_to_dict(payload, *, for_update: bool = False) -> dict:
    if hasattr(payload, "model_dump"):
        if for_update:
            return payload.model_dump(exclude_unset=True)
        return payload.model_dump(exclude_none=True)
    data = payload.dict(exclude_unset=for_update)
    if for_update:
        return data
    return {k: v for k, v in data.items() if v is not None}


def _sort_cameras(docs: list[dict]) -> list[dict]:
    def sort_key(doc: dict) -> tuple:
        slot = doc.get("grid_slot")
        slot_key = int(slot) if slot is not None else 9999
        return (slot_key, str(doc.get("name") or "").lower(), str(doc.get("_id")))

    return sorted(docs, key=sort_key)


def _uses_mock_video(doc: dict) -> bool:
    return bool(
        doc.get("mock_video_name")
        or doc.get("mock_video_pick")
        or is_mock_source(doc.get("source_rtsp"))
    )


def _apply_mock_video(doc: dict) -> None:
    if not _uses_mock_video(doc):
        return
    path = resolve_mock_video(
        name=doc.get("mock_video_name"),
        pick=doc.get("mock_video_pick"),
    )
    doc["mock_video_name"] = path.name


def _stream_config_from_doc(cam_id: str, doc: dict) -> StreamConfig:
    local_video = None
    mock_name = doc.get("mock_video_name")

    if _uses_mock_video(doc):
        try:
            path = resolve_mock_video(
                name=mock_name,
                pick=doc.get("mock_video_pick"),
            )
            local_video = str(path)
            mock_name = path.name
        except MockVideoError as exc:
            raise StreamStartError(cam_id, str(exc)) from exc

    width = doc.get("width")
    height = doc.get("height")
    profile = get_relay_profile()
    w = int(width) if width else profile.default_width
    h = int(height) if height else profile.default_height
    return StreamConfig(
        camera_id=cam_id,
        source_rtsp=doc.get("source_rtsp", "rtsp://mediamtx:8554/source"),
        fps=int(doc.get("fps") or profile.default_fps),
        width=w,
        height=h,
        bitrate=profile.effective_bitrate(w, h),
        initial_reconnect_count=int(doc.get("reconnect_count") or 0),
        preset=profile.preset,
        local_video_path=local_video,
        mock_video_name=mock_name,
    )


def _configured_fps(doc: dict) -> int:
    return int(doc.get("fps") or get_relay_profile().default_fps)


def _configured_resolution(doc: dict) -> tuple[int, int]:
    profile = get_relay_profile()
    width = doc.get("width")
    height = doc.get("height")
    return (
        int(width) if width else profile.default_width,
        int(height) if height else profile.default_height,
    )


def _ensure_doc_resolution(doc: dict) -> dict:
    profile = get_relay_profile()
    if not doc.get("width"):
        doc["width"] = profile.default_width
    if not doc.get("height"):
        doc["height"] = profile.default_height
    return doc


async def _backfill_resolution(db, doc: dict) -> dict:
    profile = get_relay_profile()
    updates: dict = {}
    if not doc.get("width"):
        updates["width"] = profile.default_width
    if not doc.get("height"):
        updates["height"] = profile.default_height
    if updates:
        oid = doc["_id"]
        if isinstance(oid, str):
            oid = ObjectId(oid)
        await db.cameras.update_one({"_id": oid}, {"$set": updates})
        doc.update(updates)
    return doc


def _attach_runtime(doc: dict) -> dict:
    runtime = stream_manager.get_runtime_info(doc["_id"])
    return _enrich_runtime(doc, runtime)


def _enrich_runtime(doc: dict, runtime: dict | None) -> dict:
    configured_fps = _configured_fps(doc)
    configured_width, configured_height = _configured_resolution(doc)
    cam_id = doc["_id"]

    if stream_manager.is_syncing(cam_id):
        return {
            "status": "STARTING",
            "running": False,
            "sync_in_progress": True,
            "uptime_seconds": 0.0,
            "configured_fps": configured_fps,
            "configured_width": configured_width,
            "configured_height": configured_height,
            "stream_fps": None,
            "stream_width": None,
            "stream_height": None,
            "fps": configured_fps,
            "width": configured_width,
            "height": configured_height,
            "fps_synced": False,
            "resolution_synced": False,
            "mock_synced": False,
            "encoding_synced": False,
            "last_error": None,
            "reconnect_count": int(doc.get("reconnect_count") or 0),
            "playback_path": f"live/cam_{cam_id}",
            "mock_video_name": doc.get("mock_video_name"),
            "mode": "relay",
        }

    if runtime:
        stream_fps = runtime.get("stream_fps", runtime.get("fps"))
        stream_width = runtime.get("stream_width", runtime.get("width"))
        stream_height = runtime.get("stream_height", runtime.get("height"))
        runtime = {
            **runtime,
            "configured_fps": configured_fps,
            "configured_width": configured_width,
            "configured_height": configured_height,
            "stream_fps": stream_fps,
            "stream_width": stream_width,
            "stream_height": stream_height,
            "fps": configured_fps,
            "width": configured_width,
            "height": configured_height,
        }
        runtime["fps_synced"] = stream_fps is None or int(stream_fps) == int(configured_fps)
        runtime["resolution_synced"] = (
            stream_width is not None
            and stream_height is not None
            and int(stream_width) == int(configured_width)
            and int(stream_height) == int(configured_height)
        )
        runtime["mock_synced"] = (
            (runtime.get("mock_video_name") or "")
            == (doc.get("mock_video_name") or "")
        )
        runtime["encoding_synced"] = (
            runtime["fps_synced"]
            and runtime["resolution_synced"]
            and runtime["mock_synced"]
        )
        persisted_rc = int(doc.get("reconnect_count") or 0)
        mem_rc = int(runtime.get("reconnect_count") or 0)
        runtime["reconnect_count"] = max(mem_rc, persisted_rc)
        return runtime

    return {
        "status": "STOPPED",
        "running": False,
        "uptime_seconds": 0.0,
        "configured_fps": configured_fps,
        "configured_width": configured_width,
        "configured_height": configured_height,
        "stream_fps": None,
        "stream_width": None,
        "stream_height": None,
        "fps": configured_fps,
        "width": configured_width,
        "height": configured_height,
        "fps_synced": True,
        "resolution_synced": True,
        "mock_synced": True,
        "encoding_synced": True,
        "last_error": None,
        "reconnect_count": int(doc.get("reconnect_count") or 0),
        "playback_path": f"live/cam_{doc['_id']}",
        "mock_video_name": doc.get("mock_video_name"),
        "mode": None,
    }


def _camera_response(doc: dict) -> dict:
    out = _obj_to_dict(doc)
    runtime = _attach_runtime(out)
    out["runtime"] = runtime
    out["display_status"] = _display_status(out, runtime)
    return out


async def _apply_stream_changes(cam_id: str, doc: dict, meta_only: bool) -> None:
    if meta_only:
        return

    def _run() -> None:
        if not doc.get("active", True):
            stream_manager.stop_stream(cam_id)
            return
        if stream_manager.is_syncing(cam_id):
            logger.info("Skip stream apply for cam %s (sync in progress)", cam_id)
            return
        config = _stream_config_from_doc(cam_id, doc)
        status = stream_manager.get_status(cam_id)
        if status in (StreamStatus.STARTING, StreamStatus.STOPPING):
            logger.info(
                "Skip stream apply for cam %s (status=%s)", cam_id, status.value
            )
            return
        if (
            status == StreamStatus.RUNNING
            and stream_manager.config_matches(config)
        ):
            return
        stream_manager.sync_stream(config)
        logger.info(
            "Synced stream for cam %s at %sx%s @ %s FPS",
            cam_id,
            config.width,
            config.height,
            config.fps,
        )

    await asyncio.to_thread(_run)


@router.get("/mock-videos")
async def list_mock_videos():
    names = list_mock_video_names()
    return {"videos": names, "count": len(names)}


@router.post("", status_code=201)
@router.post("/", status_code=201, include_in_schema=False)
async def create_camera(request: Request, payload: CameraCreate):
    db = request.app.state.db
    count = await db.cameras.count_documents({})
    if count >= MAX_CAMERAS:
        raise HTTPException(
            status_code=400,
            detail=f"Đã đạt giới hạn {MAX_CAMERAS} camera",
        )

    doc = _payload_to_dict(payload)
    doc = _ensure_doc_resolution(doc)
    doc["created_at"] = datetime.utcnow()

    try:
        _apply_mock_video(doc)
    except MockVideoError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if doc.get("grid_slot") is not None:
        slot = int(doc["grid_slot"])
        if await _grid_slot_taken(db, slot):
            raise HTTPException(
                status_code=400,
                detail=f"Grid slot {slot} is already assigned",
            )
    else:
        free = await _next_free_grid_slot(db)
        if free is not None:
            doc["grid_slot"] = free

    res = await db.cameras.insert_one(doc)
    cam_id = str(res.inserted_id)

    if doc.get("active"):
        try:
            config = _stream_config_from_doc(cam_id, doc)
            await asyncio.to_thread(stream_manager.start_stream, config)
        except StreamStartError as exc:
            logger.error("Stream start failed for cam %s: %s", cam_id, exc)
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    created = await db.cameras.find_one({"_id": ObjectId(cam_id)})
    return _camera_response(created)


@router.get("", response_model=List[dict])
@router.get("/", response_model=List[dict], include_in_schema=False)
async def list_cameras(
    request: Request,
    active: Optional[bool] = Query(None, description="Lọc theo trạng thái bật/tắt"),
):
    db = request.app.state.db
    query = {"active": active} if active is not None else {}
    docs = []
    cursor = db.cameras.find(query)
    async for d in cursor:
        doc = _obj_to_dict(d)
        doc = await _backfill_resolution(db, doc)
        runtime = _attach_runtime(doc)
        doc["runtime"] = runtime
        doc["display_status"] = _display_status(doc, runtime)
        docs.append(doc)
    return _sort_cameras(docs)


@router.get("/{camera_id}/status")
async def get_camera_status(request: Request, camera_id: str):
    db = request.app.state.db
    try:
        doc = await db.cameras.find_one({"_id": ObjectId(camera_id)})
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid camera id")
    if not doc:
        raise HTTPException(status_code=404, detail="Camera not found")

    doc_out = _obj_to_dict(doc)
    doc_out = await _backfill_resolution(db, doc_out)
    runtime = _attach_runtime(doc_out)
    return {
        "camera_id": doc_out["_id"],
        "name": doc_out.get("name"),
        "active": doc_out.get("active", True),
        "source_rtsp": doc_out.get("source_rtsp"),
        "grid_slot": doc_out.get("grid_slot"),
        "display_status": _display_status(doc_out, runtime),
        "configured": {
            "fps": _configured_fps(doc_out),
            "width": _configured_resolution(doc_out)[0],
            "height": _configured_resolution(doc_out)[1],
            "mock_video_name": doc_out.get("mock_video_name"),
            "source_rtsp": doc_out.get("source_rtsp"),
        },
        "runtime": runtime,
    }


@router.get("/{camera_id}")
async def get_camera(request: Request, camera_id: str):
    db = request.app.state.db
    try:
        doc = await db.cameras.find_one({"_id": ObjectId(camera_id)})
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid camera id")
    if not doc:
        raise HTTPException(status_code=404, detail="Camera not found")

    doc_out = _obj_to_dict(doc)
    doc_out = await _backfill_resolution(db, doc_out)
    return _camera_response(doc_out)


@router.patch("/{camera_id}")
async def update_camera(request: Request, camera_id: str, payload: CameraUpdate):
    db = request.app.state.db
    try:
        oid = ObjectId(camera_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid camera id")

    cur = await db.cameras.find_one({"_id": oid})
    if not cur:
        raise HTTPException(status_code=404, detail="Camera not found")

    update_doc = _payload_to_dict(payload, for_update=True)
    merged = {**cur, **update_doc}

    if _uses_mock_video(merged) and (
        update_doc.get("mock_video_name") not in (None, "")
        or update_doc.get("mock_video_pick") is not None
        or update_doc.get("source_rtsp") is not None
    ):
        try:
            _apply_mock_video(merged)
            update_doc["mock_video_name"] = merged["mock_video_name"]
        except MockVideoError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    unset_fields = {}
    profile = get_relay_profile()
    if update_doc.get("mock_video_name") == "":
        unset_fields["mock_video_name"] = ""
        update_doc.pop("mock_video_name", None)
    if update_doc.get("width") == 0:
        update_doc["width"] = profile.default_width
    if update_doc.get("height") == 0:
        update_doc["height"] = profile.default_height
    if "grid_slot" in update_doc and update_doc.get("grid_slot") is None:
        unset_fields["grid_slot"] = ""
        update_doc.pop("grid_slot", None)

    if update_doc.get("grid_slot") is not None:
        slot = int(update_doc["grid_slot"])
        if await _grid_slot_taken(db, slot, exclude_id=camera_id):
            raise HTTPException(
                status_code=400,
                detail=f"Grid slot {slot} is already assigned",
            )

    if unset_fields:
        await db.cameras.update_one({"_id": oid}, {"$unset": unset_fields})
    if update_doc:
        await db.cameras.update_one({"_id": oid}, {"$set": update_doc})

    new = await db.cameras.find_one({"_id": oid})
    cam_id = str(oid)

    payload_dict = _payload_to_dict(payload, for_update=True)
    changed_keys = set(payload_dict.keys()) if payload_dict else set()
    meta_only = changed_keys <= {"name", "grid_slot"}

    try:
        await _apply_stream_changes(cam_id, new, meta_only)
    except StreamStartError as exc:
        logger.error("Stream sync failed for cam %s: %s", cam_id, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return _camera_response(new)


@router.patch("/{camera_id}/fps")
async def update_camera_fps(
    request: Request, camera_id: str, payload: CameraFpsUpdate
):
    """Đổi FPS cho một camera (dùng từ ô grid hoặc API)."""
    return await update_camera(
        request,
        camera_id,
        CameraUpdate(fps=payload.fps),
    )


@router.patch("/{camera_id}/resolution")
async def update_camera_resolution(
    request: Request, camera_id: str, payload: CameraResolutionUpdate
):
    """Đổi độ phân giải relay (width×height) cho một camera."""
    return await update_camera(
        request,
        camera_id,
        CameraUpdate(width=payload.width, height=payload.height),
    )


@router.delete("/{camera_id}")
async def delete_camera(request: Request, camera_id: str):
    db = request.app.state.db
    try:
        oid = ObjectId(camera_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid camera id")

    doc = await db.cameras.find_one({"_id": oid})
    if not doc:
        raise HTTPException(status_code=404, detail="Camera not found")

    cam_id = str(oid)
    await asyncio.to_thread(stream_manager.cancel_camera, cam_id)
    await db.cameras.delete_one({"_id": oid})

    status_map = getattr(request.app.state, "camera_status", None)
    if isinstance(status_map, dict):
        status_map.pop(cam_id, None)

    return {"deleted": camera_id}
