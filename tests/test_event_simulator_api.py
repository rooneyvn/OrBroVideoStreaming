"""Tests for simulate-event API (when enabled)."""

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture
def client():
    mock_mongo = MagicMock()
    mock_db = MagicMock()
    mock_mongo.__getitem__.return_value = mock_db
    mock_db.stream_events.create_index = AsyncMock()

    with patch("main.init_client", return_value=mock_mongo):
        with patch("main.close_client"):
            with patch("main.restore_active_streams", new=AsyncMock()):
                with patch("main.monitor_streams", new=AsyncMock()):
                    with TestClient(main.app) as test_client:
                        yield test_client


def test_simulate_event_forbidden_by_default(client):
    with patch.dict(os.environ, {"ALLOW_EVENT_SIMULATION": ""}, clear=False):
        res = client.post(
            "/api/system/simulate-event",
            json={"event_type": "stream_died"},
        )
    assert res.status_code == 403


def test_simulate_event_success(client):
    mock_db = MagicMock()
    mock_db.stream_events = MagicMock()

    with patch.dict(os.environ, {"ALLOW_EVENT_SIMULATION": "1"}, clear=False):
        with patch.object(main, "log_stream_event", new=AsyncMock()) as mock_log:
            main.app.state.db = mock_db
            res = client.post(
                "/api/system/simulate-event",
                json={
                    "event_type": "stream_stall",
                    "camera_id": "sim-cam-01",
                    "message": "custom stall message",
                },
            )

    assert res.status_code == 200
    data = res.json()
    assert data["simulated"] is True
    assert data["event_type"] == "stream_stall"
    assert data["camera_id"] == "sim-cam-01"
    mock_log.assert_awaited_once()


def test_simulate_event_unknown_type(client):
    with patch.dict(os.environ, {"ALLOW_EVENT_SIMULATION": "1"}, clear=False):
        res = client.post(
            "/api/system/simulate-event",
            json={"event_type": "not_a_real_event"},
        )
    assert res.status_code == 400


def test_simulate_all_events(client):
    with patch.dict(os.environ, {"ALLOW_EVENT_SIMULATION": "1"}, clear=False):
        with patch.object(main, "log_stream_event", new=AsyncMock()):
            res = client.post(
                "/api/system/simulate-event/all",
                json={"camera_id": "sim-batch"},
            )

    assert res.status_code == 200
    body = res.json()
    assert body["count"] == len(main.SIMULATABLE_EVENT_TYPES)
    assert len(body["events"]) == body["count"]
