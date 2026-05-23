from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.core.relay_profile import get_relay_profile


def _default_fps() -> int:
    return get_relay_profile().default_fps


def _default_width() -> int:
    return get_relay_profile().default_width


def _default_height() -> int:
    return get_relay_profile().default_height


class CameraBase(BaseModel):
    name: str
    source_rtsp: str = "rtsp://mediamtx:8554/source"
    mock_video_name: Optional[str] = Field(
        None,
        description="Tên file .mp4 trong data/Video_BE.mp4/ (vd: office.mp4)",
    )
    mock_video_pick: Optional[Literal["random", "first"]] = Field(
        None,
        description="Khi không có mock_video_name: random hoặc first",
    )
    fps: int = Field(default_factory=_default_fps, ge=1, le=60)
    width: int = Field(default_factory=_default_width, ge=160, le=3840)
    height: int = Field(default_factory=_default_height, ge=120, le=2160)
    grid_slot: Optional[int] = Field(
        None,
        ge=0,
        le=31,
        description="Vị trí ô lưới (0-based). Null = tự gán.",
    )
    active: bool = True


class CameraCreate(CameraBase):
    pass


class CameraUpdate(BaseModel):
    name: Optional[str] = None
    source_rtsp: Optional[str] = None
    mock_video_name: Optional[str] = None
    mock_video_pick: Optional[Literal["random", "first"]] = None
    fps: Optional[int] = Field(None, ge=1, le=60)
    width: Optional[int] = Field(None, ge=160, le=3840)
    height: Optional[int] = Field(None, ge=120, le=2160)
    grid_slot: Optional[int] = Field(None, ge=0, le=31)
    active: Optional[bool] = None


class CameraFpsUpdate(BaseModel):
    fps: int = Field(..., ge=1, le=60)


class CameraResolutionUpdate(BaseModel):
    width: int = Field(..., ge=160, le=3840)
    height: int = Field(..., ge=120, le=2160)


class CameraOut(CameraBase):
    id: str = Field(..., alias="_id")
    created_at: datetime

    class Config:
        populate_by_name = True
