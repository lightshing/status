import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadServices,
  saveServices,
  saveServicesNow,
  newId,
  readChecks,
  deleteChecks,
} from './store.js';
import { RANGES, DEFAULT_RANGE } from './ranges.js';
import { startMonitor, POLL_INTERVAL } from './monitor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = 3333;

// ---- In-memory state (source of truth, mirrored to disk) -------------------
let services = loadServices();

function persist(force) {
  if (force) saveServicesNow(services);
  else saveServices(services);
}

// ---- Aggregation -----------------------------------------------------------
function buildBuckets(id, range) {
  const { window, bucket } = RANGES[range];
  const now = Math.floor(Date.now() / 1000);
  const start = now - window;
  const numBuckets = Math.ceil(window / bucket);

  const buckets = new Array(numBuckets);
  for (let i = 0; i < numBuckets; i++) {
    buckets[i] = { t: start + i * bucket, up: 0, total: 0 };
  }

  const checks = readChecks(id, start);
  let totalUp = 0;
  for (const c of checks) {
    const idx = Math.floor((c.ts - start) / bucket);
    if (idx < 0 || idx >= numBuckets) continue;
    buckets[idx].total++;
    if (c.status) {
      buckets[idx].up++;
      totalUp++;
    }
  }
  const uptimePct = checks.length ? (totalUp / checks.length) * 100 : null;
  return { buckets, uptimePct };
}

function publicService(svc) {
  return {
    id: svc.id,
    name: svc.name,
    port: svc.port,
    rootDir: svc.rootDir || '',
    publicUrl: svc.publicUrl || '',
    status: svc.status ?? null, // 1 up, 0 down, null unknown
    statusSince: svc.statusSince ?? null,
    lastCheck: svc.lastCheck ?? null,
    createdAt: svc.createdAt,
  };
}

// ---- Request helpers -------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// Version token derived from asset mtimes, used for cache-busting query
// strings so a proxy (e.g. Cloudflare) or browser can't serve stale JS/CSS.
function assetVersion() {
  try {
    const a = fs.statSync(path.join(PUBLIC_DIR, 'app.js')).mtimeMs;
    const c = fs.statSync(path.join(PUBLIC_DIR, 'styles.css')).mtimeMs;
    return String(Math.floor(Math.max(a, c)));
  } catch {
    return '1';
  }
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // Never let JS/CSS/HTML be cached by intermediaries — this app is served
    // through tunnels/proxies and must always reflect the latest deploy.
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
    };
    if (ext === '.html') {
      const html = buf.toString('utf8').replace(/__V__/g, assetVersion());
      res.writeHead(200, headers);
      res.end(html);
      return;
    }
    res.writeHead(200, headers);
    res.end(buf);
  });
}

// ---- Validation ------------------------------------------------------------
function validateRegistration(body) {
  const name = String(body.name ?? '').trim();
  const port = Number(body.port);
  const rootDir = String(body.rootDir ?? '').trim();
  const publicUrl = String(body.publicUrl ?? '').trim();

  if (!name) return { error: '服务名称不能为空' };
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return { error: '端口号必须是 1-65535 之间的整数' };
  return { value: { name, port, rootDir, publicUrl } };
}

// ---- Router ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathName = url.pathname;

  try {
    // GET /api/data?range=1d — everything the dashboard needs in one call.
    if (pathName === '/api/data' && req.method === 'GET') {
      let range = url.searchParams.get('range') || DEFAULT_RANGE;
      if (!RANGES[range]) range = DEFAULT_RANGE;
      const { window, bucket } = RANGES[range];
      const payload = {
        range,
        window,
        bucket,
        pollInterval: POLL_INTERVAL,
        now: Date.now(),
        ranges: Object.fromEntries(
          Object.entries(RANGES).map(([k, v]) => [k, { label: v.label }])
        ),
        services: services.map((svc) => {
          const { buckets, uptimePct } = buildBuckets(svc.id, range);
          return { ...publicService(svc), buckets, uptimePct };
        }),
      };
      return sendJson(res, 200, payload);
    }

    // GET /api/services — metadata only.
    if (pathName === '/api/services' && req.method === 'GET') {
      return sendJson(res, 200, { services: services.map(publicService) });
    }

    // POST /api/services — register a new service.
    if (pathName === '/api/services' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return sendJson(res, 400, { error: '无效的 JSON' });
      }
      const { error, value } = validateRegistration(body);
      if (error) return sendJson(res, 400, { error });

      const svc = {
        id: newId(),
        ...value,
        status: null,
        statusSince: null,
        lastCheck: null,
        createdAt: Date.now(),
      };
      services.push(svc);
      persist(true);
      return sendJson(res, 201, { service: publicService(svc) });
    }

    // DELETE /api/services/:id — remove a service and its history.
    const delMatch = pathName.match(/^\/api\/services\/([a-f0-9]+)$/);
    if (delMatch && req.method === 'DELETE') {
      const id = delMatch[1];
      const idx = services.findIndex((s) => s.id === id);
      if (idx === -1) return sendJson(res, 404, { error: '服务不存在' });
      services.splice(idx, 1);
      deleteChecks(id);
      persist(true);
      return sendJson(res, 200, { ok: true });
    }

    // PUT /api/services/:id — edit metadata.
    const putMatch = pathName.match(/^\/api\/services\/([a-f0-9]+)$/);
    if (putMatch && req.method === 'PUT') {
      const id = putMatch[1];
      const svc = services.find((s) => s.id === id);
      if (!svc) return sendJson(res, 404, { error: '服务不存在' });
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return sendJson(res, 400, { error: '无效的 JSON' });
      }
      const { error, value } = validateRegistration(body);
      if (error) return sendJson(res, 400, { error });
      Object.assign(svc, value);
      persist(true);
      return sendJson(res, 200, { service: publicService(svc) });
    }

    if (pathName.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Not found' });
    }

    // Static assets / SPA.
    return serveStatic(req, res, pathName);
  } catch (err) {
    console.error('[server] error:', err);
    return sendJson(res, 500, { error: '服务器内部错误' });
  }
});

startMonitor(() => services, persist);

server.listen(PORT, () => {
  console.log(`Port Health Monitor running at http://localhost:${PORT}`);
  console.log(`Polling every ${POLL_INTERVAL}s. ${services.length} service(s) registered.`);
});
