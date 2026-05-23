"""Unit tests for stream event logging."""

import pytest
from unittest.mock import AsyncMock, MagicMock

from app.core.event_simulator import ALERT_SCENARIOS, SIMULATION_SCENARIOS
from app.core.stream_events import ALERT_EVENT_TYPES, log_stream_event


@pytest.mark.asyncio
async def test_log_stream_event_persists_to_db():
    db = MagicMock()
    db.stream_events.insert_one = AsyncMock()

    await log_stream_event(
        db,
        "config_applied",
        "Live config applied",
        camera_id="cam-test-001",
        fields=["fps"],
    )

    db.stream_events.insert_one.assert_awaited_once()
    doc = db.stream_events.insert_one.await_args.args[0]
    assert doc["type"] == "config_applied"
    assert doc["camera_id"] == "cam-test-001"
    assert doc["message"] == "Live config applied"
    assert doc["extra"]["fields"] == ["fps"]


@pytest.mark.asyncio
async def test_alert_event_persists_to_db():
    db = MagicMock()
    db.stream_events.insert_one = AsyncMock()

    await log_stream_event(
        db,
        "stream_died",
        "ffmpeg exited",
        camera_id="cam-alert-001",
        simulated=True,
    )

    db.stream_events.insert_one.assert_awaited_once()
    doc = db.stream_events.insert_one.await_args.args[0]
    assert doc["type"] == "stream_died"
    assert doc["extra"]["simulated"] is True


def test_alert_event_types_match_simulator():
    assert ALERT_SCENARIOS <= set(SIMULATION_SCENARIOS.keys())
    assert ALERT_SCENARIOS == ALERT_EVENT_TYPES


@pytest.mark.parametrize("event_type", sorted(ALERT_SCENARIOS))
def test_all_alert_scenarios_have_messages(event_type):
    assert event_type in SIMULATION_SCENARIOS
    assert SIMULATION_SCENARIOS[event_type]
