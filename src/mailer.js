// Dependency-free SMTP mailer.
//
// Two responsibilities, mirroring telegram.js:
//   1. Transport — a minimal SMTP client speaking the protocol directly over
//      Node's built-in tls/net (implicit TLS on 465, or STARTTLS on 587/25).
//      Supports AUTH LOGIN. No third-party packages.
//   2. Rendering — turns a structured alert event into a clean, responsive
//      HTML email (plus a plain-text alternative) styled to match the web UI.
//
// Config is read live through getConfig() so toggling SMTP on/off or editing
// credentials in the settings drawer takes effect without a restart.

import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';

// Palette mirrored from public/styles.css so mail feels like the dashboard.
const C = {
  bg: '#f6f7f9',
  panel: '#ffffff',
  border: '#e6e8ec',
  text: '#1f2430',
  muted: '#767d8c',
  faint: '#aab0bd',
  up: '#22c55e',
  down: '#ef4444',
  primary: '#18181b',
  track: '#edeff2',
};

const CRLF = '\r\n';

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- header / address encoding ---------------------------------------------
// RFC 2047 encoded-word for any header value containing non-ASCII (Chinese).
function encodeWord(str) {
  const s = String(str);
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  // Chunk on character boundaries so multibyte sequences never split, keeping
  // each encoded-word comfortably under the 75-char limit.
  const words = [];
  let chunk = '';
  for (const ch of s) {
    const next = chunk + ch;
    if (Buffer.byteLength(next, 'utf8') > 45) {
      words.push('=?UTF-8?B?' + Buffer.from(chunk, 'utf8').toString('base64') + '?=');
      chunk = ch;
    } else {
      chunk = next;
    }
  }
  if (chunk) words.push('=?UTF-8?B?' + Buffer.from(chunk, 'utf8').toString('base64') + '?=');
  return words.join(CRLF + ' ');
}

// Split "Name <a@b.com>" or "a@b.com" into { name, address }.
function parseAddress(s) {
  const str = String(s || '').trim();
  const m = str.match(/^(.*?)<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim() };
  return { name: '', address: str };
}

function formatFrom(fromRaw) {
  const { name, address } = parseAddress(fromRaw);
  const display = name || '端口健康监测';
  return `${encodeWord(display)} <${address}>`;
}

// RFC 5322 date, e.g. "Fri, 04 Jul 2026 12:34:56 +0000".
function rfc2822Date(d = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${mon[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
  );
}

// Base64 body, wrapped to 76-char lines per MIME.
function base64Body(str) {
  const b64 = Buffer.from(str, 'utf8').toString('base64');
  return (b64.match(/.{1,76}/g) || []).join(CRLF);
}

// ---- message assembly ------------------------------------------------------
function buildMessage({ from, to, subject, html, text, host }) {
  const boundary = '=_phm_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const msgId = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${host}>`;
  const headers = [
    `From: ${formatFrom(from)}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${rfc2822Date()}`,
    `Message-ID: ${msgId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(html),
    `--${boundary}--`,
    '',
  ];
  return headers.join(CRLF) + CRLF + CRLF + parts.join(CRLF);
}

// Dot-stuffing: any line starting with '.' gets an extra '.' so it isn't read
// as the end-of-DATA terminator.
function dotStuff(msg) {
  return msg.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');
}

// ---- SMTP conversation -----------------------------------------------------
// Wraps a socket with a promise-based read() that returns one full SMTP reply
// (handling multiline 250- continuations).
function makeConn(socket) {
  let buffer = '';
  let pending = null;
  let closedErr = null;

  const settle = () => {
    if (!pending) return;
    if (closedErr) { const p = pending; pending = null; p.reject(closedErr); return; }
    const m = buffer.match(/^\d{3} [^\n]*\n/m);
    if (!m) return;
    const end = m.index + m[0].length;
    const text = buffer.slice(0, end);
    buffer = buffer.slice(end);
    const code = Number(text.slice(0, 3));
    const p = pending; pending = null;
    p.resolve({ code, text: text.trim() });
  };

  socket.on('data', (d) => { buffer += d.toString('utf8'); settle(); });
  socket.on('error', (e) => { closedErr = e; settle(); });
  socket.on('close', () => { closedErr = closedErr || new Error('连接被关闭'); settle(); });

  return {
    read() {
      return new Promise((resolve, reject) => { pending = { resolve, reject }; settle(); });
    },
    write(line) { socket.write(line + CRLF); },
    writeRaw(data) { socket.write(data); },
    rawSocket: socket,
  };
}

function connect(host, port, secure, timeoutMs) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, servername: host };
    const socket = secure ? tls.connect(opts, () => resolve(socket)) : net.connect(opts, () => resolve(socket));
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error('连接超时')); });
    socket.once('error', reject);
  });
}

function upgradeTls(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername: host }, () => resolve(tlsSocket));
    tlsSocket.setTimeout(timeoutMs, () => { tlsSocket.destroy(); reject(new Error('TLS 握手超时')); });
    tlsSocket.once('error', reject);
  });
}

// Perform one delivery. Returns { ok, description }.
async function smtpSend(cfg, message) {
  const { host, port, secure, username, password } = cfg;
  const localHost = os.hostname() || 'localhost';
  const timeoutMs = 20000;
  let socket;
  try {
    socket = await connect(host, Number(port), secure, timeoutMs);
  } catch (e) {
    return { ok: false, description: '无法连接服务器：' + e.message };
  }

  let conn = makeConn(socket);
  const expect = async (cmd, ...codes) => {
    if (cmd != null) conn.write(cmd);
    const r = await conn.read();
    if (!codes.includes(r.code)) {
      const err = new Error(`${r.code} ${r.text.split('\n').pop()}`);
      err.smtp = true;
      throw err;
    }
    return r;
  };

  try {
    await expect(null, 220); // greeting
    let ehlo = await expect(`EHLO ${localHost}`, 250);

    // STARTTLS upgrade for plaintext connections that advertise it.
    if (!secure && /STARTTLS/i.test(ehlo.text)) {
      await expect('STARTTLS', 220);
      const tlsSocket = await upgradeTls(socket, host, timeoutMs);
      socket = tlsSocket;
      conn = makeConn(tlsSocket);
      ehlo = await expect(`EHLO ${localHost}`, 250);
    }

    if (username || password) {
      await expect('AUTH LOGIN', 334);
      await expect(Buffer.from(username, 'utf8').toString('base64'), 334);
      await expect(Buffer.from(password, 'utf8').toString('base64'), 235);
    }

    const fromAddr = parseAddress(cfg.from).address;
    await expect(`MAIL FROM:<${fromAddr}>`, 250);
    for (const rcpt of message.to) await expect(`RCPT TO:<${rcpt}>`, 250, 251);
    await expect('DATA', 354);
    conn.writeRaw(dotStuff(message.raw) + CRLF + '.' + CRLF);
    await expect(null, 250);
    try { await expect('QUIT', 221); } catch { /* some servers just drop */ }
    socket.end();
    return { ok: true };
  } catch (e) {
    try { socket.destroy(); } catch { /* ignore */ }
    return { ok: false, description: e.smtp ? 'SMTP 拒绝：' + e.message : e.message };
  }
}

// ============================================================================
//  HTML email rendering
// ============================================================================

const ACCENTS = { up: C.up, down: C.down, info: C.primary };

// mail = { accent, emoji, title, subject, rows:[[label,value]], note?, summary? }
export function renderAlertEmail(mail) {
  const accent = ACCENTS[mail.accent] || C.primary;
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });

  const rowsHtml = (mail.rows || [])
    .map(
      ([label, value], i) => `
      <tr>
        <td style="padding:11px 0;${i ? `border-top:1px solid ${C.track};` : ''}color:${C.muted};font-size:13px;white-space:nowrap;">${escHtml(label)}</td>
        <td style="padding:11px 0 11px 16px;${i ? `border-top:1px solid ${C.track};` : ''}color:${C.text};font-size:14px;font-weight:600;text-align:right;">${escHtml(value)}</td>
      </tr>`
    )
    .join('');

  const summaryHtml = mail.summary
    ? `<p style="margin:0 0 18px;color:${C.muted};font-size:14px;line-height:1.6;">${escHtml(mail.summary)}</p>`
    : '';

  const noteHtml = mail.note
    ? `<div style="margin-top:16px;padding:12px 14px;background:${C.bg};border:1px solid ${C.border};border-radius:10px;color:${C.text};font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.55;word-break:break-all;">${escHtml(mail.note)}</div>`
    : '';

  const font = `-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif`;

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escHtml(mail.title)} · ${escHtml(mail.subject)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:32px 16px;font-family:${font};">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
      <tr><td style="padding:0 4px 16px;">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${accent};vertical-align:middle;"></span>
        <span style="margin-left:8px;color:${C.muted};font-size:13px;font-weight:600;letter-spacing:.02em;vertical-align:middle;">端口健康监测</span>
      </td></tr>
      <tr><td style="background:${C.panel};border:1px solid ${C.border};border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(16,24,40,.06);">
        <div style="height:4px;background:${accent};"></div>
        <div style="padding:28px 28px 26px;">
          <div style="font-size:34px;line-height:1;margin-bottom:14px;">${mail.emoji || '🔔'}</div>
          <h1 style="margin:0 0 ${summaryHtml ? '10px' : '18px'};color:${C.text};font-size:20px;font-weight:700;letter-spacing:-.01em;">${escHtml(mail.title)}</h1>
          ${summaryHtml}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table>
          ${noteHtml}
        </div>
      </td></tr>
      <tr><td style="padding:16px 4px 0;color:${C.faint};font-size:12px;line-height:1.6;">
        ${escHtml(stamp)}　·　由端口健康监测自动发送
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const textLines = [
    `【端口健康监测】${mail.title}`,
    '',
    ...(mail.summary ? [mail.summary, ''] : []),
    ...(mail.rows || []).map(([l, v]) => `${l}：${v}`),
    ...(mail.note ? ['', mail.note] : []),
    '',
    `${stamp} · 由端口健康监测自动发送`,
  ];

  return { subject: mail.subject || mail.title, html, text: textLines.join('\n') };
}

// ============================================================================
//  Public factory
// ============================================================================
// getConfig() -> { enabled, host, port, secure, username, password, from }
// Recipients are supplied per-send (opts.to / opts.override.recipients), never
// read from the transport config — each alert rule owns its own recipient list.
export function createMailer({ getConfig }) {
  // Low-level send. Recipients come from opts.to, falling back to an override's
  // recipients (used by the pre-save test); the transport config carries none.
  async function sendRaw({ subject, html, text }, opts = {}) {
    const cfg = { ...getConfig(), ...(opts.override || {}) };
    if (!cfg.enabled && !opts.force) return { ok: false, description: '未启用' };
    if (!cfg.host) return { ok: false, description: '缺少 SMTP 服务器' };
    if (!cfg.from) return { ok: false, description: '缺少发件人地址' };
    const source = opts.to != null ? opts.to : cfg.recipients;
    const to = (Array.isArray(source) ? source : [])
      .map((r) => String(r).trim())
      .filter(Boolean);
    if (!to.length) return { ok: false, description: '缺少收件人' };

    const host = os.hostname() || 'localhost';
    const raw = buildMessage({ from: cfg.from, to, subject, html, text, host });
    return smtpSend(cfg, { to, raw });
  }

  // Render + deliver an alert event to the rule's recipients. Fire-and-forget
  // wrapper for the dispatcher.
  function notify(mail, recipients) {
    const { subject, html, text } = renderAlertEmail(mail);
    sendRaw({ subject, html, text }, { to: recipients }).catch((e) =>
      console.error('[mailer] send error:', e.message)
    );
  }

  // Send a rendered test email, honoring not-yet-saved overrides.
  async function sendTest(override) {
    const { subject, html, text } = renderAlertEmail({
      accent: 'info',
      emoji: '✅',
      title: '测试邮件发送成功',
      subject: '端口健康监测 · 测试邮件',
      summary: '如果你收到了这封邮件，说明 SMTP 通道已配置正确，告警将通过邮件送达。',
      rows: [
        ['通道', 'SMTP 邮件'],
        ['状态', '连接正常'],
      ],
    });
    return sendRaw({ subject, html, text }, { force: true, override });
  }

  return { notify, sendRaw, sendTest, renderAlertEmail };
}
