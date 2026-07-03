// Alert engine. Evaluates user-defined rules against live state and dispatches
// messages to the configured channels (Telegram now; SMTP reserved).
//
// Three rule types:
//   status_change — a service's up/down state flips on a poll (10s granularity).
//                   scope: all | selected ports. direction: both | up | down.
//   duration      — a service stays up/down continuously for >= N seconds.
//                   scope: all | selected ports. state: up | down.
//   new_port      — the 20s port scan finds a listening port that is neither
//                   registered nor ignored (i.e. a brand-new occupant).
//
// The engine is stateful but keeps everything in memory: transition detection,
// per-episode dedupe for duration alerts, and a rolling baseline of "known"
// unregistered ports so we don't re-nag about the same one.

import { listListeningPorts } from './ports.js';

const NEW_PORT_SCAN_INTERVAL = 20 * 1000; // ms

export function createNotifier({ getServices, getIgnores, getRules, dispatch }) {
  const prevStatus = new Map(); // serviceId -> last seen status (1/0/null)
  const durationFired = new Map(); // `${ruleId}:${serviceId}` -> statusSince already alerted
  let knownPorts = null; // Set<number> baseline of unregistered+unignored ports
  let scanTimer = null;

  const activeRules = (type) => getRules().filter((r) => r && r.enabled && r.type === type);

  function ruleCovers(rule, svc) {
    if (rule.scope === 'all') return true;
    return Array.isArray(rule.serviceIds) && rule.serviceIds.includes(svc.id);
  }

  function fmtDur(sec) {
    let s = Math.max(0, Math.floor(sec));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const parts = [];
    if (d) parts.push(d + ' 天');
    if (h) parts.push(h + ' 时');
    if (m) parts.push(m + ' 分');
    if (s || !parts.length) parts.push(s + ' 秒');
    return parts.join(' ');
  }

  // ---- called by the monitor after every poll round ------------------------
  function onPoll(services) {
    const now = Date.now();

    // status_change: detect transitions vs the previous poll.
    const changeRules = activeRules('status_change');
    for (const svc of services) {
      const prev = prevStatus.has(svc.id) ? prevStatus.get(svc.id) : undefined;
      const cur = svc.status;
      prevStatus.set(svc.id, cur);
      if (prev === undefined || prev === null || cur === null || prev === cur) continue;
      const dir = cur === 1 ? 'up' : 'down';
      const label = cur === 1 ? '恢复在线 🟢' : '变为离线 🔴';
      for (const rule of changeRules) {
        if (!ruleCovers(rule, svc)) continue;
        const want = rule.direction || 'both';
        if (want !== 'both' && want !== dir) continue;
        dispatch(rule.channels, `⚠️ <b>${svc.name}</b> <code>:${svc.port}</code> ${label}`);
      }
    }

    // duration: fire once per episode when the threshold is crossed.
    const durRules = activeRules('duration');
    for (const rule of durRules) {
      const wantStatus = rule.state === 'up' ? 1 : 0;
      const threshMs = (Number(rule.seconds) || 0) * 1000;
      for (const svc of services) {
        if (!ruleCovers(rule, svc)) continue;
        const key = `${rule.id}:${svc.id}`;
        if (svc.status !== wantStatus || !svc.statusSince) continue;
        const elapsed = now - svc.statusSince;
        if (elapsed < threshMs) continue;
        // dedupe by the episode's start timestamp
        if (durationFired.get(key) === svc.statusSince) continue;
        durationFired.set(key, svc.statusSince);
        const word = wantStatus === 1 ? '持续在线' : '持续离线';
        const emoji = wantStatus === 1 ? '🟢' : '🔴';
        dispatch(
          rule.channels,
          `⏱ ${emoji} <b>${svc.name}</b> <code>:${svc.port}</code> 已${word} ${fmtDur(elapsed / 1000)}（阈值 ${fmtDur(rule.seconds)}）`
        );
      }
    }
  }

  // ---- new-port scan (every 20s) -------------------------------------------
  async function scanNewPorts() {
    let ports;
    try {
      ports = await listListeningPorts();
    } catch (e) {
      console.error('[notify] port scan failed:', e.message);
      return;
    }
    const registered = new Set(getServices().map((s) => s.port));
    const ignored = new Set(getIgnores().map((ig) => ig.port));
    const candidates = ports.filter((p) => !registered.has(p.port) && !ignored.has(p.port));
    const candSet = new Set(candidates.map((p) => p.port));

    if (knownPorts === null) {
      // First scan establishes the baseline — never alert for pre-existing ports.
      knownPorts = candSet;
      return;
    }

    const rules = activeRules('new_port');
    if (rules.length) {
      for (const p of candidates) {
        if (knownPorts.has(p.port)) continue;
        const name = p.suggestedName || p.process || '未知进程';
        const cmd = p.command && p.command !== name ? `\n<code>${escHtml(p.command)}</code>` : '';
        dispatch(
          rules.flatMap((r) => r.channels),
          `🆕 发现新占用端口 <code>:${p.port}</code>（${escHtml(name)}）\n既未注册也未忽略。${cmd}`
        );
      }
    }
    // Advance the baseline regardless of rules, so enabling a rule later doesn't
    // dump every already-open port. Ports that vanish drop out and can re-alert.
    knownPorts = candSet;
  }

  function escHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  function start() {
    scanNewPorts().catch(() => {}); // establish baseline immediately
    scanTimer = setInterval(() => scanNewPorts().catch(() => {}), NEW_PORT_SCAN_INTERVAL);
  }
  function stop() {
    if (scanTimer) clearInterval(scanTimer);
  }

  return { onPoll, start, stop };
}
