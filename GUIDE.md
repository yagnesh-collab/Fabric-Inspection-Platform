# Nextex Fabric Inspection — Complete Repository Guide

This document covers everything in this repository: what each file does, what technology it
uses, where all data comes from, how it moves through the system, and where it ends up.

---

## Table of Contents

1. [What This System Does](#1-what-this-system-does)
2. [How to Run It](#2-how-to-run-it)
3. [System Architecture](#3-system-architecture)
4. [Complete File Reference](#4-complete-file-reference)
5. [Technology Stack](#5-technology-stack)
6. [The Dataset — Where Data Comes From](#6-the-dataset--where-data-comes-from)
7. [Data Flows — How Data Moves](#7-data-flows--how-data-moves)
8. [Database — Where Data Is Stored](#8-database--where-data-is-stored)
9. [Security Controls](#9-security-controls)
10. [API Reference](#10-api-reference)
11. [Configuration Reference](#11-configuration-reference)
12. [Ports and Access URLs](#12-ports-and-access-urls)
13. [Common Commands](#13-common-commands)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. What This System Does

This project simulates an end-to-end industrial fabric defect detection pipeline. In a real
factory, a NVIDIA Jetson Orin device runs a computer-vision model against a live camera feed
pointed at a knitting machine. When it detects a defect it sends two types of cloud events:

- **new_anomaly_class** — first time a defect type has ever been seen (triggers model retraining)
- **threshold_exceeded** — any frame whose detection confidence is above 75% (triggers operator alert)

This repository reproduces the entire pipeline locally using Docker Compose. No cloud account,
no Kubernetes, no AWS required — a single command starts everything.

---

## 2. How to Run It

**Only requirement:** Docker Desktop installed and running.

```bash
# Step 1 — copy the environment file
cp .env.example .env

# Step 2 — open .env and set a strong API_KEY
#   Generate one: python3 -c "import secrets; print('nx-' + secrets.token_hex(16))"
#   IMPORTANT: do not use @ # % in passwords — they break URL parsing

# Step 3 — build and start everything
docker compose up --build

# Step 4 — open the dashboard
# http://localhost:3000
```

First run takes 2–4 minutes. Subsequent runs are fast (Docker caches layers).
Wait until the logs show `Consumer is ready` and `Dataset loaded: 422 images`.

---

## 3. System Architecture

```
  HOST MACHINE
  ┌────────────────────────────────────────────────────────────────┐
  │  port 3000 only                                                │
  │  ┌──────────────────────────────────────────────────────────┐  │
  │  │  ui  (nginx)                                             │  │
  │  │  Serves compiled React app                               │  │
  │  │  Proxies /api/consumer/  →  consumer:8000                │  │
  │  │  Proxies /api/jetson/    →  jetson-sim:8001              │  │
  │  │  Upgrades /ws/stream     →  jetson-sim:8001/stream       │  │
  │  └──────────────────────────────────────────────────────────┘  │
  │                                                                │
  │  DOCKER INTERNAL NETWORK (not reachable from host)            │
  │  ┌────────────────────┐   ┌─────────────────────────────┐     │
  │  │  jetson-sim :8001  │   │  consumer :8000              │     │
  │  │                    │   │                              │     │
  │  │  Reads images from │   │  Drains RabbitMQ queue       │     │
  │  │  data/images/      │   │  Writes to PostgreSQL        │     │
  │  │  Streams via WS    │──▶│  Exposes /health /events     │     │
  │  │  Publishes events  │   │                              │     │
  │  └────────┬───────────┘   └──────────────┬──────────────┘     │
  │           │ AMQP publish                  │ asyncpg            │
  │           ▼                               ▼                    │
  │  ┌─────────────────┐       ┌──────────────────────────┐       │
  │  │  rabbitmq :5672 │       │  postgres :5432           │       │
  │  │  queue: events  │       │  db: nextex               │       │
  │  │  durable, perst │       │  table: events            │       │
  │  └─────────────────┘       └──────────────────────────┘       │
  └────────────────────────────────────────────────────────────────┘
```

Only port **3000** is bound to the host. All other ports (5432, 5672, 8000, 8001) are
Docker-internal and unreachable from outside the container network.

---

## 4. Complete File Reference

Every file in the repository is listed here with a description of exactly what it contains
and what role it plays.

### Root level

```
.env
```
Secret credentials for this machine. Never committed. Contains database password, RabbitMQ
password, API key, and connection strings. Loaded by all five Docker containers via
`env_file: .env` in docker-compose.yml. Must be created by copying `.env.example`.

---

```
.env.example
```
Safe template committed to the repo. Contains placeholder values and instructions.
Anyone cloning the repo copies this to `.env` and fills in their own secrets.
Documents which characters are forbidden in passwords (@ # % break URL parsing).

---

```
.gitignore
```
Ensures `.env` is never committed. Also ignores `__pycache__`, `*.pyc`, `data/images/*/`
(the 422 images are committed but the glob prevents accidental re-addition), and
`ui/node_modules/` and `ui/dist/`.

---

```
docker-compose.yml
```
Defines all five services, their dependencies, environment variables, volumes, and health
checks. Key decisions:

- `rabbitmq` and `postgres` use `expose:` not `ports:` — internal only, not reachable from host
- `consumer` and `jetson-sim` also use `expose:` — only reachable through nginx proxy
- `ui` uses `ports: "3000:80"` — the only externally accessible service
- `postgres_data` is a named Docker volume — database survives container restarts
- `./data/images:/data/images:ro` mounts dataset read-only into jetson-sim
- `consumer` waits for both rabbitmq and postgres to be healthy before starting
- `jetson-sim` waits for rabbitmq to be healthy before starting
- `VITE_API_KEY` is passed as a Docker build arg to the ui build so the API key gets
  compiled into the React JavaScript bundle

---

```
README.md
```
Quick-start instructions, architecture overview, why RabbitMQ was chosen, dataset details,
security section, configuration table, and API reference.

---

```
GUIDE.md
```
This file. Complete reference for everything in the repository.

---

```
design-notes.md
```
Design decisions document covering: local disk vs MQTT for Jetson telemetry (with full
reasoning), and production readiness considerations (authentication, TLS, observability,
database hardening, horizontal scaling, device management).

---

```
task.txt
```
Original assignment specification from the hiring process. Kept for reference.

---

### consumer/

The cloud-side event ingestion service. Written in Python 3.12, runs on port 8000.

```
consumer/Dockerfile
```
Builds from `python:3.12-slim`. Copies `requirements.txt`, runs `pip install`, copies
source files. Runs `uvicorn main:app --host 0.0.0.0 --port 8000`.

---

```
consumer/requirements.txt
```
Python dependencies:
- `fastapi==0.111.0` — web framework, HTTP routing, WebSocket, middleware
- `uvicorn[standard]==0.30.1` — ASGI server (runs the FastAPI app)
- `aio-pika==9.4.1` — async AMQP client for RabbitMQ communication
- `sqlalchemy[asyncio]==2.0.30` — ORM for database access (async version)
- `asyncpg==0.29.0` — async PostgreSQL driver used by SQLAlchemy
- `alembic==1.13.1` — database migration tool (available, not actively used; schema is created at startup)
- `pydantic==2.7.1` — data validation and response model serialisation
- `pydantic-settings==2.3.0` — reads settings from environment variables
- `slowapi==0.1.9` — rate limiting middleware for FastAPI

---

```
consumer/settings.py
```
Reads environment variables using pydantic-settings. Defines four settings:
- `DATABASE_URL` — PostgreSQL async connection string
- `RABBITMQ_URL` — AMQP connection string
- `API_KEY` — shared secret required on all HTTP requests
- `ALLOWED_ORIGIN` — the only origin permitted by CORS policy

---

```
consumer/main.py
```
The entire consumer application in one file. Contains:

- **API key authentication** — `require_api_key()` dependency reads `X-API-Key` header,
  rejects requests that don't match `settings.API_KEY` with HTTP 401
- **Rate limiter** — slowapi limiter, 60 req/min default, overridden per route
- **Event ORM model** — `Event` class maps to the `events` PostgreSQL table with columns:
  id, event_type, anomaly_class, confidence, device_id, frame_id, payload, received_at
- **Database engine** — `create_async_engine` with asyncpg driver
- **In-memory state** (`_state` dict) — fast counters for processed count, backlog,
  events by type, start time, last event timestamp; reset on container restart
- **`_persist()`** — creates an Event ORM object and commits it to PostgreSQL
- **`_process_message()`** — decodes JSON from AMQP message body, calls `_persist()`,
  updates `_state` counters, acks the message (if exception occurs, message stays in queue)
- **`_consume()`** — connects to RabbitMQ, sets prefetch 10, declares the `events` queue,
  registers `_on_message` callback, starts a background `_backlog_updater` task
- **`lifespan()`** — FastAPI lifespan context: creates DB tables on startup, starts consumer
- **Security headers middleware** — adds X-Content-Type-Options, X-Frame-Options,
  X-XSS-Protection, Referrer-Policy, Cache-Control, Permissions-Policy to every response
- **CORS middleware** — restricts origin to `settings.ALLOWED_ORIGIN` only, GET method only
- **`GET /health`** — returns in-memory stats plus a live `SELECT count(*)` from PostgreSQL;
  rate limited to 30 req/min; requires API key
- **`GET /events`** — queries events table ordered by received_at DESC; `limit` capped at 200,
  `offset` capped at 100,000; rate limited to 20 req/min; requires API key

---

### jetson-sim/

The simulated Jetson device. Streams real fabric images and publishes anomaly events.
Written in Python 3.12, runs on port 8001.

```
jetson-sim/Dockerfile
```
Builds from `python:3.12-slim`. Installs `curl` (for health check tooling), then
`pip install`, then copies source. Runs `python main.py` which starts uvicorn internally.

---

```
jetson-sim/requirements.txt
```
Python dependencies:
- `aio-pika==9.4.1` — async AMQP client to publish events to RabbitMQ
- `fastapi==0.111.0` — HTTP and WebSocket server
- `uvicorn[standard]==0.30.1` — ASGI server
- `websockets==12.0` — WebSocket protocol implementation
- `Pillow==10.3.0` — opens images, resizes to 640×480, draws text overlays, encodes to JPEG
- `pydantic-settings==2.3.0` — reads environment variables
- `slowapi==0.1.9` — rate limiting on HTTP endpoints

---

```
jetson-sim/settings.py
```
Reads five environment variables:
- `RABBITMQ_URL` — where to publish events
- `FRAME_INTERVAL_MS` — milliseconds between frames (default 800 = ~1.25 fps)
- `ANOMALY_THRESHOLD` — confidence above which threshold_exceeded events are triggered (default 0.75)
- `DATASET_PATH` — path inside the container to the image folder (default `/data/images`)
- `API_KEY` — shared secret for HTTP endpoint auth
- `ALLOWED_ORIGIN` — CORS origin

---

```
jetson-sim/main.py
```
The entire simulator in one file. Contains:

- **API key auth** — same pattern as consumer; `require_api_key()` dependency on HTTP endpoints
- **Rate limiter** — slowapi, 60 req/min default
- **`DatasetLoader` class** — scans `DATASET_PATH` for subdirectories; each subdirectory name
  becomes an anomaly class; folders named good/normal/defect_free/nodefect/ok are treated as
  no-anomaly; all images shuffled randomly on startup; `next_frame()` cycles through them
  sequentially forever; raises `RuntimeError` with a clear message if directory is missing
- **`next_frame()`** — opens the next image file, converts to RGB, resizes to 640×480 using
  Pillow, assigns a mocked confidence score (0.60–0.99 for anomaly images, 0.05–0.35 for
  normal images), draws frame number and device ID text overlays, saves to JPEG bytes,
  returns both the bytes and a metadata dict
- **`_publish_event()`** — decides event type: `threshold_exceeded` if confidence > threshold;
  `new_anomaly_class` if the class has not been seen before this session; publishes to
  RabbitMQ default exchange with `routing_key="events"`, `DeliveryMode.PERSISTENT`
- **`_stream_loop()`** — runs as asyncio background task; dispatches `next_frame()` to a thread
  pool executor (CPU-bound work off the event loop); base64-encodes the JPEG; sends JSON to
  all connected WebSocket clients; calls `_publish_event()`; sleeps the remaining interval time
- **`_connect_rabbit()`** — connects with `connect_robust` (auto-reconnect); retries every 3s
  until RabbitMQ is available; declares the `events` queue as durable
- **WebSocket `/stream`** — accepts connections, adds to `_connections` set, keeps alive
  by waiting for incoming messages, removes from set on disconnect; no API key required
  (browser WebSocket API cannot send custom headers; nginx proxies only from localhost:3000)
- **`GET /stats`** — returns frames generated, events sent, connected WS clients, seen anomaly
  classes, threshold, dataset classes, total image count; requires API key

---

### data/

```
data/download_dataset.py
```
Standalone script that downloads the fabric defect dataset from HuggingFace without
requiring a Kaggle account. Downloads the parquet file from
`aaozgur/fabric-defect-dataset-v4`, extracts all 422 images, and organises them into
`data/images/<class_name>/`. Has a fallback to the AITEX dataset if the primary fails.
Only needed if you want to re-download the dataset from scratch — the images are already
included in the repository.

---

```
data/images/
├── burst/          105 images
├── lycra_run/      107 images
├── needle_break/   105 images
└── oil_stain/      105 images
```
422 real fabric defect photographs. Sourced from the
`aaozgur/fabric-defect-dataset-v4` dataset on HuggingFace (public, no login required).
Original size is 1300×400 pixels; `DatasetLoader` resizes to 640×480 at stream time.
Mounted into the `jetson-sim` container as a read-only volume at `/data/images`.
The subfolder name becomes the anomaly class name throughout the system.

---

### ui/

The React monitoring dashboard. TypeScript + Vite, compiled to static files and served by nginx.

```
ui/Dockerfile
```
Multi-stage build:
1. **Builder stage** — `node:20-alpine`: copies `package.json`, runs `npm ci`, copies source,
   receives `VITE_API_KEY` as a build argument and injects it as an environment variable,
   runs `npm run build` (tsc type-check + Vite bundle) — outputs `dist/`
2. **Runtime stage** — `nginx:alpine`: copies `dist/` to `/usr/share/nginx/html`,
   copies `nginx.conf` to `/etc/nginx/conf.d/default.conf`

---

```
ui/.dockerignore
```
Prevents `node_modules/` and `dist/` from being copied into the Docker build context.
Critical — without this, macOS `node_modules` binaries would overwrite the Linux install.

---

```
ui/nginx.conf
```
nginx reverse proxy configuration. Three rate limit zones defined globally:
- `api` zone — 30 req/min per IP for API proxy locations
- `ws` zone — 10 req/min per IP for WebSocket connections
- `ui` zone — 60 req/min per IP for static asset requests

Server block:
- `server_tokens off` — removes nginx version from error pages and response headers
- Security headers on all responses: X-Content-Type-Options, X-Frame-Options,
  X-XSS-Protection, Referrer-Policy, Permissions-Policy, Content-Security-Policy
- `location /` — serves static SPA files; nested `location ~* .(js|css|...)` caches
  assets for 1 year; `try_files` falls back to `index.html` for client-side routing
- `location /api/consumer/` — proxies to `consumer:8000`; GET only (`limit_except`);
  `proxy_no_cache` and `Cache-Control: no-store` prevent any caching of API responses
- `location /api/jetson/` — proxies to `jetson-sim:8001`; same rules as above
- `location /ws/stream` — upgrades HTTP to WebSocket, proxies to `jetson-sim:8001/stream`;
  3600s read timeout to keep long-running connections alive
- `location ~ /\.` — blocks all dotfile access (`.env`, `.git`, etc.) with 404
- `location ~* (wp-admin|phpMyAdmin|\.php...)` — blocks common attack paths with 404

---

```
ui/package.json
```
Node project manifest. Runtime dependencies: `react@18`, `react-dom@18`.
Dev dependencies: TypeScript, Vite, `@vitejs/plugin-react`, React type definitions.
Build script: `tsc && vite build` — TypeScript type-check first, then Vite bundle.

---

```
ui/vite.config.ts
```
Vite configuration. Uses `@vitejs/plugin-react` plugin for JSX transformation.
Dev server proxy rules (used when running `npm run dev` locally, not in Docker):
routes `/api/consumer` → `http://consumer:8000` and `/api/jetson` → `http://jetson-sim:8001`.

---

```
ui/tsconfig.json
```
TypeScript compiler configuration. Key settings:
- `moduleResolution: "bundler"` — uses Vite's module resolution
- `allowImportingTsExtensions: true` — allows `.ts` imports without extension
- `noEmit: true` — tsc only type-checks; Vite handles the actual compilation
- `types: ["vite/client"]` — provides TypeScript types for `import.meta.env`,
  CSS module imports (`*.module.css`), and other Vite-specific globals

---

```
ui/src/vite-env.d.ts
```
Single line: `/// <reference types="vite/client" />`. This is the declaration file that
tells TypeScript to accept `*.module.css` imports and `import.meta.env` variables
without errors. Without this file the build fails with "cannot find module" errors.

---

```
ui/index.html
```
HTML entry point for the Vite SPA. Contains a single `<div id="root">` and a
`<script type="module" src="/src/main.tsx">` tag.

---

```
ui/src/main.tsx
```
React entry point. Calls `ReactDOM.createRoot(document.getElementById("root"))` and
renders `<App />` wrapped in `<React.StrictMode>`. Also imports `global.css`.

---

```
ui/src/types.ts
```
TypeScript interface definitions shared across the application:

- **`FrameMeta`** — shape of the `meta` object inside each WebSocket frame message:
  `frame_id`, `frame_index`, `device_id`, `anomaly_class` (nullable), `confidence`,
  `has_anomaly`, `threshold`, `threshold_exceeded`, `timestamp`
- **`HealthData`** — shape of the `GET /health` JSON response:
  `status`, `uptime_seconds`, `processed_total`, `queue_backlog`, `events_by_type`,
  `last_event_at`, `db_event_count`

---

```
ui/src/App.tsx
```
Root component. Imports and composes all three data hooks and three display components.
Also contains:
- `useCurrentTime()` — local hook, sets an interval to update a `Date` every second
- `formatUptime()` — converts seconds to a human-readable string like `2h 14m`
- Header bar with logo, system status pill (green/red based on `health.status`), and live clock
- Two-column grid: left column has `CameraFeed` + four KPI tiles; right column has
  `HealthPanel` + `AlertList`
- KPI tiles read `health.processed_total`, `health.db_event_count`, `health.queue_backlog`,
  and `health.uptime_seconds` directly from the health poll result

---

```
ui/src/App.module.css
```
CSS Module for the root layout. Defines the sticky frosted-glass header (backdrop blur),
the gradient logo mark, the status pill variants (online/offline/idle), the two-column
CSS grid, the KPI tile cards with hover lift animation, and responsive breakpoints at
1100px and 768px.

---

```
ui/src/styles/global.css
```
Global CSS custom properties (design tokens) and base resets. Defines:
- Color palette (background, surfaces, accent blue, success green, warning amber, danger red)
- Typography scale (font sizes, weights, line heights, letter spacing)
- Spacing scale (4px–64px)
- Border radius scale
- Shadow levels (card, hover, focus)
- Transition speeds
- Light scrollbar styling
- Body background, font family, font smoothing

---

```
ui/src/hooks/useJetsonStream.ts
```
Manages the WebSocket connection to the live camera feed.
- Connects to `ws://<current host>/ws/stream` — always uses the same host and port
  the page was loaded from, routing through nginx
- `onmessage` parses JSON, extracts `data` (base64 JPEG) and `meta` (FrameMeta object),
  sets them in state for the CameraFeed component
- Tracks frame arrival times in a 1-second sliding window to compute live FPS
- `onclose` schedules a reconnect after 3 seconds (handles jetson-sim restarts)
- Returns: `frameDataUrl` (data URI string), `meta` (FrameMeta), `connected` (bool), `fps` (number)

---

```
ui/src/hooks/useHealthPoll.ts
```
Polls `GET /api/consumer/health` on a 3-second interval.
- Uses `window.location` to build the base URL — always routes through nginx
- Sends `X-API-Key: <VITE_API_KEY>` header on every request (key compiled in at build time)
- On success: sets `health` state to the parsed `HealthData` object, clears `error`
- On failure: sets `error` to the error message string, keeps last known `health` value
- Clears the interval on component unmount
- Returns: `health` (HealthData | null), `error` (string | null)

---

```
ui/src/hooks/useAlertHistory.ts
```
Derives alert history from the live frame stream — no API calls.
- Receives `meta: FrameMeta | null` from `useJetsonStream`
- Tracks last-seen `frame_id` in a ref to avoid processing the same frame twice
- When `meta.threshold_exceeded` is true, prepends an `AlertItem` to the alerts array
- Caps the array at 30 items (oldest dropped)
- Returns: `AlertItem[]`

---

```
ui/src/components/CameraFeed.tsx
```
Renders the live fabric image stream with overlay badges and alert state.
- `feedWrapper` — 16:7 aspect ratio thumbnail in dashboard mode; cursor changes to pointer
- Hover shows frosted-glass "⤢ Expand" hint; image slightly dims and scales on hover
- Click opens the lightbox modal (full-screen, up to 1100px wide, 16:9 aspect ratio)
- Lightbox: blurred dark backdrop, spring scale-in animation, ESC or click-outside to close,
  meta bar at bottom showing class chip, confidence bar, frame number, threshold, device
- Alert state (`threshold_exceeded`): card border pulses red ring; frosted-glass red banner
  slides up from image bottom with warning icon, class name, and confidence percentage
- Meta strip below image: class chip (green/amber/red), confidence progress bar, threshold label

---

```
ui/src/components/CameraFeed.module.css
```
All styles for CameraFeed. Key animations: `ringPulse` (red pulsing border on alert),
`blink` (live dot), `slideUp` (alert banner entrance), `fadeIn` (lightbox backdrop),
`scaleIn` (lightbox content spring entrance), `expandHint` opacity transition on hover.

---

```
ui/src/components/HealthPanel.tsx
```
Displays cloud ingestion status from the health poll.
- Header with icon box (gradient blue background) and status badge (green "Healthy" or
  red "Unreachable")
- Error banner with icon when consumer cannot be reached
- Loading spinner while waiting for first response
- Event type breakdown: each type with coloured dot, label, count, and a proportional
  bar showing share of total events (uses `opacity: 0.7` bars with per-type colour)
- Meta list rows: queue backlog (amber when > 50), uptime, last event time — each with
  a small icon box and hover highlight

---

```
ui/src/components/HealthPanel.module.css
```
Styles for HealthPanel. Card with 16px radius, subtle shadow. Spinner keyframe animation.
Event bar fill uses CSS `transition: width 0.6s cubic-bezier(0.4,0,0.2,1)` for smooth updates.

---

```
ui/src/components/AlertList.tsx
```
Scrollable list of the last 30 threshold-exceeded alerts.
- Header with amber icon box (bell icon) and amber count badge
- Empty state: faded SVG bell icon, "No alerts yet" title, hint text
- Alert rows: 3px gradient red severity bar, class name (capitalised, underscores removed),
  timestamp, red confidence pill
- Each new item slides in with `fadeSlide` CSS animation (translateX from right)
- Scrollable with thin custom scrollbar; capped at `max-height: 340px`

---

```
ui/src/components/AlertList.module.css
```
Styles for AlertList. `fadeSlide` keyframe animation for new items entering from the right.
Severity bar uses `linear-gradient(180deg, #EF4444, #DC2626)`.

---

## 5. Technology Stack

| Technology | Version | Used In | Role |
|---|---|---|---|
| Docker / Docker Compose | Latest | All | Containerisation and orchestration |
| Python | 3.12 | consumer, jetson-sim | Backend language |
| FastAPI | 0.111 | consumer, jetson-sim | HTTP server, WebSocket, routing, middleware |
| uvicorn | 0.30 | consumer, jetson-sim | ASGI server (runs FastAPI) |
| asyncio | stdlib | consumer, jetson-sim | Async concurrency — no threads |
| aio-pika | 9.4 | consumer, jetson-sim | Async AMQP client for RabbitMQ |
| SQLAlchemy | 2.0 (async) | consumer | ORM for PostgreSQL access |
| asyncpg | 0.29 | consumer | High-performance async PostgreSQL driver |
| pydantic | 2.7 | consumer | Request/response validation and serialisation |
| pydantic-settings | 2.3 | both backends | Environment variable loading |
| slowapi | 0.1.9 | both backends | Per-IP rate limiting |
| Pillow | 10.3 | jetson-sim | Image open, resize, draw, JPEG encode |
| RabbitMQ | 3.13 | broker | Message queue between jetson-sim and consumer |
| PostgreSQL | 16 | database | Persistent storage for all events |
| React | 18 | ui | UI component framework |
| TypeScript | 5.4 | ui | Static type checking |
| Vite | 5 | ui | Frontend build tool and bundler |
| nginx | Alpine | ui | Static file server and reverse proxy |
| CSS Modules | (Vite) | ui | Scoped component styles |

---

## 6. The Dataset — Where Data Comes From

### Source

422 real fabric defect photographs from the **aaozgur/fabric-defect-dataset-v4** dataset
on HuggingFace. Public, no account required. Originally distributed as a Parquet file
containing raw image bytes. Extracted using `data/download_dataset.py` and committed to
the repository so anyone who clones it has the data immediately.

### Classes and counts

| Folder | Anomaly class | Images | Description |
|---|---|---|---|
| `data/images/burst/` | `burst` | 105 | Broken loops / burst fabric |
| `data/images/lycra_run/` | `lycra_run` | 107 | Lycra thread ladder defect |
| `data/images/needle_break/` | `needle_break` | 105 | Needle breakage marks |
| `data/images/oil_stain/` | `oil_stain` | 105 | Oil contamination |

### How it enters the system

1. `DatasetLoader.__init__()` scans `/data/images` for subdirectories on startup
2. Every file in each subdirectory is added to `_entries` as a `(path, class_name, is_anomaly)` tuple
3. The entire list is shuffled with `random.shuffle()` so the stream order is different every run
4. `next_frame()` advances an index cyclically — after all 422 images, it loops back to the start
5. Each image is opened by Pillow, converted to RGB, resized to 640×480, overlaid with text,
   compressed to JPEG at quality 85, and sent as a WebSocket message

### Confidence scores

The dataset is a classification dataset with no confidence scores. Confidence is **mocked**:
- Defect class images: `random.uniform(0.60, 0.99)` — always detected as anomalous
- Normal class images (folders named `good`, `normal`, etc.): `random.uniform(0.05, 0.35)`

This simulates the probabilistic output of a real anomaly detection model.

---

## 7. Data Flows — How Data Moves

### Frame streaming (jetson-sim → browser)

```
1.  _stream_loop() runs as asyncio background task every 800ms
2.  _loader.next_frame(frame_idx) dispatched to thread pool (Pillow is CPU-bound)
3.  Returns (jpeg_bytes, meta_dict)
4.  base64.b64encode(jpeg_bytes).decode() → base64 string
5.  json.dumps({"type": "frame", "data": "<b64>", "meta": {...}}) → JSON string
6.  ws.send_text(json_string) to every client in _connections set
7.  nginx /ws/stream proxy upgrades connection and forwards the message
8.  Browser WebSocket onmessage fires
9.  useJetsonStream parses JSON, sets frameDataUrl = "data:image/jpeg;base64,..."
10. React re-renders CameraFeed, <img src={frameDataUrl}> displays the frame
```

### Event publishing (jetson-sim → RabbitMQ → consumer → PostgreSQL)

```
1.  After each frame, _publish_event(meta) is called
2.  Decision logic:
      if meta["threshold_exceeded"] → event_type = "threshold_exceeded"
      elif anomaly_class not in _seen_classes → event_type = "new_anomaly_class"
                                                 _seen_classes.add(anomaly_class)
      else → return (no event)
3.  Payload: {event_type, anomaly_class, confidence, device_id, frame_id, timestamp, source}
4.  aio_pika.Message(body=json.dumps(payload).encode(), delivery_mode=PERSISTENT)
5.  channel.default_exchange.publish(message, routing_key="events")
6.  RabbitMQ writes message to disk (persistent) in the "events" queue
7.  consumer's _on_message callback fires
8.  message.process() context manager entered (auto-ack on success, auto-nack on exception)
9.  json.loads(message.body) → data dict
10. Event ORM object created, session.add(event), await session.commit()
11. PostgreSQL executes INSERT INTO events (...)
12. Commit succeeds → context manager sends ACK to RabbitMQ
13. Message removed from queue
14. _state["processed"] += 1, _state["by_type"][event_type] += 1
```

### Health polling (browser → nginx → consumer → browser)

```
1.  useHealthPoll sets setInterval(fetch_, 3000) on mount
2.  fetch(`${window.location.origin}/api/consumer/health`, {headers: {"X-API-Key": key}})
3.  nginx receives GET /api/consumer/health
4.  Rate limit check (30 req/min zone)
5.  Proxied to consumer:8000/health
6.  require_api_key() dependency validates X-API-Key header
7.  Handler reads _state dict (in-memory, O(1))
8.  Also runs: SELECT count(*) FROM events  (for db_event_count)
9.  Returns HealthResponse JSON
10. nginx adds Cache-Control: no-store headers, forwards response
11. useHealthPoll sets health state, React re-renders HealthPanel and KPI tiles
```

### Alert history (derived state, no API call)

```
1.  useJetsonStream updates meta state on each frame
2.  useAlertHistory useEffect fires when meta changes
3.  Compares meta.frame_id to lastFrameIdRef.current
4.  If frame_id is new AND meta.threshold_exceeded is true:
      Prepend AlertItem to alerts array (capped at 30)
5.  AlertList re-renders, new item slides in from right
```

---

## 8. Database — Where Data Is Stored

### Engine

PostgreSQL 16, running in the `postgres` Docker container. Data stored in a Docker named
volume `postgres_data` — survives container restarts and `docker compose down` (only
`docker compose down -v` deletes it).

### Connection

Consumer connects via `asyncpg` with the DSN from `DATABASE_URL` env var:
```
postgresql+asyncpg://nextex:<password>@postgres:5432/nextex
```

The hostname `postgres` resolves to the postgres container via Docker DNS.

### Schema creation

On startup, `Base.metadata.create_all(conn)` runs inside `lifespan()`. It issues a
`CREATE TABLE IF NOT EXISTS events (...)` statement — idempotent, safe to run on every
startup. No migration tool is needed for this single-table schema.

### Table: events

| Column | Type | Nullable | Source |
|---|---|---|---|
| `id` | INTEGER | NOT NULL | Auto-increment primary key |
| `event_type` | VARCHAR | NOT NULL | `"threshold_exceeded"` or `"new_anomaly_class"` |
| `anomaly_class` | VARCHAR | nullable | Folder name: `burst`, `lycra_run`, etc. |
| `confidence` | FLOAT | nullable | Mocked score 0.0–1.0 |
| `device_id` | VARCHAR | nullable | Always `"jetson-sim-001"` |
| `frame_id` | VARCHAR | nullable | UUID v4, unique per frame |
| `payload` | VARCHAR | nullable | Full original JSON message (complete audit trail) |
| `received_at` | TIMESTAMPTZ | NOT NULL | Set by PostgreSQL `now()` at insert time |

### Querying directly

```bash
# While stack is running:
docker exec postgres psql -U nextex -d nextex \
  -c "SELECT id, event_type, anomaly_class, confidence, received_at
      FROM events ORDER BY received_at DESC LIMIT 10;"
```

### What is NOT persisted

| Data | Where it lives | Survival |
|---|---|---|
| Live video frames | Memory only (never written to disk) | Lost immediately |
| In-memory counters (_state) | consumer process memory | Lost on container restart |
| Alert history in UI | React state (browser memory) | Lost on page refresh |
| Seen anomaly classes (_seen_classes) | jetson-sim process memory | Lost on container restart |

---

## 9. Security Controls

| Control | Implementation | File |
|---|---|---|
| Secrets in env file | `.env` not committed; `.gitignore` excludes it | `.gitignore`, `.env.example` |
| API key authentication | `X-API-Key` header required on all HTTP endpoints; 401 if missing/wrong | `consumer/main.py`, `jetson-sim/main.py` |
| API key in UI bundle | `VITE_API_KEY` Docker build arg baked into compiled JS at build time | `ui/Dockerfile`, `docker-compose.yml` |
| CORS lockdown | `allow_origins=[settings.ALLOWED_ORIGIN]` — single origin, no wildcard | Both `main.py` files |
| Rate limiting | slowapi per-IP limits: /health 30/min, /events 20/min, /stats 30/min | Both `main.py` files |
| nginx rate limiting | Separate zones for API (30/min), WS (10/min), UI (60/min) | `ui/nginx.conf` |
| Input validation | Query params `limit` and `offset` bounded with `Query(ge=..., le=...)` | `consumer/main.py` |
| Security response headers | X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy, CSP | Both `main.py` files, `nginx.conf` |
| server token removal | `server_tokens off` in nginx; `del response.headers["server"]` in Python | Both |
| GET-only enforcement | `limit_except GET { deny all; }` in nginx proxy blocks | `ui/nginx.conf` |
| Port isolation | Only port 3000 exposed; DB and broker use `expose:` (Docker-internal only) | `docker-compose.yml` |
| Read-only volume | Dataset mounted `:ro` — jetson-sim cannot write to host filesystem | `docker-compose.yml` |
| SQL injection prevention | SQLAlchemy ORM with parameterised queries — no raw SQL | `consumer/main.py` |
| Attack path blocking | nginx blocks `.env`, `.git`, `.php`, `wp-admin`, `phpMyAdmin` | `ui/nginx.conf` |
| Named DB volume | `postgres_data` named volume — data at rest in Docker-managed storage | `docker-compose.yml` |

---

## 10. API Reference

All HTTP endpoints require the header: `X-API-Key: <your key from .env>`

### GET /health — consumer

Returns ingestion metrics. Rate limit: 30 req/min.

```json
{
  "status": "ok",
  "uptime_seconds": 312.4,
  "processed_total": 148,
  "queue_backlog": 0,
  "events_by_type": {
    "threshold_exceeded": 112,
    "new_anomaly_class": 36
  },
  "last_event_at": "2024-10-01T10:34:22.000Z",
  "db_event_count": 148
}
```

| Field | Source |
|---|---|
| `status` | Hardcoded `"ok"` (if service is up, it returns ok) |
| `uptime_seconds` | `time.time() - start_time` in process memory |
| `processed_total` | In-memory counter, incremented per message |
| `queue_backlog` | RabbitMQ queue message count, polled every 5s |
| `events_by_type` | In-memory dict, keyed by event_type string |
| `last_event_at` | ISO timestamp set on last successful database write |
| `db_event_count` | Live `SELECT count(*) FROM events` query |

---

### GET /events — consumer

Returns stored events from PostgreSQL, most recent first. Rate limit: 20 req/min.

Query params: `limit` (1–200, default 50), `offset` (0–100000, default 0)

```json
[
  {
    "id": 148,
    "event_type": "threshold_exceeded",
    "anomaly_class": "burst",
    "confidence": 0.871,
    "device_id": "jetson-sim-001",
    "frame_id": "3f4a2b1c-...",
    "received_at": "2024-10-01T10:34:22+00:00"
  }
]
```

---

### GET /stats — jetson-sim

Returns simulator runtime statistics. Rate limit: 30 req/min.

```json
{
  "frames_generated": 1042,
  "events_sent": 148,
  "connected_clients": 1,
  "seen_anomaly_classes": ["burst", "lycra_run", "needle_break", "oil_stain"],
  "threshold": 0.75,
  "dataset_classes": ["burst", "lycra_run", "needle_break", "oil_stain"],
  "dataset_image_count": 422
}
```

---

### WS /ws/stream — via nginx → jetson-sim

WebSocket. Each message is a JSON string:

```json
{
  "type": "frame",
  "data": "/9j/4AAQSkZJRgAB...",
  "meta": {
    "frame_id": "uuid-v4",
    "frame_index": 1042,
    "device_id": "jetson-sim-001",
    "anomaly_class": "burst",
    "confidence": 0.871,
    "has_anomaly": true,
    "threshold": 0.75,
    "threshold_exceeded": true,
    "timestamp": 1720000000.123,
    "source": "image_filename.jpg"
  }
}
```

`data` is a standard base64-encoded JPEG. Set it as `src` on an `<img>` tag to display.
No API key required on the WebSocket itself — browser WebSocket API cannot send custom headers.

---

## 11. Configuration Reference

All values live in `.env`. Copy `.env.example` and fill in your own secrets.

**Do not use `@`, `#`, or `%` in passwords** — these characters break URL parsing in
`DATABASE_URL` and `RABBITMQ_URL`. Use letters, digits, and underscores only.

| Variable | Used By | What It Controls |
|---|---|---|
| `POSTGRES_USER` | postgres | Database username |
| `POSTGRES_PASSWORD` | postgres, consumer (via DATABASE_URL) | Database password |
| `POSTGRES_DB` | postgres | Database name (default `nextex`) |
| `RABBITMQ_DEFAULT_USER` | rabbitmq | Broker username |
| `RABBITMQ_DEFAULT_PASS` | rabbitmq, both services (via RABBITMQ_URL) | Broker password |
| `DATABASE_URL` | consumer | Full async PostgreSQL connection string |
| `RABBITMQ_URL` | consumer, jetson-sim | Full AMQP connection string |
| `API_KEY` | consumer, jetson-sim, ui (build arg) | Shared API key for all HTTP endpoints |
| `ALLOWED_ORIGIN` | consumer, jetson-sim | Only CORS origin permitted |
| `FRAME_INTERVAL_MS` | jetson-sim | Milliseconds between frames (800 = ~1.25 fps) |
| `ANOMALY_THRESHOLD` | jetson-sim | Confidence threshold for alerts (0.75 = 75%) |
| `DATASET_PATH` | jetson-sim | Path to images inside the container |

---

## 12. Ports and Access URLs

Only port **3000** is accessible from the host browser. All other ports are Docker-internal.

| URL | What it is | Auth |
|---|---|---|
| `http://localhost:3000` | Monitoring dashboard | None — open |
| `http://localhost:3000/api/consumer/health` | Health endpoint via nginx | `X-API-Key` header |
| `http://localhost:3000/api/consumer/events` | Events list via nginx | `X-API-Key` header |
| `http://localhost:3000/api/consumer/docs` | Swagger UI for consumer | `X-API-Key` header |
| `http://localhost:3000/api/jetson/stats` | Simulator stats via nginx | `X-API-Key` header |
| `ws://localhost:3000/ws/stream` | Live WebSocket stream | None |
| `postgres:5432` | PostgreSQL | Internal only |
| `rabbitmq:5672` | RabbitMQ AMQP | Internal only |
| `rabbitmq:15672` | RabbitMQ management UI | Internal only |

---

## 13. Common Commands

```bash
# Start everything (first run builds images)
docker compose up --build

# Start in background
docker compose up --build -d

# Watch all logs
docker compose logs -f

# Watch one service
docker compose logs -f consumer

# Stop (keeps database volume)
docker compose down

# Full reset including database
docker compose down -v

# Rebuild one service after code change
docker compose up --build -d consumer

# Check container status
docker compose ps

# Query database directly
docker exec postgres psql -U nextex -d nextex \
  -c "SELECT event_type, count(*) FROM events GROUP BY event_type;"

# Call health endpoint manually
curl -s http://localhost:3000/api/consumer/health \
  -H "X-API-Key: <your-api-key>"

# Call events endpoint manually
curl -s "http://localhost:3000/api/consumer/events?limit=5" \
  -H "X-API-Key: <your-api-key>"
```

---

## 14. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `.env: no such file` on startup | `.env` was not created | `cp .env.example .env` and fill in values |
| Dashboard shows "Offline" | Consumer not running or API key mismatch | Check `docker compose logs consumer` |
| Black screen, "Waiting for stream" | WebSocket cannot connect | Run `docker compose ps` — all containers must be Up |
| Consumer restart-loops | `DATABASE_URL` has `@` in password | Remove special characters from passwords |
| `401 Unauthorized` on API calls | Wrong or missing API key | Ensure `API_KEY` in `.env` matches what you send |
| Old data showing after restart | Named volume still holds old DB | Run `docker compose down -v` then `up --build` |
| Port 3000 already in use | Another process on port 3000 | Change `"3000:80"` in `docker-compose.yml` |
| Images not loading | Dataset folder missing | Ensure `data/images/burst/` etc. exist with `.jpg` files |
