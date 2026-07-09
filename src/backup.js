// Backup monitor — polls the server-backup project's read-only status API
// (scripts/status_api.py, documented in ../backup/docs/API.md) and exposes the
// latest snapshot to the dashboard. When a *new* backup run appears, it pushes
// a Telegram message with the run's details and the next scheduled backup time.
//
// The backup API is GET-only and unauthenticated; we only ever read it. Times
// it returns are UTC ISO strings; we format them in a display timezone
// (Asia/Shanghai by default, matching the Chinese UI) for the Telegram push.
//
// Only Node's built-in http is used.

import http from 'node:http';
import { loadBackupState, saveBackupState } from './store.js';

const DEFAULT_URL = 'http://127.0.0.1:8787';
const POLL_MS = 60 * 1000; // backups are daily; a minute of latency is plenty
const TIMEOUT_MS = 8000;
const DISPLAY_TZ = process.env.BACKUP_TZ || 'Asia/Shanghai';

// ---- tiny HTTP GET → JSON --------------------------------------------------
function getJson(url, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        // The API returns JSON for every response, including 503 (unhealthy)
        // and 405 — so parse regardless of status, but surface hard failures.
        let json = null;
        try { json = JSON.parse(body); } catch { /* leave null */ }
        if (res.statusCode >= 500 && json == null) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ---- formatting helpers (used by the Telegram message) ---------------------
function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function fmtTime(iso) {
  if (!iso) return '未知';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  // zh-CN separates the date with slashes; use dashes to match the dashboard.
  return d.toLocaleString('zh-CN', {
    timeZone: DISPLAY_TZ,
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-');
}

function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Number(n), i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const val = i === 0 ? String(v) : v.toFixed(v < 10 ? 2 : 1);
  return `${val} ${units[i]}`;
}

function fmtDur(sec) {
  let s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [];
  if (h) parts.push(h + ' 时');
  if (m || h) parts.push(m + ' 分');
  parts.push(s + ' 秒');
  return parts.join(' ');
}

// Coarse "约 X 后" from now to an ISO time (up to two units, no seconds).
function relFromNow(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  let diff = Math.floor((d.getTime() - Date.now()) / 1000);
  if (diff <= 0) return '即将开始';
  const day = Math.floor(diff / 86400); diff -= day * 86400;
  const h = Math.floor(diff / 3600); diff -= h * 3600;
  const m = Math.floor(diff / 60);
  const parts = [];
  if (day) parts.push(day + ' 天');
  if (h) parts.push(h + ' 小时');
  if (!day && m) parts.push(m + ' 分钟');
  if (!parts.length) parts.push('不到 1 分钟');
  return '约 ' + parts.slice(0, 2).join(' ') + '后';
}

// A backup run's Telegram-flavored HTML message.
function buildText(st) {
  const b = st.lastBackup || {};
  const ok = b.status === 'success';
  const lines = [];
  lines.push(ok ? '✅ <b>服务器备份完成</b>' : '❌ <b>服务器备份失败</b>');
  lines.push('');
  lines.push(`🕐 开始：${fmtTime(b.start_time)}`);
  if (b.end_time) lines.push(`🏁 结束：${fmtTime(b.end_time)}`);
  if (b.duration_seconds != null) lines.push(`⏱ 耗时：${fmtDur(b.duration_seconds)}`);
  if (ok) {
    if (b.data_added_bytes != null) lines.push(`📦 新增数据：${fmtBytes(b.data_added_bytes)}`);
    const fp = [];
    if (b.files_new != null) fp.push(`新增 ${b.files_new}`);
    if (b.files_changed != null) fp.push(`变更 ${b.files_changed}`);
    if (fp.length) lines.push(`📄 文件：${fp.join(' · ')}`);
    if (b.snapshot_id) lines.push(`🔖 快照：<code>${esc(String(b.snapshot_id).slice(0, 12))}</code>`);
  } else if (b.error) {
    lines.push(`⚠️ 错误：${esc(String(b.error).slice(0, 400))}`);
  }
  lines.push('');
  const rel = relFromNow(st.nextBackupTime);
  lines.push(`⏭ 下次备份：${fmtTime(st.nextBackupTime)}${rel ? `（${rel}）` : ''}`);
  return lines.join('\n');
}

// The semantic object the email renderer turns into a styled message
// (mailer.renderAlertEmail). Mirrors the shape the alert engine emits.
function buildMail(st) {
  const b = st.lastBackup || {};
  const ok = b.status === 'success';
  const rows = [];
  rows.push(['开始时间', fmtTime(b.start_time)]);
  if (b.end_time) rows.push(['结束时间', fmtTime(b.end_time)]);
  if (b.duration_seconds != null) rows.push(['耗时', fmtDur(b.duration_seconds)]);
  if (ok) {
    if (b.data_added_bytes != null) rows.push(['新增数据', fmtBytes(b.data_added_bytes)]);
    const fp = [];
    if (b.files_new != null) fp.push(`新增 ${b.files_new}`);
    if (b.files_changed != null) fp.push(`变更 ${b.files_changed}`);
    if (fp.length) rows.push(['文件', fp.join(' · ')]);
    if (b.snapshot_id) rows.push(['快照', String(b.snapshot_id).slice(0, 12)]);
  }
  const rel = relFromNow(st.nextBackupTime);
  rows.push(['下次备份', `${fmtTime(st.nextBackupTime)}${rel ? `（${rel}）` : ''}`]);
  return {
    accent: ok ? 'up' : 'down',
    emoji: ok ? '✅' : '❌',
    title: ok ? '服务器备份完成' : '服务器备份失败',
    subject: `${ok ? '✅ 服务器备份完成' : '❌ 服务器备份失败'} · ${fmtTime(b.end_time || b.start_time)}`,
    summary: ok ? '服务器备份已成功完成。' : '服务器备份未能成功完成，请及时排查。',
    rows,
    note: !ok && b.error ? String(b.error).slice(0, 400) : '',
  };
}

// One backup run rendered as a channel-agnostic alert event:
//   { ok, text, mail } — `text` for Telegram, `mail` for the email renderer.
function buildEvent(st) {
  return {
    ok: (st.lastBackup || {}).status === 'success',
    text: buildText(st),
    mail: buildMail(st),
  };
}

// ---- monitor ---------------------------------------------------------------
// emit(event) -> fire the alert event { ok, text, mail } to whatever the caller
// wires up (in the app: the notification center, which fans it out to the
// channels/recipients of the enabled "backup" rules).
export function createBackupMonitor({
  emit,
  apiUrl = process.env.BACKUP_API_URL || DEFAULT_URL,
  pollMs = POLL_MS,
} = {}) {
  const base = apiUrl.replace(/\/+$/, '');
  let latest = {
    reachable: false,
    health: null,
    lastBackup: null,
    nextBackupTime: null,
    history: [],
    config: null,
    updatedAt: null,
    fetchedAt: null,
    error: null,
  };
  // Identity of the last run we've already accounted for. Loaded from disk so a
  // restart doesn't re-announce a backup that ran while we were down.
  let lastKey = loadBackupState().lastKey || null;
  let timer = null;
  let stopped = false;

  // A run is "the same run" iff snapshot + end/start + status all match.
  function backupKey(b) {
    if (!b) return null;
    return [b.snapshot_id || 'nosnap', b.end_time || b.start_time || '', b.status || ''].join('|');
  }

  async function poll() {
    try {
      const status = await getJson(base + '/status');
      const s = (status && status.json) || {};
      let config = latest.config;
      try {
        const c = await getJson(base + '/config');
        if (c && c.json && c.json.config) config = c.json.config;
      } catch { /* config is best-effort; keep the previous one */ }

      latest = {
        reachable: true,
        health: s.health || null,
        lastBackup: s.last_backup || null,
        nextBackupTime: s.next_backup_time || null,
        history: Array.isArray(s.history) ? s.history : [],
        config,
        updatedAt: s.updated_at || null,
        fetchedAt: Date.now(),
        error: null,
      };

      const key = backupKey(latest.lastBackup);
      if (key) {
        if (lastKey === null) {
          // First time we've ever seen a run — remember it, don't announce
          // history retroactively.
          lastKey = key;
          saveBackupState({ lastKey });
        } else if (key !== lastKey) {
          lastKey = key;
          saveBackupState({ lastKey });
          try { if (emit) emit(buildEvent(latest)); }
          catch (e) { console.error('[backup] emit error:', e.message); }
        }
      }
    } catch (err) {
      latest = { ...latest, reachable: false, fetchedAt: Date.now(), error: err.message };
    }
  }

  function start() {
    if (timer) return;
    poll().catch((e) => console.error('[backup] poll error:', e.message));
    timer = setInterval(() => {
      if (stopped) return;
      poll().catch((e) => console.error('[backup] poll error:', e.message));
    }, pollMs);
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  function snapshot() {
    return latest;
  }

  return { start, stop, snapshot, _buildEvent: buildEvent };
}
