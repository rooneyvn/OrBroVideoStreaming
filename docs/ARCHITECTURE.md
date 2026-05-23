# OrBro Video Streaming — Kiến trúc hệ thống

Tài liệu mô tả luồng dữ liệu, thành phần và quyết định thiết kế của hệ thống giám sát đa kênh RTSP/HLS.

## 1. Tổng quan

```
┌─────────────┐     RTSP      ┌──────────┐     RTSP/HLS     ┌─────────────┐
│ Nguồn video │──────────────▶│ MediaMTX │◀───────────────│ FFmpeg relay│
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

| Thành phần | Vai trò |
|-----------|---------|
| **Nguồn phát** | Camera RTSP thật hoặc file `.mp4` lặp qua FFmpeg mock → `rtsp://mediamtx:8554/...` |
| **MediaMTX** | Hub trung chuyển RTSP, phát HLS/WebRTC cho client |
| **FFmpeg relay** | Một process/camera: decode → scale → encode (libx264) → push RTSP vào MediaMTX |
| **FastAPI** | CRUD camera, quản lý vòng đời FFmpeg, monitor, metrics, event log |
| **Dashboard** | Grid 4/9/16/32 ô, HLS.js player, FPS/latency/uptime theo kênh |
| **MongoDB** | Cấu hình camera (`cameras`), sự kiện vận hành (`stream_events`) |

## 2. Luồng dữ liệu video

1. **Ingress:** Camera hoặc mock source đẩy RTSP vào MediaMTX.
2. **Relay:** `StreamManager` spawn FFmpeg đọc nguồn, transcode theo profile (width, height, fps, bitrate), publish path `live/cam_{id}`.
3. **Playback:** Browser tải HLS từ MediaMTX (`/live/cam_{id}/index.m3u8`).
4. **Cấu hình:** PATCH camera → `_apply_stream_changes` → `sync_stream` (stop + delay + start với retry).

Relay profile mặc định (tối ưu CPU trên Mac/Docker không GPU):

- 640×360 @ 10 fps, 256 kbps, ultrafast, 1 thread/camera
- Override qua env: `RELAY_WIDTH`, `RELAY_HEIGHT`, `RELAY_DEFAULT_FPS`, `RELAY_BITRATE`, `RELAY_X264_THREADS`

## 3. Quản lý stream (Backend)

### 3.1 StreamManager

- Registry in-memory: `camera_id → StreamHandle` (process, status, uptime, reconnect_count).
- `start_stream` / `stop_stream` / `sync_stream` với lock `is_syncing` (timeout 45s chống deadlock).
- Monitor loop (`asyncio`, mỗi 5s): đọc DB, so khớp config vs runtime, khôi phục FAILED/missing, restart khi drift FPS/resolution.

### 3.2 Đồng bộ cấu hình

- **meta_only** (chỉ đổi `name`, `grid_slot`): không restart FFmpeg.
- Thay đổi `fps`, `width`, `height`, `source_rtsp`, `mock_video_name`, `active`: restart relay đồng bộ qua API.

### 3.3 Auto-reconnect & sự kiện

- Process chết hoặc FAILED → tăng `reconnect_count`, log vào `stream_events`.
- Monitor gọi `start_stream` hoặc `sync_stream` tùy trạng thái.
- API: `GET /api/system/events?camera_id=&limit=50`

## 4. Dashboard (Frontend)

### 4.1 Grid & ô cố định

- Mỗi camera có `grid_slot` (0–31). Tạo mới tự gán slot trống.
- `camerasBySlot()` map camera → ô; camera chưa gán slot fill vào ô trống còn lại.

### 4.2 Trạng thái kênh

| Code | Nhãn hiển thị |
|------|---------------|
| CONNECTED / RUNNING | Đã kết nối |
| DISCONNECTED / FAILED / STALL | Mất kết nối |
| RECONNECTING / STARTING | Đang kết nối lại |
| INACTIVE | Tắt |

### 4.3 Giám sát phía client

- **Latency:** buffer HLS end − `currentTime` (ms), cập nhật mỗi 2s.
- **Frame stall:** nếu `currentTime` không tiến trong `FRAME_STALL_SECONDS` (mặc định 10s) → reload player.
- **Metrics topbar:** CPU, Memory, GPU (`nvidia-smi` nếu có), số luồng active.

## 5. API chính

| Endpoint | Mô tả |
|----------|-------|
| `GET/POST /api/cameras` | Danh sách / tạo camera |
| `PATCH/DELETE /api/cameras/{id}` | Sửa / xóa |
| `GET /api/cameras/{id}/status` | Runtime chi tiết |
| `GET /api/system/metrics` | CPU, RAM, GPU, streams |
| `GET /api/system/config` | HLS port, max channels, frame_stall_seconds |
| `GET /api/system/events` | Nhật ký sự kiện stream |

## 6. Vận hành & mở rộng

### 6.1 Khả năng chịu lỗi

- Graceful shutdown FFmpeg: `terminate()` → `kill()` sau 3s.
- Stagger khởi động: `STREAM_START_STAGGER_MS` tránh burst CPU.
- Client-side stall detection bổ sung khi decoder treo nhưng process backend vẫn RUNNING.

### 6.2 Bottleneck khi scale

Trên Docker Mac (software encoding):

1. **CPU encoding** — điểm nghẽn đầu tiên khi >16–32 kênh ở độ phân giải cao.
2. **RAM / NIC** — khi nhiều luồng ingress đồng thời.
3. **Subprocess overhead** — 80+ FFmpeg riêng lẻ không bền vững trên một node.

### 6.3 Hướng mở rộng production

- GPU passthrough: `h264_nvenc` / VideoToolbox thay libx264.
- GStreamer pipeline zero-copy thay nhiều subprocess.
- SFU (Janus/mediasoup) cho phân phối WebRTC hàng loạt.
- Sharding relay theo node, MediaMTX cluster.

## 7. Tham chiếu benchmark

Xem [REPORT.MD](../REPORT.MD) cho số liệu đo trên Mac M1 (16/32 kênh, CPU/RAM/latency).
