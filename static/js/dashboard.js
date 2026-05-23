const STATUS_LABELS = {
  CONNECTED: "Đã kết nối",
  DISCONNECTED: "Mất kết nối",
  RECONNECTING: "Đang kết nối lại",
  STARTING: "Đang kết nối",
  RUNNING: "Đã kết nối",
  FAILED: "Mất kết nối",
  STOPPED: "Dừng",
  STOPPING: "Đang dừng",
  INACTIVE: "Không hoạt động",
  EMPTY: "Ô trống",
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
  if (h > 0) return `${h}h ${m}m ${s}s`;
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

class Dashboard {
  constructor() {
    this.gridEl = document.getElementById("video-grid");
    this.gridSizeSelect = document.getElementById("grid-size");
    this.lastUpdatedEl = document.getElementById("last-updated");
    this.webrtcBase = `http://${window.location.hostname}:8889`;
    this.maxChannels = 32;
    this.gridSize = 4;
    this.cameras = [];
    this.cameraStatus = {};
    this.readers = new Map();
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
      this.closeAllReaders();
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
      const port = config.webrtc_port || 8889;
      this.webrtcBase = `http://${window.location.hostname}:${port}`;
      this.maxChannels = config.max_channels || 32;
    } catch (err) {
      console.warn("Config load failed:", err);
    }
  }

  async refresh() {
    try {
      const [camerasRes, statusRes] = await Promise.all([
        fetch("/api/cameras"),
        fetch("/api/system/camera-status"),
      ]);
      this.cameras = camerasRes.ok ? await camerasRes.json() : [];
      this.cameraStatus = statusRes.ok ? await statusRes.json() : {};
      this.syncPlayers();
      this.lastUpdatedEl.textContent = `Cập nhật: ${new Date().toLocaleTimeString("vi-VN")}`;
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
          <div class="cell-stats">
            <span>FPS: <strong data-role="fps">—</strong></span>
            <span>Uptime: <strong data-role="uptime">0s</strong></span>
            <span>Reconnect: <strong data-role="reconnect">0</strong></span>
          </div>
          <div class="fps-control">
            <input type="number" min="1" max="60" value="15" data-role="fps-input" disabled />
            <button type="button" data-role="fps-apply" disabled>FPS</button>
          </div>
        </div>
      `;

      const fpsBtn = root.querySelector('[data-role="fps-apply"]');
      fpsBtn.addEventListener("click", () => {
        const cell = this.cells[i];
        if (cell && cell.cameraId) {
          this.applyFps(cell.cameraId, root);
        }
      });

      this.gridEl.appendChild(root);
      this.cells.push({ root, cameraId: null, slotIndex: i });
    }
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
    const fpsInput = cell.root.querySelector('[data-role="fps-input"]');
    const fpsBtn = cell.root.querySelector('[data-role="fps-apply"]');

    cell.root.classList.toggle("cell-empty", !camera);
    titleEl.textContent = camera ? camera.name : `Kênh ${cell.slotIndex + 1}`;
    statusEl.textContent = status.label;
    statusEl.className = `status-badge ${statusClass(status.code)}`;

    const playing = shouldPlayStream(camera, status.code);
    overlayEl.classList.toggle("hidden", playing);
    overlayEl.textContent = camera
      ? camera.active
        ? playing
          ? ""
          : "Chờ luồng video..."
        : "Camera đang tắt"
      : "Chưa gán camera";

    fpsEl.textContent = camera ? String(camera.fps) : "—";
    uptimeEl.textContent = formatUptime(runtime.uptime_seconds);
    reconnectEl.textContent = String(runtime.reconnect_count || 0);

    fpsInput.disabled = !camera;
    fpsInput.value = camera ? camera.fps : 15;
    fpsBtn.disabled = !camera;

    cell.cameraId = camera ? camera._id : null;
  }

  syncPlayers() {
    const activeIds = new Set();

    for (let i = 0; i < this.gridSize; i += 1) {
      const camera = this.cameras[i] || null;
      const cell = this.cells[i];
      if (!cell) continue;

      this.updateCellView(cell, camera);

      const statusCode = resolveStatus(
        camera,
        camera && camera.runtime && camera.runtime.status,
        camera ? this.cameraStatus[camera._id] : null
      ).code;

      if (!shouldPlayStream(camera, statusCode)) {
        if (cell.cameraId) {
          this.stopReader(cell.cameraId);
        }
        continue;
      }

      activeIds.add(camera._id);
      this.ensureReader(
        camera._id,
        cell.root.querySelector('[data-role="video"]')
      );
    }

    for (const camId of [...this.readers.keys()]) {
      if (!activeIds.has(camId)) {
        this.stopReader(camId);
      }
    }
  }

  ensureReader(cameraId, videoEl) {
    const existing = this.readers.get(cameraId);
    if (existing && existing.videoEl === videoEl) return;

    if (existing) {
      existing.reader.close();
      this.readers.delete(cameraId);
    }

    const url = `${this.webrtcBase}/live/cam_${cameraId}/whep`;
    const reader = new MediaMTXWebRTCReader({
      url,
      onError: (err) => console.warn(`[cam ${cameraId}]`, err),
      onTrack: (evt) => {
        videoEl.srcObject = evt.streams[0];
      },
    });

    this.readers.set(cameraId, { reader, videoEl });
  }

  stopReader(cameraId) {
    if (!cameraId) return;
    const entry = this.readers.get(cameraId);
    if (!entry) return;
    entry.reader.close();
    if (entry.videoEl) entry.videoEl.srcObject = null;
    this.readers.delete(cameraId);
  }

  closeAllReaders() {
    for (const camId of [...this.readers.keys()]) {
      this.stopReader(camId);
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

    btn.disabled = true;
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
      await this.refresh();
    } catch (err) {
      console.error("FPS update failed:", err);
      alert("Không thể đổi FPS. Xem console để biết chi tiết.");
    } finally {
      btn.disabled = false;
    }
  }
}

const dashboard = new Dashboard();

window.addEventListener("load", () => {
  dashboard.init();
});

window.addEventListener("beforeunload", () => {
  dashboard.closeAllReaders();
});
