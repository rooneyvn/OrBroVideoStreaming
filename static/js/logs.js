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

function formatEventExtra(extra) {
  if (!extra || typeof extra !== "object") return "";
  const parts = [];
  for (const [key, val] of Object.entries(extra)) {
    if (val == null || val === "") continue;
    if (key === "simulated" || key === "source") continue;
    if (Array.isArray(val)) {
      parts.push(`${key}=${val.join(",")}`);
    } else {
      parts.push(`${key}=${val}`);
    }
  }
  return parts.join(" · ");
}

class LogsPage {
  constructor() {
    this.cameras = [];
    this.eventTypes = [];
    this.simulationTypes = [];
    this.simulationEnabled = false;
    this.page = 1;
    this.loading = false;
    this.timer = null;

    this.el = {
      camera: document.getElementById("filter-camera"),
      type: document.getElementById("filter-type"),
      from: document.getElementById("filter-from"),
      to: document.getElementById("filter-to"),
      q: document.getElementById("filter-q"),
      alertsOnly: document.getElementById("filter-alerts-only"),
      pageSize: document.getElementById("filter-page-size"),
      tbody: document.getElementById("logs-tbody"),
      summary: document.getElementById("logs-summary"),
      pagination: document.getElementById("logs-pagination"),
      autoRefresh: document.getElementById("auto-refresh"),
      testBtn: document.getElementById("btn-test-event"),
      testModal: document.getElementById("test-event-modal"),
      testType: document.getElementById("test-event-type"),
      testCamera: document.getElementById("test-event-camera"),
      testMessage: document.getElementById("test-event-message"),
      testStatus: document.getElementById("test-event-status"),
      testSend: document.getElementById("btn-test-event-send"),
    };

    this.labels = window.STREAM_EVENT_LABELS || {};
    this.typeClass = window.STREAM_EVENT_CLASS || {};
  }

  readUrlParams() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("camera_id")) this.el.camera.dataset.initial = params.get("camera_id");
    if (params.get("type")) this.el.type.dataset.initial = params.get("type");
    if (params.get("page")) this.page = Math.max(1, Number(params.get("page")) || 1);
    if (params.get("alerts_only") === "1") this.el.alertsOnly.checked = true;
    if (params.get("q")) this.el.q.value = params.get("q");
    if (params.get("from")) this.el.from.value = params.get("from").slice(0, 10);
    if (params.get("to")) this.el.to.value = params.get("to").slice(0, 10);
    if (params.get("page_size")) this.el.pageSize.value = params.get("page_size");
  }

  syncUrl() {
    const params = new URLSearchParams();
    if (this.el.camera.value) params.set("camera_id", this.el.camera.value);
    if (this.el.type.value) params.set("type", this.el.type.value);
    if (this.el.from.value) params.set("from", this.el.from.value);
    if (this.el.to.value) params.set("to", this.el.to.value);
    if (this.el.q.value.trim()) params.set("q", this.el.q.value.trim());
    if (this.el.alertsOnly.checked) params.set("alerts_only", "1");
    if (this.page > 1) params.set("page", String(this.page));
    if (this.el.pageSize.value !== "25") params.set("page_size", this.el.pageSize.value);

    const qs = params.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", url);
  }

  cameraName(id) {
    if (!id) return "—";
    const cam = this.cameras.find((c) => c._id === id);
    return cam ? cam.name : `…${String(id).slice(-6)}`;
  }

  buildQueryParams() {
    const params = new URLSearchParams();
    params.set("page", String(this.page));
    params.set("page_size", this.el.pageSize.value || "25");
    if (this.el.camera.value) params.set("camera_id", this.el.camera.value);
    if (this.el.type.value) params.set("event_type", this.el.type.value);
    if (this.el.from.value) params.set("from_ts", this.el.from.value);
    if (this.el.to.value) params.set("to_ts", this.el.to.value);
    if (this.el.q.value.trim()) params.set("q", this.el.q.value.trim());
    if (this.el.alertsOnly.checked) params.set("alerts_only", "true");
    return params;
  }

  async loadFilters() {
    const [camRes, typeRes] = await Promise.all([
      fetch("/api/cameras"),
      fetch("/api/system/event-types"),
    ]);

    if (camRes.ok) {
      this.cameras = await camRes.json();
      const initial = this.el.camera.dataset.initial || "";
      this.el.camera.innerHTML =
        '<option value="">All</option>' +
        this.cameras
          .map(
            (c) =>
              `<option value="${escapeHtml(c._id)}"${c._id === initial ? " selected" : ""}>${escapeHtml(c.name)}</option>`
          )
          .join("");
    }

    if (typeRes.ok) {
      const data = await typeRes.json();
      this.eventTypes = data.types || [];
      this.simulationTypes = data.simulation_types || [];
      this.simulationEnabled = Boolean(data.simulation_enabled);
      const initial = this.el.type.dataset.initial || "";
      this.el.type.innerHTML =
        '<option value="">All</option>' +
        this.eventTypes
          .map((t) => {
            const label = this.labels[t] || t;
            return `<option value="${escapeHtml(t)}"${t === initial ? " selected" : ""}>${escapeHtml(label)}</option>`;
          })
          .join("");
      this.setupTestEventUI();
    }
  }

  setupTestEventUI() {
    if (!this.el.testBtn) return;

    const types = this.simulationTypes.length
      ? this.simulationTypes
      : this.eventTypes.filter((t) => t !== "unknown");

    this.el.testType.innerHTML = types
      .map((t) => {
        const label = this.labels[t] || t;
        return `<option value="${escapeHtml(t)}">${escapeHtml(label)}</option>`;
      })
      .join("");

    this.populateTestCameras();

    if (!this.simulationEnabled) {
      this.el.testBtn.title = "Requires ALLOW_EVENT_SIMULATION=1 on server";
    } else {
      this.el.testBtn.removeAttribute("title");
    }
  }

  populateTestCameras() {
    if (!this.el.testCamera) return;
    const options = this.cameras.length
      ? this.cameras.map(
          (c) => `<option value="${escapeHtml(c._id)}">${escapeHtml(c.name)}</option>`
        )
      : ['<option value="sim-test-camera">sim-test-camera</option>'];
    this.el.testCamera.innerHTML = options.join("");
    const filterCam = this.el.camera.value;
    if (filterCam) this.el.testCamera.value = filterCam;
  }

  openTestModal() {
    if (!this.el.testModal) return;
    this.populateTestCameras();
    this.el.testMessage.value = "";
    if (!this.simulationEnabled) {
      this.setTestStatus(
        "Server has not enabled ALLOW_EVENT_SIMULATION=1 — add it to docker-compose and recreate the app.",
        "err"
      );
      this.el.testSend.disabled = true;
    } else {
      this.setTestStatus("");
      this.el.testSend.disabled = false;
    }
    this.el.testModal.showModal();
  }

  setTestStatus(text, type = "") {
    if (!this.el.testStatus) return;
    if (!text) {
      this.el.testStatus.hidden = true;
      this.el.testStatus.textContent = "";
      this.el.testStatus.className = "test-event-status";
      return;
    }
    this.el.testStatus.hidden = false;
    this.el.testStatus.textContent = text;
    this.el.testStatus.className = `test-event-status ${type}`.trim();
  }

  async sendTestEvent() {
    const eventType = this.el.testType.value;
    const cameraId = this.el.testCamera.value;
    const message = this.el.testMessage.value.trim();
    if (!eventType || !cameraId) return;

    this.el.testSend.disabled = true;
    this.setTestStatus("Sending...", "");

    const payload = { event_type: eventType, camera_id: cameraId };
    if (message) payload.message = message;

    try {
      const res = await fetch("/api/system/simulate-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = body.detail;
        const msg =
          typeof detail === "string"
            ? detail
            : Array.isArray(detail)
              ? detail.map((d) => d.msg || JSON.stringify(d)).join(", ")
              : res.statusText;
        throw new Error(msg);
      }
      this.setTestStatus("Event recorded in logs.", "ok");
      this.page = 1;
      await this.fetchLogs();
      window.setTimeout(() => {
        if (this.el.testModal.open) this.el.testModal.close();
      }, 700);
    } catch (err) {
      console.error(err);
      this.setTestStatus(err.message || "Cannot send test event.", "err");
    } finally {
      this.el.testSend.disabled = false;
    }
  }

  async fetchLogs() {
    if (this.loading) return;
    this.loading = true;
    this.el.summary.textContent = "Loading...";

    try {
      const res = await fetch(`/api/system/events?${this.buildQueryParams()}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      this.renderTable(data.events || []);
      this.renderPagination(data.page, data.total_pages, data.total);
      this.syncUrl();
    } catch (err) {
      console.error(err);
      this.el.tbody.innerHTML =
        '<tr><td colspan="5" class="logs-empty">Cannot load logs.</td></tr>';
      this.el.summary.textContent = "Data loading error";
      this.el.pagination.innerHTML = "";
    } finally {
      this.loading = false;
    }
  }

  renderTable(events) {
    if (!events.length) {
      this.el.tbody.innerHTML =
        '<tr><td colspan="5" class="logs-empty">No events match the filter.</td></tr>';
      return;
    }

    this.el.tbody.innerHTML = events
      .map((evt) => {
        const type = evt.type || "unknown";
        const typeLabel = this.labels[type] || type;
        const cls = this.typeClass[type] || "event-type-info";
        const extra = formatEventExtra(evt.extra);
        const testBadge = evt.extra?.simulated
          ? '<span class="event-test-badge" title="Test event">test</span>'
          : "";
        return `<tr>
          <td><time datetime="${escapeHtml(evt.created_at || "")}">${escapeHtml(formatEventTime(evt.created_at))}</time></td>
          <td><span class="event-type ${cls}">${escapeHtml(typeLabel)}</span>${testBadge}</td>
          <td>${escapeHtml(this.cameraName(evt.camera_id))}</td>
          <td class="col-message">${escapeHtml(evt.message || "—")}</td>
          <td class="col-extra">${escapeHtml(extra || "—")}</td>
        </tr>`;
      })
      .join("");
  }

  renderPagination(page, totalPages, total) {
    this.el.summary.textContent = `${total} events · page ${page}/${totalPages} · updated ${new Date().toLocaleTimeString("en-US")}`;

    const parts = [];
    parts.push(
      `<button type="button" class="page-btn" data-page="${page - 1}"${page <= 1 ? " disabled" : ""}>‹</button>`
    );

    const windowSize = 5;
    let start = Math.max(1, page - Math.floor(windowSize / 2));
    let end = Math.min(totalPages, start + windowSize - 1);
    start = Math.max(1, end - windowSize + 1);

    for (let p = start; p <= end; p += 1) {
      parts.push(
        `<button type="button" class="page-btn${p === page ? " active" : ""}" data-page="${p}">${p}</button>`
      );
    }

    parts.push(
      `<button type="button" class="page-btn" data-page="${page + 1}"${page >= totalPages ? " disabled" : ""}>›</button>`
    );
    parts.push(`<span class="page-info">${total} rows</span>`);

    this.el.pagination.innerHTML = parts.join("");
    this.el.pagination.querySelectorAll(".page-btn[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = Number(btn.dataset.page);
        if (!Number.isFinite(next) || next < 1 || next > totalPages) return;
        this.page = next;
        this.fetchLogs();
      });
    });
  }

  resetFilters() {
    this.el.camera.value = "";
    this.el.type.value = "";
    this.el.from.value = "";
    this.el.to.value = "";
    this.el.q.value = "";
    this.el.alertsOnly.checked = false;
    this.el.pageSize.value = "25";
    this.page = 1;
    this.fetchLogs();
  }

  bindEvents() {
    document.getElementById("btn-apply").addEventListener("click", () => {
      this.page = 1;
      this.fetchLogs();
    });
    document.getElementById("btn-reset").addEventListener("click", () => this.resetFilters());
    document.getElementById("btn-refresh").addEventListener("click", () => this.fetchLogs());
    if (this.el.testBtn) {
      this.el.testBtn.addEventListener("click", () => this.openTestModal());
    }
    if (this.el.testSend) {
      this.el.testSend.addEventListener("click", () => this.sendTestEvent());
    }
    if (this.el.testModal) {
      this.el.testModal.querySelectorAll("[data-action='close-test-event']").forEach((el) => {
        el.addEventListener("click", () => this.el.testModal.close());
      });
    }
    this.el.q.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.page = 1;
        this.fetchLogs();
      }
    });
    this.el.autoRefresh.addEventListener("change", () => this.setupAutoRefresh());
  }

  setupAutoRefresh() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.el.autoRefresh.checked) {
      this.timer = setInterval(() => this.fetchLogs(), 10000);
    }
  }

  async init() {
    this.readUrlParams();
    this.bindEvents();
    await this.loadFilters();
    await this.fetchLogs();
    this.setupAutoRefresh();
  }
}

window.addEventListener("load", () => {
  new LogsPage().init();
});
