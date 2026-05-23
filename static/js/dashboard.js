const STATUS_LABELS = {
  CONNECTED: "Live",
  DISCONNECTED: "Mất",
  RECONNECTING: "Kết nối lại",
  STARTING: "Đang kết nối",
  RUNNING: "Live",
  FAILED: "Lỗi",
  STOPPED: "Dừng",
  STOPPING: "Dừng",
  INACTIVE: "Tắt",
  EMPTY: "Trống",
};

const GRID_CLASS = {
  4: "grid-4",
  9: "grid-9",
  16: "grid-16",
  32: "grid-32",
};

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function resolveStatus(camera, runtimeStatus, globalStatus) {
  if (!camera) return { code: "EMPTY", label: STATUS_LABELS.EMPTY };
  if (!camera.active) return { code: "INACTIVE", label: STATUS_LABELS.INACTIVE };

  const code =
    globalStatus ||
    runtimeStatus ||
    (camera.runtime && camera.runtime.status) ||
    "DISCONNECTED";

  const normalized = code === "RUNNING" ? "CONNECTED" : code;
  return {
    code: normalized,
    label: STATUS_LABELS[normalized] || normalized,
  };
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
    this.hlsBase = `http://${window.location.hostname}:8888`;
    this.webrtcBase = `http://${window.location.hostname}:8889`;
    this.playback = "hls";
    this.maxChannels = 32;
    this.gridSize = 4;
    this.cameras = [];
    this.cameraStatus = {};
    this.players = new Map();
    this.cells = [];
    this.pollTimer = null;
    this.metricsTimer = null;
  }

  async init() {
    await this.loadConfig();
    this.gridSize = Number(localStorage.getItem("gridSize") || 4);
    this.gridSizeSelect.value = String(this.gridSize);
    this.gridSizeSelect.addEventListener("change", () => {
      this.gridSize = Number(this.gridSizeSelect.value);
      localStorage.setItem("gridSize", String(this.gridSize));
      this.closeAllPlayers();
      this.buildGrid();
      this.syncPlayers();
    });

    this.buildGrid();
    await this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), 4000);
    this.metricsTimer = setInterval(() => this.refreshMetrics(), 5000);
  }

  async loadConfig() {
    try {
      const res = await fetch("/api/system/config");
      if (!res.ok) return;
      const config = await res.json();
      const hlsPort = config.hls_port || 8888;
      const webrtcPort = config.webrtc_port || 8889;
      this.hlsBase = `http://${window.location.hostname}:${hlsPort}`;
      this.webrtcBase = `http://${window.location.hostname}:${webrtcPort}`;
      this.playback = config.playback || "hls";
      this.maxChannels = config.max_channels || 32;
    } catch (err) {
      console.warn("Config load failed:", err);
    }
  }

  autoFitGrid() {
    const n = this.cameras.length;
    if (n === 0) return;
    const fit = gridSizeForCount(n);
    if (this.gridSize === fit) return;
    this.gridSize = fit;
    this.gridSizeSelect.value = String(fit);
    localStorage.setItem("gridSize", String(fit));
    this.closeAllPlayers();
    this.buildGrid();
  }

  async refresh() {
    try {
      const [camerasRes, statusRes] = await Promise.all([
        fetch("/api/cameras"),
        fetch("/api/system/camera-status"),
      ]);
      this.cameras = camerasRes.ok ? await camerasRes.json() : [];
      this.cameraStatus = statusRes.ok ? await statusRes.json() : {};
      this.autoFitGrid();
      this.syncPlayers();
      this.lastUpdatedEl.textContent = `${this.cameras.length} camera · ${new Date().toLocaleTimeString("vi-VN")}`;
      await this.refreshMetrics();
    } catch (err) {
      console.error("Refresh failed:", err);
      this.lastUpdatedEl.textContent = "Lỗi tải dữ liệu";
    }
  }

  async refreshMetrics() {
    try {
      const res = await fetch("/api/system/metrics");
      if (!res.ok) return;
      const data = await res.json();
      document.getElementById("metric-cpu").textContent = `${data.cpu_percent.toFixed(1)}%`;
      document.getElementById("metric-memory").textContent = `${data.memory_percent.toFixed(1)}%`;
      document.getElementById("metric-streams").textContent = String(data.active_streams);
    } catch (err) {
      console.warn("Metrics failed:", err);
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
          <span class="status-badge status-stopped" data-role="status">${STATUS_LABELS.EMPTY}</span>
        </div>
        <div class="cell-video-wrap">
          <video data-role="video" autoplay muted playsinline></video>
          <div class="cell-overlay" data-role="overlay">Chưa gán camera</div>
        </div>
        <div class="cell-foot">
          <div class="cell-meta">
            <span class="meta-item"><em>FPS</em> <strong data-role="fps">—</strong></span>
            <span class="meta-item meta-reconnect hidden"><em>RC</em> <strong data-role="reconnect">0</strong></span>
            <span class="meta-item"><em>Up</em> <strong data-role="uptime">0s</strong></span>
          </div>
          <div class="fps-control">
            <input type="number" min="1" max="60" value="15" data-role="fps-input" disabled aria-label="FPS" />
            <button type="button" data-role="fps-apply" disabled title="Áp dụng FPS">✓</button>
          </div>
        </div>
      `;

      const fpsInput = root.querySelector('[data-role="fps-input"]');
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

      const fpsBtn = root.querySelector('[data-role="fps-apply"]');
      fpsBtn.addEventListener("click", () => {
        const cell = this.cells[i];
        if (cell && cell.cameraId) {
          this.applyFps(cell.cameraId, root);
        }
      });

      this.gridEl.appendChild(root);
      this.cells.push({ root, cameraId: null, slotIndex: i, editingFps: false });
    }
  }

  resolveConfiguredFps(camera, runtime) {
    return Number(runtime.configured_fps ?? camera.fps) || 15;
  }

  streamKey(camera) {
    const runtime = camera.runtime || {};
    const path = this.streamPath(camera);
    const streamFps = runtime.stream_fps ?? runtime.configured_fps ?? camera.fps ?? 15;
    return `${path}@${streamFps}`;
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

    const hasCamera = Boolean(camera);
    cell.root.classList.toggle("cell-empty", !hasCamera);
    const hideSlot =
      this.cameras.length > 0 && cell.slotIndex >= this.cameras.length;
    cell.root.classList.toggle("cell-hidden", hideSlot);

    titleEl.textContent = camera ? camera.name : `Kênh ${cell.slotIndex + 1}`;
    statusEl.textContent = status.label;
    statusEl.className = `status-badge ${statusClass(status.code)}`;

    const playing = shouldPlayStream(camera, status.code);
    overlayEl.classList.toggle("hidden", playing);
    overlayEl.textContent = camera
      ? camera.active
        ? playing
          ? ""
          : runtime.fps_synced === false
            ? "Đang đổi FPS..."
            : "Chờ luồng video..."
        : "Camera tắt"
      : "";

    const configuredFps = camera ? this.resolveConfiguredFps(camera, runtime) : 15;
    const streamFps =
      runtime.stream_fps != null ? Number(runtime.stream_fps) : null;
    const fpsSynced = runtime.fps_synced !== false;

    if (!camera) {
      fpsEl.textContent = "—";
    } else if (!fpsSynced && streamFps != null && streamFps !== configuredFps) {
      fpsEl.textContent = `${configuredFps}→${streamFps}`;
      fpsEl.classList.add("fps-pending");
    } else {
      fpsEl.textContent = String(configuredFps);
      fpsEl.classList.remove("fps-pending");
    }

    uptimeEl.textContent = formatUptime(runtime.uptime_seconds);
    const rc = runtime.reconnect_count || 0;
    reconnectEl.textContent = String(rc);
    reconnectWrap.classList.toggle("hidden", rc === 0);

    const fpsLocked = !camera || runtime.mode === "passthrough";
    fpsInput.disabled = fpsLocked;
    if (!cell.editingFps) {
      fpsInput.value = configuredFps;
    }
    fpsBtn.disabled = fpsLocked || cell.applyingFps;
    fpsBtn.title = fpsLocked && camera
      ? "Không đổi FPS với luồng passthrough"
      : "Áp dụng FPS";

    cell.cameraId = camera ? camera._id : null;
  }

  syncPlayers() {
    const activeIds = new Set();

    for (let i = 0; i < this.gridSize; i += 1) {
      const camera = this.cameras[i] || null;
      const cell = this.cells[i];
      if (!cell) continue;

      this.updateCellView(cell, camera);

      if (cell.root.classList.contains("cell-hidden")) {
        if (cell.cameraId) this.stopPlayer(cell.cameraId);
        continue;
      }

      const statusCode = resolveStatus(
        camera,
        camera && camera.runtime && camera.runtime.status,
        camera ? this.cameraStatus[camera._id] : null
      ).code;

      if (!shouldPlayStream(camera, statusCode)) {
        if (cell.cameraId) {
          this.stopPlayer(cell.cameraId);
        }
        continue;
      }

      activeIds.add(camera._id);
      this.ensurePlayer(
        camera._id,
        cell.root.querySelector('[data-role="video"]')
      );
    }

    for (const camId of [...this.players.keys()]) {
      if (!activeIds.has(camId)) {
        this.stopPlayer(camId);
      }
    }
  }

  streamPath(camera) {
    if (camera.runtime && camera.runtime.playback_path) {
      return camera.runtime.playback_path;
    }
    const match = camera.source_rtsp && camera.source_rtsp.match(/rtsp:\/\/[^/]+\/(.+)/);
    if (match && !match[1].startsWith("live/cam_")) {
      return match[1];
    }
    return `live/cam_${camera._id}`;
  }

  ensurePlayer(cameraId, videoEl) {
    const camera = this.cameras.find((item) => item._id === cameraId);
    if (!camera) return;

    const key = this.streamKey(camera);
    const existing = this.players.get(cameraId);
    if (existing && existing.videoEl === videoEl && existing.streamKey === key) {
      return;
    }

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
      hls.loadSource(url);
      hls.attachMedia(videoEl);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        videoEl.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          console.warn(`[cam ${cameraId}] HLS fatal error`, data);
        }
      });
      this.players.set(cameraId, { type: "hls", hls, videoEl, streamKey: key });
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

    if (entry.type === "webrtc" && entry.reader) {
      entry.reader.close();
    }
    if (entry.hls) {
      entry.hls.destroy();
    }
    if (entry.videoEl) {
      entry.videoEl.pause();
      entry.videoEl.removeAttribute("src");
      entry.videoEl.srcObject = null;
      entry.videoEl.load();
    }
    this.players.delete(cameraId);
  }

  closeAllPlayers() {
    for (const camId of [...this.players.keys()]) {
      this.stopPlayer(camId);
    }
  }

  findCellByCameraId(cameraId) {
    return this.cells.find((cell) => cell.cameraId === cameraId);
  }

  async applyFps(cameraId, cellRoot) {
    const input = cellRoot.querySelector('[data-role="fps-input"]');
    const btn = cellRoot.querySelector('[data-role="fps-apply"]');
    const fps = Number(input.value);
    if (!Number.isFinite(fps) || fps < 1 || fps > 60) {
      alert("FPS phải từ 1 đến 60");
      return;
    }

    const cell = this.cells.find((item) => item.root === cellRoot);
    if (cell) cell.applyingFps = true;
    btn.disabled = true;
    btn.textContent = "…";

    this.stopPlayer(cameraId);

    try {
      const res = await fetch(`/api/cameras/${cameraId}`, {
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
      if (idx >= 0) {
        this.cameras[idx] = { ...this.cameras[idx], ...updated };
      }
      await this.refresh();
    } catch (err) {
      console.error("FPS update failed:", err);
      alert("Không thể đổi FPS. Xem console để biết chi tiết.");
    } finally {
      if (cell) {
        cell.applyingFps = false;
        cell.editingFps = false;
      }
      btn.textContent = "✓";
      const cam = this.cameras.find((item) => item._id === cameraId);
      const targetCell = cell || this.findCellByCameraId(cameraId);
      if (cam && targetCell) {
        this.updateCellView(targetCell, cam);
      }
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
