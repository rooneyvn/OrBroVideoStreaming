Simple FastAPI + MongoDB Camera CRUD
Docker (recommended)

1. Build and start all services (MediaMTX, mock camera, MongoDB, FastAPI app):

```bash
docker compose up --build
```

2. Open dashboard at: `http://localhost:8000` (Swagger: `http://localhost:8000/docs`)

3. Register a camera (mock video from `data/Video_BE.mp4/`):

```bash
# Xem danh sách file có sẵn
curl http://localhost:8000/api/cameras/mock-videos

# Chọn file cụ thể
curl -X POST http://localhost:8000/api/cameras \
  -H "Content-Type: application/json" \
  -d '{"name":"Office Cam","mock_video_name":"office.mp4","fps":15,"active":true}'

# Không truyền tên → random (mặc định MOCK_VIDEO_PICK=random)
curl -X POST http://localhost:8000/api/cameras \
  -H "Content-Type: application/json" \
  -d '{"name":"Random Cam","fps":15,"active":true}'

# Random / first rõ ràng
curl -X POST http://localhost:8000/api/cameras \
  -H "Content-Type: application/json" \
  -d '{"name":"First Cam","mock_video_pick":"first","active":true}'
```

RTSP camera thật (không dùng mock file):

```bash
curl -X POST http://localhost:8000/api/cameras \
  -H "Content-Type: application/json" \
  -d '{"name":"Real Cam","source_rtsp":"rtsp://192.168.1.10/stream","active":true}'
```

When testing from the host browser (not inside Docker), use `rtsp://localhost:8554/source` as `source_rtsp` instead.

Mock video files go under `data/Video_BE.mp4/` (folder, not a single file).

Pick a video when starting `mock_camera`:

```bash
# Chỉ tên file (khuyến nghị)
MOCK_VIDEO_NAME=office.mp4 docker compose up -d mock_camera

# Random mỗi lần start container
MOCK_VIDEO_MODE=random docker compose up -d mock_camera

# Ép lấy file đầu tiên (sort alphabet)
MOCK_VIDEO_MODE=first docker compose up -d mock_camera

# Full path trong container
MOCK_VIDEO_FILE=/data/Video_BE.mp4/fire.mp4 docker compose up -d mock_camera
```

Priority: `MOCK_VIDEO_FILE` → `MOCK_VIDEO_NAME` → `MOCK_VIDEO_MODE` (default `fixed` = first file).

Notes:
- The app connects to MongoDB via `MONGODB_URI=mongodb://mongo:27017` set in `docker-compose.yml`.
- FFmpeg is installed inside the app container so `StreamManager` can spawn `ffmpeg` processes to push streams into MediaMTX.
- The web dashboard plays video via **HLS** (MediaMTX port `8888`). Hard-refresh the browser (`Ctrl+F5`) after updates.
- Cameras pointing at MediaMTX internally (e.g. `rtsp://mediamtx:8554/source`) use passthrough mode — no extra FFmpeg relay.
