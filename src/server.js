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
  loadIgnores,
  saveIgnores,
  loadSettings,
  saveSettings,
  loadRules,
  saveRules,
} from './store.js';
import { RANGES, DEFAULT_RANGE } from './ranges.js';
import { startMonitor, POLL_INTERVAL } from './monitor.js';
import { listListeningPorts } from './ports.js';
import { createTelegram } from './telegram.js';
import { createNotifier } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3333;

// ---- In-memory state (source of truth, mirrored to disk) -------------------
let services = loadServices();
let ignores = loadIgnores();
let settings = loadSettings();
let rules = loadRules();

function persist(force) {
  if (force) saveServicesNow(services);
  else saveServices(services);
}

// ---- Notification wiring ---------------------------------------------------
// Uptime over the last `windowSec` seconds for one service, from its raw log.
function statsFor(id, windowSec) {
  const from = Math.floor(Date.now() / 1000) - windowSec;
  const checks = readChecks(id, from);
  let up = 0;
  for (const c of checks) if (c.status) up++;
  const total = checks.length;
  return { up, down: total - up, total, ratio: total ? up / total : null };
}

const telegram = createTelegram({
  getConfig: () => settings.telegram,
  getServices: () => services,
  statsFor,
  pollIntervalSec: POLL_INTERVAL,
});

// Route a rendered alert to every requested channel (deduped). Telegram is
// live; SMTP is reserved (UI exists, delivery is a follow-up).
function dispatchNotification(channels, text) {
  const set = new Set(Array.isArray(channels) ? channels : []);
  if (set.has('telegram') && settings.telegram.enabled) telegram.notify(text);
  // if (set.has('smtp') && settings.smtp.enabled) sendMail(text); // TODO
}

const notifier = createNotifier({
  getServices: () => services,
  getIgnores: () => ignores,
  getRules: () => rules,
  dispatch: dispatchNotification,
});

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

// Settings sent to the browser never include secrets — only whether one is set.
function publicSettings(s) {
  return {
    telegram: {
      enabled: !!s.telegram.enabled,
      chatId: s.telegram.chatId || '',
      tokenSet: !!s.telegram.token,
    },
    smtp: {
      enabled: !!s.smtp.enabled,
      host: s.smtp.host || '',
      port: s.smtp.port ?? 465,
      secure: s.smtp.secure !== false,
      username: s.smtp.username || '',
      from: s.smtp.from || '',
      recipients: Array.isArray(s.smtp.recipients) ? s.smtp.recipients : [],
      passwordSet: !!s.smtp.password,
    },
  };
}

// Merge an incoming settings patch. A blank/absent secret keeps the stored one;
// the literal sentinel '' with the *Clear flag wipes it.
function applySettingsPatch(current, body) {
  const next = JSON.parse(JSON.stringify(current));
  const tg = body.telegram || {};
  if (typeof tg.enabled === 'boolean') next.telegram.enabled = tg.enabled;
  if (typeof tg.chatId === 'string') next.telegram.chatId = tg.chatId.trim();
  if (typeof tg.token === 'string' && tg.token.trim()) next.telegram.token = tg.token.trim();
  if (tg.clearToken === true) next.telegram.token = '';

  const sm = body.smtp || {};
  if (typeof sm.enabled === 'boolean') next.smtp.enabled = sm.enabled;
  if (typeof sm.host === 'string') next.smtp.host = sm.host.trim();
  if (sm.port !== undefined && Number.isInteger(Number(sm.port))) next.smtp.port = Number(sm.port);
  if (typeof sm.secure === 'boolean') next.smtp.secure = sm.secure;
  if (typeof sm.username === 'string') next.smtp.username = sm.username.trim();
  if (typeof sm.from === 'string') next.smtp.from = sm.from.trim();
  if (Array.isArray(sm.recipients))
    next.smtp.recipients = sm.recipients.map((r) => String(r).trim()).filter(Boolean);
  if (typeof sm.password === 'string' && sm.password) next.smtp.password = sm.password;
  if (sm.clearPassword === true) next.smtp.password = '';
  return next;
}

const RULE_TYPES = ['status_change', 'duration', 'new_port'];
const CHANNELS = ['telegram', 'smtp'];

// Validate + normalise a rule payload against the current service list.
function validateRule(body) {
  const type = String(body.type || '');
  if (!RULE_TYPES.includes(type)) return { error: '未知的告警类型' };

  const channels = Array.isArray(body.channels)
    ? body.channels.filter((c) => CHANNELS.includes(c))
    : [];
  if (!channels.length) return { error: '请至少选择一种推送方式' };

  const enabled = body.enabled !== false;
  const name = String(body.name ?? '').trim();
  const out = { type, enabled, name, channels };

  if (type === 'new_port') return { value: out };

  // status_change & duration share scope/serviceIds.
  const scope = body.scope === 'selected' ? 'selected' : 'all';
  const validIds = new Set(services.map((s) => s.id));
  const serviceIds = Array.isArray(body.serviceIds)
    ? body.serviceIds.filter((id) => validIds.has(id))
    : [];
  if (scope === 'selected' && !serviceIds.length)
    return { error: '请至少选择一个端口，或改为「所有端口」' };
  out.scope = scope;
  out.serviceIds = serviceIds;

  if (type === 'status_change') {
    const dir = body.direction;
    out.direction = ['both', 'up', 'down'].includes(dir) ? dir : 'both';
  } else if (type === 'duration') {
    out.state = body.state === 'up' ? 'up' : 'down';
    const seconds = Number(body.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0)
      return { error: '持续时长必须是正数（秒）' };
    out.seconds = Math.floor(seconds);
  }
  return { value: out };
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

    // GET /api/ports — every TCP port currently listened on, with the process
    // occupying it and whether it's registered here.
    if (pathName === '/api/ports' && req.method === 'GET') {
      const ports = await listListeningPorts();
      const byPort = new Map();
      for (const svc of services) {
        if (!byPort.has(svc.port)) byPort.set(svc.port, svc);
      }
      const ignoreByPort = new Map(ignores.map((ig) => [ig.port, ig]));
      const rows = ports.map((p) => {
        const svc = byPort.get(p.port);
        const ig = ignoreByPort.get(p.port);
        return {
          ...p,
          registered: !!svc,
          registeredName: svc ? svc.name : null,
          registeredId: svc ? svc.id : null,
          ignored: !!ig,
          ignoreNote: ig ? ig.note || '' : '',
        };
      });
      return sendJson(res, 200, { ports: rows });
    }

    // POST /api/ports/ignore — hide an unregistered port from the nag.
    // Body: { port, note? }. Note is optional. Re-posting updates the note.
    if (pathName === '/api/ports/ignore' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return sendJson(res, 400, { error: '无效的 JSON' });
      }
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        return sendJson(res, 400, { error: '端口号必须是 1-65535 之间的整数' });
      const note = String(body.note ?? '').trim();
      const existing = ignores.find((ig) => ig.port === port);
      if (existing) {
        existing.note = note;
      } else {
        ignores.push({ port, note, createdAt: Date.now() });
      }
      saveIgnores(ignores);
      return sendJson(res, 200, { ok: true });
    }

    // DELETE /api/ports/ignore/:port — un-ignore a port.
    const unignoreMatch = pathName.match(/^\/api\/ports\/ignore\/(\d+)$/);
    if (unignoreMatch && req.method === 'DELETE') {
      const port = Number(unignoreMatch[1]);
      const idx = ignores.findIndex((ig) => ig.port === port);
      if (idx === -1) return sendJson(res, 404, { error: '该端口未被忽略' });
      ignores.splice(idx, 1);
      saveIgnores(ignores);
      return sendJson(res, 200, { ok: true });
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

    // GET /api/settings — channel config, secrets masked.
    if (pathName === '/api/settings' && req.method === 'GET') {
      return sendJson(res, 200, { settings: publicSettings(settings) });
    }

    // PUT /api/settings — update channel config (blank secret keeps existing).
    if (pathName === '/api/settings' && req.method === 'PUT') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); }
      catch { return sendJson(res, 400, { error: '无效的 JSON' }); }
      settings = applySettingsPatch(settings, body);
      saveSettings(settings);
      return sendJson(res, 200, { settings: publicSettings(settings) });
    }

    // POST /api/settings/telegram/test — send a test message. Accepts optional
    // token/chatId in the body so it works before saving.
    if (pathName === '/api/settings/telegram/test' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); }
      catch { return sendJson(res, 400, { error: '无效的 JSON' }); }
      const token = (body.token && String(body.token).trim()) || settings.telegram.token;
      const chatId = (body.chatId && String(body.chatId).trim()) || settings.telegram.chatId;
      if (!token) return sendJson(res, 400, { error: '缺少 Bot Token' });
      if (!chatId) return sendJson(res, 400, { error: '缺少 Chat ID' });
      const r = await telegram.send('✅ 端口健康监测 · 测试消息发送成功。', {
        force: true, token, chatId,
      });
      if (r && r.ok) return sendJson(res, 200, { ok: true });
      return sendJson(res, 502, { error: 'Telegram 返回：' + (r?.description || '发送失败') });
    }

    // GET /api/rules — all alert rules.
    if (pathName === '/api/rules' && req.method === 'GET') {
      return sendJson(res, 200, { rules });
    }

    // POST /api/rules — create a rule.
    if (pathName === '/api/rules' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); }
      catch { return sendJson(res, 400, { error: '无效的 JSON' }); }
      const { error, value } = validateRule(body);
      if (error) return sendJson(res, 400, { error });
      const rule = { id: newId(), ...value, createdAt: Date.now() };
      rules.push(rule);
      saveRules(rules);
      return sendJson(res, 201, { rule });
    }

    // PUT /api/rules/:id — update a rule.
    const rulePut = pathName.match(/^\/api\/rules\/([a-f0-9]+)$/);
    if (rulePut && req.method === 'PUT') {
      const id = rulePut[1];
      const rule = rules.find((r) => r.id === id);
      if (!rule) return sendJson(res, 404, { error: '规则不存在' });
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); }
      catch { return sendJson(res, 400, { error: '无效的 JSON' }); }
      const { error, value } = validateRule(body);
      if (error) return sendJson(res, 400, { error });
      Object.assign(rule, value);
      saveRules(rules);
      return sendJson(res, 200, { rule });
    }

    // DELETE /api/rules/:id — remove a rule.
    const ruleDel = pathName.match(/^\/api\/rules\/([a-f0-9]+)$/);
    if (ruleDel && req.method === 'DELETE') {
      const id = ruleDel[1];
      const idx = rules.findIndex((r) => r.id === id);
      if (idx === -1) return sendJson(res, 404, { error: '规则不存在' });
      rules.splice(idx, 1);
      saveRules(rules);
      return sendJson(res, 200, { ok: true });
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

startMonitor(() => services, persist, (svcs) => notifier.onPoll(svcs));
notifier.start();
telegram.start();

server.listen(PORT, () => {
  console.log(`Port Health Monitor running at http://localhost:${PORT}`);
  console.log(`Polling every ${POLL_INTERVAL}s. ${services.length} service(s) registered.`);
  console.log(`Alert rules: ${rules.length}. Telegram bot: ${settings.telegram.enabled ? 'on' : 'off'}.`);
});
