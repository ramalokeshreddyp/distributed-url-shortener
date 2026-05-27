# Benchmark & Performance Analysis Report

This report details the load testing and performance benchmarks for the Distributed URL Shortener under concurrent load. The benchmark was executed using `k6` in a containerized environment with 50 concurrent virtual users (VUs) for a ~1 minute scenario (see `k6.js`). Results depend on host hardware, Docker resource allocation, and network conditions; the values below reflect the captured runs on the target machine.

---

## 1. Executive Summary

Both the **Hash-based** and **Snowflake-inspired** ID generation strategies were tested under identical configurations (50 VUs, 80% read requests, 20% write requests). The runs exported JSON summaries (`k6_hash_summary.json` and `k6_snow_summary.json`) which were used to produce the numbers below.

| Metric | Hash-based Strategy (measured) | Snowflake-inspired Strategy (measured) |
| :--- | :---: | :---: |
| **Total HTTP Requests** | 20,408 | 20,440 |
| **Throughput (Requests/sec)** | 339.38 req/s | 339.43 req/s |
| **Checks: passes / fails** | 73,280 / 0 | 73,504 / 2 |
| **Avg HTTP Req Duration** | 9.93 ms | 9.74 ms |
| **Median Req Duration** | 3.57 ms | 3.22 ms |
| **90th Percentile Latency** | 23.55 ms | 24.97 ms |
| **95th Percentile Latency** | 37.71 ms | 43.68 ms |
| **Minimum Req Latency (min)** | 0.12 ms | 0.035 ms |
| **Maximum Req Latency** | 244.61 ms | 168.12 ms |

---

## 2. Strategy Comparison: Hash vs. Snowflake

### Hash-based Strategy (MD5 + Base62)
- **Mechanics**: Computes the MD5 hash of the original URL, takes the first 6 bytes (48 bits), and encodes them using Base62.
- **Collisions**: In these runs no database unique-constraint collisions were observed. The implementation defends against rare collisions with a retry-on-conflict loop (up to 5 attempts) which appends an `:attempt` salt.
- **Performance**: Measured throughput was **~339.4 req/s** with an average request duration of **~9.93 ms**, dominated by DB insert time on writes.

### Snowflake-inspired Strategy (64-bit Integer + Base62)
- **Mechanics**: Generates a 64-bit integer composed from timestamp, node id, and a per-ms sequence, then encodes it in Base62.
- **Collisions**: Effectively collision-free when `node_id` assignment and clock monotonicity are maintained. Sequence exhaustion is possible only at extreme per-ms generation rates.
- **Performance**: Measured throughput was **~339.4 req/s** with an average request duration of **~9.74 ms**. In this environment both strategies produced similar end-to-end latencies since writes require a DB insert; Snowflake avoids the MD5 CPU cost but does not eliminate the DB roundtrip.

---

## 3. Caching Effectiveness

A read-through cache strategy was implemented where redirections check Redis first before falling back to PostgreSQL.
- **Cache Hit Latency**: Requests hitting the Redis cache (subsequent reads) were served in sub-millisecond times in this environment.
- **Cache Miss Latency**: Cold reads or writes that required PostgreSQL took single-digit milliseconds to low tens of milliseconds.
- **Cache Hit Ratio**: Under the 80/20 read/write benchmark where 20 popular links were targeted repeatedly by VUs, the observed behavior shows a very high cache hit ratio for those popular links; cached redirect reads dominated the traffic and kept perceived latency low.

---

## 4. Why Auto-Increment Primary Keys Fail at Scale

In a monolithic single-database application, auto-incrementing integer columns (`SERIAL` or `IDENTITY` in PostgreSQL) are simple and convenient. However, they are fundamentally unsuitable for distributed systems for several reasons:

1. **Centralized Locking Bottleneck**: Auto-incrementing requires the database to maintain a single central lock/mutex or sequential counter. If multiple application nodes are writing concurrently, they must coordinate with a central locking coordinator to obtain the next sequential ID, causing contention and queuing.
2. **Single Point of Failure (SPOF)**: If the single database server holding the auto-increment sequence goes down or gets network-partitioned, no application node can generate IDs or insert records, halting the entire write path.
3. **Database Dependency**: Application nodes cannot generate IDs autonomously. They must complete a database write (roundtrip) to obtain the short URL's ID, which makes offline/disconnected code generation or multi-active multi-region replication difficult.
4. **Security/Predictability (ID Enumeration)**: Auto-incremented IDs are sequential (e.g. `1`, `2`, `3`). Attackers can easily guess neighboring short URLs and scrape database contents. Distributed ID generators like Snowflake or Hash-based strategies produce non-sequential, random-looking short codes, making enumeration harder.

---

## Notes & Artifacts
- The k6 run commands used locally for these runs were (run from the project root):

```powershell
docker run --rm -i --network="gpp-20_shortener-network" -v "${PWD}:/apps" -e BASE_URL="http://api:3000" -e STRATEGY="hash" grafana/k6 run --summary-export=/apps/k6_hash_summary.json /apps/k6.js
docker run --rm -i --network="gpp-20_shortener-network" -v "${PWD}:/apps" -e BASE_URL="http://api:3000" -e STRATEGY="snowflake" grafana/k6 run --summary-export=/apps/k6_snow_summary.json /apps/k6.js
```

- The JSON summaries are saved in the workspace as `k6_hash_summary.json` and `k6_snow_summary.json` for further inspection.

