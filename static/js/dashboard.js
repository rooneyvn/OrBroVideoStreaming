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

function formatResolution(width, height) {
  if (width && height) return `${width}×${height}`;
  return "auto";
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
    this.gridSize = 4;
    this.cameras = [];
    this.mockVideos = [];
    this.cameraStatus = {};
    this.players = new Map();
    this.cells = [];
    this.pollTimer = null;
    this.metricsTimer = null;
    this.editingCameraId = null;
    this.reloadingCameras = new Set();
    this.playerGenerations = new Map();
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
    await this.loadConfig();
    await this.loadMockVideos();

    this.gridSize = Number(localStorage.getItem("gridSize") || 4);
    this.gridSizeSelect.value = String(this.gridSize);
    this.gridSizeSelect.addEventListener("change", () => {
      this.gridSize = Number(this.gridSizeSelect.value);
      localStorage.setItem("gridSize", String(this.gridSize));
      this.closeAllPlayers();
      this.buildGrid();
      this.syncPlayers();
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

    this.buildGrid();
    await this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), 4000);
    this.metricsTimer = setInterval(() => this.refreshMetrics(), 5000);
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
      const [camerasRes, statusRes, metricsRes] = await Promise.all([
        fetch("/api/cameras"),
        fetch("/api/system/camera-status"),
        fetch("/api/system/metrics"),
      ]);
      this.cameras = camerasRes.ok ? await camerasRes.json() : [];
      this.cameraStatus = statusRes.ok ? await statusRes.json() : {};
      if (metricsRes.ok) {
        this.applyMetrics(await metricsRes.json());
      }
      this.autoFitGrid();
      this.syncPlayers();
      this.renderCameraList();
      this.lastUpdatedEl.textContent = `${this.cameras.length} camera · ${new Date().toLocaleTimeString("vi-VN")}`;
    } catch (err) {
      console.error("Refresh failed:", err);
      this.lastUpdatedEl.textContent = "Lỗi tải dữ liệu";
    }
  }

  applyMetrics(data) {
    document.getElementById("metric-cpu").textContent = `${data.cpu_percent.toFixed(1)}%`;
    document.getElementById("metric-memory").textContent = `${data.memory_percent.toFixed(1)}%`;

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
              <strong>${cam.name}</strong>
              <span class="status-badge ${statusClass(st.code)}">${st.label}</span>
            </div>
            <p class="camera-card-meta">${cam.source_rtsp || "—"}</p>
            <p class="camera-card-meta">${rt.configured_fps ?? cam.fps ?? 15} FPS · ${res}</p>
            <div class="camera-card-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-action="status" data-id="${cam._id}">Trạng thái</button>
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
  }

  openCameraModal(cameraId = null) {
    this.editingCameraId = cameraId;
    const isEdit = Boolean(cameraId);
    const cam = isEdit ? this.cameras.find((c) => c._id === cameraId) : null;

    document.getElementById("modal-title").textContent = isEdit ? "Sửa camera" : "Thêm camera";
    document.getElementById("form-camera-id").value = cameraId || "";
    document.getElementById("form-name").value = cam ? cam.name : "";
    document.getElementById("form-source").value = cam ? cam.source_rtsp || "" : "rtsp://mediamtx:8554/source";
    document.getElementById("form-mock-video").value = cam ? cam.mock_video_name || "" : "";
    document.getElementById("form-fps").value = cam ? cam.fps || 15 : 15;
    document.getElementById("form-width").value = cam && cam.width ? cam.width : "";
    document.getElementById("form-height").value = cam && cam.height ? cam.height : "";
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
        ["RTSP", data.source_rtsp || "—"],
        ["FPS cấu hình", String(data.configured?.fps ?? "—")],
        ["FPS luồng", rt.stream_fps != null ? String(rt.stream_fps) : "—"],
        ["Độ phân giải", formatResolution(data.configured?.width, data.configured?.height)],
        ["Luồng thực tế", formatResolution(rt.stream_width, rt.stream_height)],
        ["Chế độ", rt.mode || "—"],
        ["Uptime", formatUptime(rt.uptime_seconds)],
        ["Reconnect", String(rt.reconnect_count || 0)],
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

  buildPayloadFromForm() {
    const name = document.getElementById("form-name").value.trim();
    const source = document.getElementById("form-source").value.trim();
    const fps = Number(document.getElementById("form-fps").value);
    const active = document.getElementById("form-active").checked;
    const mock = document.getElementById("form-mock-video").value;
    const widthRaw = document.getElementById("form-width").value.trim();
    const heightRaw = document.getElementById("form-height").value.trim();

    if (!this.editingCameraId) {
      const payload = { name, source_rtsp: source, fps, active };
      if (mock) payload.mock_video_name = mock;
      if (widthRaw) payload.width = Number(widthRaw);
      if (heightRaw) payload.height = Number(heightRaw);
      return payload;
    }

    const prev = this.cameras.find((item) => item._id === this.editingCameraId);
    const payload = { name };

    if (source !== (prev?.source_rtsp || "")) payload.source_rtsp = source;
    if (fps !== Number(prev?.fps ?? 15)) payload.fps = fps;
    if (active !== (prev?.active !== false)) payload.active = active;

    const prevMock = prev?.mock_video_name || "";
    if (mock !== prevMock) payload.mock_video_name = mock;

    const prevWidth = prev?.width ? Number(prev.width) : null;
    const prevHeight = prev?.height ? Number(prev.height) : null;
    const nextWidth = widthRaw ? Number(widthRaw) : null;
    const nextHeight = heightRaw ? Number(heightRaw) : null;
    if (nextWidth !== prevWidth) payload.width = nextWidth ?? 0;
    if (nextHeight !== prevHeight) payload.height = nextHeight ?? 0;

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
            <span class="meta-item"><em>Res</em> <strong data-role="resolution">—</strong></span>
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
      this.cells.push({ root, cameraId: null, slotIndex: i, editingFps: false, applyingFps: false });
    }
  }

  resolveConfiguredFps(camera, runtime) {
    return Number(runtime.configured_fps ?? camera.fps) || 15;
  }

  resolveConfiguredResolution(camera, runtime) {
    const w = runtime.configured_width ?? camera.width;
    const h = runtime.configured_height ?? camera.height;
    return { width: w ? Number(w) : null, height: h ? Number(h) : null };
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
    const resEl = cell.root.querySelector('[data-role="resolution"]');
    const uptimeEl = cell.root.querySelector('[data-role="uptime"]');
    const reconnectEl = cell.root.querySelector('[data-role="reconnect"]');
    const reconnectWrap = cell.root.querySelector(".meta-reconnect");
    const fpsInput = cell.root.querySelector('[data-role="fps-input"]');
    const fpsBtn = cell.root.querySelector('[data-role="fps-apply"]');
    const settingsBtn = cell.root.querySelector('[data-role="settings"]');
    const infoBtn = cell.root.querySelector('[data-role="info"]');

    const hasCamera = Boolean(camera);
    cell.root.classList.toggle("cell-empty", !hasCamera);
    const hideSlot = this.cameras.length > 0 && cell.slotIndex >= this.cameras.length;
    cell.root.classList.toggle("cell-hidden", hideSlot);

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
    resEl.textContent = formatResolution(res.width, res.height);

    uptimeEl.textContent = formatUptime(runtime.uptime_seconds);
    const rc = runtime.reconnect_count || 0;
    reconnectEl.textContent = String(rc);
    reconnectWrap.classList.toggle("hidden", rc === 0);

    const fpsLocked = !camera || runtime.mode === "passthrough" || cell.applyingFps;
    fpsInput.disabled = fpsLocked;
    if (!cell.editingFps) fpsInput.value = configuredFps;
    fpsBtn.disabled = fpsLocked;
    fpsBtn.title = fpsLocked && camera && runtime.mode === "passthrough"
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

      if (!shouldPlayStream(camera, statusCode) || this.isReloading(camera._id)) {
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
