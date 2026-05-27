# Questionnaire — Design Answers

1) Trade-offs between Hash-based and Snowflake-inspired ID strategies

- Hash-based (MD5 truncated → Base62):
  - Collision probability: uses MD5 then truncates to 48 bits. Large space but truncation increases theoretical collision risk; the code defends with a DB UNIQUE constraint and up to 5 retry attempts with a salt. Collisions are rare at modest scale but possible at extreme cardinality.
  - Performance: computing MD5 and Base62 is moderately cheap but heavier than simple bit ops; per-write CPU cost is higher than Snowflake.
  - Sortability: not k-sortable — outputs appear random (no time ordering).
  - Practical tradeoffs: good for opaque, deterministic codes (same URL → same code) but requires collision handling and slightly higher CPU.

- Snowflake-inspired (timestamp|node_id|sequence → Base62):
  - Collision probability: negligible when `node_id` is unique and clocks are monotonic. Collisions occur only when node_id misconfiguration or clock skew/backwards happens.
  - Performance: very cheap (bit shifts and sequence increments) and lower CPU per ID than hashing; better for very high write rates.
  - Sortability: k-sortable — preserves approximate time ordering (good for recent-first queries).
  - Practical tradeoffs: excellent write throughput and sortability but requires stable node-id assignment and clock management.

Summary: Snowflake wins for write performance and k-sortability; hash gives opaque, deterministic IDs but needs DB-backed collision handling.

2) Primary scalability bottleneck and mitigation for 10× traffic

- Primary bottleneck: PostgreSQL write load (inserts for `urls` and UPSERTs for `analytics_hourly`) and connection/IO contention.
- Mitigations (incremental):
  - Add read replicas for read-heavy traffic; route analytics reads to replicas.
  - Use connection pooling (PgBouncer) to reduce connection churn.
  - Partition `analytics_hourly` (time-based partitions) to reduce index contention and speed UPSERTs.
  - Batch analytics writes (worker-side aggregates) and increase UPSERT batch sizes.
  - Move high-ingest analytics to a purpose-built store (TimescaleDB, ClickHouse) if aggregation scale grows.
  - Scale Redis to a cluster for capacity and throughput; tune persistence (AOF) and retention for Streams.
  - Horizontally scale API and worker instances; ensure deterministic `NODE_ID` assignment for Snowflake.
  - Add CDN/edge caching for extremely hot short codes.

3) TTL-based expiration inconsistency scenario and alternative invalidation

- Problem: If a URL is deleted/updated in Postgres but the Redis cache entry remains until TTL expiry, clients can still be redirected to stale or deleted targets.
- Fixes:
  - Cache-aside with explicit invalidation: after any DB update/delete, issue `redis.del('url:<short_code>')` post-commit to evict the cache immediately.
  - Use Pub/Sub invalidation across API instances to evict local caches simultaneously.
  - Store a version/tombstone in DB and include version in cached entry; verify or revalidate on cache hit when stricter correctness is required.
  - Use short TTLs for critical mutable records and combine with explicit invalidation.

Recommendation: perform explicit `DEL` after DB commit (or use a post-commit hook) so cache and DB remain consistent without waiting for TTLs.

4) Why Redis Streams asynchronous pipeline for analytics

- Benefits:
  - Low hot-path latency: publishing to a stream is fast; redirect requests don't wait for analytics DB writes.
  - Durability & ordering: Streams persist events (subject to Redis persistence config) and preserve append order.
  - Scalability: consumer groups allow multiple workers to share processing load.
  - Back-pressure tolerance: producers append quickly while consumers process at their own rate.
- Drawbacks:
  - Eventual consistency: analytics are delayed; dashboards lag behind real time.
  - Backlog risk: if consumers lag or are down, streams grow and consume memory unless trimmed.
  - Operational complexity: must monitor consumer lag, pending entries, and Redis persistence settings.

Tradeoff: chosen to optimize redirect latency and availability while accepting eventual consistency for analytics.

5) Analytics Worker down for an hour — impact and recovery

- Impact: redirects continue to work; analytics events accumulate in the `clicks` stream. Metrics are stale until workers process the backlog. Large backlogs increase Redis memory usage.
- How design prevents data loss:
  - Redis Streams persist appended events; with AOF/RDB persistence enabled events survive Redis restarts.
  - Consumer groups track delivered-but-unacked messages in the Pending Entries List (PEL). Worker acknowledges (`XACK`) only after successful DB commit in our implementation, ensuring at-least-once delivery semantics without acknowledging uncommitted work.
  - On restart or with new consumers, pending entries can be claimed (`XAUTOCLAIM`) or read again for processing, preventing loss.
- Hardening recommendations: enable AOF, monitor stream length and PEL size, autoscale workers based on lag, and consider Kafka if retention and durability requirements rise further.

6) Role of Redis Streams persistence and consumer groups

- Persistence: Streams store messages in Redis memory and, if persistence is enabled (AOF/RDB), on disk; this makes the stream durable across restarts according to configured persistence guarantees.
- Consumer groups: allow multiple worker instances to cooperatively consume a stream; the PEL records delivery state so messages can be retried or claimed by other consumers if a worker dies. Proper `XACK` after DB commit ensures messages are not lost nor double-acknowledged.

---

Implementation notes (repo): the API uses `xAdd('clicks', '*', {...})` to publish events. The worker runs an `analytics-group` consumer group, aggregates hourly counts, does bulk UPSERTs into `analytics_hourly`, and `XACK`s after the DB transaction succeeds. The ID generators live in `api/src/idGenerator.js` (MD5-truncate + Snowflake impl). The DB schema is in `db/init.sql`.

If you want, I will commit and push `answers.md` now — say "commit" to proceed.
