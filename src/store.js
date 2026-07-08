// Dependency-free persistence layer.
//
// Service metadata + current state lives in data/services.json.
// Each service's health history is an append-only binary log at
// data/checks/<id>.bin, 5 bytes per record:
//   bytes 0..3  uint32 LE  unix timestamp (seconds)
//   byte  4     uint8      status (1 = up, 0 = down)
//
// At 10s granularity a full month is ~260k records = ~1.3 MB per service,
// so full-file reads and periodic rewrites are cheap.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR defaults to <repo>/data; PHM_DATA_DIR overrides it (used for tests).
const DATA_DIR = process.env.PHM_DATA_DIR
  ? path.resolve(process.env.PHM_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const CHECKS_DIR = path.join(DATA_DIR, 'checks');
const SERVICES_FILE = path.join(DATA_DIR, 'services.json');
const IGNORES_FILE = path.join(DATA_DIR, 'ignores.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const RULES_FILE = path.join(DATA_DIR, 'rules.json');
const BACKUP_FILE = path.join(DATA_DIR, 'backup.json');

const RECORD_SIZE = 5;

function ensureDirs() {
  fs.mkdirSync(CHECKS_DIR, { recursive: true });
}

export function loadServices() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(SERVICES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.services) ? parsed.services : [];
  } catch {
    return [];
  }
}

let saveTimer = null;
export function saveServices(services) {
  ensureDirs();
  // Debounced atomic write to avoid hammering disk on every poll.
  const write = () => {
    const tmp = SERVICES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ services }, null, 2));
    fs.renameSync(tmp, SERVICES_FILE);
  };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(write, 200);
}

export function saveServicesNow(services) {
  ensureDirs();
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const tmp = SERVICES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ services }, null, 2));
  fs.renameSync(tmp, SERVICES_FILE);
}

export function newId() {
  return crypto.randomBytes(8).toString('hex');
}

// ---- Ignored ports ---------------------------------------------------------
// Ports the user has chosen to hide from the "unregistered" nag in 端口速查.
// Keyed by port number, with an optional free-text note. Stored in
// data/ignores.json as { ignores: [{ port, note, createdAt }] }.
export function loadIgnores() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(IGNORES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.ignores) ? parsed.ignores : [];
  } catch {
    return [];
  }
}

export function saveIgnores(ignores) {
  ensureDirs();
  const tmp = IGNORES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ignores }, null, 2));
  fs.renameSync(tmp, IGNORES_FILE);
}

// ---- Notification settings (channels) --------------------------------------
// Delivery-channel configuration lives in data/settings.json:
//   { telegram: { enabled, token, chatId },
//     smtp:     { enabled, host, port, secure, username, password, from } }
// Recipients are NOT global — each alert rule carries its own recipient list
// (see data/rules.json), so the SMTP block here is purely the transport.
// The token / password are secrets — the HTTP layer never echoes them back to
// the browser, only a boolean "set" flag.
const DEFAULT_SETTINGS = {
  telegram: { enabled: false, token: '', chatId: '' },
  smtp: {
    enabled: false,
    host: '',
    port: 465,
    secure: true,
    username: '',
    password: '',
    from: '',
  },
};

export function loadSettings() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const smtp = { ...DEFAULT_SETTINGS.smtp, ...(parsed.smtp || {}) };
    delete smtp.recipients; // migrated to per-rule recipients; never carry it forward
    return {
      telegram: { ...DEFAULT_SETTINGS.telegram, ...(parsed.telegram || {}) },
      smtp,
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}

export function saveSettings(settings) {
  ensureDirs();
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
}

// ---- Alert rules -----------------------------------------------------------
// data/rules.json: { rules: [ { id, type, enabled, ...typeFields, channels:[] } ] }
export function loadRules() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(RULES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.rules) ? parsed.rules : [];
  } catch {
    return [];
  }
}

export function saveRules(rules) {
  ensureDirs();
  const tmp = RULES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ rules }, null, 2));
  fs.renameSync(tmp, RULES_FILE);
}

// ---- Backup monitor marker -------------------------------------------------
// data/backup.json: { lastKey } — identity of the last backup run we've already
// pushed a Telegram notification for, so a restart doesn't re-announce it.
export function loadBackupState() {
  ensureDirs();
  try {
    const parsed = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveBackupState(stateObj) {
  ensureDirs();
  const tmp = BACKUP_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(stateObj, null, 2));
  fs.renameSync(tmp, BACKUP_FILE);
}

function checkFile(id) {
  return path.join(CHECKS_DIR, `${id}.bin`);
}

// Append one health record.
export function appendCheck(id, tsSec, status) {
  ensureDirs();
  const buf = Buffer.allocUnsafe(RECORD_SIZE);
  buf.writeUInt32LE(tsSec >>> 0, 0);
  buf.writeUInt8(status ? 1 : 0, 4);
  fs.appendFileSync(checkFile(id), buf);
}

// Read all records with ts >= fromSec. Returns [{ ts, status }] in order.
export function readChecks(id, fromSec = 0) {
  let buf;
  try {
    buf = fs.readFileSync(checkFile(id));
  } catch {
    return [];
  }
  const out = [];
  const count = Math.floor(buf.length / RECORD_SIZE);
  // Records are appended in time order, so binary-search the first offset.
  let lo = 0, hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const ts = buf.readUInt32LE(mid * RECORD_SIZE);
    if (ts < fromSec) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < count; i++) {
    const off = i * RECORD_SIZE;
    out.push({ ts: buf.readUInt32LE(off), status: buf.readUInt8(off + 4) });
  }
  return out;
}

// Drop records older than cutoffSec by rewriting the file.
export function pruneChecks(id, cutoffSec) {
  const kept = readChecks(id, cutoffSec);
  const buf = Buffer.allocUnsafe(kept.length * RECORD_SIZE);
  kept.forEach((r, i) => {
    buf.writeUInt32LE(r.ts >>> 0, i * RECORD_SIZE);
    buf.writeUInt8(r.status ? 1 : 0, i * RECORD_SIZE + 4);
  });
  const tmp = checkFile(id) + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, checkFile(id));
}

export function deleteChecks(id) {
  try { fs.unlinkSync(checkFile(id)); } catch { /* ignore */ }
}
