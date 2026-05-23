# SYSTEM DESIGN AND VERIFICATION REPORT
**Project:** Camera Management and Video Streaming System (Assignment B1)
**Author:** Pham Van Nguyen

---

## 1. System Architecture
The system is designed using a Decoupled Architecture, divided into 3 core components to ensure stability and reproducibility:

1.  **Video Input:** Uses an FFmpeg container to continuously loop the `Video_BE.mp4` file into a local RTSP stream (`rtsp://mediamtx:8554/source`) or receives streams from real cameras.
2.  **Streaming Engine:** 
    * Uses **MediaMTX** as the central stream hub (RTSP Server / WebRTC Gateway) due to its ultra-low latency.
    * Uses independent **FFmpeg** processes to decode the source stream, change configurations (FPS, Resolution), and encode it back to MediaMTX.
3.  **Web Interface, API & Management:** The Backend (Python/FastAPI) provides REST API CRUD operations and monitoring. The Frontend (HTML/JS) displays a grid of HLS/WebRTC streams and calls control APIs. It acts as a Process Manager managing the FFmpeg lifecycle.

## 2. Core Design Decisions
* **Stream Processing & Concurrency:** Uses Python's `subprocess` module combined with `threading.Lock()` to manage each independent FFmpeg process. This design prevents Race Conditions when multiple API requests change configurations concurrently.
* **FPS Control per Grid Slot:** When changing FPS on a grid slot, the interface sends a `PATCH` API request for the corresponding camera ID. The backend only restarts (kill & spawn) the FFmpeg process for that specific camera with the new `-r` parameter, ensuring the new stream updates smoothly, **without causing downtime (zero-downtime)** for other grid slots.
* **State Synchronization:** Separates static configuration (DB) and runtime state in RAM. The API uses the `_enrich_runtime` function to report whether the current FFmpeg stream has actually applied the new configuration.
* **State Monitoring Method:** The backend reads the `-progress` of FFmpeg to detect frame stalls (`STALL`); the browser supplements this with client-side HLS stall detection. A 5-second monitor loop auto-reconnects; the number of reconnects and the latest error are saved to MongoDB. Event logs are debounced for 60 seconds to prevent spamming `/logs`.

## 3. Empirical Benchmarks
**Execution Environment:** Mac Pro M1 2021 (16GB RAM, SSD), Docker Engine (Does not support hardware decoding passthrough).
**Measurement Tools:** `psutil` library (Backend), Docker Stats.

| Stream Configuration (Resolution @ FPS) | Channels | CPU Usage | RAM Usage | Status Evaluation |
| :--- | :--- | :--- | :--- | :--- |
| **1080p @ 15fps** (Original) | 16 | **~95% - 100%** | ~1.5 GB | ❌ Software Encoding limit reached. Frame drops. |
| **640x360 @ 10fps** | 16 | **~40% - 60%** | ~1.1 GB | ✅ Stable. Suitable for Grid View display. |
| **480x270 @ 8fps** | 32 | **~70% - 90%** | ~2.0 GB | ✅ Performs well. Meets assignment goals. |
*Latency Note:* The dashboard defaults to playing **HLS** (MediaMTX port 8888). Client-side latency (HLS buffer) is typically **~1–3 seconds** depending on the segment; it can be switched to WebRTC (`DASHBOARD_PLAYBACK=webrtc`) to reduce it to **~300–500ms** if needed.

## 4. Day-2 Ops & Scalability Considerations
**4.1. Operational Resilience:**
* **Handling Broken Streams & Stalled Decoders:** The backend implements a Background Task running a loop every 5s to `poll()` the FFmpeg process status. If a stream breaks (crash/exit), the status changes to `RECONNECTING` and the stream is restarted. To handle stalled decoders, the backend monitors via the `-progress` pipe; if no frames are received for 10s, it reports `STALL` and automatically restarts FFmpeg.
* **Handling Memory Bloat:** When processing streams for a long time, RAM might leak. The solution is using child processes (`subprocess`), where each camera is an independent OS process; when a stream fails or changes configuration, the old process is completely killed, returning memory and preventing widespread memory bloat from affecting the entire system.
* **Avoiding "Zombie Processes":** Stops FFmpeg using `process.terminate()` (SIGTERM), waits 3 seconds, then uses `process.kill()` (SIGKILL) if the process is hard-hung.

**4.2. Identifying the First Bottleneck when Scaling from 8 to 80 Channels:**
Based on benchmark results, scaling the load to 80 channels will immediately face physical limits:
1.  **First Bottleneck - CPU Encoding:** Maintaining 80 independent `subprocess` instances performing Software Encoding (`libx264`) will overload CPU Context Switching and consume 100% CPU immediately. This is the earliest bottleneck before encountering RAM or Network Bandwidth issues.
2.  **Network Ingress/Egress I/O:** 80 streams pushing to MediaMTX will require significant bandwidth and cause a spike in RAM Buffers.

**4.3. Scale-out Strategy:**

*Note - Optimal decision for the test:* At a display scale of up to 32 channels on an admin screen, choosing the **FFmpeg + MediaMTX** architecture ensures a lean and resource-optimized deployment. This architecture allows the system to run smoothly in a Local/Docker environment with just a single `docker-compose up` command, excellently meeting the low latency requirement (< 0.5s with WebRTC) and automatically downscaling resolution during transcoding.

However, when the system needs to scale to 80 channels or expand for thousands of concurrent users accessing the dashboard, Bottlenecks will appear in I/O and CPU. Therefore, the upgrade plan for Production is as follows:

* **Switching Stream Processing Tools:** Switch from FFmpeg to **GStreamer** to fully leverage Zero-copy memory architecture and optimize the decoding Pipeline using hardware.
* **Deploying an SFU (Selective Forwarding Unit) Cluster:** Replace MediaMTX with **Janus Gateway** (SFU). Configure GStreamer streams to push RTP packets directly into the Janus Streaming Plugin. This solution completely isolates the Media Server's load from WebRTC streams.
* **Media Node Model & Horizontal Scaling:** Package GStreamer and Janus into a dedicated processing server (Media Server Node). When scaling, the system will replicate these Nodes into a large Cluster. Combined with an API Gateway / Load Balancer to shard camera stream connections and Viewer devices evenly across corresponding Nodes, allowing the system to scale horizontally linearly.
* **Backend Optimization with Rust (Performance & Concurrency):** FastAPI/Python is suitable for Rapid Prototyping, but when managing the state of thousands of concurrent processes (high concurrency) along with continuous I/O operations, Python will be limited by the GIL (Global Interpreter Lock) and consume a large amount of RAM. The solution is to **rewrite the core Process Manager in Rust**. Rust provides powerful native concurrency and memory safety without a Garbage Collector, helping the Backend achieve extremely high performance and strictly conserve system resources.
