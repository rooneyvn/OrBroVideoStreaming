"""Predefined stream event scenarios for testing alerts."""

from typing import Any, Optional

# event_type -> default message (same wording as production events)
SIMULATION_SCENARIOS: dict[str, str] = {
    "stream_died": "ffmpeg process exited",
    "stream_failed": "Stream ensure failed: connection refused",
    "stream_stall": "No encoded frames within stall threshold",
    "client_stall": "Client HLS stalled > 10s",
    "stream_error": "Unexpected monitor error",
    "stream_start_failed": "Failed to start stream on restore",
    "stream_recover": "Recovering from FAILED",
    "stream_recovered": "Stream running after recovery",
    "stream_reconnect": "Reconnect count increased",
    "config_applied": "Live config applied: fps, width, height",
    "stream_missing": "Starting missing stream",
    "stream_stall_recover": "Restarting relay after frame stall",
}

ALERT_SCENARIOS = frozenset(
    {
        "stream_died",
        "stream_failed",
        "stream_stall",
        "client_stall",
        "stream_error",
        "stream_start_failed",
    }
)


def scenario_message(event_type: str, message: Optional[str] = None) -> str:
    if message:
        return message
    if event_type not in SIMULATION_SCENARIOS:
        raise ValueError(
            f"Unknown event type: {event_type}. "
            f"Choose from: {', '.join(sorted(SIMULATION_SCENARIOS))}"
        )
    return SIMULATION_SCENARIOS[event_type]


def build_simulation_extra(event_type: str, **overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"simulated": True, "source": "event_simulator"}
    if event_type == "config_applied":
        base.update({"fields": ["fps", "width", "height"], "fps": 15, "width": 1280, "height": 720})
    elif event_type in ("stream_recovered", "stream_reconnect"):
        base["reconnect_count"] = 1
    base.update(overrides)
    return base
