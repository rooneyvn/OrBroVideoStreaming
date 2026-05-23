from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


class CameraBase(BaseModel):
    name: str
    source_rtsp: str = "rtsp://mediamtx:8554/source"
    mock_video_name: Optional[str] = Field(
        None,
        description="Tên file .mp4 trong data/Video_BE.mp4/ (vd: office.mp4)",
    )
    mock_video_pick: Optional[Literal["random", "first"]] = Field(
        None,
        description="Khi không có mock_video_name: random hoặc first (mặc định env MOCK_VIDEO_PICK)",
    )
    fps: int = 15
    active: bool = True


class CameraCreate(CameraBase):
    pass


class CameraUpdate(BaseModel):
    name: Optional[str] = None
    source_rtsp: Optional[str] = None
    mock_video_name: Optional[str] = None
    mock_video_pick: Optional[Literal["random", "first"]] = None
    fps: Optional[int] = None
    active: Optional[bool] = None


class CameraOut(CameraBase):
    id: str = Field(..., alias="_id")
    created_at: datetime

    class Config:
        populate_by_name = True
