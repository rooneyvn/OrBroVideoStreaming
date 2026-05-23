from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


class CameraBase(BaseModel):
    name: str
    source_rtsp: str
    fps: int = 15
    active: bool = True


class CameraCreate(CameraBase):
    pass


class CameraUpdate(BaseModel):
    name: Optional[str]
    source_rtsp: Optional[str]
    fps: Optional[int]
    active: Optional[bool]


class CameraOut(CameraBase):
    id: str = Field(..., alias="_id")
    created_at: datetime

    class Config:
        allow_population_by_field_name = True
