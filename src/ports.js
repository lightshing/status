// Reads the set of TCP ports currently being listened on, together with the
// process/command occupying each. Uses `ss -Htlnp`; process names for
// processes owned by other users are only visible with elevated privileges,
// so we try `sudo -n ss` first and fall back to a plain `ss` (which still
// lists every port, just without foreign process names).

import { execFile } from 'node:child_process';
import fs from 'node:fs';

const SS_ARGS = ['-Htlnp']; // -H no header, -t tcp, -l listening, -n numeric, -p process

function runSs() {
  return new Promise((resolve) => {
    // Prefer sudo so we can see process names owned by root/other users.
    execFile('sudo', ['-n', 'ss', ...SS_ARGS], { timeout: 4000 }, (err, out) => {
      if (!err && out) return resolve(out);
      // Fall back to unprivileged ss — still lists all ports.
      execFile('ss', SS_ARGS, { timeout: 4000 }, (err2, out2) => {
        resolve(err2 ? '' : out2 || '');
      });
    });
  });
}

// Full command line from /proc, nul-separated args joined by spaces.
function readCmdline(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const cmd = raw.split('\0').filter(Boolean).join(' ').trim();
    if (cmd) return cmd;
  } catch { /* not readable */ }
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch { /* ignore */ }
  return '';
}

// Guess a friendly service name from a full command line, for pre-filling the
// registration form. Prefers a project directory (…/<project>/…) over the bare
// interpreter name (node, python3, gunicorn…).
function guessName(command, processName) {
  const tokens = command.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    if (!tok.includes('/')) continue;
    // Skip interpreter / system paths — they don't name the service.
    if (/^\/(usr|bin|sbin|lib|lib64|etc|opt\/[^/]*\/[^/]*\/\.venv)(\/|$)/.test(tok)) continue;
    const proj = tok.match(/\/(?:home\/[^/]+|opt|srv|mnt|data|www|apps?)\/([^/]+)/);
    if (proj) return proj[1];
    const base = tok.split('/').pop().replace(/\.[a-z0-9]+$/i, '');
    if (base) return base;
  }
  // Second pass ignoring the venv exclusion, to still catch /opt/<proj>/… venvs.
  for (const tok of tokens) {
    const proj = tok.match(/\/(?:opt|srv)\/([^/]+)/);
    if (proj) return proj[1];
  }
  return processName || '';
}

// Parse one `ss` LISTEN row into { port, addr, process, pid }.
// Example row:
//   LISTEN 0 511 *:3333 *:* users:(("node",pid=910552,fd=18))
function parseRow(line) {
  const f = line.trim().split(/\s+/);
  if (f.length < 4) return null;
  const local = f[3];
  const colon = local.lastIndexOf(':');
  if (colon === -1) return null;
  const port = Number(local.slice(colon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let addr = local.slice(0, colon);
  // Normalise wildcard / IPv6 bracket forms for display.
  if (addr === '*' || addr === '0.0.0.0' || addr === '[::]') addr = '所有网卡';
  else if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);

  let processName = '';
  let pid = null;
  const procField = f.slice(5).join(' ');
  const m = procField.match(/\("([^"]+)",pid=(\d+)/);
  if (m) {
    processName = m[1];
    pid = Number(m[2]);
  }
  return { port, addr, process: processName, pid };
}

// Returns a de-duplicated (by port) array of listening ports:
//   [{ port, addr, process, command, pid }]
// A port listening on both IPv4 and IPv6 collapses to a single row; the row
// carrying process info wins.
export async function listListeningPorts() {
  const out = await runSs();
  const byPort = new Map();

  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const row = parseRow(line);
    if (!row) continue;
    const existing = byPort.get(row.port);
    if (!existing) {
      byPort.set(row.port, row);
    } else if (!existing.pid && row.pid) {
      byPort.set(row.port, row); // prefer the row that resolved a process
    }
  }

  const result = [];
  for (const row of byPort.values()) {
    const command = row.pid ? readCmdline(row.pid) : '';
    const fullCommand = command || row.process || '';
    result.push({
      port: row.port,
      addr: row.addr,
      process: row.process || '',
      command: fullCommand,
      suggestedName: guessName(fullCommand, row.process),
      pid: row.pid,
    });
  }
  result.sort((a, b) => a.port - b.port);
  return result;
}
