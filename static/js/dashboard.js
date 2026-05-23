const STATUS_LABELS = {
  CONNECTED: "Đã kết nối",
  DISCONNECTED: "Mất kết nối",
  RECONNECTING: "Đang kết nối lại",
  STARTING: "Đang kết nối lại",
  RUNNING: "Đã kết nối",
  FAILED: "Mất kết nối",
  STOPPED: "Dừng",
  STOPPING: "Dừng",
  INACTIVE: "Tắt",
  EMPTY: "Trống",
  STALL: "Mất kết nối",
};

const GRID_CLASS = {
  4: "grid-4",
  9: "grid-9",
  16: "grid-16",
  32: "grid-32",
};

const EVENT_TYPE_LABELS = {
  stream_start_failed: "Khởi động thất bại",
  stream_missing: "Thiếu luồng",
  stream_recover: "Đang phục hồi",
  stream_recovered: "Phục hồi OK",
  stream_failed: "Luồng lỗi",
  stream_error: "Lỗi hệ thống",
};

const EVENT_TYPE_CLASS = {
  stream_recovered: "event-type-ok",
  stream_missing: "event-type-warn",
  stream_recover: "event-type-warn",
  stream_start_failed: "event-type-err",
  stream_failed: "event-type-err",
  stream_error: "event-type-err",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatEventTime(value) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("vi-VN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatEventExtra(extra) {
  if (!extra || typeof extra !== "object") return "";
  const parts = Object.entries(extra)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(" · ") : "";
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatResolution(width, height) {
  if (width && height) return `${width}×${height}`;
  return "auto";
}

const RESOLUTION_PRESETS = [
  { label: "LD", width: 480, height: 270, title: "480×270 — Nhẹ, phù hợp ~32 kênh" },
  { label: "SD", width: 640, height: 360, title: "640×360 — Mặc định giám sát grid" },
  { label: "HD", width: 1280, height: 720, title: "1280×720 — HD 720p" },
  { label: "FHD", width: 1920, height: 1080, title: "1920×1080 — Full HD 1080p" },
];

function findResolutionPreset(width, height) {
  const w = Number(width);
  const h = Number(height);
  return RESOLUTION_PRESETS.find((item) => item.width === w && item.height === h) || null;
}

function resolutionShortLabel(width, height) {
  const preset = findResolutionPreset(width, height);
  return preset ? preset.label : formatResolution(width, height);
}

function resolutionDisplayLabel(width, height) {
  const preset = findResolutionPreset(width, height);
  const px = formatResolution(width, height);
  return preset ? `${preset.label} (${px})` : px;
}

function resPresetButtonsHtml(disabled = true) {
  return RESOLUTION_PRESETS.map(
    (p) =>
      `<button type="button" class="res-preset-btn" data-width="${p.width}" data-height="${p.height}" title="${escapeHtml(p.title)}"${disabled ? " disabled" : ""}>${p.label}</button>`
  ).join("");
}

function resolveStatus(camera, runtimeStatus, globalStatus) {
  if (!camera) return { code: "EMPTY", label: STATUS_LABELS.EMPTY };
  if (!camera.active) return { code: "INACTIVE", label: STATUS_LABELS.INACTIVE };

  const rt = camera.runtime || {};
  const rtStatus = runtimeStatus || rt.status || null;
  const syncing =
    rt.sync_in_progress === true ||
    rt.encoding_synced === false ||
    globalStatus === "RECONNECTING";

  let code;
  if (globalStatus === "STALL") {
    code = "STALL";
  } else if (syncing && rtStatus !== "FAILED") {
    code = "RECONNECTING";
  } else if (rtStatus === "RUNNING") {
    code = "CONNECTED";
  } else if (rtStatus === "STARTING") {
    code = "RECONNECTING";
  } else if (rtStatus === "FAILED") {
    code = "DISCONNECTED";
  } else if (rtStatus === "STOPPED" || rtStatus === "STOPPING") {
    code = syncing ? "RECONNECTING" : globalStatus || "DISCONNECTED";
  } else if (rtStatus) {
    code = rtStatus;
  } else {
    code = syncing ? "RECONNECTING" : globalStatus || camera.display_status || "DISCONNECTED";
  }

  const normalized =
    code === "RUNNING"
      ? "CONNECTED"
      : code === "STALL" || code === "FAILED"
        ? "DISCONNECTED"
        : code;
  return {
    code: normalized,
    label: STATUS_LABELS[normalized] || normalized,
  };
}

function shouldKeepPlayer(camera, statusCode, hasPlayer) {
  if (!camera || !camera.active) return false;
  if (["CONNECTED", "RUNNING", "RECONNECTING", "STARTING"].includes(statusCode)) {
    return true;
  }
  const rt = camera.runtime || {};
  if (hasPlayer && (rt.encoding_synced === false || rt.sync_in_progress)) {
    return true;
  }
  return false;
}

function statusClass(code) {
  switch (code) {
    case "CONNECTED":
      return "status-connected";
    case "RECONNECTING":
    case "STARTING":
      return "status-reconnecting";
    case "INACTIVE":
    case "STOPPED":
    case "EMPTY":
      return "status-stopped";
    default:
      return "status-disconnected";
  }
}

function shouldPlayStream(camera, statusCode) {
  if (!camera || !camera.active) return false;
  return ["CONNECTED", "RUNNING", "RECONNECTING", "STARTING"].includes(statusCode);
}

function formatLatency(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return `${Math.round(ms)}ms`;
}

function getPlaybackLatency(videoEl) {
  if (!videoEl || videoEl.readyState < 2) return null;
  try {
    const buf = videoEl.buffered;
    if (!buf || buf.length === 0) return null;
    const end = buf.end(buf.length - 1);
    return Math.max(0, (end - videoEl.currentTime) * 1000);
  } catch {
    return null;
  }
}
function gridSizeForCount(count) {
  if (count <= 4) return 4;
  if (count <= 9) return 9;
  if (count <= 16) return 16;
  return 32;
}

class Dashboard {
  constructor() {
    this.gridEl = document.getElementById("video-grid");
    this.gridSizeSelect = document.getElementById("grid-size");
    this.lastUpdatedEl = document.getElementById("last-updated");
    this.sidePanel = document.getElementById("side-panel");
    this.cameraListEl = document.getElementById("camera-list");
    this.cameraModal = document.getElementById("camera-modal");
    this.statusModal = document.getElementById("status-modal");
    this.eventsModal = document.getElementById("events-modal");
    this.eventsListEl = document.getElementById("events-list");
    this.eventsMetaEl = document.getElementById("events-meta");
    this.eventsFilterCamera = document.getElementById("events-filter-camera");
    this.eventsLimitSelect = document.getElementById("events-limit");
    this.cameraForm = document.getElementById("camera-form");
    this.mockVideoSelect = document.getElementById("form-mock-video");
    this.hlsBase = `http://${window.location.hostname}:8888`;
    this.webrtcBase = `http://${window.location.hostname}:8889`;
    this.playback = "hls";
    this.maxChannels = 32;
    this.defaultFps = 10;
    this.defaultWidth = 640;
    this.defaultHeight = 360;
    this.gridSize = 4;
    this.gridSizeManual = false;
    this.cameras = [];
    this.mockVideos = [];
    this.cameraStatus = {};
    this.players = new Map();
    this.cells = [];
    this.pollTimer = null;
    this.metricsTimer = null;
    this.editingCameraId = null;
    this.reloadingCameras = new Set();
    this.configApplyingCameras = new Set();
    this.playerGenerations = new Map();
    this.stallTrack = new WeakMap();
    this.stallThresholdMs = 10000;
    this.playbackHealthTimer = null;
    this.eventsTimer = null;
    this.eventsLoading = false;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  cancelCameraClient(cameraId) {
    if (!cameraId) return;
    this.reloadingCameras.delete(cameraId);
    this.playerGenerations.delete(cameraId);
    this.stopPlayer(cameraId);
  }

  bumpPlayerGeneration(cameraId) {
    this.playerGenerations.set(cameraId, Date.now());
  }

  isReloading(cameraId) {
    return this.reloadingCameras.has(cameraId);
  }

  async waitForStreamSync(cameraId, { maxAttempts = 16, hlsWarmupMs = 0 } = {}) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (!this.reloadingCameras.has(cameraId)) {
        return null;
      }

      await this.sleep(500);

      let res;
      try {
        res = await this.fetchWithTimeout(`/api/cameras/${cameraId}/status`);
      } catch (err) {
        console.warn(`[cam ${cameraId}] status poll failed`, err);
        continue;
      }

      if (res.status === 404) return null;
      if (!res.ok) continue;

      const data = await res.json();
      const rt = data.runtime || {};
      const cfg = data.configured || {};

      if (rt.status === "FAILED") {
        throw new Error(rt.last_error || "Luồng stream khởi động thất bại");
      }

      const fpsSynced = rt.stream_fps == null || Number(rt.stream_fps) === Number(cfg.fps);
      const widthSynced =
        (rt.stream_width == null && !cfg.width) ||
        Number(rt.stream_width) === Number(cfg.width);
      const heightSynced =
        (rt.stream_height == null && !cfg.height) ||
        Number(rt.stream_height) === Number(cfg.height);
      const encodingSynced =
        rt.encoding_synced !== false && fpsSynced && widthSynced && heightSynced;
      const mockSynced =
        (cfg.mock_video_name || null) === (rt.mock_video_name || null);
      const sourceSynced =
        (cfg.source_rtsp || "") === (data.source_rtsp || "");

      if (rt.status === "RUNNING" && encodingSynced && mockSynced && sourceSynced) {
        const idx = this.cameras.findIndex((item) => item._id === cameraId);
        if (idx >= 0) {
          this.cameras[idx] = {
            ...this.cameras[idx],
            fps: cfg.fps,
            width: cfg.width ?? undefined,
            height: cfg.height ?? undefined,
            mock_video_name: cfg.mock_video_name ?? undefined,
            source_rtsp: data.source_rtsp,
            runtime: rt,
          };
        }
        if (hlsWarmupMs > 0) {
          await this.sleep(hlsWarmupMs);
        }
        return data;
      }
    }

    console.warn(`[cam ${cameraId}] stream sync timeout, thử phát lại`);
    return null;
  }

  async reloadCameraStream(cameraId, { hlsWarmupMs = 0 } = {}) {
    this.configApplyingCameras.add(cameraId);
    this.cameraStatus[cameraId] = "RECONNECTING";
    this.reloadingCameras.add(cameraId);
    this.bumpPlayerGeneration(cameraId);
    this.stopPlayer(cameraId);

    const cell = this.findCellByCameraId(cameraId);
    const cam = this.cameras.find((item) => item._id === cameraId);
    if (cell && cam) this.updateCellView(cell, cam);

    try {
      await this.waitForStreamSync(cameraId, { hlsWarmupMs });
    } catch (err) {
      console.error("Reload stream failed:", err);
    } finally {
      this.reloadingCameras.delete(cameraId);
      this.configApplyingCameras.delete(cameraId);
    }

    await this.refresh();
    this.syncPlayers();
  }

  async init() {
    await this.loadConfig();
    await this.loadMockVideos();

    this.gridSizeManual = localStorage.getItem("gridSizeManual") === "1";
    this.gridSize = Math.max(4, Number(localStorage.getItem("gridSize") || 4));
    this.gridSizeSelect.value = String(this.gridSize);
    this.gridSizeSelect.addEventListener("change", () => {
      this.setGridSize(Number(this.gridSizeSelect.value), { manual: true });
    });

    document.getElementById("btn-add-camera").addEventListener("click", () => this.openCameraModal());
    document.getElementById("btn-panel-add").addEventListener("click", () => this.openCameraModal());
    document.getElementById("btn-toggle-panel").addEventListener("click", () => this.togglePanel());
    document.getElementById("btn-events-log").addEventListener("click", () => this.openEventsModal());
    document.getElementById("btn-close-panel").addEventListener("click", () => this.togglePanel(false));
    document.getElementById("btn-delete-camera").addEventListener("click", () => this.deleteCamera());
    document.getElementById("btn-status-edit").addEventListener("click", () => {
      const id = this.statusModal.dataset.cameraId;
      this.statusModal.close();
      if (id) this.openCameraModal(id);
    });
    document.getElementById("btn-status-events").addEventListener("click", () => {
      const id = this.statusModal.dataset.cameraId;
      this.statusModal.close();
      this.openEventsModal(id || null);
    });
    document.getElementById("btn-events-refresh").addEventListener("click", () => this.refreshEvents());
    this.eventsFilterCamera.addEventListener("change", () => this.refreshEvents());
    this.eventsLimitSelect.addEventListener("change", () => this.refreshEvents());
    this.eventsModal.addEventListener("close", () => this.stopEventsPolling());

    this.cameraForm.addEventListener("submit", (evt) => {
      evt.preventDefault();
      this.saveCamera();
    });

    document.querySelectorAll("[data-action='close-modal']").forEach((el) => {
      el.addEventListener("click", () => this.cameraModal.close());
    });
    document.querySelectorAll("[data-action='close-status']").forEach((el) => {
      el.addEventListener("click", () => this.statusModal.close());
    });
    document.querySelectorAll("[data-action='close-events']").forEach((el) => {
      el.addEventListener("click", () => this.eventsModal.close());
    });

    this.initFormResPresets();

    this.buildGrid();
    await this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), 4000);
    this.metricsTimer = setInterval(() => this.refreshMetrics(), 5000);
    this.playbackHealthTimer = setInterval(() => this.checkPlaybackHealth(), 2000);
  }

  camerasBySlot() {
    const map = new Map();
    const unassigned = [];
    const sorted = [...this.cameras].sort((a, b) => {
      const sa = a.grid_slot != null ? Number(a.grid_slot) : 9999;
      const sb = b.grid_slot != null ? Number(b.grid_slot) : 9999;
      if (sa !== sb) return sa - sb;
      return String(a._id).localeCompare(String(b._id));
    });
    for (const cam of sorted) {
      const slot = cam.grid_slot != null ? Number(cam.grid_slot) : null;
      if (slot != null && slot >= 0 && slot < this.gridSize && !map.has(slot)) {
        map.set(slot, cam);
      } else {
        unassigned.push(cam);
      }
    }
    let idx = 0;
    for (let i = 0; i < this.gridSize && idx < unassigned.length; i += 1) {
      if (!map.has(i)) {
        map.set(i, unassigned[idx]);
        idx += 1;
      }
    }
    return map;
  }

  isVideoStalled(videoEl) {
    if (!videoEl || videoEl.readyState < 2 || videoEl.paused) return false;
    const now = Date.now();
    const track = this.stallTrack.get(videoEl) || {
      lastTime: videoEl.currentTime,
      since: now,
    };
    if (videoEl.currentTime > track.lastTime + 0.05) {
      track.lastTime = videoEl.currentTime;
      track.since = now;
    }
    this.stallTrack.set(videoEl, track);
    return now - track.since > this.stallThresholdMs;
  }

  async checkPlaybackHealth() {
    for (const [cameraId, entry] of this.players.entries()) {
      if (!entry.videoEl || this.isReloading(cameraId)) continue;

      const cam = this.cameras.find((c) => c._id === cameraId);
      const rt = (cam && cam.runtime) || {};
      entry.latencyMs = getPlaybackLatency(entry.videoEl);

      const backendBusy =
        rt.encoding_synced === false ||
        rt.status === "STARTING" ||
        rt.status === "STOPPING" ||
        this.cameraStatus[cameraId] === "RECONNECTING";

      if (backendBusy) {
        this.stallTrack.delete(entry.videoEl);
        continue;
      }

      if (this.isVideoStalled(entry.videoEl)) {
        console.warn(`[cam ${cameraId}] no frames for ${this.stallThresholdMs}ms, reloading`);
        this.cameraStatus[cameraId] = "STALL";
        const cell = this.findCellByCameraId(cameraId);
        if (cell && cam) this.updateCellView(cell, cam);
        await this.reloadCameraStream(cameraId);
        continue;
      }
      if (this.cameraStatus[cameraId] === "STALL") {
        delete this.cameraStatus[cameraId];
      }
    }
    this.updateCellLatencies();
  }

  updateCellLatencies() {
    for (const cell of this.cells) {
      const latEl = cell.root.querySelector('[data-role="latency"]');
      if (!latEl || !cell.cameraId) {
        if (latEl) latEl.textContent = "—";
        continue;
      }
      const entry = this.players.get(cell.cameraId);
      latEl.textContent = formatLatency(entry ? entry.latencyMs : null);
    }
  }

  togglePanel(force) {
    const open = force !== undefined ? force : this.sidePanel.classList.contains("hidden");
    this.sidePanel.classList.toggle("hidden", !open);
    if (open) this.renderCameraList();
  }

  async loadConfig() {
    try {
      const res = await fetch("/api/system/config");
      if (!res.ok) return;
      const config = await res.json();
      this.hlsBase = `http://${window.location.hostname}:${config.hls_port || 8888}`;
      this.webrtcBase = `http://${window.location.hostname}:${config.webrtc_port || 8889}`;
      this.playback = config.playback || "hls";
      this.maxChannels = config.max_channels || 32;
      this.defaultFps = config.default_fps || 10;
      const defaultRes = config.default_resolution || {};
      this.defaultWidth = defaultRes.width || 640;
      this.defaultHeight = defaultRes.height || 360;
      this.stallThresholdMs = (config.frame_stall_seconds || 10) * 1000;
    } catch (err) {
      console.warn("Config load failed:", err);
    }
  }

  async loadMockVideos() {
    try {
      const res = await fetch("/api/cameras/mock-videos");
      if (!res.ok) return;
      const data = await res.json();
      this.mockVideos = data.videos || [];
      this.mockVideoSelect.innerHTML = '<option value="">— Tự chọn / RTSP —</option>';
      for (const name of this.mockVideos) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        this.mockVideoSelect.appendChild(opt);
      }
    } catch (err) {
      console.warn("Mock videos load failed:", err);
    }
  }

  setGridSize(size, { manual = false } = {}) {
    const allowed = [4, 9, 16, 32];
    let normalized = Number(size) || 4;
    if (!allowed.includes(normalized)) {
      normalized = gridSizeForCount(normalized);
    }
    normalized = Math.max(4, normalized);
    if (this.gridSize === normalized) return;
    this.gridSize = normalized;
    if (manual) {
      this.gridSizeManual = true;
      localStorage.setItem("gridSizeManual", "1");
    }
    this.gridSizeSelect.value = String(normalized);
    localStorage.setItem("gridSize", String(normalized));
    this.closeAllPlayers();
    this.buildGrid();
    this.syncPlayers();
  }

  autoFitGrid() {
    const n = this.cameras.length;
    if (n === 0) return;

    let maxSlot = -1;
    for (const cam of this.cameras) {
      if (cam.grid_slot != null) {
        maxSlot = Math.max(maxSlot, Number(cam.grid_slot));
      }
    }

    const neededByCount = gridSizeForCount(n);
    const neededBySlot = maxSlot >= 0 ? gridSizeForCount(maxSlot + 1) : 4;
    const needed = Math.max(4, neededByCount, neededBySlot);

    if (this.gridSize < needed) {
      this.setGridSize(needed, { manual: false });
    }
  }

  updateAddButtons() {
    const atMax = this.cameras.length >= this.maxChannels;
    for (const id of ["btn-add-camera", "btn-panel-add"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.disabled = atMax;
      el.title = atMax ? `Đã đạt giới hạn ${this.maxChannels} camera` : "";
    }
  }

  async refresh() {
    try {
      const [camerasRes, statusRes, metricsRes] = await Promise.all([
        fetch("/api/cameras"),
        fetch("/api/system/camera-status"),
        fetch("/api/system/metrics"),
      ]);
      this.cameras = camerasRes.ok ? await camerasRes.json() : [];
      const globalStatus = statusRes.ok ? await statusRes.json() : {};
      this.cameraStatus = { ...globalStatus };
      for (const cam of this.cameras) {
        const rt = cam.runtime || {};
        if (
          this.configApplyingCameras.has(cam._id) ||
          this.reloadingCameras.has(cam._id) ||
          rt.sync_in_progress ||
          rt.encoding_synced === false
        ) {
          this.cameraStatus[cam._id] = "RECONNECTING";
        } else if (rt.status === "RUNNING") {
          this.cameraStatus[cam._id] = "CONNECTED";
        } else if (rt.status === "STARTING") {
          this.cameraStatus[cam._id] = "RECONNECTING";
        }
      }
      if (metricsRes.ok) {
        this.applyMetrics(await metricsRes.json());
      }
      this.autoFitGrid();
      this.syncPlayers();
      this.renderCameraList();
      this.updateAddButtons();
      const gridCols = { 4: "2×2", 9: "3×3", 16: "4×4", 32: "4×8" };
      this.lastUpdatedEl.textContent =
        `${this.cameras.length}/${this.maxChannels} camera · lưới ${gridCols[this.gridSize] || this.gridSize} · ${new Date().toLocaleTimeString("vi-VN")}`;
    } catch (err) {
      console.error("Refresh failed:", err);
      this.lastUpdatedEl.textContent = "Lỗi tải dữ liệu";
    }
  }

  applyMetrics(data) {
    document.getElementById("metric-cpu").textContent = `${data.cpu_percent.toFixed(1)}%`;
    document.getElementById("metric-memory").textContent = `${data.memory_percent.toFixed(1)}%`;
    const gpuEl = document.getElementById("metric-gpu");
    if (gpuEl) {
      gpuEl.textContent =
        data.gpu_available && data.gpu_percent != null
          ? `${data.gpu_percent.toFixed(0)}%`
          : "N/A";
      gpuEl.title = data.gpu_available
        ? "GPU utilization (nvidia-smi)"
        : "Không có GPU / Docker Mac không expose GPU";
    }

    const live = data.active_streams ?? 0;
    const starting = data.starting_streams ?? 0;
    const failed = data.failed_streams ?? 0;
    let streamLabel = `${live} live`;
    if (starting > 0) streamLabel += ` · ${starting} start`;
    if (failed > 0) streamLabel += ` · ${failed} lỗi`;
    document.getElementById("metric-streams").textContent = streamLabel;
    document.getElementById("metric-streams").title = this.formatStreamMetricsTooltip(data);
  }

  formatStreamMetricsTooltip(data) {
    const streams = data.streams || [];
    if (streams.length === 0) return "Không có luồng đang quản lý";
    return streams
      .map((item) => {
        const res =
          item.width && item.height ? `${item.width}×${item.height}` : "auto";
        return `${item.camera_id.slice(-6)}: ${item.status} · ${item.fps} FPS · ${res}`;
      })
      .join("\n");
  }

  async refreshMetrics() {
    try {
      const res = await fetch("/api/system/metrics");
      if (!res.ok) return;
      this.applyMetrics(await res.json());
    } catch (err) {
      console.warn("Metrics failed:", err);
    }
  }

  renderCameraList() {
    if (!this.cameraListEl) return;
    if (this.cameras.length === 0) {
      this.cameraListEl.innerHTML = '<p class="panel-empty">Chưa có camera. Nhấn "+ Thêm" để đăng ký.</p>';
      return;
    }

    this.cameraListEl.innerHTML = this.cameras
      .map((cam) => {
        const rt = cam.runtime || {};
        const st = resolveStatus(cam, rt.status, this.cameraStatus[cam._id]);
        const res = formatResolution(
          rt.configured_width ?? cam.width,
          rt.configured_height ?? cam.height
        );
        return `
          <article class="camera-card" data-id="${cam._id}">
            <div class="camera-card-head">
              <strong>${escapeHtml(cam.name)}</strong>
              <span class="status-badge ${statusClass(st.code)}">${st.label}</span>
            </div>
            <p class="camera-card-meta">${escapeHtml(cam.source_rtsp || "—")}</p>
            <p class="camera-card-meta">${rt.configured_fps ?? cam.fps ?? this.defaultFps} FPS · ${res}</p>
            <p class="camera-card-meta">Ô lưới: ${cam.grid_slot != null ? Number(cam.grid_slot) + 1 : "—"}</p>
            <div class="camera-card-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-action="status" data-id="${cam._id}">Trạng thái</button>
              <button type="button" class="btn btn-ghost btn-sm" data-action="events" data-id="${cam._id}">Nhật ký</button>
              <button type="button" class="btn btn-ghost btn-sm" data-action="edit" data-id="${cam._id}">Sửa</button>
            </div>
          </article>`;
      })
      .join("");

    this.cameraListEl.querySelectorAll("[data-action='edit']").forEach((btn) => {
      btn.addEventListener("click", () => this.openCameraModal(btn.dataset.id));
    });
    this.cameraListEl.querySelectorAll("[data-action='status']").forEach((btn) => {
      btn.addEventListener("click", () => this.openStatusModal(btn.dataset.id));
    });
    this.cameraListEl.querySelectorAll("[data-action='events']").forEach((btn) => {
      btn.addEventListener("click", () => this.openEventsModal(btn.dataset.id));
    });
  }

  cameraNameById(cameraId) {
    if (!cameraId) return "Hệ thống";
    const cam = this.cameras.find((item) => item._id === cameraId);
    return cam ? cam.name : `Camera …${String(cameraId).slice(-6)}`;
  }

  populateEventsFilter(selectedId = "") {
    if (!this.eventsFilterCamera) return;
    const current = selectedId || this.eventsFilterCamera.value || "";
    const options = ['<option value="">Tất cả camera</option>'];
    for (const cam of this.cameras) {
      const selected = cam._id === current ? " selected" : "";
      options.push(
        `<option value="${escapeHtml(cam._id)}"${selected}>${escapeHtml(cam.name)}</option>`
      );
    }
    this.eventsFilterCamera.innerHTML = options.join("");
  }

  openEventsModal(cameraId = null) {
    this.populateEventsFilter(cameraId || "");
    if (cameraId) {
      this.eventsFilterCamera.value = cameraId;
    }
    this.eventsModal.showModal();
    this.refreshEvents();
    this.stopEventsPolling();
    this.eventsTimer = setInterval(() => this.refreshEvents({ silent: true }), 5000);
  }

  stopEventsPolling() {
    if (this.eventsTimer) {
      clearInterval(this.eventsTimer);
      this.eventsTimer = null;
    }
  }

  async refreshEvents({ silent = false } = {}) {
    if (!this.eventsModal.open || this.eventsLoading) return;

    const cameraId = this.eventsFilterCamera.value || "";
    const limit = Number(this.eventsLimitSelect.value) || 50;
    const params = new URLSearchParams({ limit: String(limit) });
    if (cameraId) params.set("camera_id", cameraId);

    if (!silent) {
      this.eventsMetaEl.textContent = "Đang tải nhật ký...";
    }

    this.eventsLoading = true;
    try {
      const res = await fetch(`/api/system/events?${params.toString()}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      this.renderEvents(data.events || [], { cameraId, limit });
      this.eventsMetaEl.textContent = `${data.count || 0} sự kiện gần nhất · cập nhật ${new Date().toLocaleTimeString("vi-VN")}`;
    } catch (err) {
      console.error("Events load failed:", err);
      this.eventsListEl.innerHTML = '<p class="events-empty">Không thể tải nhật ký sự kiện.</p>';
      this.eventsMetaEl.textContent = "Lỗi tải dữ liệu";
    } finally {
      this.eventsLoading = false;
    }
  }

  renderEvents(events, { cameraId, limit }) {
    if (!events.length) {
      const hint = cameraId
        ? "Chưa có sự kiện cho camera này."
        : "Chưa có sự kiện stream. Sự kiện được ghi khi luồng lỗi, phục hồi hoặc khởi động lại.";
      this.eventsListEl.innerHTML = `<p class="events-empty">${hint}</p>`;
      return;
    }

    this.eventsListEl.innerHTML = events
      .map((evt) => {
        const type = evt.type || "unknown";
        const typeLabel = EVENT_TYPE_LABELS[type] || type;
        const typeClass = EVENT_TYPE_CLASS[type] || "event-type-info";
        const extra = formatEventExtra(evt.extra);
        return `
          <article class="event-row">
            <time class="event-time">${escapeHtml(formatEventTime(evt.created_at))}</time>
            <span class="event-type ${typeClass}">${escapeHtml(typeLabel)}</span>
            <div class="event-body">
              <div class="event-camera">${escapeHtml(this.cameraNameById(evt.camera_id))}</div>
              <div class="event-message">${escapeHtml(evt.message || "—")}</div>
              ${extra ? `<div class="event-extra">${escapeHtml(extra)}</div>` : ""}
            </div>
          </article>`;
      })
      .join("");
  }

  openCameraModal(cameraId = null) {
    if (!cameraId && this.cameras.length >= this.maxChannels) {
      alert(`Đã đạt giới hạn ${this.maxChannels} camera. Xóa hoặc tắt camera cũ trước khi thêm.`);
      return;
    }

    this.editingCameraId = cameraId;
    const isEdit = Boolean(cameraId);
    const cam = isEdit ? this.cameras.find((c) => c._id === cameraId) : null;

    document.getElementById("modal-title").textContent = isEdit ? "Sửa camera" : "Thêm camera";
    document.getElementById("form-camera-id").value = cameraId || "";
    document.getElementById("form-name").value = cam ? cam.name : "";
    document.getElementById("form-source").value = cam ? cam.source_rtsp || "" : "rtsp://mediamtx:8554/source";
    document.getElementById("form-mock-video").value = cam ? cam.mock_video_name || "" : "";
    document.getElementById("form-fps").value = cam ? cam.fps || this.defaultFps : this.defaultFps;
    const res = cam
      ? this.resolveConfiguredResolution(cam, cam.runtime || {})
      : { width: this.defaultWidth, height: this.defaultHeight };
    this.setFormResolution(res.width, res.height);
    document.getElementById("form-grid-slot").value =
      cam && cam.grid_slot != null ? String(Number(cam.grid_slot) + 1) : "";
    document.getElementById("form-active").checked = cam ? cam.active !== false : true;
    document.getElementById("btn-delete-camera").classList.toggle("hidden", !isEdit);

    this.cameraModal.showModal();
  }

  async openStatusModal(cameraId) {
    try {
      const res = await fetch(`/api/cameras/${cameraId}/status`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const rt = data.runtime || {};
      const st = resolveStatus(
        { active: data.active, runtime: rt },
        rt.status,
        this.cameraStatus[cameraId]
      );

      document.getElementById("status-modal-title").textContent = data.name || "Trạng thái camera";
      this.statusModal.dataset.cameraId = cameraId;

      const rows = [
        ["Trạng thái", st.label],
        ["Ô lưới", data.grid_slot != null ? String(Number(data.grid_slot) + 1) : "—"],
        ["RTSP", data.source_rtsp || "—"],
        ["FPS cấu hình", String(data.configured?.fps ?? "—")],
        ["FPS luồng", rt.stream_fps != null ? String(rt.stream_fps) : "—"],
        ["Độ phân giải", resolutionDisplayLabel(data.configured?.width, data.configured?.height)],
        ["Luồng thực tế", resolutionDisplayLabel(rt.stream_width, rt.stream_height)],
        ["Bitrate relay", rt.stream_bitrate ?? "—"],
        ["Chế độ", rt.mode || "—"],
        ["Uptime", formatUptime(rt.uptime_seconds)],
        ["Reconnect", String(rt.reconnect_count || 0)],
        ["Độ trễ (HLS buffer)", formatLatency(getPlaybackLatency(
          this.players.get(cameraId)?.videoEl
        ))],
        ["Playback", rt.playback_path || "—"],
      ];
      if (rt.last_error) rows.push(["Lỗi gần nhất", rt.last_error]);

      document.getElementById("status-details").innerHTML = rows
        .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
        .join("");

      this.statusModal.showModal();
    } catch (err) {
      console.error("Status load failed:", err);
      alert("Không thể tải trạng thái camera.");
    }
  }

  initFormResPresets() {
    const wrap = document.getElementById("form-res-presets");
    if (!wrap) return;
    if (!wrap.childElementCount) {
      wrap.innerHTML = resPresetButtonsHtml(false);
      wrap.querySelectorAll(".res-preset-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (btn.disabled) return;
          this.setFormResolution(Number(btn.dataset.width), Number(btn.dataset.height));
        });
      });
    }
  }

  setFormResolution(width, height) {
    document.getElementById("form-width").value = String(width);
    document.getElementById("form-height").value = String(height);
    this.syncResPresetGroup(
      document.getElementById("form-res-presets"),
      width,
      height,
      { streamW: width, streamH: height, encodingSynced: true }
    );
  }

  syncResPresetGroup(
    container,
    configuredW,
    configuredH,
    { streamW = null, streamH = null, disabled = false, applying = false, encodingSynced = true } = {}
  ) {
    if (!container) return;
    const cfgW = Number(configuredW);
    const cfgH = Number(configuredH);
    const playW = streamW != null ? Number(streamW) : cfgW;
    const playH = streamH != null ? Number(streamH) : cfgH;

    container.querySelectorAll(".res-preset-btn").forEach((btn) => {
      const bw = Number(btn.dataset.width);
      const bh = Number(btn.dataset.height);
      const isPlaying = bw === playW && bh === playH;
      const isConfigured = bw === cfgW && bh === cfgH;
      const isPending = isConfigured && !isPlaying && !encodingSynced;

      btn.classList.toggle("active-stream", isPlaying);
      btn.classList.toggle("active-pending", isPending);
      btn.classList.toggle("is-applying", applying && isConfigured);
      btn.disabled = disabled || applying;
    });
  }

  buildPayloadFromForm() {
    const name = document.getElementById("form-name").value.trim();
    const source = document.getElementById("form-source").value.trim();
    const fps = Number(document.getElementById("form-fps").value);
    const active = document.getElementById("form-active").checked;
    const mock = document.getElementById("form-mock-video").value;
    const widthRaw = document.getElementById("form-width").value.trim();
    const heightRaw = document.getElementById("form-height").value.trim();
    const slotRaw = document.getElementById("form-grid-slot").value.trim();

    const parseSlot = () => {
      if (!slotRaw) return undefined;
      const n = Number(slotRaw);
      if (!Number.isFinite(n) || n < 1 || n > 32) return null;
      return n - 1;
    };
    const gridSlot = parseSlot();
    if (gridSlot === null) return null;

    if (!this.editingCameraId) {
      const payload = {
        name,
        source_rtsp: source,
        fps,
        width: widthRaw ? Number(widthRaw) : this.defaultWidth,
        height: heightRaw ? Number(heightRaw) : this.defaultHeight,
        active,
      };
      if (mock) payload.mock_video_name = mock;
      if (gridSlot !== undefined) payload.grid_slot = gridSlot;
      return payload;
    }

    const prev = this.cameras.find((item) => item._id === this.editingCameraId);
    const payload = { name };

    if (source !== (prev?.source_rtsp || "")) payload.source_rtsp = source;
    if (fps !== Number(prev?.fps ?? 15)) payload.fps = fps;
    if (active !== (prev?.active !== false)) payload.active = active;

    const prevMock = prev?.mock_video_name || "";
    if (mock !== prevMock) payload.mock_video_name = mock;

    const prevWidth = prev?.width != null ? Number(prev.width) : this.defaultWidth;
    const prevHeight = prev?.height != null ? Number(prev.height) : this.defaultHeight;
    const nextWidth = widthRaw ? Number(widthRaw) : prevWidth;
    const nextHeight = heightRaw ? Number(heightRaw) : prevHeight;
    if (nextWidth !== prevWidth) payload.width = nextWidth;
    if (nextHeight !== prevHeight) payload.height = nextHeight;

    const prevSlot = prev?.grid_slot != null ? Number(prev.grid_slot) : null;
    if (!slotRaw && prevSlot != null) payload.grid_slot = null;
    else if (gridSlot !== undefined && gridSlot !== prevSlot) payload.grid_slot = gridSlot;

    return payload;
  }

  cameraNeedsStreamReload(cameraId, payload) {
    const streamFields = new Set([
      "fps",
      "width",
      "height",
      "source_rtsp",
      "mock_video_name",
      "active",
    ]);
    return [...streamFields].some((key) =>
      Object.prototype.hasOwnProperty.call(payload, key)
    );
  }

  async saveCamera() {
    const fps = Number(document.getElementById("form-fps").value);
    const payload = this.buildPayloadFromForm();
    if (!payload) {
      alert("Ô lưới phải từ 1 đến 32.");
      return;
    }
    if (!payload.name) {
      alert("Vui lòng nhập tên camera.");
      return;
    }
    if (!Number.isFinite(fps) || fps < 1 || fps > 60) {
      alert("FPS phải từ 1 đến 60.");
      return;
    }

    const btn = document.getElementById("btn-save-camera");
    btn.disabled = true;
    btn.textContent = "Đang lưu…";

    try {
      const isEdit = Boolean(this.editingCameraId);
      const url = isEdit ? `/api/cameras/${this.editingCameraId}` : "/api/cameras";
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail || res.statusText);
      }

      const saved = await res.json();
      this.cameraModal.close();

      const camId = isEdit ? this.editingCameraId : saved._id;
      const isActive = isEdit ? payload.active !== false : saved.active !== false;

      if (!isEdit && isActive && camId) {
        await this.refresh();
        await this.reloadCameraStream(camId, { hlsWarmupMs: 2000 });
        return;
      }

      const needsReload =
        isEdit &&
        payload.active !== false &&
        this.cameraNeedsStreamReload(camId, payload);

      if (isEdit && payload.active === false) {
        this.cancelCameraClient(camId);
        await this.refresh();
      } else if (needsReload) {
        this.configApplyingCameras.add(camId);
        this.cameraStatus[camId] = "RECONNECTING";
        await this.reloadCameraStream(camId);
      } else {
        await this.refresh();
      }
    } catch (err) {
      console.error("Save camera failed:", err);
      alert("Không thể lưu camera. Xem console để biết chi tiết.");
    } finally {
      btn.disabled = false;
      btn.textContent = "Lưu";
    }
  }

  async deleteCamera() {
    if (!this.editingCameraId) return;
    if (!confirm("Xóa camera này? Luồng stream sẽ dừng.")) return;

    const camId = this.editingCameraId;
    this.cancelCameraClient(camId);
    this.cameraModal.close();

    try {
      const res = await this.fetchWithTimeout(`/api/cameras/${camId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      await this.refresh();
    } catch (err) {
      console.error("Delete failed:", err);
      alert("Không thể xóa camera.");
    }
  }

  buildGrid() {
    this.gridEl.className = `video-grid ${GRID_CLASS[this.gridSize] || "grid-4"}`;
    this.gridEl.innerHTML = "";
    this.cells = [];

    for (let i = 0; i < this.gridSize; i += 1) {
      const root = document.createElement("article");
      root.className = "cell cell-empty";
      root.innerHTML = `
        <div class="cell-head">
          <span class="cell-title">Kênh ${i + 1}</span>
          <div class="cell-head-actions">
            <button type="button" class="btn-icon btn-cell" data-role="settings" title="Cài đặt" hidden>⚙</button>
            <button type="button" class="btn-icon btn-cell" data-role="info" title="Trạng thái" hidden>ℹ</button>
            <span class="status-badge status-stopped" data-role="status">${STATUS_LABELS.EMPTY}</span>
          </div>
        </div>
        <div class="cell-video-wrap">
          <video data-role="video" autoplay muted playsinline></video>
          <div class="cell-overlay" data-role="overlay">Chưa gán camera</div>
        </div>
        <div class="cell-foot">
          <div class="cell-meta">
            <span class="meta-item"><em>FPS</em> <strong data-role="fps">—</strong></span>
            <span class="meta-item"><em>Lat</em> <strong data-role="latency">—</strong></span>
            <span class="meta-item meta-reconnect hidden"><em>RC</em> <strong data-role="reconnect">0</strong></span>
            <span class="meta-item"><em>Up</em> <strong data-role="uptime">0s</strong></span>
          </div>
          <div class="cell-controls">
            <div class="enc-control">
              <span class="enc-label">FPS</span>
              <input type="number" min="1" max="60" value="10" data-role="fps-input" disabled aria-label="FPS" />
              <button type="button" data-role="fps-apply" disabled title="Áp dụng FPS">✓</button>
            </div>
            <div class="enc-control res-control res-control-only">
              <div class="res-presets" data-role="res-presets">${resPresetButtonsHtml(true)}</div>
            </div>
          </div>
        </div>
      `;

      const fpsInput = root.querySelector('[data-role="fps-input"]');
      const resPresets = root.querySelector('[data-role="res-presets"]');
      fpsInput.addEventListener("focus", () => {
        const cell = this.cells[i];
        if (cell) cell.editingFps = true;
      });
      fpsInput.addEventListener("blur", () => {
        const cell = this.cells[i];
        if (cell) cell.editingFps = false;
      });
      fpsInput.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") {
          const cell = this.cells[i];
          if (cell && cell.cameraId) this.applyFps(cell.cameraId, root);
        }
      });

      resPresets.querySelectorAll(".res-preset-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const cell = this.cells[i];
          if (!cell?.cameraId || btn.disabled || btn.classList.contains("active-stream")) return;
          this.applyResolution(
            cell.cameraId,
            Number(btn.dataset.width),
            Number(btn.dataset.height),
            root
          );
        });
      });

      root.querySelector('[data-role="fps-apply"]').addEventListener("click", () => {
        const cell = this.cells[i];
        if (cell && cell.cameraId) this.applyFps(cell.cameraId, root);
      });

      root.querySelector('[data-role="settings"]').addEventListener("click", () => {
        const cell = this.cells[i];
        if (cell && cell.cameraId) this.openCameraModal(cell.cameraId);
      });

      root.querySelector('[data-role="info"]').addEventListener("click", () => {
        const cell = this.cells[i];
        if (cell && cell.cameraId) this.openStatusModal(cell.cameraId);
      });

      this.gridEl.appendChild(root);
      this.cells.push({
        root,
        cameraId: null,
        slotIndex: i,
        editingFps: false,
        applyingFps: false,
        applyingRes: false,
      });
    }
  }

  resolveConfiguredFps(camera, runtime) {
    return Number(runtime.configured_fps ?? camera.fps) || this.defaultFps;
  }

  resolveConfiguredResolution(camera, runtime) {
    const w = runtime.configured_width ?? camera.width ?? this.defaultWidth;
    const h = runtime.configured_height ?? camera.height ?? this.defaultHeight;
    return { width: Number(w), height: Number(h) };
  }

  streamKey(camera) {
    const runtime = camera.runtime || {};
    const path = this.streamPath(camera);
    const fps = runtime.stream_fps ?? runtime.configured_fps ?? camera.fps ?? 15;
    const res = this.resolveConfiguredResolution(camera, runtime);
    const resKey = res.width && res.height ? `${res.width}x${res.height}` : "auto";
    const mock = camera.mock_video_name || runtime.mock_video_name || "";
    const source = camera.source_rtsp || "";
    const gen = this.playerGenerations.get(camera._id) || 0;
    return `${path}@${fps}@${resKey}@${mock}@${source}@${gen}`;
  }

  updateCellView(cell, camera) {
    const runtime = (camera && camera.runtime) || {};
    const status = resolveStatus(
      camera,
      runtime.status,
      camera ? this.cameraStatus[camera._id] : null
    );

    const titleEl = cell.root.querySelector(".cell-title");
    const statusEl = cell.root.querySelector('[data-role="status"]');
    const overlayEl = cell.root.querySelector('[data-role="overlay"]');
    const fpsEl = cell.root.querySelector('[data-role="fps"]');
    const uptimeEl = cell.root.querySelector('[data-role="uptime"]');
    const reconnectEl = cell.root.querySelector('[data-role="reconnect"]');
    const reconnectWrap = cell.root.querySelector(".meta-reconnect");
    const fpsInput = cell.root.querySelector('[data-role="fps-input"]');
    const fpsBtn = cell.root.querySelector('[data-role="fps-apply"]');
    const resPresets = cell.root.querySelector('[data-role="res-presets"]');
    const settingsBtn = cell.root.querySelector('[data-role="settings"]');
    const infoBtn = cell.root.querySelector('[data-role="info"]');

    const hasCamera = Boolean(camera);
    cell.root.classList.toggle("cell-empty", !hasCamera);

    titleEl.textContent = camera ? camera.name : `Kênh ${cell.slotIndex + 1}`;
    statusEl.textContent = status.label;
    statusEl.className = `status-badge ${statusClass(status.code)}`;
    settingsBtn.hidden = !hasCamera;
    infoBtn.hidden = !hasCamera;

    const playing = shouldPlayStream(camera, status.code) && !this.isReloading(camera._id);
    overlayEl.classList.toggle("hidden", playing);
    overlayEl.textContent = camera
      ? camera.active
        ? this.isReloading(camera._id)
          ? "Đang tải lại luồng..."
          : playing
            ? ""
            : runtime.encoding_synced === false
              ? "Đang áp dụng cấu hình..."
              : status.code === "STARTING"
                ? "Đang khởi động luồng..."
                : "Chờ luồng video..."
        : "Camera tắt"
      : "";

    const configuredFps = camera ? this.resolveConfiguredFps(camera, runtime) : 15;
    const streamFps = runtime.stream_fps != null ? Number(runtime.stream_fps) : null;
    const encodingSynced = runtime.encoding_synced !== false;

    if (!camera) {
      fpsEl.textContent = "—";
    } else if (!encodingSynced && streamFps != null && streamFps !== configuredFps) {
      fpsEl.textContent = `${configuredFps}→${streamFps}`;
      fpsEl.classList.add("fps-pending");
    } else {
      fpsEl.textContent = String(configuredFps);
      fpsEl.classList.remove("fps-pending");
    }

    const res = this.resolveConfiguredResolution(camera || {}, runtime);
    const streamW = runtime.stream_width != null ? Number(runtime.stream_width) : null;
    const streamH = runtime.stream_height != null ? Number(runtime.stream_height) : null;

    uptimeEl.textContent = formatUptime(runtime.uptime_seconds);
    const rc = runtime.reconnect_count || 0;
    reconnectEl.textContent = String(rc);
    reconnectWrap.classList.toggle("hidden", rc === 0);

    const latEl = cell.root.querySelector('[data-role="latency"]');
    if (latEl && camera) {
      const entry = this.players.get(camera._id);
      latEl.textContent = formatLatency(entry ? entry.latencyMs : null);
    } else if (latEl) {
      latEl.textContent = "—";
    }

    const encLocked =
      !camera || runtime.mode === "passthrough" || cell.applyingFps || cell.applyingRes;
    fpsInput.disabled = encLocked;
    if (!cell.editingFps) fpsInput.value = configuredFps;
    fpsBtn.disabled = encLocked;
    fpsBtn.title = encLocked && camera && runtime.mode === "passthrough"
      ? "Không đổi encoding với luồng passthrough"
      : "Áp dụng FPS";

    this.syncResPresetGroup(resPresets, res.width, res.height, {
      streamW: streamW,
      streamH: streamH,
      disabled: encLocked,
      applying: Boolean(cell.applyingRes),
      encodingSynced,
    });

    cell.cameraId = camera ? camera._id : null;
  }

  syncPlayers() {
    const activeIds = new Set();
    const slotMap = this.camerasBySlot();

    for (let i = 0; i < this.gridSize; i += 1) {
      const camera = slotMap.get(i) || null;
      const cell = this.cells[i];
      if (!cell) continue;

      this.updateCellView(cell, camera);

      if (!camera) {
        if (cell.cameraId) this.stopPlayer(cell.cameraId);
        continue;
      }

      const statusCode = resolveStatus(
        camera,
        camera.runtime && camera.runtime.status,
        this.cameraStatus[camera._id]
      ).code;

      const hasPlayer = this.players.has(camera._id);
      if (
        !shouldKeepPlayer(camera, statusCode, hasPlayer) ||
        (this.isReloading(camera._id) && statusCode === "DISCONNECTED")
      ) {
        if (cell.cameraId) this.stopPlayer(cell.cameraId);
        continue;
      }

      activeIds.add(camera._id);
      this.ensurePlayer(camera._id, cell.root.querySelector('[data-role="video"]'));
    }

    for (const camId of [...this.players.keys()]) {
      if (!activeIds.has(camId)) this.stopPlayer(camId);
    }
  }

  streamPath(camera) {
    if (camera.runtime && camera.runtime.playback_path) {
      return camera.runtime.playback_path;
    }
    const match = camera.source_rtsp && camera.source_rtsp.match(/rtsp:\/\/[^/]+\/(.+)/);
    if (match && !match[1].startsWith("live/cam_")) return match[1];
    return `live/cam_${camera._id}`;
  }

  ensurePlayer(cameraId, videoEl) {
    const camera = this.cameras.find((item) => item._id === cameraId);
    if (!camera) return;

    const key = this.streamKey(camera);
    const existing = this.players.get(cameraId);
    if (existing && existing.videoEl === videoEl && existing.streamKey === key) return;

    this.stopPlayer(cameraId);
    const path = this.streamPath(camera);

    if (this.playback === "webrtc" && typeof MediaMTXWebRTCReader !== "undefined") {
      const url = `${this.webrtcBase}/${path}/whep`;
      const reader = new MediaMTXWebRTCReader({
        url,
        onError: (err) => console.warn(`[cam ${cameraId}]`, err),
        onTrack: (evt) => {
          videoEl.srcObject = evt.streams[0];
        },
      });
      this.players.set(cameraId, { type: "webrtc", reader, videoEl, streamKey: key });
      return;
    }

    const cacheBust = encodeURIComponent(key);
    const url = `${this.hlsBase}/${path}/index.m3u8?_=${cacheBust}`;

    if (typeof Hls !== "undefined" && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 10,
        liveSyncDurationCount: 2,
      });
      const entry = {
        type: "hls",
        hls,
        videoEl,
        streamKey: key,
        hlsRetries: 0,
      };
      hls.loadSource(url);
      hls.attachMedia(videoEl);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        videoEl.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        console.warn(`[cam ${cameraId}] HLS fatal error`, data);
        if (
          data.type === Hls.ErrorTypes.NETWORK_ERROR &&
          entry.hlsRetries < 5
        ) {
          entry.hlsRetries += 1;
          setTimeout(() => {
            if (this.players.get(cameraId) === entry) {
              hls.loadSource(url);
            }
          }, 1500);
        }
      });
      this.players.set(cameraId, entry);
      return;
    }

    if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
      videoEl.src = url;
      videoEl.play().catch(() => {});
      this.players.set(cameraId, { type: "native-hls", videoEl, streamKey: key });
    }
  }

  stopPlayer(cameraId) {
    if (!cameraId) return;
    const entry = this.players.get(cameraId);
    if (!entry) return;

    if (entry.type === "webrtc" && entry.reader) entry.reader.close();
    if (entry.hls) entry.hls.destroy();
    if (entry.videoEl) {
      entry.videoEl.pause();
      entry.videoEl.removeAttribute("src");
      entry.videoEl.srcObject = null;
      entry.videoEl.load();
    }
    this.players.delete(cameraId);
  }

  closeAllPlayers() {
    for (const camId of [...this.players.keys()]) this.stopPlayer(camId);
  }

  findCellByCameraId(cameraId) {
    return this.cells.find((cell) => cell.cameraId === cameraId);
  }

  async applyResolution(cameraId, width, height, cellRoot) {
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < 160 ||
      width > 3840 ||
      height < 120 ||
      height > 2160
    ) {
      alert("Độ phân giải không hợp lệ");
      return;
    }

    const cell = this.cells.find((item) => item.root === cellRoot);
    const cam = this.cameras.find((item) => item._id === cameraId);
    const rt = (cam && cam.runtime) || {};
    const streamW = rt.stream_width != null ? Number(rt.stream_width) : null;
    const streamH = rt.stream_height != null ? Number(rt.stream_height) : null;
    if (streamW === width && streamH === height) return;

    this.configApplyingCameras.add(cameraId);
    this.cameraStatus[cameraId] = "RECONNECTING";
    if (cell) cell.applyingRes = true;
    const resPresets = cellRoot.querySelector('[data-role="res-presets"]');
    this.syncResPresetGroup(resPresets, width, height, {
      streamW: width,
      streamH: height,
      applying: true,
      encodingSynced: false,
    });

    try {
      const res = await fetch(`/api/cameras/${cameraId}/resolution`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ width, height }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail || res.statusText);
      }
      const updated = await res.json();
      const idx = this.cameras.findIndex((item) => item._id === cameraId);
      if (idx >= 0) this.cameras[idx] = updated;

      await this.reloadCameraStream(cameraId);
    } catch (err) {
      console.error("Resolution update failed:", err);
      alert("Không thể đổi độ phân giải. Xem console để biết chi tiết.");
    } finally {
      if (cell) cell.applyingRes = false;
      this.configApplyingCameras.delete(cameraId);
      const camAfter = this.cameras.find((item) => item._id === cameraId);
      const targetCell = cell || this.findCellByCameraId(cameraId);
      if (camAfter && targetCell) this.updateCellView(targetCell, camAfter);
    }
  }

  async applyFps(cameraId, cellRoot) {
    const input = cellRoot.querySelector('[data-role="fps-input"]');
    const btn = cellRoot.querySelector('[data-role="fps-apply"]');
    const fps = Number(input.value);
    if (!Number.isFinite(fps) || fps < 1 || fps > 60) {
      alert("FPS phải từ 1 đến 60");
      return;
    }

    this.configApplyingCameras.add(cameraId);
    this.cameraStatus[cameraId] = "RECONNECTING";
    const cell = this.cells.find((item) => item.root === cellRoot);
    if (cell) cell.applyingFps = true;
    btn.disabled = true;
    btn.textContent = "…";

    try {
      const res = await fetch(`/api/cameras/${cameraId}/fps`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fps }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail || res.statusText);
      }
      const updated = await res.json();
      const idx = this.cameras.findIndex((item) => item._id === cameraId);
      if (idx >= 0) this.cameras[idx] = updated;

      await this.reloadCameraStream(cameraId);
    } catch (err) {
      console.error("FPS update failed:", err);
      alert("Không thể đổi FPS. Xem console để biết chi tiết.");
    } finally {
      if (cell) {
        cell.applyingFps = false;
        cell.editingFps = false;
      }
      this.configApplyingCameras.delete(cameraId);
      btn.textContent = "✓";
      const cam = this.cameras.find((item) => item._id === cameraId);
      const targetCell = cell || this.findCellByCameraId(cameraId);
      if (cam && targetCell) this.updateCellView(targetCell, cam);
    }
  }
}

const dashboard = new Dashboard();

window.addEventListener("load", () => {
  dashboard.init();
});

window.addEventListener("beforeunload", () => {
  dashboard.closeAllPlayers();
});
