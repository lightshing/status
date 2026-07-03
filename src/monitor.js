// Health polling loop. Every POLL_INTERVAL seconds it opens a TCP connection
// to 127.0.0.1:<port> for each registered service and records up/down.

import net from 'node:net';
import { appendCheck, pruneChecks } from './store.js';
import { MAX_WINDOW } from './ranges.js';

export const POLL_INTERVAL = 10; // seconds — the recording granularity
const CONNECT_TIMEOUT = 3000; // ms
const PRUNE_EVERY = 6 * 60 * 60 * 1000; // prune old records every 6h

// Resolve to true if a TCP connection to the port succeeds.
export function checkPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(CONNECT_TIMEOUT);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

// Run a single polling round over all services, mutating their live state.
async function pollAll(services, persist, afterPoll) {
  if (services.length === 0) {
    if (afterPoll) afterPoll(services);
    return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  let changed = false;

  await Promise.all(
    services.map(async (svc) => {
      const up = await checkPort(svc.port);
      const status = up ? 1 : 0;
      appendCheck(svc.id, nowSec, status);

      if (svc.status !== status) {
        svc.status = status;
        svc.statusSince = nowMs;
        changed = true;
      }
      svc.lastCheck = nowMs;
    })
  );

  if (changed) persist(true);
  else persist(false);

  // Hand the freshly-updated services to the alert engine (transition &
  // duration checks run on the same 10s cadence).
  if (afterPoll) {
    try { afterPoll(services); }
    catch (err) { console.error('[monitor] afterPoll error:', err); }
  }
}

export function startMonitor(getServices, persist, afterPoll) {
  const tick = () => {
    pollAll(getServices(), persist, afterPoll).catch((err) =>
      console.error('[monitor] poll error:', err)
    );
  };

  // Fire immediately, then align to the interval.
  tick();
  const interval = setInterval(tick, POLL_INTERVAL * 1000);

  // Periodic retention cleanup.
  const cutoff = () => Math.floor(Date.now() / 1000) - MAX_WINDOW - 24 * 60 * 60;
  const pruneTimer = setInterval(() => {
    for (const svc of getServices()) {
      try {
        pruneChecks(svc.id, cutoff());
      } catch (err) {
        console.error('[monitor] prune error:', err);
      }
    }
  }, PRUNE_EVERY);

  return () => {
    clearInterval(interval);
    clearInterval(pruneTimer);
  };
}
