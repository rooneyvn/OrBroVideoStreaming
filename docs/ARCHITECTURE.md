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

- 640×360 @ 10 fps, **256 kbps baseline** (bitrate scale theo resolution), ultrafast, 1 thread/camera
- Override qua env: `RELAY_WIDTH`, `RELAY_HEIGHT`, `RELAY_DEFAULT_FPS`, `RELAY_BITRATE`, `RELAY_THREADS`
- Passthrough (không relay): chỉ khi `ALLOW_PASSTHROUGH=1` và FPS/resolution = default profile

## 3. Quản lý stream (Backend)

### 3.1 StreamManager

- Registry in-memory: `camera_id → StreamHandle` (process, status, uptime, reconnect_count).
- `start_stream` / `stop_stream` / `sync_stream` với lock `is_syncing` (timeout 45s chống deadlock).
- Monitor loop (`asyncio`, mỗi 5s): đọc DB, so khớp config vs runtime, khôi phục FAILED/missing, restart khi drift FPS/resolution.

### 3.2 Đồng bộ cấu hình

- **meta_only** (chỉ đổi `name`, `grid_slot`): không restart FFmpeg.
- Thay đổi `fps`, `width`, `height`, `source_rtsp`, `mock_video_name`, `active`: restart relay đồng bộ qua API.

### 3.3 Auto-reconnect & sự kiện

- Process chết, **STALL** (không frame encode trong `FRAME_STALL_SECONDS`), hoặc FAILED → tăng `reconnect_count`, log vào `stream_events`.
- `reconnect_count` được **persist** trên document camera (MongoDB) và khôi phục sau restart app.
- Sự kiện `stream_recover`, `stream_failed`, `stream_error` được **debounce** (mặc định 60s) để tránh spam DB khi lỗi kéo dài.
- Monitor gọi `start_stream` hoặc `sync_stream` tùy trạng thái.
- Nhật ký: trang `/logs` (UI) hoặc `GET /api/system/events` (phân trang, lọc theo camera/loại/thời gian/từ khóa).

### 3.4 Phát hiện treo frame (backend)

- FFmpeg chạy với `-progress pipe:1`; thread đọc stdout cập nhật `last_frame_at` mỗi khi có `frame=`.
- Monitor gọi `mark_stalled_streams()` trước mỗi vòng ensure → trạng thái `STALL` → restart relay.

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
- **Frame stall (client):** nếu `currentTime` HLS không tiến trong `FRAME_STALL_SECONDS` → reload player.

### 4.4 Giám sát phía backend

- **Frame stall:** FFmpeg `-progress` → `STALL` nếu không có frame encode trong ngưỡng (mặc định 10s, cùng env `FRAME_STALL_SECONDS`).
- Bổ sung cho client stall khi decoder treo nhưng relay vẫn RUNNING.
- **Metrics topbar:** CPU, Memory, GPU (`nvidia-smi` nếu có), số luồng active.

## 5. API chính

| Endpoint | Mô tả |
|----------|-------|
| `GET/POST /api/cameras` | Danh sách / tạo camera |
| `PATCH/DELETE /api/cameras/{id}` | Sửa / xóa |
| `GET /api/cameras/{id}/status` | Runtime chi tiết |
| `GET /api/system/metrics` | CPU, RAM, GPU, streams |
| `GET /api/system/config` | HLS port, max channels, frame_stall_seconds, simulation flag |
| `GET /api/system/events` | Nhật ký sự kiện (page, page_size, camera_id, event_type, alerts_only, from_ts, to_ts, q) |
| `GET /logs` | Trang nhật ký sự kiện (filter, phân trang, test thủ công) |
| `POST /api/system/client-stall` | Browser báo treo frame HLS |
| `POST /api/system/simulate-event` | Ghi sự kiện test (cần `ALLOW_EVENT_SIMULATION=1`) |

## 6. Vận hành & mở rộng

### 6.1 Khả năng chịu lỗi

- Graceful shutdown FFmpeg: `terminate()` → chờ 3s → `kill()` nếu chưa thoát.
- Stagger khởi động: `STREAM_START_STAGGER_MS` tránh burst CPU.
- Stall detection: backend (FFmpeg progress) + client (HLS buffer).

### 6.2 Bottleneck khi scale

Trên Docker Mac (software encoding):

1. **CPU encoding** — điểm nghẽn đầu tiên khi >16–32 kênh ở độ phân giải cao.
2. **RAM / NIC** — khi nhiều luồng ingress đồng thời.
3. **Subprocess overhead** — 80+ FFmpeg riêng lẻ không bền vững trên một node.

### 6.3 Hướng mở rộng production (Scale-out Strategy)

*Ghi chú - Quyết định tối ưu cho bài test:* Ở quy mô hiển thị tối đa 32 kênh trên một màn hình quản trị, việc lựa chọn kiến trúc **FFmpeg + MediaMTX** đảm bảo sự tinh gọn và tối ưu tài nguyên triển khai. Kiến trúc này giúp hệ thống chạy mượt mà trên môi trường Local/Docker chỉ với 1 thao tác `docker-compose up`, đáp ứng xuất sắc yêu cầu độ trễ thấp (< 0.5s với WebRTC) và tự động hạ độ phân giải khi transcode.

Tuy nhiên, khi hệ thống cần scale lên 80 kênh hoặc mở rộng cho hàng nghìn người dùng truy cập dashboard cùng lúc, Bottleneck sẽ xuất hiện ở khâu I/O và CPU. Do đó, phương án nâng cấp khi đưa vào Production như sau:

- **Chuyển đổi công cụ xử lý luồng:** Chuyển từ FFmpeg sang **GStreamer** để tận dụng tối đa kiến trúc Zero-copy memory và tối ưu Pipeline giải mã bằng phần cứng.
- **Triển khai cụm SFU (Selective Forwarding Unit):** Thay thế MediaMTX bằng **Janus Gateway** (SFU). Cấu hình luồng GStreamer đẩy trực tiếp RTP packets vào Janus Streaming Plugin. Giải pháp này tách biệt hoàn toàn tải chịu đựng (Load) của Media Server ra khỏi các luồng WebRTC.
- **Mô hình Media Node & Phân tán tải (Horizontal Scaling):** Đóng gói GStreamer và Janus thành một khối xử lý hoàn chỉnh (Media Server Node). Khi hệ thống scale lên, ta nhân bản (replicate) các Node này lên thành một Cluster. Phía trước thiết lập một Load Balancer (hoặc Signaling Gateway) điều phối (Sharding) kết nối từ camera và thiết bị của người dùng (Viewer) đến các Node trống tải, đảm bảo hệ thống mở rộng ngang vô hạn.
- **Tối ưu Backend (Performance & Concurrency):** FastAPI/Python rất tốt để xây dựng nhanh bản thử nghiệm, tuy nhiên khi cần quản lý trạng thái của hàng nghìn tiến trình đồng thời và xử lý I/O nặng, Python sẽ bộc lộ điểm yếu do Global Interpreter Lock (GIL) và tiêu tốn nhiều RAM. Phương án là **viết lại lõi quản lý luồng (Process Manager) bằng Rust** — ngôn ngữ cho phép quản lý memory an toàn (không cần Garbage Collector), xử lý concurrency mạnh mẽ và tiết kiệm tài nguyên hệ thống triệt để.

## 7. Tham chiếu benchmark

Xem [REPORT.MD](../REPORT.MD) cho số liệu đo trên Mac M1 (16/32 kênh, CPU/RAM/latency).

## 8. Giám sát trạng thái (đối chiếu require.md)

| Yêu cầu | Triển khai |
|---------|------------|
| Phát hiện lỗi kết nối stream | FFmpeg stderr + process exit → `FAILED`; log `stream_died` |
| Sự cố khi không nhận frame (timeout) | Backend: `-progress` → `STALL`; Client: HLS stall → reload + log `client_stall` |
| Auto-reconnect | Monitor 5s → `start_stream` / `sync_stream` khi FAILED/STALL/missing |
| Log reconnect & trạng thái gần nhất | `stream_events` + `cameras.reconnect_count`, `last_stream_status`, `last_stream_error`, `last_stream_at` |
| Uptime từng kênh | `runtime.uptime_seconds` → ô **Up** trên grid (reset khi reconnect) |

Debounce log lặp: `stream_recover`, `stream_failed`, `stream_error`, `client_stall` (mặc định 60s).

API bổ sung: `POST /api/system/client-stall` — browser báo cáo treo frame phía client.

## 9. Bonus (điểm cộng)

| Yêu cầu | Triển khai |
|---------|------------|
| Áp dụng cấu hình ngay vào stream đang chạy | PATCH camera / FPS / resolution → `_apply_stream_changes` → `sync_stream` (restart FFmpeg có retry) |
| Gửi cảnh báo hoặc lưu sự kiện sự cố | MongoDB `stream_events` + trang `/logs` (phân trang, lọc) |

**Live config:** thay đổi `fps`, `width`, `height`, `source_rtsp`, `mock_video_name`, `active` đều restart relay ngay; chỉ `name` / `grid_slot` không restart (`meta_only`).

**Cảnh báo:**
- Lưu: mọi sự kiện vận hành (`stream_died`, `config_applied`, …) trong `stream_events`.
- UI: trang **Nhật ký** (`/logs`) — bảng có phân trang, lọc theo camera/loại/thời gian/từ khóa; không hiện popup trên dashboard.
- `client_stall` được debounce (mặc định 60s) cả phía client lẫn server để tránh spam DB.
- `stream_failed` / `stream_error` debounce 60s khi monitor retry liên tục (env `FAILURE_LOG_INTERVAL_SECONDS`).
- Test thủ công: bật `ALLOW_EVENT_SIMULATION=1` → nút **Thử sự kiện** trên `/logs` (chọn loại + camera, ghi DB khi bấm gửi). Không tự chạy lúc khởi động.
