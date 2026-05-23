"""Persist stream lifecycle events for ops / reporting."""

from datetime import datetime
from typing import Any, Optional


async def log_stream_event(
    db,
    event_type: str,
    message: str,
    *,
    camera_id: Optional[str] = None,
    **extra: Any,
) -> None:
    await db.stream_events.insert_one(
        {
            "camera_id": camera_id,
            "type": event_type,
            "message": message,
            "extra": extra,
            "created_at": datetime.utcnow(),
        }
    )
