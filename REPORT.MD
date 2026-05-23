# BÁO CÁO THIẾT KẾ VÀ KIỂM CHỨNG HỆ THỐNG
**Dự án:** Hệ thống quản lý camera và streaming video (Bài tập B1)
**Người thực hiện:** Phạm Văn Nguyên

---

## 1. Cấu trúc hệ thống (System Architecture)
Hệ thống được thiết kế theo mô hình phân tán (Decoupled Architecture), chia làm 3 thành phần cốt lõi để đảm bảo tính ổn định và khả năng dễ dàng tái lập (reproducible):

1.  **Đầu vào video (Video Input):** Sử dụng FFmpeg container để phát lặp lại file `Video_BE.mp4` thành luồng RTSP cục bộ (`rtsp://mediamtx:8554/source`) hoặc nhận luồng từ camera thật.
2.  **Nhận stream & Giải mã (Streaming Engine):** 
    * Sử dụng **MediaMTX** làm trung tâm trung chuyển luồng (RTSP Server / WebRTC Gateway) vì độ trễ siêu thấp.
    * Sử dụng tiến trình **FFmpeg** độc lập để giải mã (decoding) luồng gốc, thay đổi cấu hình (FPS, Resolution) và truyền tải lại (encoding) vào MediaMTX.
3.  **Truyền tải lên giao diện web, API & Quản trị:** Backend (Python/FastAPI) cung cấp REST API CRUD và giám sát. Giao diện (Frontend HTML/JS) chia lưới (grid) hiển thị luồng HLS/WebRTC và gọi API điều khiển. Đóng vai trò là Process Manager quản lý vòng đời FFmpeg.

## 2. Quyết định thiết kế cốt lõi (Core Design Decisions)
* **Phương thức xử lý stream & Đồng thời (Concurrency):** Sử dụng module `subprocess` của Python kết hợp `threading.Lock()` để quản lý từng tiến trình FFmpeg độc lập. Thiết kế này tránh Race Condition khi có nhiều request API thay đổi cấu hình đồng thời.
* **Cách điều khiển FPS theo từng ô grid:** Khi thay đổi FPS trên một ô grid, giao diện gửi API `PATCH` cho ID camera tương ứng. Backend chỉ khởi động lại (kill & spawn) tiến trình FFmpeg của riêng camera đó với thông số `-r` mới, đảm bảo luồng mới cập nhật mượt mà, **không gây gián đoạn (zero-downtime)** cho các ô grid khác.
* **Đồng bộ trạng thái (State Synchronization):** Tách biệt cấu hình tĩnh (DB) và trạng thái thực thi trong RAM. API sử dụng hàm `_enrich_runtime` để báo cáo luồng FFmpeg hiện tại đã thực sự áp dụng cấu hình mới hay chưa.
* **Phương pháp giám sát trạng thái:** Backend đọc `-progress` của FFmpeg để phát hiện treo frame (`STALL`); browser bổ sung phát hiện treo HLS phía client. Monitor loop 5 giây tự reconnect; số lần reconnect và lỗi gần nhất được lưu vào MongoDB. Các loại log sự kiện được debounce 60 giây để tránh spam vào `/logs`.

## 3. Kết quả đo lường (Empirical Benchmarks)
**Môi trường thực thi:** Mac Pro M1 2021 (16GB RAM, SSD), Docker Engine (Không hỗ trợ phần cứng giải mã passthrough).
**Công cụ đo lường:** Thư viện `psutil` (Backend), Docker Stats.

| Cấu hình luồng (Resolution @ FPS) | Số kênh (Channels) | Mức sử dụng CPU | Mức sử dụng RAM | Đánh giá trạng thái |
| :--- | :--- | :--- | :--- | :--- |
| **1080p @ 15fps** (Gốc) | 16 | **~95% - 100%** | ~1.5 GB | ❌ Tới hạn Software Encoding. Drop frame. |
| **640x360 @ 10fps** | 16 | **~40% - 60%** | ~1.1 GB | ✅ Ổn định. Phù hợp Grid View hiển thị. |
| **480x270 @ 8fps** | 32 | **~70% - 90%** | ~2.0 GB | ✅ Hoạt động tốt. Đạt mục tiêu đề bài. |
*Ghi chú độ trễ (Latency):* Dashboard mặc định phát **HLS** (MediaMTX port 8888). Độ trễ đo phía client (buffer HLS) thường **~1–3 giáy** tùy segment; có thể chuyển sang WebRTC (`DASHBOARD_PLAYBACK=webrtc`) để giảm xuống **~300–500ms** nếu cần.

## 4. Xem xét khía cạnh Vận hành & Mở rộng (Day-2 Ops & Scalability)
**4.1. Khắc phục sự cố vận hành (Resilience):**
* **Xử lý đứt Stream & Decoder bị treo:** Backend triển khai một Background Task chạy vòng lặp mỗi 5s để `poll()` trạng thái tiến trình FFmpeg. Nếu stream đứt (crash/exit), trạng thái chuyển sang `RECONNECTING` và luồng được gọi khởi động lại. Để xử lý decoder bị treo, backend giám sát qua pipe `-progress`, nếu không nhận được frame trong 10s sẽ báo `STALL` và tự động restart FFmpeg.
* **Xử lý tăng dung lượng bộ nhớ (Memory Bloat):** Khi xử lý stream lâu ngày, RAM có thể bị rò rỉ. Giải pháp là ứng dụng tiến trình con (subprocess), mỗi camera là một quy trình OS độc lập; khi luồng lỗi hoặc đổi cấu hình, tiến trình cũ bị tiêu diệt hoàn toàn trả lại bộ nhớ, ngăn ngừa tăng dung lượng bộ nhớ diện rộng ảnh hưởng toàn hệ thống.
* **Tránh "Zombie Process":** Dừng FFmpeg bằng `process.terminate()` (SIGTERM), chờ 3 giây, rồi `process.kill()` (SIGKILL) nếu tiến trình treo cứng.

**4.2. Xác định điểm nghẽn đầu tiên khi nâng từ 8 lên 80 kênh:**
Dựa trên kết quả đo lường, việc nâng tải lên 80 kênh sẽ ngay lập tức đối mặt với các giới hạn vật lý:
1.  **Điểm nghẽn (Bottleneck) đầu tiên - CPU Encoding:** Việc duy trì 80 tiến trình `subprocess` độc lập thực hiện Software Encoding (`libx264`) sẽ làm quá tải CPU Context Switching và tiêu tốn 100% CPU ngay lập tức. Đây là điểm thắt cổ chai sớm nhất trước khi gặp vấn đề về RAM hay Băng thông mạng.
2.  **Network Ingress/Egress I/O:** 80 luồng đẩy về MediaMTX sẽ đòi hỏi băng thông lớn và tăng đột biến RAM Buffer.

**4.3. Giải pháp Kiến trúc Mở rộng (Scale-out Strategy):**

*Ghi chú - Quyết định tối ưu cho bài test:* Ở quy mô hiển thị tối đa 32 kênh trên một màn hình quản trị, việc lựa chọn kiến trúc **FFmpeg + MediaMTX** đảm bảo sự tinh gọn và tối ưu tài nguyên triển khai. Kiến trúc này giúp hệ thống chạy mượt mà trên môi trường Local/Docker chỉ với 1 thao tác `docker-compose up`, đáp ứng xuất sắc yêu cầu độ trễ thấp (< 0.5s với WebRTC) và tự động hạ độ phân giải khi transcode.

Tuy nhiên, khi hệ thống cần scale lên 80 kênh hoặc mở rộng cho hàng nghìn người dùng truy cập dashboard cùng lúc, Bottleneck sẽ xuất hiện ở khâu I/O và CPU. Do đó, phương án nâng cấp khi đưa vào Production như sau:

* **Chuyển đổi công cụ xử lý luồng:** Chuyển từ FFmpeg sang **GStreamer** để tận dụng tối đa kiến trúc Zero-copy memory và tối ưu Pipeline giải mã bằng phần cứng.
* **Triển khai cụm SFU (Selective Forwarding Unit):** Thay thế MediaMTX bằng **Janus Gateway** (SFU). Cấu hình luồng GStreamer đẩy trực tiếp RTP packets vào Janus Streaming Plugin. Giải pháp này tách biệt tải chịu đựng (Load) của Media Server ra khỏi các luồng WebRTC.
* **Mô hình Media Node & Phân tán tải (Horizontal Scaling):** Đóng gói GStreamer và Janus vào chung một máy chủ xử lý chuyên biệt (Media Server Node). Khi scale, hệ thống sẽ nhân bản (replicate) các Node này lên thành một Cluster lớn. Kết hợp cùng API Gateway / Load Balancer để điều phối (Sharding) kết nối luồng camera và thiết bị Viewer phân bổ đều cho các Node tương ứng, cho phép hệ thống mở rộng theo chiều ngang một cách tuyến tính.
* **Tối ưu Backend bằng Rust (Performance & Concurrency):** FastAPI/Python phù hợp để phát triển nhanh (Rapid Prototyping), nhưng khi cần quản lý trạng thái của hàng nghìn tiến trình đồng thời (high concurrency) cùng với thao tác I/O liên tục, Python sẽ bị giới hạn bởi GIL (Global Interpreter Lock) và tiêu thụ lượng lớn RAM. Giải pháp là **viết lại lõi quản lý luồng (Process Manager) bằng Rust**. Rust cung cấp khả năng xử lý đồng thời (native concurrency) mạnh mẽ, kiểm soát bộ nhớ an toàn (memory safety) mà không cần Garbage Collector, giúp Backend đạt hiệu năng cực cao và tiết kiệm tối đa tài nguyên hệ thống.