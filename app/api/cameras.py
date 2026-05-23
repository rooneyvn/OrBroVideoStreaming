import asyncio
import logging
from datetime import datetime
from typing import List

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request

from app.core.mock_video import (
    MockVideoError,
    is_mock_source,
    list_mock_video_names,
    resolve_mock_video,
)
from app.core.stream_manager import StreamConfig, StreamStartError, stream_manager
from app.models.camera import CameraCreate, CameraUpdate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/cameras", tags=["cameras"])


def _obj_to_dict(doc):
    if not doc:
        return None
    doc = dict(doc)
    _id = doc.pop("_id")
    doc["_id"] = str(_id)
    return doc


def _payload_to_dict(payload) -> dict:
    if hasattr(payload, "model_dump"):
        return payload.model_dump(exclude_none=True)
    return {k: v for k, v in payload.dict().items() if v is not None}


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

    return StreamConfig(
        camera_id=cam_id,
        source_rtsp=doc.get("source_rtsp", "rtsp://mediamtx:8554/source"),
        fps=doc.get("fps", 15),
        local_video_path=local_video,
        mock_video_name=mock_name,
    )


def _configured_fps(doc: dict) -> int:
    return int(doc.get("fps") or 15)


def _attach_runtime(doc: dict) -> dict:
    configured = _configured_fps(doc)
    if doc.get("active"):
        stream_manager.request_fps_sync(doc["_id"], configured)
    runtime = stream_manager.get_runtime_info(doc["_id"])
    return _enrich_runtime(doc, runtime)


def _enrich_runtime(doc: dict, runtime: dict | None) -> dict:
    configured = _configured_fps(doc)
    if runtime:
        stream_fps = runtime.get("stream_fps", runtime.get("fps"))
        runtime = {**runtime, "configured_fps": configured, "stream_fps": stream_fps}
        runtime["fps_synced"] = stream_fps is None or stream_fps == configured
        runtime["fps"] = configured
        return runtime
    return {
        "status": "STOPPED",
        "running": False,
        "uptime_seconds": 0.0,
        "configured_fps": configured,
        "stream_fps": None,
        "fps": configured,
        "fps_synced": True,
        "last_error": None,
        "reconnect_count": 0,
        "playback_path": f"live/cam_{doc['_id']}",
        "mock_video_name": doc.get("mock_video_name"),
    }


def _camera_response(doc: dict) -> dict:
    out = _obj_to_dict(doc)
    out["runtime"] = _attach_runtime(out)
    return out


async def _reconcile_stream(cam_id: str, doc: dict, payload: CameraUpdate) -> None:
    if not doc.get("active"):
        await asyncio.to_thread(stream_manager.stop_stream, cam_id)
        return

    payload_dict = _payload_to_dict(payload)
    mock_changed = (
        payload_dict.get("mock_video_name") is not None
        or payload_dict.get("mock_video_pick") is not None
        or payload_dict.get("source_rtsp") is not None
    )

    fps_only = (
        payload.fps is not None
        and not mock_changed
        and payload.active is None
    )
    if fps_only:
        runtime = stream_manager.get_runtime_info(cam_id)
        if runtime and runtime.get("mode") != "passthrough":
            await asyncio.to_thread(stream_manager.change_fps, cam_id, doc["fps"])
            return

    config = _stream_config_from_doc(cam_id, doc)
    await asyncio.to_thread(stream_manager.start_stream, config)


@router.get("/mock-videos")
async def list_mock_videos():
    names = list_mock_video_names()
    return {"videos": names, "count": len(names)}


@router.post("", status_code=201)
@router.post("/", status_code=201, include_in_schema=False)
async def create_camera(request: Request, payload: CameraCreate):
    db = request.app.state.db
    doc = _payload_to_dict(payload)
    doc["created_at"] = datetime.utcnow()

    try:
        _apply_mock_video(doc)
    except MockVideoError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

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
    return _obj_to_dict(created)


@router.get("", response_model=List[dict])
@router.get("/", response_model=List[dict], include_in_schema=False)
async def list_cameras(request: Request):
    db = request.app.state.db
    docs = []
    cursor = db.cameras.find({})
    async for d in cursor:
        doc = _obj_to_dict(d)
        doc["runtime"] = _attach_runtime(doc)
        docs.append(doc)
    return docs


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
    doc_out["runtime"] = _attach_runtime(doc_out)
    return doc_out


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

    update_doc = _payload_to_dict(payload)
    merged = {**cur, **update_doc}

    if _uses_mock_video(merged) and (
        update_doc.get("mock_video_name") is not None
        or update_doc.get("mock_video_pick") is not None
        or update_doc.get("source_rtsp") is not None
    ):
        try:
            _apply_mock_video(merged)
            update_doc["mock_video_name"] = merged["mock_video_name"]
        except MockVideoError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    await db.cameras.update_one({"_id": oid}, {"$set": update_doc})

    new = await db.cameras.find_one({"_id": oid})
    cam_id = str(oid)
    try:
        await _reconcile_stream(cam_id, new, payload)
    except StreamStartError as exc:
        logger.error("Stream reconcile failed for cam %s: %s", cam_id, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return _camera_response(new)


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

    await db.cameras.delete_one({"_id": oid})
    await asyncio.to_thread(stream_manager.stop_stream, str(oid))
    return {"deleted": camera_id}
