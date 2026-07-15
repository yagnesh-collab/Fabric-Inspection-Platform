import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

import aio_pika
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Security, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sqlalchemy import Column, DateTime, Float, Integer, String, func, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from settings import settings

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("consumer")

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


# === Database ===
class Base(DeclarativeBase):
    pass


class Event(Base):
    __tablename__ = "events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    event_type = Column(String, nullable=False)
    anomaly_class = Column(String, nullable=True)
    confidence = Column(Float, nullable=True)
    device_id = Column(String, nullable=True)
    frame_id = Column(String, nullable=True)
    payload = Column(String, nullable=True)
    received_at = Column(DateTime(timezone=True), server_default=func.now())


engine = create_async_engine(settings.DATABASE_URL, echo=False)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

# === In-memory state ===
_state: dict = {
    "processed": 0,
    "backlog": 0,
    "by_type": {},
    "start_time": time.time(),
    "last_event_at": None,
}


async def _persist(session: AsyncSession, data: dict) -> None:
    event = Event(
        event_type=data.get("event_type", "unknown"),
        anomaly_class=data.get("anomaly_class"),
        confidence=data.get("confidence"),
        device_id=data.get("device_id"),
        frame_id=data.get("frame_id"),
        payload=json.dumps(data),
    )
    session.add(event)
    await session.commit()


async def _process_message(message: aio_pika.IncomingMessage) -> None:
    async with message.process():
        try:
            data = json.loads(message.body)
            async with AsyncSessionLocal() as session:
                await _persist(session, data)
            etype = data.get("event_type", "unknown")
            _state["processed"] += 1
            _state["by_type"][etype] = _state["by_type"].get(etype, 0) + 1
            _state["last_event_at"] = datetime.now(timezone.utc).isoformat()
            log.info("Processed event type=%s processed_total=%d", etype, _state["processed"])
        except Exception as exc:
            log.error("Failed to process message: %s", exc)


async def _consume() -> None:
    await asyncio.sleep(2)
    connection = await aio_pika.connect_robust(settings.RABBITMQ_URL)
    channel = await connection.channel()
    await channel.set_qos(prefetch_count=10)

    queue = await channel.declare_queue("events", durable=True)

    async def _on_message(message: aio_pika.IncomingMessage) -> None:
        _state["backlog"] = max(0, _state["backlog"] - 1)
        await _process_message(message)

    await queue.consume(_on_message)

    async def _backlog_updater() -> None:
        while True:
            try:
                q = await channel.declare_queue("events", durable=True, passive=True)
                _state["backlog"] = q.declaration_result.message_count
            except Exception:
                pass
            await asyncio.sleep(5)

    asyncio.create_task(_backlog_updater())
    log.info("Consumer is ready")


@asynccontextmanager
async def lifespan(_: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    task = asyncio.create_task(_consume())
    yield
    task.cancel()


# === App ===
app = FastAPI(
    title="Nextex Consumer",
    lifespan=lifespan,
    # Hide schema endpoints in production-like mode
    docs_url="/docs",
    redoc_url=None,
)

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
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    # Remove server identity
    if "server" in response.headers:
        del response.headers["server"]
    return response


# === Models ===
class HealthResponse(BaseModel):
    status: str
    uptime_seconds: float
    processed_total: int
    queue_backlog: int
    events_by_type: dict
    last_event_at: Optional[str]
    db_event_count: Optional[int] = None


# === Routes ===
@app.get("/health", response_model=HealthResponse, dependencies=[Depends(require_api_key)])
@limiter.limit("30/minute")
async def health(request: Request) -> HealthResponse:
    db_count: Optional[int] = None
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(select(func.count()).select_from(Event))
            db_count = result.scalar()
    except Exception:
        pass

    return HealthResponse(
        status="ok",
        uptime_seconds=round(time.time() - _state["start_time"], 1),
        processed_total=_state["processed"],
        queue_backlog=_state["backlog"],
        events_by_type=dict(_state["by_type"]),
        last_event_at=_state["last_event_at"],
        db_event_count=db_count,
    )


@app.get("/events", dependencies=[Depends(require_api_key)])
@limiter.limit("20/minute")
async def list_events(
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0, le=100_000),
):
    # Clamp in case Field constraints are bypassed
    limit = max(1, min(limit, 200))
    offset = max(0, min(offset, 100_000))

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Event).order_by(Event.received_at.desc()).limit(limit).offset(offset)
        )
        rows = result.scalars().all()
    return [
        {
            "id": r.id,
            "event_type": r.event_type,
            "anomaly_class": r.anomaly_class,
            "confidence": r.confidence,
            "device_id": r.device_id,
            "frame_id": r.frame_id,
            "received_at": r.received_at.isoformat() if r.received_at else None,
        }
        for r in rows
    ]
