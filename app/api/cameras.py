import asyncio
import logging
from datetime import datetime
from typing import List

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request

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


def _stream_config_from_doc(cam_id: str, doc: dict) -> StreamConfig:
    return StreamConfig(
        camera_id=cam_id,
        source_rtsp=doc["source_rtsp"],
        fps=doc.get("fps", 15),
    )


async def _reconcile_stream(cam_id: str, doc: dict, payload: CameraUpdate) -> None:
    if not doc.get("active"):
        await asyncio.to_thread(stream_manager.stop_stream, cam_id)
        return

    fps_only = (
        payload.fps is not None
        and payload.source_rtsp is None
        and payload.active is None
        and stream_manager.is_running(cam_id)
    )
    if fps_only:
        await asyncio.to_thread(stream_manager.change_fps, cam_id, doc["fps"])
        return

    config = _stream_config_from_doc(cam_id, doc)
    await asyncio.to_thread(stream_manager.start_stream, config)


@router.post("/", status_code=201)
async def create_camera(request: Request, payload: CameraCreate):
    db = request.app.state.db
    doc = payload.dict()
    doc["created_at"] = datetime.utcnow()
    res = await db.cameras.insert_one(doc)
    cam_id = str(res.inserted_id)

    if doc.get("active"):
        try:
            config = _stream_config_from_doc(cam_id, doc)
            await asyncio.to_thread(stream_manager.start_stream, config)
        except StreamStartError as exc:
            logger.error("Stream start failed for cam %s: %s", cam_id, exc)

    created = await db.cameras.find_one({"_id": ObjectId(cam_id)})
    return _obj_to_dict(created)


@router.get("/", response_model=List[dict])
async def list_cameras(request: Request):
    db = request.app.state.db
    docs = []
    cursor = db.cameras.find({})
    async for d in cursor:
        doc = _obj_to_dict(d)
        runtime = stream_manager.get_runtime_info(doc["_id"])
        if runtime:
            doc["runtime"] = runtime
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
    runtime = stream_manager.get_runtime_info(camera_id)
    doc_out["runtime"] = runtime or {
        "status": "STOPPED",
        "running": False,
        "uptime_seconds": 0.0,
        "fps": doc.get("fps", 15),
        "last_error": None,
        "reconnect_count": 0,
    }
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

    update_doc = {k: v for k, v in payload.dict().items() if v is not None}
    await db.cameras.update_one({"_id": oid}, {"$set": update_doc})

    new = await db.cameras.find_one({"_id": oid})
    cam_id = str(oid)
    try:
        await _reconcile_stream(cam_id, new, payload)
    except StreamStartError as exc:
        logger.error("Stream reconcile failed for cam %s: %s", cam_id, exc)
        raise HTTPException(status_code=502, detail=str(exc))

    return _obj_to_dict(new)


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
