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
  if (!cell) {
    els.tooltip.hidden = true;
    return;
  }
  const t = Number(cell.dataset.t);
  const total = Number(cell.dataset.total);
  const up = Number(cell.dataset.up);
  const end = t + state.bucketSec;
  let body;
  if (total === 0) {
    body = `<div>${fmtTime(t)} – ${fmtTime(end)}</div><div class="tt-pct">无数据</div>`;
  } else {
    const ratio = ((up / total) * 100).toFixed(1);
    body = `<div>${fmtTime(t)} – ${fmtTime(end)}</div><div class="tt-pct">在线 ${ratio}% · ${up}/${total} 次</div>`;
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
  // The register form stacks above 端口速查 — close it first, then the ports modal.
  if (!modal.hidden) closeModal();
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
    } else {
      const btn = document.createElement('button');
      btn.className = 'btn primary reg-btn';
      btn.textContent = '注册';
      btn.addEventListener('click', () => openRegisterForPort(p));
      tdReg.appendChild(btn);
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

// ---- boot ------------------------------------------------------------------
buildRangeSwitch();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveRangeThumb);
fetchData();
setInterval(() => {
  // never let the periodic refresh rebuild the DOM mid-zoom, or it snaps
  if (performance.now() < zoomEndsAt) return;
  fetchData();
}, REFRESH_MS);
