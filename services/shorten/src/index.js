const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');

const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || '30', 10); // per IP per minute
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '3600', 10);

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);
const app = express();
app.use(express.json());
app.set('trust proxy', true);

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function base62(n) {
  let num = BigInt(n), out = '';
  if (num === 0n) return '0';
  while (num > 0n) { out = ALPHABET[Number(num % 62n)] + out; num /= 62n; }
  return out;
}

// Application-level rate limiter: fixed window per IP, stored in Redis
async function rateLimit(req, res, next) {
  try {
    const key = `rl:shorten:${req.ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);
    res.set('X-RateLimit-Limit', RATE_LIMIT);
    res.set('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT - count));
    if (count > RATE_LIMIT) return res.status(429).json({ error: 'Too many requests, slow down' });
  } catch (e) { /* fail open if Redis is down */ }
  next();
}

function validUrl(u) {
  try { const p = new URL(u); return ['http:', 'https:'].includes(p.protocol); } catch { return false; }
}

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'shorten' }));

// POST /api/shorten  { "url": "https://...", "alias": "optional" }
app.post('/api/shorten', rateLimit, async (req, res) => {
  const { url, alias } = req.body || {};
  if (!validUrl(url)) return res.status(400).json({ error: 'A valid http(s) url is required' });
  if (alias && !/^[A-Za-z0-9_-]{3,32}$/.test(alias))
    return res.status(400).json({ error: 'alias must be 3-32 chars: letters, digits, _ or -' });
  try {
    const { rows } = await db.query("SELECT nextval('url_id_seq') AS id");
    const id = rows[0].id;
    const code = alias || base62(id);
    await db.query('INSERT INTO urls (id, code, long_url) VALUES ($1,$2,$3)', [id, code, url]);
    await redis.set(`url:${code}`, url, 'EX', CACHE_TTL); // warm cache on write
    res.status(201).json({ code, short_url: `${BASE_URL}/${code}`, long_url: url });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'alias already taken' });
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/urls/:code  -> metadata
app.get('/api/urls/:code', async (req, res) => {
  const { rows } = await db.query('SELECT code, long_url, created_at FROM urls WHERE code=$1', [req.params.code]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

app.listen(PORT, () => console.log(`shorten-service on :${PORT}`));
