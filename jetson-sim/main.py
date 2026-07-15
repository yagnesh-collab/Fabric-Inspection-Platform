import asyncio
import base64
import io
import json
import logging
import random
import time
import uuid
from pathlib import Path
from typing import Set

import aio_pika
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request, Security, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security.api_key import APIKeyHeader
from PIL import Image, ImageDraw
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from settings import settings

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("jetson-sim")

GOOD_CLASSES = {"good", "normal", "defect_free", "nodefect", "ok"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif"}

_connections: Set[WebSocket] = set()
_rabbit_channel: aio_pika.Channel | None = None
_stats = {"frames": 0, "events_sent": 0}

# === Rate limiter ===
limiter = Limiter(key_func=get_remote_address, default_limits=["60/minute"])

# === API key auth ===
_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


async def require_api_key(key: str = Security(_api_key_header)) -> str:
    if not key or key != settings.API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API key",
            headers={"WWW-Authenticate": "ApiKey"},
        )
    return key


class DatasetLoader:
    def __init__(self, dataset_path: str) -> None:
        self._entries: list[tuple[Path, str, bool]] = []
        self._index = 0

        root = Path(dataset_path)
        if not root.exists():
            raise RuntimeError(
                f"Dataset directory '{dataset_path}' not found. "
                "Mount the images at that path and restart."
            )

        for class_dir in sorted(root.iterdir()):
            if not class_dir.is_dir():
                continue
            class_name = class_dir.name.lower().replace(" ", "_").replace("-", "_")
            is_anomaly = class_name not in GOOD_CLASSES
            files = sorted(f for f in class_dir.iterdir() if f.suffix.lower() in IMAGE_EXTS)
            for f in files:
                self._entries.append((f, class_name, is_anomaly))

        if not self._entries:
            raise RuntimeError(
                f"Dataset directory '{dataset_path}' exists but contains no images."
            )

        random.shuffle(self._entries)
        log.info(
            "Dataset loaded: %d images across %d classes from %s",
            len(self._entries),
            len({e[1] for e in self._entries}),
            dataset_path,
        )

    @property
    def classes(self) -> list[str]:
        return sorted({e[1] for e in self._entries if e[2]})

    @property
    def image_count(self) -> int:
        return len(self._entries)

    def next_frame(self, frame_idx: int) -> tuple[bytes, dict]:
        img_path, class_name, is_anomaly = self._entries[self._index % len(self._entries)]
        self._index += 1

        img = Image.open(img_path).convert("RGB").resize((640, 480))
        draw = ImageDraw.Draw(img)

        confidence = (
            round(random.uniform(0.60, 0.99), 3)
            if is_anomaly
            else round(random.uniform(0.05, 0.35), 3)
        )
        threshold_exceeded = is_anomaly and confidence > settings.ANOMALY_THRESHOLD

        draw.text((8, 8), f"Frame #{frame_idx:05d}", fill=(255, 255, 0))
        draw.text((8, 28), "Device: jetson-sim-001", fill=(200, 200, 200))

        if is_anomaly:
            label_color = (255, 80, 80) if threshold_exceeded else (255, 200, 80)
            draw.text((8, 480 - 28), f"{class_name}  {confidence:.2f}", fill=label_color)

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)

        return buf.getvalue(), {
            "frame_id": str(uuid.uuid4()),
            "frame_index": frame_idx,
            "device_id": "jetson-sim-001",
            "anomaly_class": class_name if is_anomaly else None,
            "confidence": confidence,
            "has_anomaly": is_anomaly,
            "threshold": settings.ANOMALY_THRESHOLD,
            "threshold_exceeded": threshold_exceeded,
            "timestamp": time.time(),
            "source": img_path.name,
        }


async def _publish_event(meta: dict) -> None:
    global _rabbit_channel
    if _rabbit_channel is None or _rabbit_channel.is_closed:
        return

    event_type = None
    if meta["threshold_exceeded"]:
        event_type = "threshold_exceeded"
    elif meta["has_anomaly"] and meta["anomaly_class"] not in _seen_classes:
        event_type = "new_anomaly_class"
        _seen_classes.add(meta["anomaly_class"])

    if event_type is None:
        return

    payload = {
        "event_type": event_type,
        "anomaly_class": meta["anomaly_class"],
        "confidence": meta["confidence"],
        "device_id": meta["device_id"],
        "frame_id": meta["frame_id"],
        "timestamp": meta["timestamp"],
        "source": meta["source"],
    }

    await _rabbit_channel.default_exchange.publish(
        aio_pika.Message(
            body=json.dumps(payload).encode(),
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
        ),
        routing_key="events",
    )
    _stats["events_sent"] += 1
    log.info("Published event type=%s class=%s conf=%.2f", event_type, meta["anomaly_class"], meta["confidence"])


_seen_classes: set = set()
_loader: DatasetLoader | None = None


async def _stream_loop() -> None:
    global _loader
    _loader = DatasetLoader(settings.DATASET_PATH)
    frame_idx = 0
    interval = settings.FRAME_INTERVAL_MS / 1000.0
    loop = asyncio.get_event_loop()

    while True:
        t0 = time.monotonic()

        frame_bytes, meta = await loop.run_in_executor(None, _loader.next_frame, frame_idx)
        _stats["frames"] += 1
        frame_idx += 1

        ws_payload = json.dumps({
            "type": "frame",
            "data": base64.b64encode(frame_bytes).decode(),
            "meta": meta,
        })

        dead = set()
        for ws in list(_connections):
            try:
                await ws.send_text(ws_payload)
            except Exception:
                dead.add(ws)
        _connections.difference_update(dead)

        try:
            await _publish_event(meta)
        except Exception as exc:
            log.warning("Publish failed: %s", exc)

        await asyncio.sleep(max(0.0, interval - (time.monotonic() - t0)))


async def _connect_rabbit() -> None:
    global _rabbit_channel
    while True:
        try:
            connection = await aio_pika.connect_robust(settings.RABBITMQ_URL)
            channel = await connection.channel()
            await channel.declare_queue("events", durable=True)
            _rabbit_channel = channel
            log.info("Connected to RabbitMQ")
            return
        except Exception as exc:
            log.warning("RabbitMQ not ready, retrying: %s", exc)
            await asyncio.sleep(3)


# === App ===
app = FastAPI(title="Jetson Simulator", docs_url="/docs", redoc_url=None)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS — locked to the UI origin only
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.ALLOWED_ORIGIN],
    allow_methods=["GET"],
    allow_headers=["X-API-Key"],
    allow_credentials=False,
)


# === Security headers middleware ===
@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    if "server" in response.headers:
        del response.headers["server"]
    return response


@app.on_event("startup")
async def startup() -> None:
    asyncio.create_task(_connect_rabbit())
    await asyncio.sleep(1)
    asyncio.create_task(_stream_loop())


# WebSocket — no API key (browser WebSocket API cannot send custom headers),
# but origin is validated by CORS and nginx only proxies from localhost:3000
@app.websocket("/stream")
async def ws_stream(websocket: WebSocket) -> None:
    await websocket.accept()
    _connections.add(websocket)
    log.info("WebSocket client connected, total=%d", len(_connections))
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        _connections.discard(websocket)
        log.info("WebSocket client disconnected, total=%d", len(_connections))


@app.get("/stats", dependencies=[Depends(require_api_key)])
@limiter.limit("30/minute")
async def stats(request: Request):
    return {
        "frames_generated": _stats["frames"],
        "events_sent": _stats["events_sent"],
        "connected_clients": len(_connections),
        "seen_anomaly_classes": sorted(_seen_classes),
        "threshold": settings.ANOMALY_THRESHOLD,
        "dataset_classes": _loader.classes if _loader else [],
        "dataset_image_count": _loader.image_count if _loader else 0,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001, log_level="info", root_path="/api/jetson")
