# BÁO CÁO THIẾT KẾ VÀ KIỂM CHỨNG HỆ THỐNG
**Dự án:** Hệ thống quản lý camera và streaming video (Bài tập B1)
**Người thực hiện:** Phạm Văn Nguyên

---

## 1. Cấu trúc hệ thống (System Architecture)
Hệ thống được thiết kế theo mô hình phân tán (Decoupled Architecture), chia làm 3 thành phần cốt lõi để đảm bảo tính ổn định và khả năng dễ dàng tái lập (reproducible):

1.  **Nguồn phát (Mock Source):** Sử dụng FFmpeg container để phát lặp lại file `Video_BE.mp4` thành luồng RTSP cục bộ (`rtsp://mediamtx:8554/source`).
2.  **Streaming Engine (MediaMTX + FFmpeg Process):** * Sử dụng **MediaMTX** làm trung tâm trung chuyển luồng (RTSP Server / WebRTC Gateway) vì độ trễ siêu thấp (Sub-second latency) và khả năng "Zero-config".
    * Sử dụng **FFmpeg** đóng vai trò Transcoder/Rescaler, nhận luồng từ nguồn, biến đổi theo cấu hình (FPS, Resolution) và đẩy vào MediaMTX.
3.  **Backend API (Python/FastAPI):** Quản lý trạng thái camera (CRUD qua SQLite) và hoạt động như một **Process Manager** (Quản lý vòng đời tiến trình FFmpeg, tự động kết nối lại, giám sát tài nguyên CPU/RAM).

## 2. Quyết định thiết kế cốt lõi (Core Design Decisions)
* **Quản lý luồng (Stream Management):** Thay vì code phức tạp ở tầng C/C++, tôi sử dụng module `subprocess` của Python kết hợp `threading.Lock()` để bọc (wrap) các tiến trình FFmpeg. Thiết kế này giải quyết triệt để vấn đề Race Condition khi người dùng spam API thay đổi cấu hình liên tục.
* **Chiến lược thay đổi FPS & Resolution:** Khi có yêu cầu cấu hình, Backend không dừng toàn bộ hệ thống. Logic `meta_only` được áp dụng: Chỉ khởi động lại tiến trình FFmpeg (Kill & Spawn) nếu các thông số cốt lõi (FPS, Width, Height) thay đổi, đảm bảo Zero-downtime cho các thao tác cập nhật siêu dữ liệu (Metadata).
* **Đồng bộ trạng thái (State Synchronization):** Tách biệt cấu hình tĩnh (DB) và trạng thái thực thi trong RAM. API sử dụng hàm `_enrich_runtime` để báo cáo chính xác luồng FFmpeg hiện tại đã thực sự áp dụng cấu hình mới hay chưa (`fps_synced`, `resolution_synced`).

## 3. Kết quả đo lường (Empirical Benchmarks)
**Môi trường thực thi:** Mac Pro M1 2021 (16GB RAM, SSD), Docker Engine (Không hỗ trợ phần cứng giải mã passthrough).
**Công cụ đo lường:** Thư viện `psutil` (Backend), Docker Stats.

| Cấu hình luồng (Resolution @ FPS) | Số kênh (Channels) | Mức sử dụng CPU | Mức sử dụng RAM | Đánh giá trạng thái |
| :--- | :--- | :--- | :--- | :--- |
| **1080p @ 15fps** (Gốc) | 16 | **~95% - 100%** | ~1.5 GB | ❌ Tới hạn Software Encoding. Drop frame. |
| **640x360 @ 10fps** | 16 | **~40% - 60%** | ~1.1 GB | ✅ Ổn định. Phù hợp Grid View hiển thị. |
| **480x270 @ 8fps** | 32 | **~70% - 90%** | ~2.0 GB | ✅ Hoạt động tốt. Đạt mục tiêu đề bài. |
*Ghi chú độ trễ (Latency):* Độ trễ trung bình End-to-End qua luồng WebRTC đạt mức **~300ms - 500ms**.

## 4. Xem xét khía cạnh Vận hành & Mở rộng (Day-2 Ops & Scalability)
**4.1. Khắc phục sự cố vận hành (Resilience):**
* **Xử lý đứt Stream/Decoder treo:** Backend triển khai một `Background Task` chạy ngầm qua `asyncio.sleep(5)` để `poll()` trạng thái các tiến trình FFmpeg. Nếu tiến trình bị crash hoặc tự ngắt, trạng thái chuyển sang `RECONNECTING` và hàm `sync_stream` được tự động gọi lại để phục hồi.
* **Tránh "Zombie Process":** Triển khai cơ chế Graceful Shutdown với `process.terminate()`, và bồi thêm `process.kill()` nếu sau 3 giây tiến trình không phản hồi.

**4.2. Xác định điểm nghẽn (Bottleneck) khi nâng từ 8 lên 80 kênh:**
Dựa trên kết quả đo lường, việc nâng tải lên 80 kênh sẽ ngay lập tức đối mặt với các giới hạn vật lý:
1.  **CPU Context Switching & Encoding (Điểm nghẽn đầu tiên):** Việc duy trì 80 tiến trình `subprocess` độc lập thực hiện Software Encoding (`libx264`) sẽ làm sập CPU.
2.  **Network Ingress/Egress I/O:** 80 luồng camera đẩy về một Node duy nhất sẽ gây ngập card mạng (NIC limits) và tràn RAM Buffer của MediaMTX.

**4.3. Giải pháp Kiến trúc Mở rộng (Scale-out Strategy cho Production):**
Để giải quyết bài toán 80 kênh trở lên, hệ thống cần được tái cấu trúc:
* **Nâng cấp Hardware:** Chuyển dịch lên máy chủ Linux gắn GPU (NVIDIA T4/RTX) và cấu hình lại FFmpeg sử dụng Hardware Acceleration (`-c:v h264_nvenc`).
* **Chuyển đổi Engine (GStreamer & Janus SFU):** Để loại bỏ hoàn toàn cổ chai về I/O và tối ưu bộ nhớ, giải pháp tối ưu nhất là thay thế FFmpeg bằng các pipeline của **GStreamer** (tận dụng Zero-copy memory) và đẩy luồng RTP trực tiếp vào cụm **Janus Gateway** (Streaming Plugin). Janus SFU sẽ chịu trách nhiệm phân phối hàng nghìn phiên WebRTC đồng thời với độ trễ tối thiểu mà không ảnh hưởng tới Backend xử lý logic.