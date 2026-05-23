### Camera Management and Video Streaming System

**Objective:** Implement a system that allows monitoring multiple video streams on a web interface, while managing camera information and the status of the streams.

**Implementation Requirements:**

- Ability to monitor videos on a web interface.
- Loop a provided video file as an RTSP stream in a local environment.
- Implement an API to register RTSP cameras.
- Receive input as an RTSP stream from registered cameras.
- Display a minimum of 4 videos simultaneously.
- System architecture must be scalable up to 32 channels.
- Video display screen in a grid layout.
- Feature to change FPS for each cell in the grid.
- Display status per channel: Connected, Disconnected, Reconnecting.
- Display FPS or latency per channel.
- Display CPU, GPU, and Memory usage.

**Camera Management Requirements:**

- API for Create, Read, Update, and Delete (CRUD) operations for cameras.
- Manage camera settings such as RTSP URL, resolution, FPS, etc.
- Query the status of each camera.

**Status Monitoring:**

- Detect stream connection errors.
- Evaluate as an incident (failure) when no frames are received within a certain period.
- Attempt auto-reconnect.
- Log the number of reconnection attempts or the latest status.
- Display continuous uptime per channel.

**Bonus Points:**

- When configuration changes, apply immediately to the running stream.
- Send alerts or save events when an incident occurs.

**Required Content in the Report:**

- **System Architecture:** Video input, stream reception, decoding, transmission to the web interface, API, or admin dashboard.
- **Core Design Decisions:** Stream processing method, concurrent processing architecture, how to control FPS per grid cell, status monitoring method.
- **Measurement Results:** Number of concurrently processed channels, FPS per channel, latency, CPU, GPU, and memory usage.
- **Operational & Scalability Considerations:** Handling stream disconnections, decoder hangs, increasing memory capacity, identifying the first bottleneck when scaling from 8 channels to 80 or more channels.