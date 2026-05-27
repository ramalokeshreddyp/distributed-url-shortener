# System Architecture

This document describes the runtime architecture of SnapURL, the boundaries between services, and the data flow that makes the system fast enough for redirect-heavy workloads while keeping analytics reliable.

## 1. Architectural Goal

The project is intentionally split into a synchronous request path and an asynchronous analytics path. The redirect path must be fast, cache-friendly, and resilient. The analytics path must be durable, batched, and decoupled so that click tracking never slows down the redirect response.

## 2. High-Level Topology

```mermaid
flowchart TB
    Client[Browser / HTTP Client]
    UI[Frontend SPA]
    API[API Service]
    Redis[(Redis)]
    DB[(PostgreSQL)]
    Worker[Analytics Worker]
    Bench[k6 Load Test]

    Client --> UI
    Client --> API
    UI --> API
    Bench --> API
    API --> Redis
    API --> DB
    API --> Worker
    Worker --> Redis
    Worker --> DB
```

## 3. Service Responsibilities

### 3.1 API Service

The API service owns request validation, ID generation, redirect resolution, cache population, analytics reads, and static frontend hosting.

Core responsibilities:

- Accept shortening requests at `POST /api/shorten`.
- Generate short codes using either the hash or snowflake strategy.
- Persist canonical mappings in PostgreSQL.
- Resolve redirects from Redis first, then PostgreSQL.
- Publish click events to the Redis `clicks` stream.
- Expose `GET /api/analytics/:shortCode` for hourly analytics.
- Expose `GET /api/health` for container readiness checks.

### 3.2 Worker Service

The worker is a separate background process whose only responsibility is analytics aggregation.

Core responsibilities:

- Join the `clicks` stream consumer group.
- Read events in batches.
- Normalize timestamps to the hour.
- Upsert hourly aggregates into PostgreSQL.
- Acknowledge processed stream entries.
- Recreate the consumer group if Redis is flushed or restarted.

### 3.3 PostgreSQL

PostgreSQL is the source of truth for the URL mapping table and the aggregated analytics table.

It stores:

- `urls`: canonical short code to original URL mappings.
- `analytics_hourly`: hourly click totals keyed by `short_code` and `hour`.

### 3.4 Redis

Redis plays two roles:

- Read-through cache for redirects.
- Event stream for click analytics.

Redis reduces database pressure by keeping hot redirect data in memory and by batching click events into a durable stream.

## 4. Execution Paths

### 4.1 Redirect Path

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant A as API
    participant R as Redis Cache
    participant P as PostgreSQL
    participant S as Redis Stream

    C->>A: GET /:shortCode
    A->>R: Lookup url:{shortCode}
    alt Cache hit
        R-->>A: cached mapping
    else Cache miss
        A->>P: Select row from urls
        P-->>A: row or none
        opt row found and active
            A->>R: Cache mapping with TTL
        end
    end
    alt Mapping found and active
        A->>S: XADD clicks {short_code, timestamp, user_agent}
        A-->>C: 302 with X-Cache-Status
    else Missing or expired
        A-->>C: 404
    end
```

### 4.2 Shortening Path

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant A as API
    participant G as ID Generator
    participant P as PostgreSQL

    C->>A: POST /api/shorten
    A->>G: Generate short code
    G-->>A: short code
    A->>P: Insert urls row
    alt unique constraint violation
        A->>G: Regenerate with new salt / retry
        A->>P: Insert again
    end
    A-->>C: 201 short_url
```

### 4.3 Analytics Path

```mermaid
flowchart LR
    Stream[clicks stream] --> Group[Consumer group]
    Group --> Batch[Batch fetch]
    Batch --> Hour[Truncate timestamp to hour]
    Hour --> Aggregate[Count per short_code/hour]
    Aggregate --> Upsert[UPSERT analytics_hourly]
    Upsert --> Ack[XACK processed IDs]
```

## 5. Data Model Design

### 5.1 `urls`

- `id SERIAL PRIMARY KEY`
- `short_code VARCHAR(16) UNIQUE NOT NULL`
- `original_url TEXT NOT NULL`
- `strategy VARCHAR(16) NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `expires_at TIMESTAMPTZ NULL`

Why it works:

- The unique constraint protects the shortening path against collisions.
- The optional expiration column allows temporary links without extra tables.
- The timestamp columns make operational debugging and cleanup easier.

### 5.2 `analytics_hourly`

- `id SERIAL PRIMARY KEY`
- `short_code VARCHAR(16) NOT NULL`
- `hour TIMESTAMPTZ NOT NULL`
- `click_count INTEGER NOT NULL DEFAULT 1`
- `UNIQUE(short_code, hour)`

Why it works:

- The unique constraint makes UPSERT safe and deterministic.
- Aggregation is coarse-grained by hour, which keeps write volume low.
- This structure is efficient for time-series style queries without a dedicated TSDB.

## 6. ID Generation Strategies

### 6.1 Hash Strategy

The hash strategy uses MD5 plus Base62 encoding. If a unique constraint violation occurs, the generator retries with a different attempt value, which acts as a salt.

Benefits:

- Deterministic for a given URL and retry attempt.
- Short, URL-safe codes.
- Low operational complexity.

Limitations:

- Truncation creates a theoretical collision surface.
- It is not globally ordered.

### 6.2 Snowflake Strategy

The snowflake-inspired generator packs timestamp, node ID, and sequence into a 64-bit integer.

$$
	ext{ID} = (\text{timestamp\_diff} \ll 22) \;|\; (\text{node\_id} \ll 12) \;|\; \text{sequence}
$$

Benefits:

- Collision-resistant across nodes when configured correctly.
- Chronologically sortable.
- Coordination-free generation.

Limitations:

- Requires careful node ID management.
- Sequence exhaustion can stall generation for the next millisecond.

## 7. Resilience and Recovery

The system is designed to survive common failure modes:

- If Redis is flushed, the worker recreates the consumer group.
- If the redirect cache is empty, the API falls back to PostgreSQL.
- If a URL is expired, the redirect path returns `404` rather than serving stale content.
- If a short-code insert collides, the API retries generation before failing.

## 8. Trade-Offs

### Advantages

- Fast redirect latency through Redis cache hits.
- Low write pressure on PostgreSQL through batched analytics.
- Simple deployment story with Docker Compose.
- Clear separation of concerns between API and worker.

### Costs

- Analytics are eventually consistent rather than immediate.
- Redis memory is part of the performance budget.
- Stream processing adds operational complexity compared to a single-process design.

## 9. Integration Points

- API to PostgreSQL for canonical writes and analytics reads.
- API to Redis for caching and stream publication.
- Worker to Redis Streams for durable event consumption.
- Worker to PostgreSQL for batched hourly aggregation.
- Frontend to API for shortening and analytics rendering.

## 10. Why This Structure Scales

The architecture scales because the hot path is kept small and the expensive work is deferred. Redis absorbs read pressure, PostgreSQL stores the source of truth, and the worker performs write-heavy analytics out of band. This prevents a redirect spike from turning into a database bottleneck.
