Simple FastAPI + MongoDB Camera CRUD
Docker (recommended)

1. Build and start all services (MediaMTX, mock camera, MongoDB, FastAPI app):

```bash
docker compose up --build
```

2. Open dashboard at: `http://localhost:8000` (Swagger: `http://localhost:8000/docs`)

3. Register a camera (mock video from `data/Video_BE.mp4/`):

```bash
# View list of available files
curl http://localhost:8000/api/cameras/mock-videos

# Select a specific file
curl -X POST http://localhost:8000/api/cameras \
  -H "Content-Type: application/json" \
  -d '{"name":"Office Cam","mock_video_name":"office.mp4","fps":15,"active":true}'

# Do not pass name → random (default MOCK_VIDEO_PICK=random)
curl -X POST http://localhost:8000/api/cameras \
  -H "Content-Type: application/json" \
  -d '{"name":"Random Cam","fps":15,"active":true}'

# Explicitly random / first
curl -X POST http://localhost:8000/api/cameras \
  -H "Content-Type: application/json" \
  -d '{"name":"First Cam","mock_video_pick":"first","active":true}'
```

Real RTSP camera (without using mock file):

```bash
curl -X POST http://localhost:8000/api/cameras \
  -H "Content-Type: application/json" \
  -d '{"name":"Real Cam","source_rtsp":"rtsp://192.168.1.10/stream","active":true}'
```

When testing from the host browser (not inside Docker), use `rtsp://localhost:8554/source` as `source_rtsp` instead.

Mock video files go under `data/Video_BE.mp4/` (folder, not a single file).

Pick a video when starting `mock_camera`:

```bash
# File name only (recommended)
MOCK_VIDEO_NAME=office.mp4 docker compose up -d mock_camera

# Randomize on each container start
MOCK_VIDEO_MODE=random docker compose up -d mock_camera

# Force picking the first file (alphabetical sort)
MOCK_VIDEO_MODE=first docker compose up -d mock_camera

# Full path inside the container
MOCK_VIDEO_FILE=/data/Video_BE.mp4/fire.mp4 docker compose up -d mock_camera
```

Priority: `MOCK_VIDEO_FILE` → `MOCK_VIDEO_NAME` → `MOCK_VIDEO_MODE` (default `fixed` = first file).

Notes:
- The app connects to MongoDB via `MONGODB_URI=mongodb://mongo:27017` set in `docker-compose.yml`.
- FFmpeg is installed inside the app container so `StreamManager` can spawn `ffmpeg` processes to push streams into MediaMTX.
- The web dashboard plays video via **HLS** (MediaMTX port `8888`). Hard-refresh the browser (`Ctrl+F5`) after updates.
- Cameras pointing at MediaMTX internally (e.g. `rtsp://mediamtx:8554/source`) can use **passthrough** (no per-camera FFmpeg relay) only when `ALLOW_PASSTHROUGH=1` **and** FPS/resolution match the default relay profile. Otherwise each camera gets its own FFmpeg relay for per-channel FPS/resolution.

## CPU / multi-channel tuning (Docker on Mac)

Docker Desktop on macOS runs Linux in a VM and **cannot use Apple VideoToolbox / GPU**. Every relay camera uses **software libx264** (decode + scale + encode). For grid monitoring, full HD per channel is unnecessary.

Default relay profile in `docker-compose.yml` (override via env):

| Variable | Default | Purpose |
|----------|---------|---------|
| `RELAY_WIDTH` | `640` | Output width when camera has no explicit resolution |
| `RELAY_HEIGHT` | `360` | Output height |
| `RELAY_DEFAULT_FPS` | `10` | Default FPS for new streams |
| `RELAY_BITRATE` | `256k` | H.264 baseline bitrate at `RELAY_WIDTH×RELAY_HEIGHT`; scaled up for HD/FHD |
| `RELAY_PRESET` | `ultrafast` | x264 preset |
| `RELAY_THREADS` | `1` | FFmpeg threads **per camera** (avoids 16×8 core explosion) |
| `STREAM_START_STAGGER_MS` | `300` | Delay between startup encoders |

**Suggested profiles (M1 Pro 16GB, software encode only):**

```bash
# ~16 cameras
RELAY_WIDTH=640 RELAY_HEIGHT=360 RELAY_DEFAULT_FPS=10 RELAY_BITRATE=256k docker compose up -d

# ~32 cameras (lighter)
RELAY_WIDTH=480 RELAY_HEIGHT=270 RELAY_DEFAULT_FPS=8 RELAY_BITRATE=200k RELAY_THREADS=1 docker compose up -d
```

After changing env, restart app and **re-sync cameras** (toggle active or PATCH) so FFmpeg picks up new resolution/FPS.

**Alerts (bonus):** Stream failures and ops events are persisted to MongoDB. View history on **[/logs](/logs)** (filters, pagination, auto-refresh) — no popup toasts on the dashboard.

**Simulate events (dev):** Off by default. Set `ALLOW_EVENT_SIMULATION=1` in `docker-compose.yml`, restart app, then use **Simulate event** on [/logs](/logs) (pick type + camera) or CLI:

```bash
# Single event → MongoDB
curl -X POST http://localhost:8000/api/system/simulate-event \
  -H 'Content-Type: application/json' \
  -d '{"event_type":"stream_died","camera_id":"<camera_id>"}'

# Batch (CLI only)
docker compose exec app python scripts/simulate-events.py stream_stall
```

# Unit tests
```bash
docker compose exec app pytest tests/ -v
```

**Zero-CPU tip:** If many cameras show the **same** RTSP feed at default profile (640×360 @ 10fps), set `ALLOW_PASSTHROUGH=1` in `docker-compose.yml` and register `source_rtsp: rtsp://mediamtx:8554/source` — one `mock_camera` encode, no per-channel relay. Per-camera FPS/resolution requires relay mode (default).

**Prepare lighter source files** (optional, reduces decode cost):

```bash
ffmpeg -i data/Video_BE.mp4/office.mp4 -vf scale=640:360 -c:v libx264 -preset fast -crf 28 -an data/Video_BE.mp4/office_360p.mp4
```
