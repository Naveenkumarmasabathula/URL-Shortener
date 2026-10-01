const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');

const PORT = process.env.PORT || 3002;
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '3600', 10);
const NEG_TTL = 60;
const STREAM = 'clicks';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);
const app = express();
app.set('trust proxy', true);

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'redirect', instance: process.env.HOSTNAME }));

// Cache-aside lookup: Redis -> Postgres -> populate Redis
async function resolve(code) {
  const cached = await redis.get(`url:${code}`);
  if (cached === '__NULL__') return { url: null, hit: true };
  if (cached) return { url: cached, hit: true };
  const { rows } = await db.query('SELECT long_url FROM urls WHERE code=$1', [code]);
  if (!rows.length) {
    await redis.set(`url:${code}`, '__NULL__', 'EX', NEG_TTL); // negative cache blocks repeated misses
    return { url: null, hit: false };
  }
  await redis.set(`url:${code}`, rows[0].long_url, 'EX', CACHE_TTL);
  return { url: rows[0].long_url, hit: false };
}

app.get('/:code', async (req, res) => {
  const { code } = req.params;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(code)) return res.status(404).json({ error: 'not found' });
  try {
    const { url, hit } = await resolve(code);
    if (!url) return res.status(404).json({ error: 'not found' });
    // Fire-and-forget click event -> Redis Stream (consumed by analytics service)
    redis.xadd(STREAM, 'MAXLEN', '~', 100000, '*',
      'code', code, 'ts', new Date().toISOString(), 'ip', req.ip || '',
      'ua', req.get('user-agent') || '', 'ref', req.get('referer') || '').catch(() => {});
    res.set('X-Cache', hit ? 'HIT' : 'MISS');
    res.set('X-Served-By', process.env.HOSTNAME || 'redirect');
    res.redirect(302, url); // 302 so every click reaches us (301 would be cached by browsers)
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.listen(PORT, () => console.log(`redirect-service on :${PORT}`));
