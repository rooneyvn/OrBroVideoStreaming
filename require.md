### Hệ thống quản lý camera và streaming video

**Mục tiêu:** Triển khai hệ thống cho phép giám sát nhiều luồng video trên giao diện web, đồng thời quản lý thông tin camera và trạng thái của các luồng stream.

**Yêu cầu triển khai:**

- Có thể giám sát video trên giao diện web.
- Phát lặp lại file video được cung cấp thành luồng RTSP trên môi trường local.
- Triển khai API đăng ký camera RTSP.
- Nhận đầu vào là luồng RTSP từ camera đã đăng ký.
- Hiển thị đồng thời tối thiểu 4 video.
- Cấu trúc hệ thống có khả năng mở rộng (scale) lên đến 32 kênh.
- Màn hình hiển thị video dạng lưới (grid).
- Tính năng thay đổi FPS cho từng ô trong grid.
- Hiển thị trạng thái theo từng kênh: Đã kết nối, Mất kết nối, Đang kết nối lại.
- Hiển thị FPS hoặc độ trễ (latency) theo từng kênh.
- Hiển thị mức sử dụng CPU, GPU, Memory.

**Yêu cầu quản lý camera:**

- API Đăng ký (Create), Tra cứu (Read), Sửa (Update), Xóa (Delete) camera.
- Quản lý các thiết lập camera như RTSP URL, độ phân giải, FPS...
- Tra cứu trạng thái của từng camera.

**Giám sát trạng thái:**

- Phát hiện lỗi kết nối stream.
- Đánh giá là có sự cố (장애) khi không nhận được frame nào trong một khoảng thời gian nhất định.
- Thử tự động kết nối lại (auto-reconnect).
- Ghi log số lần kết nối lại hoặc trạng thái gần nhất.
- Hiển thị thời gian hoạt động liên tục (uptime) theo từng kênh.

**Điểm cộng (Bonus points):**

- Khi thay đổi cấu hình, áp dụng ngay vào luồng stream đang chạy.
- Gửi cảnh báo hoặc lưu lại sự kiện khi xảy ra sự cố.

**Nội dung cần có trong báo cáo:**

- **Cấu trúc hệ thống:** Đầu vào video, nhận stream, giải mã (decoding), truyền tải lên giao diện web, API hoặc màn hình quản trị.
- **Quyết định thiết kế cốt lõi:** Phương thức xử lý stream, cấu trúc xử lý đồng thời, cách điều khiển FPS theo từng ô grid, phương pháp giám sát trạng thái.
- **Kết quả đo lường:** Số kênh xử lý đồng thời, FPS theo từng kênh, độ trễ, mức sử dụng CPU, GPU, bộ nhớ.
- **Xem xét khía cạnh vận hành & mở rộng:** Xử lý đứt stream, decoder bị treo, tăng dung lượng bộ nhớ, xác định điểm nghẽn (bottleneck) đầu tiên khi nâng từ 8 kênh lên 80 kênh trở lên.