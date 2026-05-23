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
from app.core.stream_manager import (
    StreamConfig,
    StreamStartError,
    StreamStatus,
    stream_manager,
)
from app.models.camera import CameraCreate, CameraUpdate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/cameras", tags=["cameras"])

ENCODING_FIELDS = frozenset({"fps", "width", "height"})
SOURCE_FIELDS = frozenset({"source_rtsp", "mock_video_name", "mock_video_pick"})


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

    width = doc.get("width")
    height = doc.get("height")
    return StreamConfig(
        camera_id=cam_id,
        source_rtsp=doc.get("source_rtsp", "rtsp://mediamtx:8554/source"),
        fps=int(doc.get("fps") or 15),
        width=int(width) if width else None,
        height=int(height) if height else None,
        local_video_path=local_video,
        mock_video_name=mock_name,
    )


def _configured_fps(doc: dict) -> int:
    return int(doc.get("fps") or 15)


def _configured_resolution(doc: dict) -> tuple[int | None, int | None]:
    width = doc.get("width")
    height = doc.get("height")
    return (int(width) if width else None, int(height) if height else None)


def _attach_runtime(doc: dict) -> dict:
    runtime = stream_manager.get_runtime_info(doc["_id"])
    return _enrich_runtime(doc, runtime)


def _enrich_runtime(doc: dict, runtime: dict | None) -> dict:
    configured_fps = _configured_fps(doc)
    configured_width, configured_height = _configured_resolution(doc)

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
        runtime["fps_synced"] = stream_fps is None or stream_fps == configured_fps
        runtime["resolution_synced"] = (
            stream_width == configured_width and stream_height == configured_height
        )
        runtime["encoding_synced"] = (
            runtime["fps_synced"] and runtime["resolution_synced"]
        )
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
        "encoding_synced": True,
        "last_error": None,
        "reconnect_count": 0,
        "playback_path": f"live/cam_{doc['_id']}",
        "mock_video_name": doc.get("mock_video_name"),
        "mode": None,
    }


def _camera_response(doc: dict) -> dict:
    out = _obj_to_dict(doc)
    out["runtime"] = _attach_runtime(out)
    return out


async def _apply_stream_changes(cam_id: str, doc: dict, meta_only: bool) -> None:
    if meta_only:
        return

    def _run() -> None:
        if not doc.get("active", True):
            stream_manager.stop_stream(cam_id)
            return
        config = _stream_config_from_doc(cam_id, doc)
        status = stream_manager.get_status(cam_id)
        if (
            status == StreamStatus.RUNNING
            and stream_manager.config_matches(config)
        ):
            return
        stream_manager.sync_stream(config)
        logger.info(
            "Synced stream for cam %s at %s FPS",
            cam_id,
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
    return _camera_response(created)


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
    runtime = _attach_runtime(doc_out)
    return {
        "camera_id": doc_out["_id"],
        "name": doc_out.get("name"),
        "active": doc_out.get("active", True),
        "source_rtsp": doc_out.get("source_rtsp"),
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

    return _camera_response(doc)


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
    if update_doc.get("mock_video_name") == "":
        unset_fields["mock_video_name"] = ""
        update_doc.pop("mock_video_name", None)
    if update_doc.get("width") == 0:
        unset_fields["width"] = ""
        update_doc.pop("width", None)
    if update_doc.get("height") == 0:
        unset_fields["height"] = ""
        update_doc.pop("height", None)

    if unset_fields:
        await db.cameras.update_one({"_id": oid}, {"$unset": unset_fields})
    if update_doc:
        await db.cameras.update_one({"_id": oid}, {"$set": update_doc})

    new = await db.cameras.find_one({"_id": oid})
    cam_id = str(oid)

    payload_dict = _payload_to_dict(payload)
    changed_keys = set(payload_dict.keys()) if payload_dict else set()
    meta_only = changed_keys <= {"name"}

    try:
        await _apply_stream_changes(cam_id, new, meta_only)
    except StreamStartError as exc:
        logger.error("Stream sync failed for cam %s: %s", cam_id, exc)
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

    cam_id = str(oid)
    await asyncio.to_thread(stream_manager.cancel_camera, cam_id)
    await db.cameras.delete_one({"_id": oid})
    return {"deleted": camera_id}
