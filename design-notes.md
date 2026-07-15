# Design Notes

---

## Decision 1: Local Disk vs MQTT for Jetson Telemetry

### Choice: Local Disk

This was not a close call. A circular knitting machine sits on a factory floor, not in a data centre. The network goes down. Power cuts happen. Operators unplug cables. The data layer must survive all of it, and MQTT simply does not.

**MQTT fails at the edge.** MQTT requires a reachable broker. If the broker is down, or the Wi-Fi drops, QoS 0 messages vanish silently and QoS 1/2 messages pile up in the client library's RAM with no persistence guarantee across a power cycle. One unexpected reboot wipes everything buffered in memory. For sensor data that drives anomaly detection and model retraining, silent data loss is unacceptable.

**Local disk never fails silently.** The Jetson Orin NX has an NVMe slot. Writing telemetry to structured files  SQLite for queryable time series, or Parquet files partitioned by hour for bulk analysis that means the data lands safely on persistent storage the moment it is written. If the cloud is unreachable for six hours, the device keeps recording. When connectivity returns, a background sync process batch-uploads in order, producing a complete, gap-free dataset.

**The numbers support it.** At 10 Hz sensor readings with a 4 KB payload each, one full day of data is under 350 MB. A 256 GB NVMe stores over two years before any retention policy is needed. Disk is not a constraint.

**When I use MQTT .** MQTT earns its place when the broker runs locally on the device itself , a Mosquitto sidecar, acting as an in-process pub/sub bus between the anomaly detection model, the telemetry logger, and the cloud uploader. In that topology it is local IPC, not a cloud transport, and it retains all the resilience properties of local storage while adding structured fan-out between processes. MQTT also becomes attractive when sub-second latency to a cloud dashboard is a hard business requirement and the network is guaranteed reliable.

**The architecture used in this project.** The Jetson simulator (`jetson-sim`) publishes events to RabbitMQ only for the two high-value cloud event types: `threshold_exceeded` and `new_anomaly_class`. Everything else, frame metadata, sensor telemetry, low-confidence detections would stay local on disk in a real deployment, synced in bulk on a schedule. This is exactly the split that makes sense: real-time alerts over AMQP, bulk history over disk.

---

## Decision 2: Why RabbitMQ over Kafka, Redis Streams, or SQS

Three alternatives were seriously considered.

**Kafka** is powerful but operationally expensive for this workload. It needs ZooKeeper or KRaft, topic partitioning decisions, consumer group offset management, and a separate retention configuration. For two event types with low volume and no replay requirement, Kafka is a sledgehammer.

**Redis Streams** would work functionally, but it conflates two responsibilities caching and message streaming in one process. A Redis restart under memory pressure can evict stream data. Using Redis as a durable event bus requires careful configuration that most teams get wrong.

**LocalStack/SQS** requires either AWS credentials or a heavyweight LocalStack container. It adds a fake cloud dependency to a local-first system for no architectural gain.

**RabbitMQ** is the correct fit because the requirements map directly to its design:

- The queue is declared `durable=True` and messages use `DeliveryMode.PERSISTENT` written to disk before the publish is acknowledged. A broker crash loses nothing.
- The consumer acks only after a successful PostgreSQL write. A crash mid-processing leaves the message in the queue for re-delivery. This is at-least-once delivery with zero configuration.
- `channel.set_qos(prefetch_count=10)` bounds memory usage and prevents a slow database from stalling the consumer.
- The management UI at port 15672 shows queue depth, message rates, and connection status in real time, monitoring that would require Kafka's consumer group lag metrics and a separate Grafana setup.
- The entire broker runs in a single Alpine Docker image with no external dependencies.

The one trade-off accepted: RabbitMQ does not retain processed messages for replay. That is acceptable because events are persisted to PostgreSQL immediately on consumption. PostgreSQL is the permanent record; RabbitMQ is the reliable transport layer.

---

## Decision 3: Security Model

The security decisions made in this project reflect what a real deployment would require, not just what passes a demo.

**All backend ports are Docker-internal only.** PostgreSQL (5432), RabbitMQ (5672, 15672), the consumer API (8000), and the jetson-sim API (8001) are unreachable from the host. The only externally accessible port is 3000 (nginx). An attacker who reaches port 3000 cannot directly query the database or the broker.

**API key authentication on every HTTP endpoint.** Both services reject requests without a valid `X-API-Key` header with `401 Unauthorized`. The key is generated per deployment, stored in `.env` and compiled into the React bundle at Docker build time via the `VITE_API_KEY` build argument. No key material appears in source code.

**CORS is locked to a single origin.** `allow_origins=["*"]` was rejected. Only `http://localhost:3000` is permitted. A browser script running on any other origin cannot call the APIs.

**Rate limiting at two layers.** SlowAPI enforces per-IP limits inside the Python services (30 req/min on `/health`, 20 req/min on `/events`). nginx enforces independent limits at the proxy layer before requests even reach Python. Volumetric abuse is blocked at both layers.

**Input is validated and bounded.** The `/events` endpoint caps `limit` at 200 and `offset` at 100,000 using FastAPI's `Query` type with `ge`/`le` constraints. A client cannot trigger a full-table scan with a single request.

**Security headers on every response.** `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `X-XSS-Protection: 1; mode=block`, `Referrer-Policy`, `Permissions-Policy`, `Content-Security-Policy`, and `Cache-Control: no-store` are set on all responses. The `Server` header is removed to prevent version fingerprinting. These are applied in both the Python middleware and nginx, so they appear regardless of which layer handles the request.

**Credentials use non-default values with no special URL characters.** Passwords avoid `@`, `#`, and `%` characters that break AMQP and PostgreSQL connection string parsing. This is documented in `.env.example` to prevent a hard-to-diagnose failure for anyone setting up the stack.

---

## What Would Change Before Going to Production

The current implementation is a fully functional local prototype. The following is what I would address before running this in a production environment.

**TLS everywhere.** All traffic is currently unencrypted. In production, nginx terminates HTTPS using a certificate from a trusted CA or an internal PKI. RabbitMQ switches to AMQPS (port 5671). WebSocket upgrades to `wss://`. No plaintext traffic crosses any network boundary.

**Per-device identity.** Every Jetson device gets a unique API key or client certificate, rotatable independently. A compromised device is revoked without affecting the rest of the fleet. The current single shared key is acceptable for a prototype but not for a multi-device deployment.

**Dead-letter exchange and queue limits.** The current setup has no dead-letter queue. A message that fails processing repeatedly will block the consumer. In production, a DLX captures repeatedly failing messages for inspection, a maximum queue length with overflow drop-head policy prevents unbounded memory growth, and an alert fires when queue depth exceeds a threshold for more than 60 seconds.

**PostgreSQL replication and connection pooling.** The current single-node PostgreSQL has no replica. Production requires at minimum one streaming replica for failover. Schema migrations use Alembic with a controlled deployment pipeline rather than `create_all` on startup. PgBouncer sits in front of the database if more than a handful of consumer replicas are deployed.

**Structured observability.** The `/health` endpoint gives useful counters but is not sufficient for production operations. The full stack needs: structured JSON logs shipped to a log aggregator (Loki, Elasticsearch), Prometheus metrics from both services (queue depth, processing latency p50/p95/p99, DB pool saturation, error rate), and OpenTelemetry distributed tracing so a single slow frame can be traced from jetson-sim publish through RabbitMQ delivery through PostgreSQL write with a single trace ID.

**Horizontal consumer scaling.** FastAPI with asyncio scales well vertically, but at high event throughput multiple consumer replicas behind a load balancer are needed. RabbitMQ's competing-consumers pattern distributes messages automatically. The in-memory `_state` counters would need to move to Redis or be aggregated from the database to remain accurate across replicas.

**Device configuration management.** Threshold values, model versions, and frame intervals are currently hardcoded environment variables. With dozens of Jetson devices, central configuration management is essential. A lightweight device shadow pattern as provided by AWS IoT Core, Azure IoT Hub, or self-hosted Eclipse Ditto allows per-device overrides to be pushed without redeploying containers.

**Model retraining pipeline.** The current system stores event metadata in PostgreSQL when a new anomaly class is detected. In production, the corresponding JPEG frame should also be uploaded to an S3-compatible object store with metadata linking it to the device ID, timestamp, anomaly class, and model version that produced the prediction. This creates the labelled dataset needed for the next training run and provides an audit trail for understanding model drift over time.
