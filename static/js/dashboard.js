const STATUS_LABELS = {
  CONNECTED: "Connected",
  DISCONNECTED: "Disconnected",
  RECONNECTING: "Reconnecting",
  STARTING: "Reconnecting",
  RUNNING: "Connected",
  FAILED: "Disconnected",
  STOPPED: "Stopped",
  STOPPING: "Stopped",
  INACTIVE: "Inactive",
  EMPTY: "Empty",
  STALL: "Disconnected",
};

const GRID_CLASS = {
  4: "grid-4",
  9: "grid-9",
  16: "grid-16",
  32: "grid-32",
};

const STALL_REPORT_COOLDOWN_MS = 60000;

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
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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
  { label: "LD", width: 480, height: 270, title: "480×270 — Lightweight, suitable for ~32 channels" },
  { label: "SD", width: 640, height: 360, title: "640×360 — Default grid monitoring" },
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
  } else if (rtStatus === "STARTING" || rtStatus === "STOPPING") {
    code = "RECONNECTING";
  } else if (rtStatus === "FAILED" || rtStatus === "STALL") {
    code = "DISCONNECTED";
  } else if (rtStatus === "STOPPED" || !rtStatus) {
    code = camera.active ? "RECONNECTING" : "DISCONNECTED";
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
    this.configApplyStartedAt = new Map();
    this.playerGenerations = new Map();
    this.stallTrack = new WeakMap();
    this.stallThresholdMs = 10000;
    this.stallReportedAt = new Map();
    this.playbackHealthTimer = null;
    this.configPendingStorageKey = "orbro_config_pending";
  }

  loadPendingConfigFromSession() {
    try {
      const raw = sessionStorage.getItem(this.configPendingStorageKey);
      if (!raw) return;
      const entries = JSON.parse(raw);
      const now = Date.now();
      for (const [cameraId, started] of Object.entries(entries)) {
        if (now - Number(started) > 120000) continue;
        this.configApplyingCameras.add(cameraId);
        this.configApplyStartedAt.set(cameraId, Number(started));
      }
    } catch {
      sessionStorage.removeItem(this.configPendingStorageKey);
    }
  }

  persistPendingConfigToSession() {
    const entries = {};
    for (const cameraId of this.configApplyingCameras) {
      entries[cameraId] = this.configApplyStartedAt.get(cameraId) || Date.now();
    }
    if (Object.keys(entries).length) {
      sessionStorage.setItem(this.configPendingStorageKey, JSON.stringify(entries));
    } else {
      sessionStorage.removeItem(this.configPendingStorageKey);
    }
  }

  markConfigPending(cameraId) {
    this.configApplyingCameras.add(cameraId);
    this.configApplyStartedAt.set(cameraId, Date.now());
    this.cameraStatus[cameraId] = "RECONNECTING";
    this.persistPendingConfigToSession();
  }

  clearConfigPending(cameraId) {
    this.configApplyingCameras.delete(cameraId);
    this.configApplyStartedAt.delete(cameraId);
    this.persistPendingConfigToSession();
  }

  clearConfigPendingIfReady(cameraId, runtime = {}) {
    if (!this.configApplyingCameras.has(cameraId)) return;
    const rt = runtime || {};
    if (rt.status === "RUNNING" && rt.encoding_synced !== false && rt.running !== false) {
      this.clearConfigPending(cameraId);
      return;
    }
    const started = this.configApplyStartedAt.get(cameraId) || 0;
    if (Date.now() - started > 120000) {
      this.clearConfigPending(cameraId);
    }
  }

  isConfigPending(cameraId, runtime = {}) {
    this.clearConfigPendingIfReady(cameraId, runtime);
    return this.configApplyingCameras.has(cameraId);
  }

  mergeCameraStatuses(globalStatus) {
    for (const cam of this.cameras) {
      const id = cam._id;
      const rt = cam.runtime || {};

      if (!cam.active) {
        this.cameraStatus[id] = "INACTIVE";
        continue;
      }

      const pending =
        this.isConfigPending(id, rt) ||
        this.reloadingCameras.has(id) ||
        rt.sync_in_progress ||
        rt.encoding_synced === false;

      if (pending || rt.status === "STARTING" || rt.status === "STOPPING") {
        this.cameraStatus[id] = "RECONNECTING";
        continue;
      }

      if (rt.status === "RUNNING" && rt.running !== false) {
        this.cameraStatus[id] = "CONNECTED";
        continue;
      }

      if (rt.status === "FAILED" || rt.status === "STALL") {
        this.cameraStatus[id] = "DISCONNECTED";
        continue;
      }

      if (!rt.status || rt.status === "STOPPED") {
        this.cameraStatus[id] = "RECONNECTING";
        continue;
      }

      this.cameraStatus[id] = globalStatus[id] || cam.display_status || "DISCONNECTED";
    }
  }

  logsUrl(cameraId = null) {
    return cameraId ? `/logs?camera_id=${encodeURIComponent(cameraId)}` : "/logs";
  }

  async resumePendingCameras() {
    for (const cameraId of [...this.configApplyingCameras]) {
      const cam = this.cameras.find((item) => item._id === cameraId);
      if (!cam?.active) {
        this.clearConfigPending(cameraId);
        continue;
      }
      const rt = cam.runtime || {};
      this.clearConfigPendingIfReady(cameraId, rt);
      if (!this.configApplyingCameras.has(cameraId)) continue;
      if (rt.status === "RUNNING" && rt.encoding_synced !== false && rt.running !== false) {
        this.bumpPlayerGeneration(cameraId);
        this.stopPlayer(cameraId);
        this.clearConfigPending(cameraId);
        continue;
      }
      await this.reloadCameraStream(cameraId);
    }
    this.syncPlayers();
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
        throw new Error(rt.last_error || "Stream failed to start");
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

    console.warn(`[cam ${cameraId}] stream sync timeout, trying to play again`);
    return null;
  }

  async reloadCameraStream(cameraId, { hlsWarmupMs = 0 } = {}) {
    this.markConfigPending(cameraId);
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
    }

    await this.refresh();
    this.syncPlayers();
  }

  async init() {
    this.loadPendingConfigFromSession();
    await this.loadConfig();
    await this.loadMockVideos();

    this.gridSizeManual = localStorage.getItem("gridSizeManual") === "1";
    if (this.gridSizeManual) {
      this.gridSize = Math.max(4, Number(localStorage.getItem("gridSize") || 4));
    } else {
      this.gridSize = 4;
    }
    this.gridSizeSelect.value = String(this.gridSize);
    this.gridSizeSelect.addEventListener("change", () => {
      this.setGridSize(Number(this.gridSizeSelect.value), { manual: true });
    });

    document.getElementById("btn-add-camera").addEventListener("click", () => this.openCameraModal());
    document.getElementById("btn-panel-add").addEventListener("click", () => this.openCameraModal());
    document.getElementById("btn-toggle-panel").addEventListener("click", () => this.togglePanel());
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
      window.location.href = this.logsUrl(id || null);
    });

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

    this.initFormResPresets();

    try {
      const camerasRes = await fetch("/api/cameras");
      if (camerasRes.ok) {
        this.cameras = await camerasRes.json();
        this.applyInitialGridSize();
      }
    } catch (err) {
      console.warn("Prefetch cameras for grid failed:", err);
    }

    this.buildGrid();
    await this.refresh();
    await this.resumePendingCameras();
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

  async reportClientStall(cameraId, message) {
    const now = Date.now();
    const last = this.stallReportedAt.get(cameraId) || 0;
    if (now - last < STALL_REPORT_COOLDOWN_MS) return;
    this.stallReportedAt.set(cameraId, now);

    try {
      await fetch("/api/system/client-stall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ camera_id: cameraId, message }),
      });
    } catch (err) {
      console.warn("Client stall report failed:", err);
    }
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
        await this.reportClientStall(
          cameraId,
          `Client HLS stalled > ${this.stallThresholdMs / 1000}s`
        );
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
      this.mockVideoSelect.innerHTML = '<option value="">— Custom / RTSP —</option>';
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
    } else {
      this.clearGridSizeManual();
    }
    this.gridSizeSelect.value = String(normalized);
    localStorage.setItem("gridSize", String(normalized));
    this.closeAllPlayers();
    this.buildGrid();
    this.syncPlayers();
  }

  clearGridSizeManual() {
    this.gridSizeManual = false;
    localStorage.removeItem("gridSizeManual");
  }

  neededGridSize() {
    const n = this.cameras.length;
    if (n === 0) return 4;
    return gridSizeForCount(n);
  }

  autoFitGrid() {
    if (this.cameras.length === 0) return;

    const needed = this.neededGridSize();

    if (this.gridSizeManual) {
      if (this.gridSize < needed) {
        this.setGridSize(needed, { manual: false });
      }
      return;
    }

    if (this.gridSize !== needed) {
      this.setGridSize(needed, { manual: false });
    }
  }

  applyInitialGridSize() {
    const needed = this.neededGridSize();
    if (this.gridSizeManual) {
      if (this.gridSize < needed) {
        this.gridSize = needed;
        this.gridSizeSelect.value = String(needed);
        localStorage.setItem("gridSize", String(needed));
      }
      return;
    }
    if (this.gridSize !== needed) {
      this.gridSize = needed;
      this.gridSizeSelect.value = String(needed);
      localStorage.setItem("gridSize", String(needed));
    }
  }

  updateAddButtons() {
    const atMax = this.cameras.length >= this.maxChannels;
    for (const id of ["btn-add-camera", "btn-panel-add"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.disabled = atMax;
      el.title = atMax ? `Reached limit of ${this.maxChannels} cameras` : "";
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
      this.mergeCameraStatuses(globalStatus);
      if (metricsRes.ok) {
        this.applyMetrics(await metricsRes.json());
      }
      this.autoFitGrid();
      this.syncPlayers();
      this.renderCameraList();
      this.updateAddButtons();
      const gridCols = { 4: "2×2", 9: "3×3", 16: "4×4", 32: "4×8" };
      this.lastUpdatedEl.textContent =
        `${this.cameras.length}/${this.maxChannels} cameras · grid ${gridCols[this.gridSize] || this.gridSize} · ${new Date().toLocaleTimeString("en-US")}`;
    } catch (err) {
      console.error("Refresh failed:", err);
      this.lastUpdatedEl.textContent = "Data loading error";
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
        : "No GPU / Docker Mac does not expose GPU";
    }

    const live = data.active_streams ?? 0;
    const starting = data.starting_streams ?? 0;
    const failed = data.failed_streams ?? 0;
    let streamLabel = `${live} live`;
    if (starting > 0) streamLabel += ` · ${starting} start`;
    if (failed > 0) streamLabel += ` · ${failed} errors`;
    document.getElementById("metric-streams").textContent = streamLabel;
    document.getElementById("metric-streams").title = this.formatStreamMetricsTooltip(data);
  }

  formatStreamMetricsTooltip(data) {
    const streams = data.streams || [];
    if (streams.length === 0) return "No managed streams";
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
      this.cameraListEl.innerHTML = '<p class="panel-empty">No cameras yet. Click "+ Add" to register.</p>';
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
            <p class="camera-card-meta">Grid slot: ${cam.grid_slot != null ? Number(cam.grid_slot) + 1 : "—"}</p>
            <div class="camera-card-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-action="status" data-id="${cam._id}">Status</button>
              <a class="btn btn-ghost btn-sm" href="/logs?camera_id=${encodeURIComponent(cam._id)}">Logs</a>
              <button type="button" class="btn btn-ghost btn-sm" data-action="edit" data-id="${cam._id}">Edit</button>
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
  }

  cameraNameById(cameraId) {
    if (!cameraId) return "System";
    const cam = this.cameras.find((item) => item._id === cameraId);
    return cam ? cam.name : `Camera …${String(cameraId).slice(-6)}`;
  }

  openCameraModal(cameraId = null) {
    if (!cameraId && this.cameras.length >= this.maxChannels) {
      alert(`Reached limit of ${this.maxChannels} cameras. Delete or disable old cameras before adding.`);
      return;
    }

    this.editingCameraId = cameraId;
    const isEdit = Boolean(cameraId);
    const cam = isEdit ? this.cameras.find((c) => c._id === cameraId) : null;

    document.getElementById("modal-title").textContent = isEdit ? "Edit camera" : "Add camera";
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

      document.getElementById("status-modal-title").textContent = data.name || "Camera status";
      this.statusModal.dataset.cameraId = cameraId;

      const rows = [
        ["Status", st.label],
        ["Grid slot", data.grid_slot != null ? String(Number(data.grid_slot) + 1) : "—"],
        ["RTSP", data.source_rtsp || "—"],
        ["Configured FPS", String(data.configured?.fps ?? "—")],
        ["Stream FPS", rt.stream_fps != null ? String(rt.stream_fps) : "—"],
        ["Resolution", resolutionDisplayLabel(data.configured?.width, data.configured?.height)],
        ["Actual stream", resolutionDisplayLabel(rt.stream_width, rt.stream_height)],
        ["Relay bitrate", rt.stream_bitrate ?? "—"],
        ["Mode", rt.mode || "—"],
        ["Uptime", formatUptime(rt.uptime_seconds)],
        ["Reconnects", String(rt.reconnect_count || 0)],
        ["Save status", rt.last_stream_status || "—"],
        ["Updated at", rt.last_stream_at ? formatEventTime(rt.last_stream_at) : "—"],
        ["Latency (HLS buffer)", formatLatency(getPlaybackLatency(
          this.players.get(cameraId)?.videoEl
        ))],
        ["Playback", rt.playback_path || "—"],
      ];
      if (rt.last_error) rows.push(["Last error", rt.last_error]);

      document.getElementById("status-details").innerHTML = rows
        .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
        .join("");

      this.statusModal.showModal();
    } catch (err) {
      console.error("Status load failed:", err);
      alert("Cannot load camera status.");
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
      alert("Grid slot must be between 1 and 32.");
      return;
    }
    if (!payload.name) {
      alert("Please enter camera name.");
      return;
    }
    if (!Number.isFinite(fps) || fps < 1 || fps > 60) {
      alert("FPS must be between 1 and 60.");
      return;
    }

    const btn = document.getElementById("btn-save-camera");
    btn.disabled = true;
    btn.textContent = "Saving…";

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

      if (!isEdit) {
        this.clearGridSizeManual();
      }

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
        await this.reloadCameraStream(camId);
      } else {
        await this.refresh();
      }
    } catch (err) {
      console.error("Save camera failed:", err);
      alert("Cannot save camera. Check console for details.");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save";
    }
  }

  async deleteCamera() {
    if (!this.editingCameraId) return;
    if (!confirm("Delete this camera? The stream will be stopped.")) return;

    const camId = this.editingCameraId;
    this.cancelCameraClient(camId);
    this.cameraModal.close();

    try {
      const res = await this.fetchWithTimeout(`/api/cameras/${camId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      this.clearGridSizeManual();
      await this.refresh();
    } catch (err) {
      console.error("Delete failed:", err);
      alert("Cannot delete camera.");
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
          <span class="cell-title">Channel ${i + 1}</span>
          <div class="cell-head-actions">
            <button type="button" class="btn-icon btn-cell" data-role="settings" title="Settings" hidden>⚙</button>
            <button type="button" class="btn-icon btn-cell" data-role="info" title="Status" hidden>ℹ</button>
            <span class="status-badge status-stopped" data-role="status">${STATUS_LABELS.EMPTY}</span>
          </div>
        </div>
        <div class="cell-video-wrap">
          <video data-role="video" autoplay muted playsinline></video>
          <div class="cell-overlay" data-role="overlay">No camera assigned</div>
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
              <button type="button" data-role="fps-apply" disabled title="Apply FPS">✓</button>
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

    titleEl.textContent = camera ? camera.name : `Channel ${cell.slotIndex + 1}`;
    statusEl.textContent = status.label;
    statusEl.className = `status-badge ${statusClass(status.code)}`;
    const tipParts = [status.label];
    if (runtime.last_error) tipParts.push(runtime.last_error);
    else if (runtime.last_stream_error) tipParts.push(runtime.last_stream_error);
    if (runtime.last_stream_at) tipParts.push(`Updated: ${formatEventTime(runtime.last_stream_at)}`);
    statusEl.title = tipParts.join(" · ");
    settingsBtn.hidden = !hasCamera;
    infoBtn.hidden = !hasCamera;

    const playing = shouldPlayStream(camera, status.code) && !this.isReloading(camera._id);
    overlayEl.classList.toggle("hidden", playing);
    overlayEl.textContent = camera
      ? camera.active
        ? this.isReloading(camera._id)
          ? "Reloading stream..."
          : playing
            ? ""
            : runtime.encoding_synced === false
              ? "Applying configuration..."
              : status.code === "STARTING"
                ? "Starting stream..."
                : "Waiting for video stream..."
        : "Camera off"
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

    uptimeEl.textContent =
      runtime.running && status.code === "CONNECTED"
        ? formatUptime(runtime.uptime_seconds)
        : status.code === "RECONNECTING"
          ? "…"
          : "—";
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
      ? "Cannot change encoding with passthrough stream"
      : "Apply FPS";

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
      alert("Invalid resolution");
      return;
    }

    const cell = this.cells.find((item) => item.root === cellRoot);
    const cam = this.cameras.find((item) => item._id === cameraId);
    const rt = (cam && cam.runtime) || {};
    const streamW = rt.stream_width != null ? Number(rt.stream_width) : null;
    const streamH = rt.stream_height != null ? Number(rt.stream_height) : null;
    if (streamW === width && streamH === height) return;

    this.markConfigPending(cameraId);
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
      alert("Cannot change resolution. Check console for details.");
    } finally {
      if (cell) cell.applyingRes = false;
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
      alert("FPS must be between 1 and 60");
      return;
    }

    this.markConfigPending(cameraId);
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
      alert("Cannot change FPS. Check console for details.");
    } finally {
      if (cell) {
        cell.applyingFps = false;
        cell.editingFps = false;
      }
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
