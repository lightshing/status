// Dependency-free Telegram Bot client.
//
// Two responsibilities:
//   1. Outbound — send alert messages via the Bot API (sendMessage).
//   2. Interactive — a long-polling getUpdates loop that answers commands and
//      inline-keyboard taps: an overview of every port, and per-port uptime
//      over a choice of time windows.
//
// Config is read live through getConfig() so toggling the bot on/off or
// changing the token in the settings drawer takes effect without a restart.
// Only Node's built-in https is used.

import https from 'node:https';

const API_HOST = 'api.telegram.org';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Time windows offered in the bot's per-port stats menu.
const TG_RANGES = [
  { key: '1min', label: '1 分钟', sec: 60 },
  { key: '10min', label: '10 分钟', sec: 10 * 60 },
  { key: '1h', label: '1 小时', sec: 60 * 60 },
  { key: '12h', label: '12 小时', sec: 12 * 60 * 60 },
  { key: '1d', label: '1 天', sec: 24 * 60 * 60 },
  { key: '7d', label: '7 天', sec: 7 * 24 * 60 * 60 },
];

const BOT_COMMANDS = [
  { command: 'menu', description: '打开菜单' },
  { command: 'overview', description: '概览所有端口运行情况' },
  { command: 'id', description: '显示本对话的 Chat ID' },
  { command: 'help', description: '使用帮助' },
];

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function fmtDuration(sec) {
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

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u);
}

// createTelegram wires the bot to the rest of the app through small accessors:
//   getConfig()          -> { enabled, token, chatId }
//   getServices()        -> live services array
//   statsFor(id, secs)   -> { up, down, total, ratio } over the last `secs`
//   pollIntervalSec      -> recording granularity, to turn sample counts into time
export function createTelegram({ getConfig, getServices, statsFor, pollIntervalSec = 10 }) {
  let offset = 0;
  let running = false;
  let stopped = false;
  let lastCommandsToken = '';

  // ---- raw API call --------------------------------------------------------
  function api(method, payload, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const token = getConfig().token;
      if (!token) return resolve({ ok: false, description: 'no token' });
      const data = Buffer.from(JSON.stringify(payload || {}));
      const req = https.request(
        {
          hostname: API_HOST,
          path: `/bot${token}/${method}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
          timeout: timeoutMs,
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch { resolve({ ok: false, description: 'bad response' }); }
          });
        }
      );
      req.on('error', (e) => resolve({ ok: false, description: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, description: 'timeout' }); });
      req.end(data);
    });
  }

  // ---- outbound send (used by the alert engine) ----------------------------
  // force=true bypasses the enabled flag (used by the "send test" button so it
  // works before the toggle is flipped). Optional token/chatId override let the
  // test use not-yet-saved values.
  async function send(text, opts = {}) {
    const cfg = getConfig();
    if (!cfg.enabled && !opts.force) return { ok: false, description: 'disabled' };
    const chatId = opts.chatId || cfg.chatId;
    if (!chatId) return { ok: false, description: 'no chatId' };
    const token = opts.token || cfg.token;
    if (!token) return { ok: false, description: 'no token' };
    // When overriding token, call with a one-off config view.
    if (opts.token && opts.token !== cfg.token) {
      return apiWithToken(opts.token, 'sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    }
    return api('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  // Same as api() but with an explicit token (for pre-save connection tests).
  function apiWithToken(token, method, payload) {
    return new Promise((resolve) => {
      const data = Buffer.from(JSON.stringify(payload || {}));
      const req = https.request(
        {
          hostname: API_HOST,
          path: `/bot${token}/${method}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
          timeout: 15000,
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({ ok: false }); } });
        }
      );
      req.on('error', (e) => resolve({ ok: false, description: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, description: 'timeout' }); });
      req.end(data);
    });
  }

  // ---- message / keyboard builders -----------------------------------------
  function mainMenuKb() {
    return {
      inline_keyboard: [
        [{ text: '📊 概览所有端口', callback_data: 'overview' }],
        [{ text: '🔍 查看指定端口', callback_data: 'pick' }],
      ],
    };
  }

  function statusEmoji(status) {
    return status === 1 ? '🟢' : status === 0 ? '🔴' : '⚪';
  }

  function overviewText() {
    const services = getServices();
    if (!services.length) return '还没有注册任何服务。';
    const lines = ['<b>📊 端口概览</b>', ''];
    for (const svc of services) {
      const em = statusEmoji(svc.status);
      const name = isHttpUrl(svc.publicUrl)
        ? `<a href="${esc(svc.publicUrl)}">${esc(svc.name)}</a>`
        : esc(svc.name);
      const tail = isHttpUrl(svc.publicUrl) ? '' : svc.publicUrl ? ` · ${esc(svc.publicUrl)}` : '';
      lines.push(`${em} ${name} <code>:${svc.port}</code>${tail}`);
    }
    const up = services.filter((s) => s.status === 1).length;
    lines.push('', `共 ${services.length} 个 · 在线 ${up} · 离线 ${services.length - up}`);
    return lines.join('\n');
  }

  function pickKb() {
    const services = getServices();
    const rows = [];
    for (let i = 0; i < services.length; i += 2) {
      const row = services.slice(i, i + 2).map((s) => ({
        text: `${statusEmoji(s.status)} ${s.name}`,
        callback_data: 'svc:' + s.id,
      }));
      rows.push(row);
    }
    rows.push([{ text: '« 返回', callback_data: 'menu' }]);
    return { inline_keyboard: rows };
  }

  function rangeKb(id) {
    const rows = [];
    for (let i = 0; i < TG_RANGES.length; i += 3) {
      rows.push(
        TG_RANGES.slice(i, i + 3).map((r) => ({
          text: r.label,
          callback_data: `r:${id}:${r.key}`,
        }))
      );
    }
    rows.push([{ text: '« 返回列表', callback_data: 'pick' }]);
    return { inline_keyboard: rows };
  }

  function statText(id, rangeKey) {
    const svc = getServices().find((s) => s.id === id);
    if (!svc) return { text: '该服务已不存在。', kb: pickKb() };
    const range = TG_RANGES.find((r) => r.key === rangeKey) || TG_RANGES[2];
    const st = statsFor(id, range.sec);
    const head = `${statusEmoji(svc.status)} <b>${esc(svc.name)}</b> <code>:${svc.port}</code> · 近 ${range.label}`;
    let body;
    if (!st.total) {
      body = '该时段内暂无探测数据。';
    } else {
      const upSec = st.up * pollIntervalSec;
      const downSec = st.down * pollIntervalSec;
      const ratio = st.total ? (st.up / st.total) * 100 : 0;
      body =
        `🟢 在线：${fmtDuration(upSec)}（${ratio.toFixed(1)}%）\n` +
        `🔴 离线：${fmtDuration(downSec)}（${(100 - ratio).toFixed(1)}%）\n` +
        `📈 在线率：<b>${ratio.toFixed(2)}%</b>\n` +
        `🔎 样本：${st.total} 次探测`;
    }
    return { text: head + '\n\n' + body, kb: rangeKb(id) };
  }

  // ---- update handling -----------------------------------------------------
  // Data commands are limited to the configured chat for privacy; /id and
  // /start always answer so a new user can discover their Chat ID.
  function authorized(chatId) {
    const cfg = getConfig();
    if (!cfg.chatId) return true; // not yet bound — allow (onboarding)
    return String(chatId) === String(cfg.chatId);
  }

  async function handleMessage(msg) {
    const chatId = msg.chat && msg.chat.id;
    if (chatId == null) return;
    const text = String(msg.text || '').trim();
    const cmd = text.split(/\s+/)[0].replace(/@.*$/, '').toLowerCase();

    if (cmd === '/id' || cmd === '/chatid') {
      await api('sendMessage', {
        chat_id: chatId,
        text: `本对话的 Chat ID：<code>${chatId}</code>\n把它填入设置面板即可接收通知。`,
        parse_mode: 'HTML',
      });
      return;
    }
    if (!authorized(chatId)) {
      await api('sendMessage', { chat_id: chatId, text: '⛔️ 未授权。请在监测面板的设置里绑定本对话的 Chat ID。' });
      return;
    }
    if (cmd === '/overview' || cmd === '/status') {
      await api('sendMessage', {
        chat_id: chatId, text: overviewText(), parse_mode: 'HTML',
        disable_web_page_preview: true, reply_markup: mainMenuKb(),
      });
      return;
    }
    // /start, /menu, /help, and anything else → menu
    await api('sendMessage', {
      chat_id: chatId,
      text: '👋 <b>端口健康监测</b>\n选择一项操作：',
      parse_mode: 'HTML',
      reply_markup: mainMenuKb(),
    });
  }

  async function handleCallback(cq) {
    const chatId = cq.message && cq.message.chat && cq.message.chat.id;
    const messageId = cq.message && cq.message.message_id;
    const data = String(cq.data || '');
    // Always ack to clear the button's loading state.
    const ack = (text) => api('answerCallbackQuery', { callback_query_id: cq.id, text: text || '' });

    if (!authorized(chatId)) { await ack('未授权'); return; }

    const edit = (text, kb) =>
      api('editMessageText', {
        chat_id: chatId, message_id: messageId, text,
        parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb,
      });

    if (data === 'menu') {
      await edit('👋 <b>端口健康监测</b>\n选择一项操作：', mainMenuKb());
    } else if (data === 'overview') {
      await edit(overviewText(), mainMenuKb());
    } else if (data === 'pick') {
      await edit('选择要查看的端口：', pickKb());
    } else if (data.startsWith('svc:')) {
      const id = data.slice(4);
      const svc = getServices().find((s) => s.id === id);
      await edit(
        svc ? `选择时间范围查看「${esc(svc.name)}」的在线情况：` : '该服务已不存在。',
        svc ? rangeKb(id) : pickKb()
      );
    } else if (data.startsWith('r:')) {
      const [, id, rangeKey] = data.split(':');
      const { text, kb } = statText(id, rangeKey);
      await edit(text, kb);
    }
    await ack();
  }

  async function handleUpdate(upd) {
    if (upd.message && upd.message.text) return handleMessage(upd.message);
    if (upd.callback_query) return handleCallback(upd.callback_query);
  }

  // Register the slash-command list so Telegram's menu button expands it.
  async function applyCommands() {
    const cfg = getConfig();
    if (!cfg.token || !cfg.enabled) return;
    if (lastCommandsToken === cfg.token) return;
    const r = await api('setMyCommands', { commands: BOT_COMMANDS });
    if (r && r.ok) lastCommandsToken = cfg.token;
  }

  // ---- long-poll loop ------------------------------------------------------
  async function loop() {
    running = true;
    while (!stopped) {
      const cfg = getConfig();
      if (!cfg.enabled || !cfg.token) {
        lastCommandsToken = '';
        await sleep(2500);
        continue;
      }
      await applyCommands();
      const r = await api(
        'getUpdates',
        { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] },
        60000
      );
      if (r && r.ok && Array.isArray(r.result)) {
        for (const upd of r.result) {
          offset = upd.update_id + 1;
          try { await handleUpdate(upd); }
          catch (e) { console.error('[telegram] handle error:', e.message); }
        }
      } else {
        // token invalid / network hiccup — back off before retrying
        await sleep(3000);
      }
    }
    running = false;
  }

  function start() {
    if (running) return;
    stopped = false;
    loop().catch((e) => console.error('[telegram] loop crashed:', e));
  }
  function stop() { stopped = true; }

  // Fire-and-forget send used by the alert dispatcher.
  function notify(text) {
    send(text).catch((e) => console.error('[telegram] send error:', e.message));
  }

  return { start, stop, send, notify, apiWithToken };
}
