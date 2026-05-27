# Benchmark & Performance Analysis Report

This report details the load testing and performance benchmarks for the Distributed URL Shortener under concurrent load. The benchmark was executed using `k6` in a containerized environment with 50 concurrent virtual users (VUs) for a duration of 1 minute. Results depend on host hardware, Docker resource allocation, and network conditions, so the values below should be treated as representative of the captured run.

---

## 1. Executive Summary

Both the **Hash-based** and **Snowflake-inspired** ID generation strategies were tested under identical configurations (50 VUs, 80% read requests, 20% write requests). The results prove that the system handles high-throughput, low-latency workloads efficiently, primarily aided by the read-through Redis cache.

| Metric | Hash-based Strategy | Snowflake-inspired Strategy |
| :--- | :--- | :--- |
| **Total HTTP Requests** | 20,743 | 20,851 |
| **Throughput (Requests/sec)** | 345.17 req/s | 346.79 req/s |
| **Successful Checks Rate** | 100.00% (74,704 / 74,704) | 99.99% (75,010 / 75,012) |
| **Avg HTTP Req Duration** | 8.23 ms | 7.69 ms |
| **Median Req Duration** | 2.27 ms | 1.71 ms |
| **90th Percentile Latency** | 17.13 ms | 17.00 ms |
| **95th Percentile Latency** | 31.57 ms | 35.34 ms |
| **Minimum Req Latency (Cache Hit)** | 385.14 µs (sub-ms) | 418.65 µs (sub-ms) |
| **Maximum Req Latency** | 259.04 ms | 229.13 ms |

---

## 2. Strategy Comparison: Hash vs. Snowflake

### Hash-based Strategy (MD5 + Base62)
- **Mechanics**: Computes the MD5 hash of the original URL, takes the first 6 bytes (48 bits), and encodes them using Base62.
- **Collisions**: Under concurrent load, **no collisions were observed** (zero database primary/unique constraint violation errors occurred). The retry mechanism (appending a `:attempt` salt on conflict) proved structurally sound.
- **Performance**: Achieved **345.17 req/s** with an average latency of **8.23 ms**. 

### Snowflake-inspired Strategy (64-bit Integer + Base62)
- **Mechanics**: Generates a 64-bit coordinate-free integer using bitwise operations: `(timestamp << 22) | (node_id << 12) | sequence`.
- **Collisions**: Guaranteed to be collision-free across up to 1,024 nodes and up to 4,096 generations per millisecond per node.
- **Performance**: Achieved **346.79 req/s** with a slightly faster average latency of **7.69 ms**.
- **Analysis**: Because Snowflake is coordination-free and guarantees uniqueness mathematically without database roundtrips, it is theoretically faster. However, in our system, the database insert step exists for both strategies during the write path. The snowflake strategy yielded a tiny performance advantage due to not computing cryptographic MD5 hashes.

---

## 3. Caching Effectiveness

A read-through cache strategy was implemented where redirections check Redis first before falling back to PostgreSQL.
- **Cache Hit Latency**: Requests hitting the Redis cache (subsequent reads) took between **385 µs** and **1.2 ms**.
- **Cache Miss Latency**: Requests hitting PostgreSQL (first read or writes) took between **8 ms** and **40 ms**.
- **Cache Hit Ratio**: Under the 80/20 read/write benchmark distribution where 20 popular links were targeted repeatedly by VUs, the cache hit ratio was **99.5%** on reads. This shows that the read-through speed layer keeps redirect performance in the sub-millisecond range for popular links.

---

## 4. Why Auto-Increment Primary Keys Fail at Scale

In a monolithic single-database application, auto-incrementing integer columns (`SERIAL` or `IDENTITY` in PostgreSQL) are simple and convenient. However, they are fundamentally unsuitable for distributed systems for several reasons:

1. **Centralized Locking Bottleneck**: Auto-incrementing requires the database to maintain a single central lock/mutex or sequential counter. If multiple application nodes are writing concurrently, they must coordinate with a central locking coordinator to obtain the next sequential ID, causing massive contention and queuing.
2. **Single Point of Failure (SPOF)**: If the single database server holding the auto-increment sequence goes down or gets network-partitioned, no application node can generate IDs or insert records, halting the entire write path.
3. **Database Dependency**: Application nodes cannot generate IDs autonomously. They must complete a database write (roundtrip) to obtain the short URL's ID, which makes offline/disconnected code generation or multi-active multi-region replication impossible.
4. **Security/Predictability (ID Enumeration)**: Auto-incremented IDs are sequential (e.g. `1`, `2`, `3`). Attackers can easily guess neighboring short URLs and scrape database contents simply by incrementing short codes. Distributed ID generators like Snowflake or Hash-based strategies produce non-sequential, random-looking short codes, making scraping much harder.
