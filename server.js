require('dotenv').config();

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const app = express();
const port = Number(process.env.PORT || 3000);
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const supabaseKey = process.env.SUPABASE_ANON_KEY || '';
const storefrontName = fs.readdirSync(__dirname).find((name) => name.toLowerCase().endsWith('.html'));
const storefrontFile = storefrontName ? path.join(__dirname, storefrontName) : null;

if (!supabaseUrl || !supabaseKey) {
  console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY in the Render environment.');
  process.exit(1);
}
if (!storefrontFile) {
  console.error('The storefront HTML file is missing.');
  process.exit(1);
}

app.disable('x-powered-by');
// Render puts a proxy in front of the app. Without this, every visitor shares one IP and one rate limit.
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb', strict: true }));
app.use('/assets', express.static(path.join(__dirname, 'assets'), { maxAge: '1h' }));

// Small per-instance limit for public RPC calls; SQL functions still validate every operation.
const windows = new Map();
setInterval(() => {
  const cut = Date.now() - 60_000;
  for (const [ip, w] of windows) if (w.start < cut) windows.delete(ip);
}, 60_000).unref();
app.use('/api/rest/v1/rpc', (req, res, next) => {
  const now = Date.now();
  const ip = req.ip;
  let entry = windows.get(ip);
  if (!entry || now - entry.start >= 60_000) {
    entry = { start: now, count: 0 };
    windows.set(ip, entry);
  }
  entry.count += 1;
  if (entry.count > 90) return res.status(429).json({ message: 'rate_limit_exceeded' });
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Settings for the admin page. This is the publishable key only. Never put a service_role key anywhere in this app.
app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ url: supabaseUrl, key: supabaseKey });
});
app.use('/admin', express.static(path.join(__dirname, 'admin')));

const publicTables = new Set(['categories', 'products', 'store_settings']);
app.get('/api/rest/v1/:table', async (req, res) => {
  if (!publicTables.has(req.params.table)) {
    return res.status(404).json({ message: 'endpoint_not_found' });
  }
  return proxy(req, res, `/rest/v1/${req.params.table}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
});

const publicFunctions = new Set(['discount_for', 'place_order', 'track_order']);
app.post('/api/rest/v1/rpc/:fn', async (req, res) => {
  if (!publicFunctions.has(req.params.fn)) {
    return res.status(404).json({ message: 'endpoint_not_found' });
  }
  return proxy(req, res, `/rest/v1/rpc/${req.params.fn}`, req.body);
});

async function proxy(req, res, upstreamPath, body) {
  try {
    const upstream = await fetch(`${supabaseUrl}${upstreamPath}`, {
      method: req.method,
      headers: {
        apikey: supabaseKey,
        'Content-Type': 'application/json'
      },
      ...(req.method === 'POST' ? { body: JSON.stringify(body) } : {})
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.set('Cache-Control', 'no-store');
    res.type(upstream.headers.get('content-type') || 'application/json');
    return res.send(text);
  } catch (error) {
    console.error('Supabase request failed:', error.message);
    return res.status(502).json({ message: 'database_unavailable' });
  }
}

app.get('/', (_req, res) => res.sendFile(storefrontFile));
app.get('*', (_req, res) => res.status(404).send('Not found'));

app.listen(port, '0.0.0.0', () => console.log(`COFFEECUP server listening on ${port}`));
