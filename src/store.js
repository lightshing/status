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
const DATA_DIR = path.join(__dirname, '..', 'data');
const CHECKS_DIR = path.join(DATA_DIR, 'checks');
const SERVICES_FILE = path.join(DATA_DIR, 'services.json');

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
