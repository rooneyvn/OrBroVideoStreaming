/** Shared labels for stream event types (dashboard + logs page). */
window.STREAM_EVENT_LABELS = {
  stream_start_failed: "Start failed",
  stream_missing: "Stream missing",
  stream_recover: "Recovering",
  stream_recovered: "Recovered OK",
  stream_stall: "Frame stall (backend)",
  stream_stall_recover: "Recovered after stall",
  stream_died: "FFmpeg died unexpectedly",
  client_stall: "Frame stall (client HLS)",
  stream_reconnect: "Reconnecting",
  config_applied: "Live config applied",
  stream_failed: "Stream failed",
  stream_error: "System error",
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
