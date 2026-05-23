# OrBro Video Streaming — System Architecture

This document describes the data flow, components, and design decisions of the multi-channel RTSP/HLS monitoring system.

## 1. Overview

```
┌─────────────┐     RTSP      ┌──────────┐     RTSP/HLS     ┌─────────────┐
│ Video Source│──────────────▶│ MediaMTX │◀───────────────│ FFmpeg relay│
│ (camera /   │               │ (hub)    │                │ (per camera)│
│  mock mp4)  │               └────┬─────┘                └──────▲──────┘
└─────────────┘                    │                               │
                                   │ HLS / WebRTC                  │ subprocess
                                   ▼                               │
                            ┌─────────────┐                 ┌──────┴──────┐
                            │  Dashboard  │◀── REST API ──│ FastAPI app │
                            │  (browser)  │               │ + monitor   │
                            └─────────────┘                 └──────┬──────┘
                                                                   │
                                                                   ▼
                                                            ┌─────────────┐
                                                            │  MongoDB    │
                                                            │  (cameras,  │
                                                            │   events)   │
                                                            └─────────────┘
```

| Component | Role |
|-----------|---------|
| **Video Source** | Real RTSP camera or `.mp4` file looped via mock FFmpeg → `rtsp://mediamtx:8554/...` |
| **MediaMTX** | RTSP relay hub, serves HLS/WebRTC to clients |
| **FFmpeg relay** | One process per camera: decode → scale → encode (libx264) → push RTSP to MediaMTX |
| **FastAPI** | Camera CRUD, FFmpeg lifecycle management, monitor, metrics, event log |
| **Dashboard** | 4/9/16/32 grid, HLS.js player, FPS/latency/uptime per channel |
| **MongoDB** | Camera configurations (`cameras`), operational events (`stream_events`) |

## 2. Video Data Flow

1. **Ingress:** Camera or mock source pushes RTSP to MediaMTX.
2. **Relay:** `StreamManager` spawns FFmpeg to read the source, transcode according to profile (width, height, fps, bitrate), and publish to path `live/cam_{id}`.
3. **Playback:** Browser loads HLS from MediaMTX (`/live/cam_{id}/index.m3u8`).
4. **Configuration:** PATCH camera → `_apply_stream_changes` → `sync_stream` (stop + delay + start with retry).

Default relay profile (optimized for CPU on Mac/Docker without GPU):

- 640×360 @ 10 fps, **256 kbps baseline** (bitrate scales with resolution), ultrafast, 1 thread/camera
- Override via env: `RELAY_WIDTH`, `RELAY_HEIGHT`, `RELAY_DEFAULT_FPS`, `RELAY_BITRATE`, `RELAY_THREADS`
- Passthrough (no relay): only when `ALLOW_PASSTHROUGH=1` and FPS/resolution = default profile

## 3. Stream Management (Backend)

### 3.1 StreamManager

- In-memory registry: `camera_id → StreamHandle` (process, status, uptime, reconnect_count).
- `start_stream` / `stop_stream` / `sync_stream` with `is_syncing` lock (45s timeout to prevent deadlocks).
- Monitor loop (`asyncio`, every 5s): reads DB, compares config vs runtime, recovers FAILED/missing, restarts on FPS/resolution drift.

### 3.2 Configuration Synchronization

- **meta_only** (only changing `name`, `grid_slot`): does not restart FFmpeg.
- Changing `fps`, `width`, `height`, `source_rtsp`, `mock_video_name`, `active`: synchronously restarts relay via API.

### 3.3 Auto-reconnect & Events

- Process dies, **STALL** (no frames encoded within `FRAME_STALL_SECONDS`), or FAILED → increments `reconnect_count`, logs to `stream_events`.
- `reconnect_count` is **persisted** on the camera document (MongoDB) and restored after app restart.
- Events `stream_recover`, `stream_failed`, `stream_error` are **debounced** (default 60s) to prevent DB spam during prolonged failures.
- Monitor calls `start_stream` or `sync_stream` depending on the state.
- Logs: `/logs` page (UI) or `GET /api/system/events` (paginated, filtered by camera/type/time/keyword).

### 3.4 Frame Stall Detection (Backend)

- FFmpeg runs with `-progress pipe:1`; a thread reading stdout updates `last_frame_at` whenever `frame=` is present.
- Monitor calls `mark_stalled_streams()` before each ensure loop → status becomes `STALL` → restarts relay.

## 4. Dashboard (Frontend)

### 4.1 Grid & Fixed Slots

- Each camera has a `grid_slot` (0–31). Newly created cameras auto-assign to empty slots.
- `camerasBySlot()` maps cameras to slots; unassigned cameras fill remaining empty slots.

### 4.2 Channel Status

| Code | Display Label |
|------|---------------|
| CONNECTED / RUNNING | Connected |
| DISCONNECTED / FAILED / STALL | Disconnected |
| RECONNECTING / STARTING | Reconnecting |
| INACTIVE | Inactive |

### 4.3 Client-side Monitoring

- **Latency:** HLS buffer end − `currentTime` (ms), updated every 2s.
- **Frame stall (client):** if HLS `currentTime` does not advance within `FRAME_STALL_SECONDS` → reloads player.

### 4.4 Backend Monitoring

- **Frame stall:** FFmpeg `-progress` → `STALL` if no frames are encoded within the threshold (default 10s, via env `FRAME_STALL_SECONDS`).
- Supplements client stall when the decoder hangs but the relay is still RUNNING.
- **Metrics topbar:** CPU, Memory, GPU (`nvidia-smi` if available), number of active streams.

## 5. Main APIs

| Endpoint | Description |
|----------|-------|
| `GET/POST /api/cameras` | List / create cameras |
| `PATCH/DELETE /api/cameras/{id}` | Update / delete |
| `GET /api/cameras/{id}/status` | Detailed runtime status |
| `GET /api/system/metrics` | CPU, RAM, GPU, streams |
| `GET /api/system/config` | HLS port, max channels, frame_stall_seconds, simulation flag |
| `GET /api/system/events` | Event logs (page, page_size, camera_id, event_type, alerts_only, from_ts, to_ts, q) |
| `GET /logs` | Event logs page (filter, paginate, manual testing) |
| `POST /api/system/client-stall` | Browser reports HLS frame stall |
| `POST /api/system/simulate-event` | Record test event (requires `ALLOW_EVENT_SIMULATION=1`) |

## 6. Operations & Scalability

### 6.1 Fault Tolerance

- Graceful shutdown of FFmpeg: `terminate()` → wait 3s → `kill()` if not exited.
- Startup stagger: `STREAM_START_STAGGER_MS` prevents CPU bursts.
- Stall detection: backend (FFmpeg progress) + client (HLS buffer).

### 6.2 Bottlenecks when Scaling

On Docker Mac (software encoding):

1. **CPU encoding** — the first bottleneck when exceeding 16–32 channels at high resolution.
2. **RAM / NIC** — when many ingress streams occur simultaneously.
3. **Subprocess overhead** — 80+ individual FFmpeg processes are unsustainable on a single node.

### 6.3 Production Scale-out Strategy

*Note - Optimal decision for the test:* At a display scale of up to 32 channels on an admin screen, choosing the **FFmpeg + MediaMTX** architecture ensures a lean and resource-optimized deployment. This architecture allows the system to run smoothly in a Local/Docker environment with just a single `docker-compose up` command, excellently meeting the low latency requirement (< 0.5s with WebRTC) and automatically downscaling resolution during transcoding.

However, when the system needs to scale to 80 channels or expand for thousands of concurrent users accessing the dashboard, Bottlenecks will appear in I/O and CPU. Therefore, the upgrade plan for Production is as follows:

- **Switching Stream Processing Tools:** Switch from FFmpeg to **GStreamer** to fully leverage Zero-copy memory architecture and optimize the decoding Pipeline using hardware.
- **Deploying an SFU (Selective Forwarding Unit) Cluster:** Replace MediaMTX with **Janus Gateway** (SFU). Configure GStreamer streams to push RTP packets directly into the Janus Streaming Plugin. This solution completely isolates the Media Server's load from WebRTC streams.
- **Media Node Model & Horizontal Scaling:** Package GStreamer and Janus into a dedicated processing server (Media Server Node). When scaling, the system will replicate these Nodes into a large Cluster. Combined with an API Gateway / Load Balancer to shard camera stream connections and Viewer devices evenly across corresponding Nodes, allowing the system to scale horizontally linearly.
- **Backend Optimization (Performance & Concurrency):** FastAPI/Python is excellent for Rapid Prototyping, but when managing the state of thousands of concurrent processes and handling heavy I/O, Python will expose weaknesses due to the Global Interpreter Lock (GIL) and consume a large amount of RAM. The solution is to **rewrite the core Process Manager in Rust** — a language that allows safe memory management (without a Garbage Collector), powerful concurrency handling, and strict system resource conservation.

## 7. Benchmark Reference

See [REPORT.MD](../REPORT.MD) for benchmark data on Mac M1 (16/32 channels, CPU/RAM/latency).

## 8. State Monitoring (vs require.md)

| Requirement | Implementation |
|---------|------------|
| Detect stream connection errors | FFmpeg stderr + process exit → `FAILED`; logs `stream_died` |
| Frame reception timeout issues | Backend: `-progress` → `STALL`; Client: HLS stall → reload + logs `client_stall` |
| Auto-reconnect | Monitor 5s → `start_stream` / `sync_stream` on FAILED/STALL/missing |
| Log reconnects & latest status | `stream_events` + `cameras.reconnect_count`, `last_stream_status`, `last_stream_error`, `last_stream_at` |
| Uptime per channel | `runtime.uptime_seconds` → **Up** badge on grid (resets on reconnect) |

Debounce repeated logs: `stream_recover`, `stream_failed`, `stream_error`, `client_stall` (default 60s).

Additional API: `POST /api/system/client-stall` — browser reports client-side frame stalls.

## 9. Bonus (Extra Points)

| Requirement | Implementation |
|---------|------------|
| Apply configuration immediately to running streams | PATCH camera / FPS / resolution → `_apply_stream_changes` → `sync_stream` (restarts FFmpeg with retry) |
| Send alerts or save incident events | MongoDB `stream_events` + `/logs` page (pagination, filtering) |

**Live config:** changing `fps`, `width`, `height`, `source_rtsp`, `mock_video_name`, `active` all restart the relay immediately; only `name` / `grid_slot` do not restart (`meta_only`).

**Alerts:**
- Storage: all operational events (`stream_died`, `config_applied`, …) in `stream_events`.
- UI: **Logs** page (`/logs`) — paginated table, filterable by camera/type/time/keyword; no popup toasts on the dashboard.
- `client_stall` is debounced (default 60s) on both client and server to prevent DB spam.
- `stream_failed` / `stream_error` are debounced for 60s when the monitor retries continuously (env `FAILURE_LOG_INTERVAL_SECONDS`).
- Manual testing: enable `ALLOW_EVENT_SIMULATION=1` → **Simulate event** button on `/logs` (select type + camera, writes to DB on submit). Does not run automatically on startup.
