#!/usr/bin/env python3
"""CLI: inject test stream events via OrBro API (manual only, not auto-run)."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

try:
    from app.core.event_simulator import SIMULATION_SCENARIOS
except ImportError:
    SIMULATION_SCENARIOS = {
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


def post_json(url: str, payload: dict) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {exc.code}: {body}") from exc


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Inject one test event (requires ALLOW_EVENT_SIMULATION=1 on server)"
    )
    parser.add_argument(
        "--base-url",
        default="http://localhost:8000",
        help="API base URL (default: http://localhost:8000)",
    )
    parser.add_argument(
        "--camera-id",
        default="sim-test-camera",
        help="Camera id attached to the event",
    )
    parser.add_argument(
        "--message",
        default=None,
        help="Override default message",
    )
    parser.add_argument(
        "--alerts-only",
        action="store_true",
        help="With 'all', fire only alert event types",
    )
    parser.add_argument(
        "types",
        nargs="*",
        help=f"Event type or 'all'. Available: {', '.join(sorted(SIMULATION_SCENARIOS))}",
    )
    args = parser.parse_args()

    base = args.base_url.rstrip("/")

    if not args.types or args.types == ["all"]:
        result = post_json(
            f"{base}/api/system/simulate-event/all",
            {
                "camera_id": args.camera_id,
                "alerts_only": args.alerts_only,
            },
        )
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return

    for event_type in args.types:
        if event_type not in SIMULATION_SCENARIOS:
            print(
                f"Unknown type: {event_type}. Choose: {', '.join(sorted(SIMULATION_SCENARIOS))}",
                file=sys.stderr,
            )
            sys.exit(1)

        payload = {"event_type": event_type, "camera_id": args.camera_id}
        if args.message:
            payload["message"] = args.message
        result = post_json(f"{base}/api/system/simulate-event", payload)
        print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
