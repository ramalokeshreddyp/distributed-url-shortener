# Project Documentation

## 1. Project Objective and Scope

The **Distributed URL Shortener** is a high-throughput, low-latency web service built from scratch to map long URLs to short, unique codes. The project simulates a production-grade cloud infrastructure, demonstrating core concepts of **distributed systems design**, **caching strategies**, and **asynchronous event-driven processing**.

### Key Deliverables:
- **Collision-Resistant ID Generators**: Fully decentralized generation without centralized DB serial locks.
- **Sub-millisecond Redirection**: Utilizes a read-through Redis cache.
- **Asynchronous Click Analytics**: Coordinated via Redis Streams and a background worker.
- **Real-Time Data Visualization**: An interactive, glassmorphic single-page dashboard.

---

## 2. Technical Stack and Rationale

The technical stack was chosen specifically to solve high-concurrency and high-throughput constraints:

| Component | Technology | Rationale |
| :--- | :--- | :--- |
| **API & Worker** | Node.js (ESM) | Single-threaded non-blocking event-driven model. High throughput for I/O operations and superb integration with asynchronous drivers. ESM is used for native modern module handling. |
| **Data Cache** | Redis 7 | In-memory key-value store. Provides sub-millisecond read times for hot keys, reducing PostgreSQL query pressure. |
| **Message Broker**| Redis Streams | A lightweight, fast append-only log structure built directly into Redis. Avoids the operational overhead of RabbitMQ or Kafka. |
| **Database** | PostgreSQL 15 | A robust, ACID-compliant relational database. Serves as the ultimate source of truth, offering transactional guarantees and advanced indexing. |
| **Testing** | k6 | A modern developer-centric load testing tool written in Go. Executes high-concurrency requests easily in containerized environments. |
| **Visualization**| Chart.js | Client-side Canvas chart rendering, offering hardware-accelerated animations and mobile responsiveness. |

---

## 3. Key Modules and Responsibilities

### 3.1. API Server (`api`)
- **`src/index.js`**: Initializer script. Configures CORS, mounts endpoints, serves frontend static assets, and connects to Postgres/Redis.
- **`src/db.js`**: Shared service pool for Postgres and Redis. Implements automatic startup retries to prevent container boot failures.
- **`src/idGenerator.js`**: Contains Base62 encoding functions, the MD5-based Hash Generator, and the BigInt bit-shifting Snowflake generator.
- **`src/routes.js`**: Route definitions for:
  - `POST /api/shorten` (validates payloads, calls generator, handles retries on collision).
  - `GET /:shortCode` (read-through cache lookups, issues 302 Location redirect, sets `X-Cache-Status` headers, logs clicks to Redis Streams).
  - `GET /api/analytics/:shortCode` (returns aggregated history).
  - `GET /api/health` (docker container health verification).

### 3.2. Background Worker (`worker`)
- **`src/worker.js`**: Continuous stream processor.
  - Subscribes to the `clicks` stream using a Consumer Group.
  - Implements PEL (Pending Entries List) check on startup to ensure crash recovery.
  - Aggregates events hourly to avoid database write fatigue.
  - Runs batch UPSERTs inside a Postgres transaction block.
  - Exposes an HTTP status page on port 3001.

---

## 4. Problem-Solving Approach

### 4.1. Collision Resolution (Hash Strategy)
To map a 128-bit MD5 digest to an 8-character Base62 short code (48 bits of information space), truncation is required. Truncation can occasionally cause collisions.
- **Solution**: The database table enforces a `UNIQUE` constraint on the `short_code` column. If a write fails with duplicate key error `23505`, the API server catches the exception, increments the `attempt` counter, appends a salt (e.g. `:1`, `:2`), and recalculates the hash and code. This cycle repeats up to 5 times.

### 4.2. Coordination-Free Scaling (Snowflake Strategy)
Generating unique IDs across multiple API instances without a central lock.
- **Solution**: Bit-allocation layout:
  - **41 bits for timestamp**: Allows tracking up to 69 years of milliseconds from a custom epoch.
  - **10 bits for Node ID**: Passed as an environment variable (allowing 1,024 unique instances to run concurrently without collisions).
  - **12 bits for sequence**: Handles up to 4,096 generations within the same millisecond. If the sequence exhausts, the generator blocks until the clock ticks to the next millisecond.

### 4.3. Redis Stream Re-creation on Flush
Administrative or integration tests may run `FLUSHALL` on Redis, clearing active streams and deleting consumer groups.
- **Solution**: The worker's event loop catches `NOGROUP` error codes and automatically calls the stream/group initializer dynamically. This ensures that the worker immediately heals itself and resumes event processing.

---

## 5. Pros and Cons of the Architecture

### Advantages (Pros)
- **High Redirection Throughput**: Served directly from Redis memory in <1ms.
- **Database Scalability**: By batching and aggregating click counts before writing, PostgreSQL only receives 1 UPSERT query per hour per code, instead of 1 write query per click.
- **Fail-safe Recovery**: Using Redis Streams Consumer Groups guarantees that if the worker falls behind or crashes, no click events are lost. They are processed from the checkpoint upon worker recovery.
- **Sleek Client Experience**: Glassmorphism dark mode with animations and real-time history charts.

### Constraints (Cons)
- **Aggregated Analytics Delay**: Click logs are aggregated in the background. Analytics endpoints are updated asynchronously every 2-5 seconds rather than showing real-time immediate writes.
- **Memory Consumption**: If popular URL cache items are not evicted, Redis memory usage could increase. This is mitigated by configuring a 24-hour cache TTL and standard Redis Maxmemory LRU eviction policies.
