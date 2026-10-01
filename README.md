# URL Shortener — Microservices

A scalable URL shortening system split into three independent microservices behind an Nginx gateway, with Redis caching, load balancing and rate limiting.

**Tech stack:** Microservices · REST APIs · SQL (PostgreSQL) · Redis · Caching · Nginx · Docker

## Architecture

```
                      ┌────────────────────────── Nginx gateway (:8080) ──────────────────────────┐
 client ──HTTP──▶     │  rate limit (20 req/s/IP)  ·  routing  ·  round-robin / least_conn LB     │
                      └───────┬──────────────────────────┬──────────────────────────┬─────────────┘
                              │                          │                          │
                   POST /api/shorten            GET /:code (x2 replicas)    GET /api/analytics/:code
                     ┌────────▼───────┐        ┌────────▼───────┐          ┌────────▼───────┐
                     │ shorten-service│        │redirect-service│          │analytics-service│
                     └───┬────────┬───┘        └───┬────────┬───┘          └───┬────────▲───┘
                         │        │ warm cache     │ cache-aside              │        │ XREADGROUP
                         │        ▼                ▼        │                 │        │
                         │      ┌───────────── Redis ───────┴─────────────────┼────────┘
                         │      │  url:<code> cache · rl:<ip> counters · `clicks` stream
                         ▼      └───────────────────────────────────────────────
                  ┌─────────────┐                                       ┌──────────────┐
                  │ Postgres    │                                       │ Postgres     │
                  │ DB: urls    │                                       │ DB: analytics│
                  └─────────────┘                                       └──────────────┘
```

| Service | Responsibility | Storage |
|---|---|---|
| **shorten** | Validate URL, generate Base62 code (or custom alias), persist, warm cache | `urls` table |
| **redirect** | Resolve code → 302 redirect; cache-aside via Redis; emit click event | Redis → `urls` table |
| **analytics** | Consume click events from a Redis Stream, store in SQL, serve stats | `clicks` table |

### Key design decisions
- **Redis caching (cache-aside):** redirects hit Redis first (`url:<code>`, 1h TTL); misses fall back to Postgres and repopulate. Cache is also warmed on creation, and unknown codes are negatively cached for 60s to absorb bad-code floods. Responses carry `X-Cache: HIT|MISS`.
- **Load balancing:** redirect (the hot read path) runs as 2 replicas; Nginx balances across them (`least_conn`). Scale with `docker compose up --scale redirect=4`. Responses carry `X-Served-By`.
- **Rate limiting (two layers):** Nginx limits all traffic per IP at the edge (20 req/s, burst 40); shorten-service adds a Redis fixed-window limiter (30 creations/min/IP) returning `429` with `X-RateLimit-*` headers.
- **Decoupled analytics:** redirects publish click events to a Redis Stream and return immediately; analytics consumes via a consumer group, so redirect latency is unaffected and events survive analytics downtime.
- **Database per service:** `urls` DB (shorten/redirect) and `analytics` DB — no cross-service table access.
- **Short codes:** Postgres sequence starting at 10^11 encoded in Base62 → 7-character codes. (Swap in Snowflake IDs for multi-region ID generation.)

## Database schema

```sql
-- urls DB
urls(id BIGINT PK, code VARCHAR(32) UNIQUE, long_url TEXT, created_at TIMESTAMPTZ)
-- analytics DB
clicks(id BIGSERIAL PK, code VARCHAR(32), clicked_at TIMESTAMPTZ, ip, user_agent, referer)
INDEX clicks(code, clicked_at DESC)
```

## Run locally

```bash
docker compose up --build
```

Gateway: `http://localhost:8080`

## REST API

| Method | Path | Description |
|---|---|---|
| POST | `/api/shorten` | Body: `{"url": "https://...", "alias": "optional"}` → `201` with `short_url` |
| GET | `/api/urls/:code` | URL metadata |
| GET | `/:code` | `302` redirect to the long URL |
| GET | `/api/analytics/:code` | Total clicks, last 7 days, recent clicks |

```bash
# create
curl -X POST localhost:8080/api/shorten -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com"}'

# redirect (watch X-Cache and X-Served-By)
curl -i localhost:8080/<code>

# analytics
curl localhost:8080/api/analytics/<code>

# rate limiting demo: expect 429s after 30 creations in a minute
for i in $(seq 1 40); do curl -s -o /dev/null -w "%{http_code} " -X POST localhost:8080/api/shorten \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'; done
```

## Project structure

```
gateway/            Nginx config (load balancer + edge rate limit)
services/shorten/   creation service
services/redirect/  redirection service (cache-aside, event publisher)
services/analytics/ stream consumer + stats API
db/01-init.sql      schemas for both databases
docker-compose.yml
```
