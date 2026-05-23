Simple FastAPI + MongoDB Camera CRUD
Docker (recommended)

1. Build and start all services (MediaMTX, mock camera, MongoDB, FastAPI app):

```bash
docker compose up --build
```

2. Open dashboard at: `http://localhost:8000` (Swagger: `http://localhost:8000/docs`)

3. Register a camera pointing at the mock RTSP source, e.g.:

```bash
curl -X POST http://localhost:8000/api/cameras/ \
  -H "Content-Type: application/json" \
  -d '{"name":"Mock Cam","source_rtsp":"rtsp://mediamtx:8554/source","fps":15,"active":true}'
```

When testing from the host browser (not inside Docker), use `rtsp://localhost:8554/source` as `source_rtsp` instead.

Notes:
- The app connects to MongoDB via `MONGODB_URI=mongodb://mongo:27017` set in `docker-compose.yml`.
- FFmpeg is installed inside the app container so `StreamManager` can spawn `ffmpeg` processes to push streams into MediaMTX.
- The web dashboard shows a 4–32 channel grid with WebRTC playback (MediaMTX port `8889`), per-channel status/uptime, and FPS controls.
