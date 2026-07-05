// Alert engine. Evaluates user-defined rules against live state and dispatches
// messages to the configured channels (Telegram + SMTP email).
//
// Each alert is emitted as a structured event: { text, mail } where `text` is
// the Telegram-flavored HTML string and `mail` is a semantic object the email
// renderer turns into a styled message. dispatch() fans it out per channel.
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

  // Enabled email recipients declared on a rule. Each entry is { address,
  // enabled }; only the switched-on ones receive the alert.
  function mailRecipients(rule) {
    return (Array.isArray(rule.recipients) ? rule.recipients : [])
      .filter((r) => r && r.enabled && r.address)
      .map((r) => String(r.address).trim())
      .filter(Boolean);
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
        dispatch({ channels: rule.channels, recipients: mailRecipients(rule) }, {
          text: `⚠️ <b>${escHtml(svc.name)}</b> <code>:${svc.port}</code> ${label}`,
          mail: {
            accent: dir, // 'up' | 'down'
            emoji: cur === 1 ? '🟢' : '🔴',
            title: cur === 1 ? '端口恢复在线' : '端口变为离线',
            subject: `${cur === 1 ? '🟢 恢复在线' : '🔴 变为离线'} · ${svc.name}:${svc.port}`,
            summary: cur === 1 ? '该服务已重新可访问。' : '该服务当前无法访问，请及时排查。',
            rows: [
              ['服务', svc.name],
              ['端口', ':' + svc.port],
              ['当前状态', cur === 1 ? '在线 🟢' : '离线 🔴'],
            ],
          },
        });
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
        const elapsedTxt = fmtDur(elapsed / 1000);
        dispatch({ channels: rule.channels, recipients: mailRecipients(rule) }, {
          text: `⏱ ${emoji} <b>${escHtml(svc.name)}</b> <code>:${svc.port}</code> 已${word} ${elapsedTxt}（阈值 ${fmtDur(rule.seconds)}）`,
          mail: {
            accent: wantStatus === 1 ? 'up' : 'down',
            emoji,
            title: wantStatus === 1 ? '端口持续在线' : '端口持续离线',
            subject: `${emoji} ${word} ${elapsedTxt} · ${svc.name}:${svc.port}`,
            summary: `该服务已${word}超过设定阈值。`,
            rows: [
              ['服务', svc.name],
              ['端口', ':' + svc.port],
              [word, elapsedTxt],
              ['触发阈值', fmtDur(rule.seconds)],
            ],
          },
        });
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
        // One event, many rules: union their channels and email recipients.
        const channels = [...new Set(rules.flatMap((r) => r.channels))];
        const recipients = [...new Set(rules.flatMap(mailRecipients))];
        dispatch({ channels, recipients }, {
          text: `🆕 发现新占用端口 <code>:${p.port}</code>（${escHtml(name)}）\n既未注册也未忽略。${cmd}`,
          mail: {
            accent: 'info',
            emoji: '🆕',
            title: '发现新占用端口',
            subject: `🆕 新占用端口 :${p.port}（${name}）`,
            summary: '端口速查扫描到一个既未注册、也未被忽略的新监听端口。',
            rows: [
              ['端口', ':' + p.port],
              ['进程', name],
            ],
            note: p.command && p.command !== name ? p.command : '',
          },
        });
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
