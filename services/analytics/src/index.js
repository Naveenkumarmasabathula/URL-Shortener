const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');

const PORT = process.env.PORT || 3003;
const STREAM = 'clicks', GROUP = 'analytics', CONSUMER = process.env.HOSTNAME || 'a1';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);
const app = express();

// ---- Stream consumer: click events -> SQL ----
async function startConsumer() {
  try { await redis.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM'); }
  catch (e) { if (!String(e.message).includes('BUSYGROUP')) throw e; }
  const reader = redis.duplicate(); // dedicated connection for blocking reads
  console.log('analytics consumer started');
  for (;;) {
    try {
      const res = await reader.xreadgroup('GROUP', GROUP, CONSUMER, 'COUNT', 100, 'BLOCK', 5000, 'STREAMS', STREAM, '>');
      if (!res) continue;
      for (const [, entries] of res) {
        for (const [id, f] of entries) {
          const m = {}; for (let i = 0; i < f.length; i += 2) m[f[i]] = f[i + 1];
          await db.query(
            'INSERT INTO clicks (code, clicked_at, ip, user_agent, referer) VALUES ($1,$2,$3,$4,$5)',
            [m.code, m.ts, m.ip, m.ua, m.ref]);
          await redis.xack(STREAM, GROUP, id);
        }
      }
    } catch (e) { console.error('consumer error', e.message); await new Promise(r => setTimeout(r, 2000)); }
  }
}

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'analytics' }));

// GET /api/analytics/:code -> totals, last 7 days, recent clicks
app.get('/api/analytics/:code', async (req, res) => {
  const { code } = req.params;
  const total = await db.query('SELECT COUNT(*)::int AS n FROM clicks WHERE code=$1', [code]);
  const daily = await db.query(
    `SELECT date_trunc('day', clicked_at)::date AS day, COUNT(*)::int AS clicks
     FROM clicks WHERE code=$1 AND clicked_at > now() - interval '7 days'
     GROUP BY 1 ORDER BY 1`, [code]);
  const recent = await db.query(
    'SELECT clicked_at, ip, user_agent, referer FROM clicks WHERE code=$1 ORDER BY clicked_at DESC LIMIT 10', [code]);
  res.json({ code, total_clicks: total.rows[0].n, last_7_days: daily.rows, recent: recent.rows });
});

app.listen(PORT, () => console.log(`analytics-service on :${PORT}`));
startConsumer();
