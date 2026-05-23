from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator


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
    fps: int = Field(15, ge=1, le=60)
    width: Optional[int] = None
    height: Optional[int] = None
    active: bool = True

    @field_validator("width")
    @classmethod
    def validate_width(cls, value: Optional[int]) -> Optional[int]:
        if value is None:
            return None
        value = int(value)
        if value < 160 or value > 3840:
            raise ValueError("width must be between 160 and 3840")
        return value

    @field_validator("height")
    @classmethod
    def validate_height(cls, value: Optional[int]) -> Optional[int]:
        if value is None:
            return None
        value = int(value)
        if value < 120 or value > 2160:
            raise ValueError("height must be between 120 and 2160")
        return value


class CameraCreate(CameraBase):
    pass


class CameraUpdate(BaseModel):
    name: Optional[str] = None
    source_rtsp: Optional[str] = None
    mock_video_name: Optional[str] = None
    mock_video_pick: Optional[Literal["random", "first"]] = None
    fps: Optional[int] = Field(None, ge=1, le=60)
    width: Optional[int] = None
    height: Optional[int] = None
    active: Optional[bool] = None

    @field_validator("width")
    @classmethod
    def validate_update_width(cls, value: Optional[int]) -> Optional[int]:
        if value is None:
            return None
        value = int(value)
        if value == 0:
            return 0
        if value < 160 or value > 3840:
            raise ValueError("width must be between 160 and 3840")
        return value

    @field_validator("height")
    @classmethod
    def validate_update_height(cls, value: Optional[int]) -> Optional[int]:
        if value is None:
            return None
        value = int(value)
        if value == 0:
            return 0
        if value < 120 or value > 2160:
            raise ValueError("height must be between 120 and 2160")
        return value


class CameraOut(CameraBase):
    id: str = Field(..., alias="_id")
    created_at: datetime

    class Config:
        populate_by_name = True
