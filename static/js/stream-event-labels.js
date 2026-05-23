/** Shared labels for stream event types (dashboard + logs page). */
window.STREAM_EVENT_LABELS = {
  stream_start_failed: "Khởi động thất bại",
  stream_missing: "Thiếu luồng",
  stream_recover: "Đang phục hồi",
  stream_recovered: "Phục hồi OK",
  stream_stall: "Treo frame (backend)",
  stream_stall_recover: "Phục hồi sau treo frame",
  stream_died: "FFmpeg dừng đột ngột",
  client_stall: "Treo frame (client HLS)",
  stream_reconnect: "Kết nối lại",
  config_applied: "Áp dụng cấu hình live",
  stream_failed: "Luồng lỗi",
  stream_error: "Lỗi hệ thống",
};

window.STREAM_EVENT_CLASS = {
  stream_recovered: "event-type-ok",
  config_applied: "event-type-ok",
  stream_missing: "event-type-warn",
  stream_recover: "event-type-warn",
  stream_stall: "event-type-err",
  stream_died: "event-type-err",
  client_stall: "event-type-err",
  stream_start_failed: "event-type-err",
  stream_failed: "event-type-err",
  stream_error: "event-type-err",
};

window.STREAM_ALERT_TYPES = new Set([
  "stream_died",
  "stream_failed",
  "stream_stall",
  "client_stall",
  "stream_error",
  "stream_start_failed",
]);
