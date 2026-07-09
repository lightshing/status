'use strict';

const RANGE_ORDER = ['10min', '1h', '1d', '7d', '1m'];
const DEFAULT_RANGE = '1d';
const REFRESH_MS = 5000;
const ZOOM_MS = 460;

// Timestamp until which a bar zoom is playing; the periodic refresh holds off
// rebuilding the DOM until then, so it can't snap an in-flight animation.
let zoomEndsAt = 0;

const state = {
  range: DEFAULT_RANGE,
  data: null,
  clockOffset: 0, // serverNow - clientNow, to keep counters accurate
  bucketSec: 0,
  zoomFromWindow: null, // one-shot: window (sec) we're zooming from on a range switch
};

const els = {
  rangeSwitch: document.getElementById('rangeSwitch'),
  list: document.getElementById('serviceList'),
  emptyHint: document.getElementById('emptyHint'),
  footMeta: document.getElementById('footMeta'),
  tooltip: document.getElementById('tooltip'),
  cardTpl: document.getElementById('cardTpl'),
  backupCard: document.getElementById('backupCard'),
  backupTpl: document.getElementById('backupTpl'),
};

// ---- range switch ----------------------------------------------------------
const RANGE_LABELS = {
  '10min': '10 分钟',
  '1h': '1 小时',
  '1d': '1 天',
  '7d': '7 天',
  '1m': '1 月',
};

function buildRangeSwitch() {
  els.rangeSwitch.innerHTML = '';
  const thumb = document.createElement('span');
  thumb.className = 'range-thumb';
  els.rangeSwitch.appendChild(thumb);
  for (const key of RANGE_ORDER) {
    const btn = document.createElement('button');
    btn.textContent = RANGE_LABELS[key];
    btn.dataset.range = key;
    btn.setAttribute('role', 'tab');
    btn.addEventListener('click', () => {
      if (state.range === key) return;
      // remember the span we're leaving so the bar can zoom by the real ratio
      state.zoomFromWindow = state.data ? state.data.window : null;
      state.range = key;
      moveRangeThumb();
      fetchData();
    });
    els.rangeSwitch.appendChild(btn);
  }
  moveRangeThumb();
}

// Slide the pill to the active button and sync the active class.
function moveRangeThumb() {
  const thumb = els.rangeSwitch.querySelector('.range-thumb');
  if (!thumb) return;
  let active = null;
  for (const btn of els.rangeSwitch.querySelectorAll('button')) {
    const on = btn.dataset.range === state.range;
    btn.classList.toggle('active', on);
    if (on) active = btn;
  }
  if (!active) return;
  const base = els.rangeSwitch.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  thumb.style.width = rect.width + 'px';
  thumb.style.transform = `translateX(${rect.left - base.left}px)`;
}

// Keep the pill aligned when the top bar reflows.
window.addEventListener('resize', moveRangeThumb);

// ---- data fetching ---------------------------------------------------------
async function fetchData() {
  try {
    const res = await fetch(`/api/data?range=${encodeURIComponent(state.range)}`);
    if (!res.ok) throw new Error('bad response');
    const data = await res.json();
    state.data = data;
    state.bucketSec = data.bucket;
    state.clockOffset = data.now - Date.now();
    render();
  } catch (err) {
    console.error('fetch failed', err);
  }
}

// ---- rendering -------------------------------------------------------------
function classifyCell(bucket) {
  if (bucket.total === 0) return { cls: 'empty', ratio: null };
  const ratio = bucket.up / bucket.total;
  if (ratio >= 1) return { cls: 'up', ratio };
  if (ratio <= 0) return { cls: 'down', ratio };
  return { cls: 'partial', ratio };
}

function render() {
  const services = state.data ? state.data.services : [];
  els.emptyHint.hidden = services.length !== 0;

  // Rebuild card list.
  els.list.innerHTML = '';
  for (const svc of services) {
    els.list.appendChild(renderCard(svc));
  }
  zoomBars();
  updateCounters();
}

// One-shot timeline zoom after a range switch: scale each bar's track along the
// horizontal (time) axis from the tail. Shrinking the range (newWindow <
// oldWindow) starts the finer bar compressed at the tail and stretches it out;
// expanding starts zoomed on the tail and shrinks the whole bar down to reveal
// the wider span. The scale factor is the real ratio of the two windows.
function zoomBars() {
  const from = state.zoomFromWindow;
  state.zoomFromWindow = null;
  if (!from || !state.data || !state.data.window) return;
  const startScale = state.data.window / from;
  if (!isFinite(startScale) || startScale <= 0 || Math.abs(startScale - 1) < 0.01) return;
  zoomEndsAt = performance.now() + ZOOM_MS;
  for (const inner of els.list.querySelectorAll('.bar-inner')) {
    if (inner.animate) {
      inner.animate(
        [{ transform: `scaleX(${startScale})` }, { transform: 'scaleX(1)' }],
        { duration: ZOOM_MS, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' }
      );
    }
  }
}

function renderCard(svc) {
  const node = els.cardTpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = svc.id;
  node.dataset.status = svc.status === null ? 'unknown' : svc.status;
  node.dataset.since = svc.statusSince ?? '';

  const dot = node.querySelector('.dot');
  dot.classList.add(svc.status === 1 ? 'up' : svc.status === 0 ? 'down' : 'unknown');

  node.querySelector('.name').textContent = svc.name;
  node.querySelector('.port-badge').textContent = ':' + svc.port;

  const pct = node.querySelector('.uptime-pct');
  pct.textContent = svc.uptimePct === null ? '' : svc.uptimePct.toFixed(1) + '% 在线';

  // name doubles as the jump link when a public URL is set
  const nameLink = node.querySelector('.name-link');
  if (svc.publicUrl) {
    nameLink.href = svc.publicUrl;
    nameLink.target = '_blank';
    nameLink.rel = 'noopener';
    nameLink.classList.add('linkable');
    node.querySelector('.jump-icon').hidden = false;
  } else {
    nameLink.removeAttribute('title');
  }

  // status bar cells
  const bar = node.querySelector('.bar');
  const barInner = bar.querySelector('.bar-inner');
  const frag = document.createDocumentFragment();
  let hasData = false;
  for (const b of svc.buckets) {
    const cell = document.createElement('div');
    const { cls, ratio } = classifyCell(b);
    if (b.total > 0) hasData = true;
    cell.className = 'cell ' + cls;
    cell.dataset.t = b.t;
    cell.dataset.up = b.up;
    cell.dataset.total = b.total;
    cell.dataset.ratio = ratio === null ? '' : ratio;
    frag.appendChild(cell);
  }
  barInner.appendChild(frag);
  if (!hasData) bar.classList.add('no-data');

  // meta — root dir is click-to-copy
  const root = node.querySelector('.root');
  if (svc.rootDir) {
    root.hidden = false;
    node.querySelector('.root-path').textContent = svc.rootDir;
    root.addEventListener('click', () => copyPath(svc.rootDir));
  }
  const url = node.querySelector('.url');
  if (svc.publicUrl) {
    url.hidden = false;
    url.href = svc.publicUrl;
    url.textContent = '🔗 ' + svc.publicUrl;
  }

  // edit / delete
  node.querySelector('.edit').addEventListener('click', () => openEdit(svc));
  node.querySelector('.del').addEventListener('click', () => deleteService(svc.id, svc.name));

  return node;
}

// ============================================================================
//  服务器备份卡片 (backup status card)
// ============================================================================
// A single card pinned above the service list. Mirrors the service-card look,
// but the history bar is replaced by a row of circles — one per backup run,
// each hoverable for that run's details. Data comes from /api/backup, which the
// server keeps fresh by polling the backup project's status API.

function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Number(n), i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const val = i === 0 ? String(v) : v.toFixed(v < 10 ? 2 : 1);
  return `${val} ${units[i]}`;
}

// Compact date-time in the viewer's local zone (matches the history-bar tooltip
// style), e.g. "07-08 21:00".
function bkTime(iso, withSec) {
  if (!iso) return '未知';
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return String(iso);
  const pad = (x) => String(x).padStart(2, '0');
  const base = `${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  return withSec ? `${base}:${pad(dt.getSeconds())}` : base;
}

function bkDur(sec) {
  let s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [];
  if (h) parts.push(h + ' 时');
  if (m || h) parts.push(m + ' 分');
  parts.push(s + ' 秒');
  return parts.join(' ');
}

// Coarse "约 X 后" to a future ISO time (up to two units, no seconds).
function bkRelFromNow(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return '';
  let diff = Math.floor((dt.getTime() - Date.now()) / 1000);
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

const BK_HEALTH = {
  healthy: { cls: 'up', label: '健康' },
  unhealthy: { cls: 'down', label: '异常' },
  unknown: { cls: 'unknown', label: '未知' },
};

async function fetchBackup() {
  try {
    const res = await fetch('/api/backup');
    if (!res.ok) throw new Error('bad response');
    const json = await res.json();
    renderBackup(json.backup || null);
  } catch (err) {
    console.error('backup fetch failed', err);
    renderBackup(null);
  }
}

function renderBackup(bk) {
  els.backupCard.innerHTML = '';
  const node = els.backupTpl.content.firstElementChild.cloneNode(true);

  const dot = node.querySelector('.dot');
  const pill = node.querySelector('.health-pill');
  const badge = node.querySelector('.port-badge');
  const dots = node.querySelector('.dots');
  const last = node.querySelector('.bk-last');
  const next = node.querySelector('.bk-next');

  // Unreachable → the whole card reads as offline.
  if (!bk || !bk.reachable) {
    dot.classList.add('unknown');
    pill.className = 'health-pill na';
    pill.textContent = '未连接';
    last.textContent = '无法连接到备份服务';
    els.backupCard.appendChild(node);
    return;
  }

  // Health chip + status dot.
  const h = BK_HEALTH[(bk.health && bk.health.status) || 'unknown'] || BK_HEALTH.unknown;
  dot.classList.add(h.cls);
  pill.className = 'health-pill ' + h.cls;
  pill.textContent = h.label;

  // Remote badge (e.g. gdrive:server-oracle3).
  const remote = bk.config && bk.config.remote;
  if (remote) {
    badge.hidden = false;
    badge.textContent = remote;
  }

  // One circle per backup run, oldest → newest (left → right).
  const runs = Array.isArray(bk.history) ? bk.history : [];
  if (!runs.length) {
    dots.classList.add('no-data');
    const hint = document.createElement('span');
    hint.className = 'dots-empty';
    hint.textContent = '暂无备份记录';
    dots.appendChild(hint);
  } else {
    for (const run of runs) {
      const c = document.createElement('span');
      const ok = run.status === 'success';
      c.className = 'backup-dot ' + (ok ? 'up' : 'down');
      c.setAttribute('role', 'listitem');
      c.dataset.detail = JSON.stringify(run);
      dots.appendChild(c);
    }
  }

  // Meta: last run summary (left) and next scheduled run (right).
  const lb = bk.lastBackup;
  if (lb) {
    const ok = lb.status === 'success';
    const size = ok && lb.data_added_bytes != null ? ` · 新增 ${fmtBytes(lb.data_added_bytes)}` : '';
    last.innerHTML =
      `最近备份 ${bkTime(lb.start_time)} · ` +
      `<span class="bk-badge ${ok ? 'ok' : 'bad'}">${ok ? '成功' : '失败'}</span>` +
      size;
  } else {
    last.textContent = '尚未运行过备份';
  }

  if (bk.nextBackupTime) {
    const rel = bkRelFromNow(bk.nextBackupTime);
    next.textContent = `下次备份 ${bkTime(bk.nextBackupTime)}${rel ? `（${rel}）` : ''}`;
  }

  els.backupCard.appendChild(node);
}

// Tooltip body for one backup circle, built from its stashed run detail.
function backupTooltipHtml(el) {
  let d;
  try { d = JSON.parse(el.dataset.detail || '{}'); } catch { d = {}; }
  const ok = d.status === 'success';
  const lines = [`<div class="tt-pct">${ok ? '✅ 备份成功' : '❌ 备份失败'}</div>`];
  lines.push(`<div>${bkTime(d.start_time, true)}</div>`);
  if (d.duration_seconds != null) lines.push(`<div>耗时 ${bkDur(d.duration_seconds)}</div>`);
  if (ok) {
    if (d.data_added_bytes != null) lines.push(`<div>新增数据 ${fmtBytes(d.data_added_bytes)}</div>`);
    const fp = [];
    if (d.files_new != null) fp.push(`新增 ${d.files_new}`);
    if (d.files_changed != null) fp.push(`变更 ${d.files_changed}`);
    if (fp.length) lines.push(`<div>文件 ${fp.join(' · ')}</div>`);
    if (d.snapshot_id) lines.push(`<div class="tt-mono">${escapeHtml(String(d.snapshot_id).slice(0, 12))}</div>`);
  } else if (d.error) {
    lines.push(`<div>${escapeHtml(String(d.error).slice(0, 160))}</div>`);
  }
  return lines.join('');
}

// ---- live counters (tick every second) -------------------------------------
function formatDuration(ms) {
  let s = Math.floor(ms / 1000);
  if (s < 0) s = 0;
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [];
  if (d) parts.push(d + ' 天');
  if (h || d) parts.push(h + ' 时');
  if (m || h || d) parts.push(m + ' 分');
  parts.push(s + ' 秒');
  return parts.join(' ');
}

function updateCounters() {
  const now = Date.now() + state.clockOffset;
  for (const card of els.list.children) {
    const since = card.querySelector('.since');
    const status = card.dataset.status;
    const sinceTs = card.dataset.since ? Number(card.dataset.since) : null;

    since.classList.remove('up', 'down', 'na');
    if (status === 'unknown' || !sinceTs) {
      since.classList.add('na');
      since.textContent = '数据不可用';
      continue;
    }
    const dur = formatDuration(now - sinceTs);
    const label = status === '1' ? '已运行' : '已中断';
    since.classList.add(status === '1' ? 'up' : 'down');
    since.innerHTML = `<span class="label">${label}</span> <span class="val">${dur}</span>`;
  }
}

setInterval(updateCounters, 1000);

// ---- tooltip ---------------------------------------------------------------
function fmtTime(sec) {
  const dt = new Date(sec * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const short = state.range === '10min' || state.range === '1h';
  if (short) return `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
  return `${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

document.addEventListener('mousemove', (e) => {
  const cell = e.target.closest && e.target.closest('.bar .cell');
  const bdot = !cell && e.target.closest && e.target.closest('.backup-dot');
  if (!cell && !bdot) {
    els.tooltip.hidden = true;
    return;
  }
  let body;
  if (bdot) {
    body = backupTooltipHtml(bdot);
  } else {
    const t = Number(cell.dataset.t);
    const total = Number(cell.dataset.total);
    const up = Number(cell.dataset.up);
    const end = t + state.bucketSec;
    if (total === 0) {
      body = `<div>${fmtTime(t)} – ${fmtTime(end)}</div><div class="tt-pct">无数据</div>`;
    } else {
      const ratio = ((up / total) * 100).toFixed(1);
      body = `<div>${fmtTime(t)} – ${fmtTime(end)}</div><div class="tt-pct">在线 ${ratio}% · ${up}/${total} 次</div>`;
    }
  }
  els.tooltip.innerHTML = body;
  els.tooltip.hidden = false;
  const tw = els.tooltip.offsetWidth;
  let x = e.clientX + 12;
  if (x + tw > window.innerWidth - 8) x = e.clientX - tw - 12;
  els.tooltip.style.left = x + 'px';
  els.tooltip.style.top = e.clientY + 16 + 'px';
});

// Bottom-of-page transient notification.
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('show');
  void t.offsetWidth; // restart the transition
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1500);
}

// Copy a path to the clipboard; feedback is shown as a bottom toast only.
async function copyPath(text) {
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    } else {
      throw new Error('no clipboard api');
    }
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch {
      ok = false;
    }
  }
  showToast(ok ? '已复制' : '复制失败');
}

async function deleteService(id, name) {
  if (!confirm(`确定删除「${name}」及其全部历史记录？`)) return;
  try {
    await fetch('/api/services/' + id, { method: 'DELETE' });
    await fetchData();
  } catch {
    alert('删除失败，请重试');
  }
}

// ---- register / edit modal (shared) ----------------------------------------
const modal = document.getElementById('formModal');
const modalForm = document.getElementById('svcForm');
const modalTitle = document.getElementById('modalTitle');
const modalSubmit = document.getElementById('modalSubmit');
const modalError = document.getElementById('formError');
let editingId = null; // null => register mode, otherwise edit that id
let defaultName = ''; // fallback name (from the scanned command) when left blank
let returnToPorts = false; // true when register was launched from 端口速查

function openModal(svc) {
  editingId = svc ? svc.id : null;
  defaultName = '';
  modalTitle.textContent = svc ? '编辑服务' : '注册服务';
  modalSubmit.textContent = svc ? '保存' : '注册';
  modalError.textContent = '';
  const nameEl = document.getElementById('f-name');
  nameEl.value = svc ? svc.name : '';
  nameEl.placeholder = '例如 API 网关';
  document.getElementById('f-port').value = svc ? svc.port : '';
  document.getElementById('f-root').value = svc ? svc.rootDir || '' : '';
  document.getElementById('f-url').value = svc ? svc.publicUrl || '' : '';
  modal.hidden = false;
  nameEl.focus();
}

// Register a scanned port: prefill the port and drop the detected name in as a
// gray placeholder — left blank it's used as-is, typing overrides it.
function openRegisterForPort(p) {
  openModal(null);
  returnToPorts = true;
  defaultName = p.suggestedName || p.process || '';
  const nameEl = document.getElementById('f-name');
  nameEl.value = '';
  if (defaultName) nameEl.placeholder = defaultName + '（读取自命令，可覆盖）';
  document.getElementById('f-port').value = p.port;
  nameEl.focus();
}

function openEdit(svc) {
  openModal(svc);
}

function closeModal() {
  modal.hidden = true;
  editingId = null;
  returnToPorts = false;
}

document.getElementById('addBtn').addEventListener('click', () => openModal(null));
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalCancel').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Register / ignore forms stack above 端口速查 — close the topmost first.
  if (!modal.hidden) closeModal();
  else if (!ignoreModal.hidden) closeIgnore();
  else if (!portsModal.hidden) closePorts();
});

modalForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  modalError.textContent = '';
  const fd = new FormData(modalForm);
  const typedName = String(fd.get('name') || '').trim();
  const body = {
    name: typedName || defaultName, // blank falls back to the scanned name
    port: fd.get('port'),
    rootDir: fd.get('rootDir'),
    publicUrl: fd.get('publicUrl'),
  };
  const url = editingId ? '/api/services/' + editingId : '/api/services';
  const method = editingId ? 'PUT' : 'POST';
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
      modalError.textContent = json.error || (editingId ? '保存失败' : '注册失败');
      return;
    }
    const cameFromPorts = returnToPorts;
    closeModal();
    await fetchData();
    if (cameFromPorts && !portsModal.hidden) loadPorts(); // reflect new registration
  } catch {
    modalError.textContent = '网络错误，请重试';
  }
});

// ---- 端口速查 (port lookup) ------------------------------------------------
const portsModal = document.getElementById('portsModal');
const portsTbody = document.getElementById('portsTbody');
const portsEmpty = document.getElementById('portsEmpty');
const portsNote = document.getElementById('portsNote');

let portsData = [];
const portsSort = { key: 'port', dir: 'asc' };

// Comparable value for each sortable column.
function portSortVal(p, key) {
  if (key === 'port') return p.port;
  if (key === 'registered') return p.registered ? 1 : 0;
  if (key === 'addr') return (p.addr || '').toLowerCase();
  // name column sorts by the friendly/process name
  return (p.suggestedName || p.process || p.command || '').toLowerCase();
}

function renderPorts() {
  const { key, dir } = portsSort;
  const sign = dir === 'asc' ? 1 : -1;
  const rows = portsData.slice().sort((a, b) => {
    const va = portSortVal(a, key);
    const vb = portSortVal(b, key);
    if (va < vb) return -1 * sign;
    if (va > vb) return 1 * sign;
    return (a.port - b.port) * sign; // stable tiebreak by port
  });

  // header sort indicators
  for (const th of portsModal.querySelectorAll('th.sortable')) {
    const on = th.dataset.key === key;
    th.classList.toggle('sorted', on);
    th.dataset.dir = on ? dir : '';
  }

  portsTbody.innerHTML = '';
  for (const p of rows) {
    const tr = document.createElement('tr');

    const tdPort = document.createElement('td');
    tdPort.className = 'col-port';
    tdPort.innerHTML = `<span class="port-num">${p.port}</span>`;
    tr.appendChild(tdPort);

    const tdAddr = document.createElement('td');
    tdAddr.className = 'col-addr';
    tdAddr.textContent = p.addr || '';
    tr.appendChild(tdAddr);

    const tdName = document.createElement('td');
    tdName.className = 'col-name';
    const primary = p.suggestedName || p.process || '—';
    const cmd = p.command && p.command !== primary ? p.command : '';
    tdName.innerHTML =
      `<span class="pname">${escapeHtml(primary)}</span>` +
      (cmd ? `<span class="pcmd" title="${escapeHtml(p.command)}">${escapeHtml(cmd)}</span>` : '');
    tr.appendChild(tdName);

    const tdReg = document.createElement('td');
    tdReg.className = 'col-reg';
    if (p.registered) {
      const pill = document.createElement('span');
      pill.className = 'reg-pill';
      pill.innerHTML = `<span class="reg-dot"></span>${escapeHtml(p.registeredName || '已注册')}`;
      tdReg.appendChild(pill);
    } else if (p.ignored) {
      // Ignored: a muted pill (with the note, if any) and a way to undo.
      const pill = document.createElement('span');
      pill.className = 'ignore-pill';
      pill.textContent = '已忽略';
      if (p.ignoreNote) {
        pill.title = p.ignoreNote;
        const note = document.createElement('span');
        note.className = 'ignore-note';
        note.textContent = p.ignoreNote;
        pill.appendChild(note);
      }
      tdReg.appendChild(pill);
      const undo = document.createElement('button');
      undo.className = 'btn ghost small reg-btn';
      undo.textContent = '取消忽略';
      undo.addEventListener('click', () => unignorePort(p.port));
      tdReg.appendChild(undo);
    } else {
      const btn = document.createElement('button');
      btn.className = 'btn primary reg-btn';
      btn.textContent = '注册';
      btn.addEventListener('click', () => openRegisterForPort(p));
      tdReg.appendChild(btn);
      const ign = document.createElement('button');
      ign.className = 'btn ghost small reg-btn';
      ign.textContent = '忽略';
      ign.addEventListener('click', () => openIgnore(p));
      tdReg.appendChild(ign);
    }
    tr.appendChild(tdReg);

    portsTbody.appendChild(tr);
  }

  const n = rows.length;
  portsEmpty.hidden = n !== 0;
  portsNote.textContent = n
    ? `共 ${n} 个正在监听的 TCP 端口 · 点击表头可排序`
    : '当前正在监听的 TCP 端口 · 点击表头可排序';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function loadPorts() {
  try {
    const res = await fetch('/api/ports');
    if (!res.ok) throw new Error('bad response');
    const json = await res.json();
    portsData = Array.isArray(json.ports) ? json.ports : [];
    renderPorts();
  } catch (err) {
    console.error('ports fetch failed', err);
    portsData = [];
    renderPorts();
    portsNote.textContent = '读取端口失败，请重试';
  }
}

function openPorts() {
  portsModal.hidden = false;
  loadPorts();
}
function closePorts() {
  portsModal.hidden = true;
}

// ---- ignore a port ---------------------------------------------------------
const ignoreModal = document.getElementById('ignoreModal');
const ignoreForm = document.getElementById('ignoreForm');
const ignoreNoteEl = document.getElementById('f-ignore-note');
const ignoreError = document.getElementById('ignoreError');
const ignoreHint = document.getElementById('ignoreHint');
let ignoringPort = null;

function openIgnore(p) {
  ignoringPort = p.port;
  ignoreError.textContent = '';
  ignoreNoteEl.value = '';
  const label = p.suggestedName || p.process || '';
  ignoreHint.textContent = label
    ? `将端口 ${p.port}（${label}）从「未注册」提醒中隐藏。备注可留空。`
    : `将端口 ${p.port} 从「未注册」提醒中隐藏。备注可留空。`;
  ignoreModal.hidden = false;
  ignoreNoteEl.focus();
}

function closeIgnore() {
  ignoreModal.hidden = true;
  ignoringPort = null;
}

ignoreForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (ignoringPort == null) return;
  ignoreError.textContent = '';
  try {
    const res = await fetch('/api/ports/ignore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: ignoringPort, note: ignoreNoteEl.value.trim() }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      ignoreError.textContent = json.error || '忽略失败';
      return;
    }
    closeIgnore();
    loadPorts();
  } catch {
    ignoreError.textContent = '网络错误，请重试';
  }
});

async function unignorePort(port) {
  try {
    const res = await fetch('/api/ports/ignore/' + port, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error('bad response');
  } catch (err) {
    console.error('unignore failed', err);
  }
  loadPorts();
}

document.getElementById('ignoreClose').addEventListener('click', closeIgnore);
document.getElementById('ignoreCancel').addEventListener('click', closeIgnore);
ignoreModal.addEventListener('click', (e) => {
  if (e.target === ignoreModal) closeIgnore();
});

document.getElementById('portsBtn').addEventListener('click', openPorts);
document.getElementById('portsClose').addEventListener('click', closePorts);
document.getElementById('portsRefresh').addEventListener('click', loadPorts);
portsModal.addEventListener('click', (e) => {
  if (e.target === portsModal) closePorts();
});
for (const th of portsModal.querySelectorAll('th.sortable')) {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (portsSort.key === key) {
      portsSort.dir = portsSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      portsSort.key = key;
      // ports & registration default to a sensible direction
      portsSort.dir = key === 'registered' ? 'desc' : 'asc';
    }
    renderPorts();
  });
}

// ============================================================================
//  通知 / 设置 抽屉
// ============================================================================

// ---- generic drawer open/close (slide-in with backdrop fade) ----------------
function openDrawer(backdrop, toolBtn) {
  backdrop.hidden = false;
  void backdrop.offsetWidth; // reflow so the transition plays
  backdrop.classList.add('open');
  if (toolBtn) toolBtn.classList.add('active');
}
function closeDrawer(backdrop, toolBtn) {
  backdrop.classList.remove('open');
  if (toolBtn) toolBtn.classList.remove('active');
  setTimeout(() => { backdrop.hidden = true; }, 280);
}

const notifyDrawer = document.getElementById('notifyDrawer');
const settingsDrawer = document.getElementById('settingsDrawer');
const notifyBtn = document.getElementById('notifyBtn');
const settingsBtn = document.getElementById('settingsBtn');

notifyBtn.addEventListener('click', () => { openDrawer(notifyDrawer, notifyBtn); loadRules(); });
settingsBtn.addEventListener('click', () => { openDrawer(settingsDrawer, settingsBtn); loadSettings(); });
document.getElementById('notifyDrawerClose').addEventListener('click', () => closeDrawer(notifyDrawer, notifyBtn));
document.getElementById('settingsDrawerClose').addEventListener('click', () => closeDrawer(settingsDrawer, settingsBtn));
notifyDrawer.addEventListener('click', (e) => { if (e.target === notifyDrawer) closeDrawer(notifyDrawer, notifyBtn); });
settingsDrawer.addEventListener('click', (e) => { if (e.target === settingsDrawer) closeDrawer(settingsDrawer, settingsBtn); });

// Escape closes (topmost first): rule modal → open drawer.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!ruleModal.hidden) { closeRuleModal(); return; }
  if (notifyDrawer.classList.contains('open')) { closeDrawer(notifyDrawer, notifyBtn); return; }
  if (settingsDrawer.classList.contains('open')) { closeDrawer(settingsDrawer, settingsBtn); return; }
});

// ---- settings (Telegram / SMTP) --------------------------------------------
const tgEnabled = document.getElementById('tgEnabled');
const tgToken = document.getElementById('tgToken');
const tgChatId = document.getElementById('tgChatId');
const tgTokenHint = document.getElementById('tgTokenHint');
const tgError = document.getElementById('tgError');
let tgTokenSet = false;

const smtpEnabled = document.getElementById('smtpEnabled');
const smtpHost = document.getElementById('smtpHost');
const smtpPort = document.getElementById('smtpPort');
const smtpSecure = document.getElementById('smtpSecure');
const smtpUsername = document.getElementById('smtpUsername');
const smtpPassword = document.getElementById('smtpPassword');
const smtpFrom = document.getElementById('smtpFrom');
const smtpTestTo = document.getElementById('smtpTestTo');
const smtpError = document.getElementById('smtpError');
const smtpPasswordHint = document.getElementById('smtpPasswordHint');
let smtpPasswordSet = false;

// Split a recipient string on commas / whitespace / newlines.
function parseRecipients(raw) {
  return String(raw || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error('bad response');
    const { settings } = await res.json();
    const tg = settings.telegram || {};
    tgEnabled.checked = !!tg.enabled;
    tgChatId.value = tg.chatId || '';
    tgToken.value = '';
    tgTokenSet = !!tg.tokenSet;
    tgTokenHint.textContent = tgTokenSet
      ? '已保存 Token · 如需更换请输入新的'
      : '在 Telegram 找 @BotFather 创建机器人获取';
    tgError.textContent = '';

    const sm = settings.smtp || {};
    smtpEnabled.checked = !!sm.enabled;
    smtpHost.value = sm.host || '';
    smtpPort.value = sm.port || 465;
    smtpSecure.checked = sm.secure !== false;
    smtpUsername.value = sm.username || '';
    smtpFrom.value = sm.from || '';
    smtpPassword.value = '';
    smtpPasswordSet = !!sm.passwordSet;
    smtpPasswordHint.textContent = smtpPasswordSet
      ? '已保存密码 · 如需更换请输入新的'
      : '多数邮箱需使用「授权码 / 应用专用密码」，而非登录密码';
    smtpError.textContent = '';
  } catch (err) {
    console.error('load settings failed', err);
  }
}

async function saveSettings() {
  tgError.textContent = '';
  const typedToken = tgToken.value.trim();
  const chatId = tgChatId.value.trim();
  if (tgEnabled.checked && !tgTokenSet && !typedToken) {
    tgError.textContent = '请先填写 Bot Token';
    return;
  }
  if (tgEnabled.checked && !chatId) {
    tgError.textContent = '请先填写 Chat ID';
    return;
  }
  const telegram = { enabled: tgEnabled.checked, chatId };
  if (typedToken) telegram.token = typedToken;
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegram }),
    });
    const json = await res.json();
    if (!res.ok) { tgError.textContent = json.error || '保存失败'; return; }
    await loadSettings();
    showToast('设置已保存');
    refreshNotifyBadge();
  } catch {
    tgError.textContent = '网络错误，请重试';
  }
}

async function testTelegram() {
  tgError.textContent = '';
  const typedToken = tgToken.value.trim();
  const chatId = tgChatId.value.trim();
  if (!tgTokenSet && !typedToken) { tgError.textContent = '请先填写 Bot Token'; return; }
  if (!chatId) { tgError.textContent = '请先填写 Chat ID'; return; }
  const body = { chatId };
  if (typedToken) body.token = typedToken;
  const btn = document.getElementById('tgTestBtn');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = '发送中…';
  try {
    const res = await fetch('/api/settings/telegram/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (res.ok) showToast('测试消息已发送 ✓');
    else tgError.textContent = json.error || '发送失败';
  } catch {
    tgError.textContent = '网络错误，请重试';
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

document.getElementById('tgSaveBtn').addEventListener('click', saveSettings);
document.getElementById('tgTestBtn').addEventListener('click', testTelegram);

// ---- settings: SMTP email ---------------------------------------------------
// Collect the SMTP fields into an API patch. Password is only sent when the
// user typed a new one (blank keeps the stored secret).
function collectSmtp() {
  const from = smtpFrom.value.trim() || smtpUsername.value.trim();
  const smtp = {
    enabled: smtpEnabled.checked,
    host: smtpHost.value.trim(),
    port: Number(smtpPort.value) || 465,
    secure: smtpSecure.checked,
    username: smtpUsername.value.trim(),
    from,
  };
  const pwd = smtpPassword.value;
  if (pwd) smtp.password = pwd;
  return smtp;
}

// Guard the fields required for a working transport (only enforced when enabled).
function smtpMissing(smtp) {
  if (!smtp.host) return '请先填写 SMTP 服务器';
  if (!smtp.from) return '请先填写发件人或用户名';
  if (!smtpPasswordSet && !smtp.password) return '请先填写密码 / 授权码';
  return '';
}

async function saveSmtp() {
  smtpError.textContent = '';
  const smtp = collectSmtp();
  if (smtp.enabled) {
    const miss = smtpMissing(smtp);
    if (miss) { smtpError.textContent = miss; return; }
  }
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smtp }),
    });
    const json = await res.json();
    if (!res.ok) { smtpError.textContent = json.error || '保存失败'; return; }
    await loadSettings();
    showToast('设置已保存');
    refreshNotifyBadge();
  } catch {
    smtpError.textContent = '网络错误，请重试';
  }
}

async function testSmtp() {
  smtpError.textContent = '';
  const smtp = collectSmtp();
  const miss = smtpMissing(smtp);
  if (miss) { smtpError.textContent = miss; return; }
  const testTo = parseRecipients(smtpTestTo.value);
  if (!testTo.length) { smtpError.textContent = '请先填写测试收件人'; return; }
  smtp.recipients = testTo; // transient — only this test uses it, never saved
  const btn = document.getElementById('smtpTestBtn');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = '发送中…';
  try {
    const res = await fetch('/api/settings/smtp/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(smtp),
    });
    const json = await res.json();
    if (res.ok) showToast('测试邮件已发送 ✓');
    else smtpError.textContent = json.error || '发送失败';
  } catch {
    smtpError.textContent = '网络错误，请重试';
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

document.getElementById('smtpSaveBtn').addEventListener('click', saveSmtp);
document.getElementById('smtpTestBtn').addEventListener('click', testSmtp);

// ---- alert rules ------------------------------------------------------------
const RULE_META = {
  status_change: { icon: '⚡', label: '端口状态变更' },
  duration: { icon: '⏱', label: '状态持续时长' },
  new_port: { icon: '🆕', label: '新占用端口' },
  backup: { icon: '💾', label: '服务器备份' },
};
const RULE_TYPE_HINT = {
  status_change: '10 秒探测发现端口变为可用 / 不可用时立即推送。',
  duration: '端口在某状态持续超过设定时长后推送一次。',
  new_port: '端口速查每 20 秒扫描，发现既未注册也未忽略的新占用端口时推送。',
  backup: '每分钟轮询备份状态，检测到新的备份任务完成时推送本次详情与下次备份时间。',
};

let rulesCache = [];

function svcName(id) {
  const svc = (state.data ? state.data.services : []).find((s) => s.id === id);
  return svc ? svc.name : '(已删除)';
}

function fmtSecs(sec) {
  sec = Math.max(0, Math.floor(sec));
  if (sec % 86400 === 0 && sec >= 86400) return sec / 86400 + ' 天';
  if (sec % 3600 === 0 && sec >= 3600) return sec / 3600 + ' 小时';
  if (sec % 60 === 0 && sec >= 60) return sec / 60 + ' 分钟';
  return sec + ' 秒';
}

function ruleScopeText(rule) {
  if (rule.scope === 'all') return '所有端口';
  const ids = rule.serviceIds || [];
  if (!ids.length) return '未指定端口';
  if (ids.length <= 2) return ids.map(svcName).join('、');
  return `${svcName(ids[0])} 等 ${ids.length} 个端口`;
}

function ruleDesc(rule) {
  if (rule.type === 'status_change') {
    const dir = { both: '变为可用或不可用', up: '仅变为可用', down: '仅变为不可用' }[rule.direction || 'both'];
    return `${ruleScopeText(rule)} · ${dir}`;
  }
  if (rule.type === 'duration') {
    const st = rule.state === 'up' ? '可用' : '不可用';
    return `${ruleScopeText(rule)} · ${st}持续超过 ${fmtSecs(rule.seconds)}`;
  }
  if (rule.type === 'backup') {
    return { both: '每次备份完成（成功或失败）', success: '仅备份成功时', fail: '仅备份失败时' }[rule.on || 'both'];
  }
  return '发现未注册且未忽略的新占用端口';
}

const CHANNEL_LABEL = { telegram: 'Telegram', smtp: 'SMTP 邮件' };

function renderRules() {
  const list = document.getElementById('ruleList');
  const empty = document.getElementById('ruleEmpty');
  list.innerHTML = '';
  empty.hidden = rulesCache.length !== 0;
  for (const rule of rulesCache) {
    const card = document.createElement('div');
    card.className = 'rule-card' + (rule.enabled ? '' : ' disabled');
    const meta = RULE_META[rule.type] || { icon: '•', label: rule.type };

    const chips = (rule.channels || [])
      .map((c) => {
        let label = CHANNEL_LABEL[c] || c;
        if (c === 'smtp') {
          const n = (rule.recipients || []).filter((r) => r && r.enabled && r.address).length;
          label += ` · ${n} 位收件人`;
        }
        return `<span class="rule-chip ch">${escapeHtml(label)}</span>`;
      })
      .join('');

    card.innerHTML =
      `<span class="rule-ic ${rule.type}">${meta.icon}</span>` +
      `<div class="rule-main">` +
      `<div class="rule-name">${escapeHtml(rule.name || meta.label)}</div>` +
      `<div class="rule-desc">${escapeHtml(ruleDesc(rule))}</div>` +
      `<div class="rule-chips">${chips}</div>` +
      `</div>` +
      `<div class="rule-actions">` +
      `<label class="switch"><input type="checkbox" ${rule.enabled ? 'checked' : ''}><span class="switch-slider"></span></label>` +
      `<button class="icon-link edit-rule" title="编辑">✎</button>` +
      `<button class="icon-btn del-rule" title="删除">✕</button>` +
      `</div>`;

    card.querySelector('.switch input').addEventListener('change', (e) =>
      toggleRule(rule, e.target.checked)
    );
    card.querySelector('.edit-rule').addEventListener('click', () => openRuleModal(rule));
    card.querySelector('.del-rule').addEventListener('click', () => deleteRule(rule));
    list.appendChild(card);
  }
}

function refreshNotifyBadge() {
  const badge = document.getElementById('notifyBadge');
  const n = rulesCache.filter((r) => r.enabled).length;
  badge.textContent = n;
  badge.hidden = n === 0;
}

async function loadRules() {
  try {
    const res = await fetch('/api/rules');
    if (!res.ok) throw new Error('bad response');
    const json = await res.json();
    rulesCache = Array.isArray(json.rules) ? json.rules : [];
  } catch (err) {
    console.error('load rules failed', err);
    rulesCache = [];
  }
  renderRules();
  refreshNotifyBadge();
}

async function toggleRule(rule, enabled) {
  try {
    const res = await fetch('/api/rules/' + rule.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ruleToBody(rule), enabled }),
    });
    if (!res.ok) throw new Error('bad');
    rule.enabled = enabled;
  } catch {
    showToast('操作失败，请重试');
  }
  await loadRules();
}

async function deleteRule(rule) {
  if (!confirm(`删除告警「${rule.name || RULE_META[rule.type].label}」？`)) return;
  try {
    await fetch('/api/rules/' + rule.id, { method: 'DELETE' });
  } catch { showToast('删除失败'); }
  await loadRules();
}

// The full body a PUT expects (so a toggle re-sends a valid rule).
function ruleToBody(rule) {
  const b = {
    type: rule.type,
    enabled: rule.enabled,
    name: rule.name || '',
    channels: rule.channels || [],
    recipients: Array.isArray(rule.recipients) ? rule.recipients : [],
  };
  if (rule.type !== 'new_port') {
    b.scope = rule.scope;
    b.serviceIds = rule.serviceIds || [];
  }
  if (rule.type === 'status_change') b.direction = rule.direction || 'both';
  if (rule.type === 'duration') { b.state = rule.state; b.seconds = rule.seconds; }
  if (rule.type === 'backup') b.on = rule.on || 'both';
  return b;
}

// ---- rule editor modal ------------------------------------------------------
const ruleModal = document.getElementById('ruleModal');
const ruleForm = document.getElementById('ruleForm');
const ruleError = document.getElementById('ruleError');
const ruleServices = document.getElementById('ruleServices');
let editingRuleId = null;
const draft = { type: 'status_change', direction: 'both', state: 'down', scope: 'all', seconds: '', on: 'both', serviceIds: new Set(), recipients: [] };

function setSeg(groupId, attr, value) {
  for (const b of document.getElementById(groupId).querySelectorAll('.seg')) {
    b.classList.toggle('active', b.dataset[attr] === value);
  }
}

function applyRuleVisibility() {
  for (const el of ruleForm.querySelectorAll('.rule-when, .rule-scope')) {
    const types = (el.dataset.for || '').split(/\s+/);
    el.hidden = !types.includes(draft.type);
  }
  document.getElementById('ruleTypeHint').textContent = RULE_TYPE_HINT[draft.type] || '';
  refreshChecklistMode();
}

// "所有端口" keeps the list visible (no collapse) but locks it as fully
// included — every row checked and disabled. "指定端口" makes it interactive,
// reflecting the user's picks. draft.serviceIds is never touched here, so
// toggling back and forth preserves a specific selection.
function refreshChecklistMode() {
  const all = draft.scope === 'all';
  ruleServices.classList.toggle('all-selected', all);
  for (const cb of ruleServices.querySelectorAll('input[type="checkbox"]')) {
    cb.disabled = all;
    cb.checked = all ? true : draft.serviceIds.has(cb.value);
  }
  const hint = document.getElementById('ruleScopeHint');
  if (hint) {
    hint.textContent = all
      ? '已包含全部端口（含日后新注册的端口）'
      : '勾选需要关联的端口';
  }
}

function buildServiceChecklist() {
  const services = state.data ? state.data.services : [];
  ruleServices.innerHTML = '';
  if (!services.length) {
    ruleServices.innerHTML = '<div class="svc-opt" style="cursor:default;color:var(--faint)">暂无已注册端口</div>';
    return;
  }
  for (const svc of services) {
    const row = document.createElement('label');
    row.className = 'svc-opt';
    const cls = svc.status === 1 ? 'up' : svc.status === 0 ? 'down' : '';
    row.innerHTML =
      `<input type="checkbox" value="${svc.id}" ${draft.serviceIds.has(svc.id) ? 'checked' : ''}>` +
      `<span class="svc-opt-dot ${cls}"></span>` +
      `<span class="svc-opt-name">${escapeHtml(svc.name)}</span>` +
      `<span class="svc-opt-port">:${svc.port}</span>`;
    row.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) draft.serviceIds.add(svc.id);
      else draft.serviceIds.delete(svc.id);
    });
    ruleServices.appendChild(row);
  }
  refreshChecklistMode();
}

// ---- per-rule email recipients ---------------------------------------------
const ruleRecipientsField = document.getElementById('ruleRecipientsField');
const ruleRecipientsList = document.getElementById('ruleRecipients');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Trim, drop blanks, de-dupe (case-insensitive) the draft's recipient rows.
function collectRuleRecipients() {
  const seen = new Set();
  const out = [];
  for (const r of draft.recipients) {
    const address = String(r.address || '').trim();
    if (!address) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ address, enabled: r.enabled !== false });
  }
  return out;
}

function ruleSmtpChecked() {
  const box = document.querySelector('#ruleChannels input[value="smtp"]');
  return !!(box && box.checked);
}

// Recipient rows only matter for the SMTP channel; reveal them when it's on.
function applyRecipientVisibility() {
  const on = ruleSmtpChecked();
  ruleRecipientsField.hidden = !on;
  if (on && !draft.recipients.length) draft.recipients.push({ address: '', enabled: true });
  if (on) renderRuleRecipients();
}

function renderRuleRecipients() {
  ruleRecipientsList.innerHTML = '';
  draft.recipients.forEach((rcpt, i) => {
    const row = document.createElement('div');
    row.className = 'rcpt-row';
    row.innerHTML =
      `<label class="switch" title="开启 / 关闭"><input type="checkbox" ${rcpt.enabled ? 'checked' : ''}><span class="switch-slider"></span></label>` +
      `<input class="rcpt-input" type="email" autocomplete="off" placeholder="you@example.com" value="${escapeHtml(rcpt.address)}">` +
      `<button type="button" class="rcpt-del" title="移除">✕</button>`;
    row.querySelector('.switch input').addEventListener('change', (e) => {
      draft.recipients[i].enabled = e.target.checked;
    });
    row.querySelector('.rcpt-input').addEventListener('input', (e) => {
      draft.recipients[i].address = e.target.value;
    });
    row.querySelector('.rcpt-del').addEventListener('click', () => {
      draft.recipients.splice(i, 1);
      renderRuleRecipients();
    });
    ruleRecipientsList.appendChild(row);
  });
}

document.getElementById('ruleRecipientAdd').addEventListener('click', () => {
  draft.recipients.push({ address: '', enabled: true });
  renderRuleRecipients();
});
document.getElementById('ruleChannels').addEventListener('change', applyRecipientVisibility);

function openRuleModal(rule) {
  editingRuleId = rule ? rule.id : null;
  ruleError.textContent = '';
  document.getElementById('ruleModalTitle').textContent = rule ? '编辑告警' : '添加告警';

  draft.type = rule ? rule.type : 'status_change';
  draft.direction = rule && rule.direction ? rule.direction : 'both';
  draft.state = rule && rule.state ? rule.state : 'down';
  draft.scope = rule && rule.scope ? rule.scope : 'all';
  draft.seconds = rule && rule.seconds ? rule.seconds : '';
  draft.on = rule && rule.on ? rule.on : 'both';
  draft.serviceIds = new Set(rule && rule.serviceIds ? rule.serviceIds : []);
  draft.recipients = (rule && Array.isArray(rule.recipients) ? rule.recipients : [])
    .map((r) => ({ address: String(r.address || ''), enabled: r.enabled !== false }));

  setSeg('ruleTypeGroup', 'type', draft.type);
  setSeg('ruleDirGroup', 'dir', draft.direction);
  setSeg('ruleStateGroup', 'state', draft.state);
  setSeg('ruleBackupOnGroup', 'on', draft.on);
  setSeg('ruleScopeGroup', 'scope', draft.scope);
  document.getElementById('ruleSeconds').value = draft.seconds || '';

  const channels = new Set(rule ? rule.channels || [] : ['telegram']);
  for (const cb of document.getElementById('ruleChannels').querySelectorAll('input')) {
    cb.checked = channels.has(cb.value);
  }

  buildServiceChecklist();
  applyRuleVisibility();
  applyRecipientVisibility();
  ruleModal.hidden = false;
}

function closeRuleModal() {
  ruleModal.hidden = true;
  editingRuleId = null;
}

// segmented-control wiring
document.getElementById('ruleTypeGroup').addEventListener('click', (e) => {
  const b = e.target.closest('.seg'); if (!b) return;
  draft.type = b.dataset.type; setSeg('ruleTypeGroup', 'type', draft.type); applyRuleVisibility();
});
document.getElementById('ruleDirGroup').addEventListener('click', (e) => {
  const b = e.target.closest('.seg'); if (!b) return;
  draft.direction = b.dataset.dir; setSeg('ruleDirGroup', 'dir', draft.direction);
});
document.getElementById('ruleStateGroup').addEventListener('click', (e) => {
  const b = e.target.closest('.seg'); if (!b) return;
  draft.state = b.dataset.state; setSeg('ruleStateGroup', 'state', draft.state);
});
document.getElementById('ruleBackupOnGroup').addEventListener('click', (e) => {
  const b = e.target.closest('.seg'); if (!b) return;
  draft.on = b.dataset.on; setSeg('ruleBackupOnGroup', 'on', draft.on);
});
document.getElementById('ruleScopeGroup').addEventListener('click', (e) => {
  const b = e.target.closest('.seg'); if (!b) return;
  draft.scope = b.dataset.scope; setSeg('ruleScopeGroup', 'scope', draft.scope);
  refreshChecklistMode();
});
document.getElementById('durPresets').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  document.getElementById('ruleSeconds').value = b.dataset.sec;
});

document.getElementById('addRuleBtn').addEventListener('click', () => openRuleModal(null));
document.getElementById('ruleModalClose').addEventListener('click', closeRuleModal);
document.getElementById('ruleCancel').addEventListener('click', closeRuleModal);
ruleModal.addEventListener('click', (e) => { if (e.target === ruleModal) closeRuleModal(); });

ruleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  ruleError.textContent = '';
  const channels = [...document.getElementById('ruleChannels').querySelectorAll('input:checked')].map((c) => c.value);
  const recipients = collectRuleRecipients();
  if (channels.includes('smtp')) {
    const bad = recipients.find((r) => !EMAIL_RE.test(r.address));
    if (bad) { ruleError.textContent = `收件人「${bad.address}」不是有效的邮箱地址`; return; }
    if (!recipients.some((r) => r.enabled)) {
      ruleError.textContent = '选择「SMTP 邮件」时，请至少添加并启用一个收件人';
      return;
    }
  }
  const body = { type: draft.type, enabled: true, name: '', channels, recipients };
  if (draft.type !== 'new_port') {
    body.scope = draft.scope;
    body.serviceIds = [...draft.serviceIds];
  }
  if (draft.type === 'status_change') body.direction = draft.direction;
  if (draft.type === 'duration') {
    body.state = draft.state;
    body.seconds = Number(document.getElementById('ruleSeconds').value);
  }
  if (draft.type === 'backup') body.on = draft.on;
  // keep the enabled flag when editing an existing rule
  if (editingRuleId) {
    const existing = rulesCache.find((r) => r.id === editingRuleId);
    if (existing) body.enabled = existing.enabled;
  }

  const url = editingRuleId ? '/api/rules/' + editingRuleId : '/api/rules';
  const method = editingRuleId ? 'PUT' : 'POST';
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) { ruleError.textContent = json.error || '保存失败'; return; }
    closeRuleModal();
    await loadRules();
    showToast(editingRuleId ? '告警已更新' : '告警已添加');
  } catch {
    ruleError.textContent = '网络错误，请重试';
  }
});

// keep the bell badge current across the session
loadRules();

// ---- boot ------------------------------------------------------------------
buildRangeSwitch();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveRangeThumb);
fetchData();
fetchBackup();
setInterval(() => {
  // never let the periodic refresh rebuild the DOM mid-zoom, or it snaps
  if (performance.now() < zoomEndsAt) return;
  fetchData();
}, REFRESH_MS);
// The backup card refreshes on its own cadence — the server only re-polls the
// backup API every ~minute, so there's nothing finer to show.
setInterval(fetchBackup, 15000);
