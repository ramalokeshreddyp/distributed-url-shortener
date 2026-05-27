# Distributed URL Shortener with Collision-Resistant ID Generation & Analytics

A low-latency, scalable, distributed URL shortener designed using modern system architecture patterns. This system utilizes **Node.js**, **PostgreSQL**, and **Redis** to provide high-throughput shortening, sub-millisecond redirection, and an asynchronous analytics processing pipeline.

---

## Architecture Design

The system architecture is split into a **hot path** (for high-performance redirects) and an **asynchronous cold path** (for background analytics aggregation).

```
                      +-------------------+
                      |      Browser      |
                      +--+-------------+--+
                         |             ^
             POST/GET    |             | 302 Redirect
             (API path)  v             |
                      +--+-------------+--+
                      |    API Service    |
                      +--+----------+--+--+
                         |          |
      Read-Through Cache |          | Publish Events
        (sub-ms reads)   v          v
                  +------+---+    +-+--------+
                  |  Redis   |    |  Redis   |
                  |  Cache   |    | Streams  |
                  +------+---+    +----+-----+
                         |             ^
                         | DB Fallback | Consumer Groups (Batches)
                         v             |
                  +------+---+    +----+-----+
                  | Postgres |    | Analytics|
                  | Database |    |  Worker  |
                  +----------+    +----+-----+
                                       |
                         Batch UPSERTs | (Hourly clicks)
                                       v
                                  +----+-----+
                                  | Postgres |
                                  |Analytics |
                                  +----------+
```

### Components

1. **API Service (`api`)**:
   - Built on Node.js (Express).
   - Handles `POST /api/shorten` using:
     - **Hash-based Strategy**: MD5-hashing the URL + salt with collision retries.
     - **Snowflake-inspired Strategy**: Generating unique 64-bit integers based on millisecond timestamp, node ID, and sequence number.
   - Handles `GET /:shortCode` with a read-through cache using Redis.
   - Publishes redirect click events to a Redis Stream named `clicks`.
   - Serves the Single-Page Application (SPA) frontend.
   
2. **Analytics Worker (`worker`)**:
   - A standalone background service that consumes click events from the Redis Stream `clicks`.
   - Uses a Redis Consumer Group (`analytics-group`) to preserve processing state and support parallel scaling.
   - Aggregates event counts hourly in memory and performs transaction-safe database **UPSERTs** into PostgreSQL.
   - Exposes a micro health check HTTP server on port 3001.

3. **Database (`db`)**:
   - PostgreSQL 15 database that persists URL mappings and aggregated hourly analytics.
   
4. **Cache & Broker (`redis`)**:
   - Redis 7 used as a speed layer for original URL caching (with a 24-hour default TTL) and as an event stream broker.

---

## Features & Endpoints

- **POST `/api/shorten`**: Shortens a URL using either `'hash'` or `'snowflake'` strategy, supporting an optional `'expires_at'` timestamp.
- **GET `/:shortCode`**: Fast redirects. First lookup yields `X-Cache-Status: MISS` (PostgreSQL query + Redis cache write). Subsequent lookups yield `X-Cache-Status: HIT` (served from Redis memory in <1ms).
- **GET `/api/analytics/:shortCode`**: Returns total click counts and hourly history (time-series) data.
- **Frontend SPA**: A UI with dark mode, glowing components, glassmorphism card layouts, and real-time visualization of the click history using Chart.js.

---

## Getting Started

### Prerequisites
- [Docker](https://www.docker.com/) and Docker Compose installed.

### Setup and Start Services
Clone this repository and run the startup command from the root directory:

```bash
# Clone the repository
git clone https://github.com/ramalokeshreddyp/distributed-url-shortener.git
cd distributed-url-shortener

# Build and start all services in detached mode
docker-compose up --build -d
```

Verify that all services are running and healthy (this may take up to 30-45 seconds for initial database seeding):

```bash
docker-compose ps
```

Once running, you can access the frontend dashboard by opening your browser at:
**[http://localhost:3000](http://localhost:3000)**

### Environment Variables
For local execution outside Docker, configure variables in a `.env` file (see `.env.example` at root):
- `PORT`: API server port.
- `DATABASE_URL`: Postgres connection URI.
- `REDIS_URL`: Redis connection URI.
- `NODE_ID`: Unique integer identifier (0-1023) for Snowflake generator.
- `BASE_URL`: Root URL domain (e.g. `http://localhost:3000`).

---

## Running Benchmarks

We utilize `k6` to run performance benchmarks. If `k6` is not installed locally on your host, you can execute it inside the same Docker network via the official `grafana/k6` container:

```bash
docker run --rm -i --network="gpp-20_shortener-network" -v "${pwd}:/apps" -e BASE_URL="http://api:3000" -e STRATEGY="snowflake" grafana/k6 run /apps/k6.js
```

Change `-e STRATEGY="hash"` to compare performance profiles. Results and analysis can be reviewed in the [BENCHMARK.md](BENCHMARK.md) report.
