'use strict';

const RANGE_ORDER = ['10min', '1h', '1d', '7d', '1m'];
const DEFAULT_RANGE = '1d';
const REFRESH_MS = 5000;

const state = {
  range: DEFAULT_RANGE,
  data: null,
  clockOffset: 0, // serverNow - clientNow, to keep counters accurate
  bucketSec: 0,
};

const els = {
  rangeSwitch: document.getElementById('rangeSwitch'),
  list: document.getElementById('serviceList'),
  emptyHint: document.getElementById('emptyHint'),
  addToggle: document.getElementById('addToggle'),
  addForm: document.getElementById('addForm'),
  cancelAdd: document.getElementById('cancelAdd'),
  formError: document.getElementById('formError'),
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
  for (const key of RANGE_ORDER) {
    const btn = document.createElement('button');
    btn.textContent = RANGE_LABELS[key];
    btn.dataset.range = key;
    btn.setAttribute('role', 'tab');
    if (key === state.range) btn.classList.add('active');
    btn.addEventListener('click', () => {
      if (state.range === key) return;
      state.range = key;
      buildRangeSwitch();
      fetchData();
    });
    els.rangeSwitch.appendChild(btn);
  }
}

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
  updateCounters();
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

  const jump = node.querySelector('.jump');
  if (svc.publicUrl) {
    jump.hidden = false;
    jump.href = svc.publicUrl;
  }

  // status bar cells
  const bar = node.querySelector('.bar');
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
  bar.appendChild(frag);
  if (!hasData) bar.classList.add('no-data');

  // meta
  const root = node.querySelector('.root');
  root.textContent = svc.rootDir ? '📁 ' + svc.rootDir : '';
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

// ---- add / delete ----------------------------------------------------------
els.addToggle.addEventListener('click', () => {
  const open = !els.addForm.hidden;
  els.addForm.hidden = open;
  els.addToggle.setAttribute('aria-expanded', String(!open));
  els.formError.textContent = '';
  if (!open) document.getElementById('f-name').focus();
});

els.cancelAdd.addEventListener('click', () => {
  els.addForm.hidden = true;
  els.addToggle.setAttribute('aria-expanded', 'false');
  els.addForm.reset();
  els.formError.textContent = '';
});

els.addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.formError.textContent = '';
  const fd = new FormData(els.addForm);
  const body = {
    name: fd.get('name'),
    port: fd.get('port'),
    rootDir: fd.get('rootDir'),
    publicUrl: fd.get('publicUrl'),
  };
  try {
    const res = await fetch('/api/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
      els.formError.textContent = json.error || '注册失败';
      return;
    }
    els.addForm.reset();
    els.addForm.hidden = true;
    els.addToggle.setAttribute('aria-expanded', 'false');
    await fetchData();
  } catch {
    els.formError.textContent = '网络错误，请重试';
  }
});

async function deleteService(id, name) {
  if (!confirm(`确定删除「${name}」及其全部历史记录？`)) return;
  try {
    await fetch('/api/services/' + id, { method: 'DELETE' });
    await fetchData();
  } catch {
    alert('删除失败，请重试');
  }
}

// ---- edit modal ------------------------------------------------------------
const editModal = document.getElementById('editModal');
const editForm = document.getElementById('editForm');
const editError = document.getElementById('editError');
let editingId = null;

function openEdit(svc) {
  editingId = svc.id;
  editForm.name.value = svc.name;
  editForm.port.value = svc.port;
  editForm.rootDir.value = svc.rootDir || '';
  editForm.publicUrl.value = svc.publicUrl || '';
  editError.textContent = '';
  editModal.hidden = false;
  editForm.name.focus();
}

function closeEdit() {
  editModal.hidden = true;
  editingId = null;
}

document.getElementById('editClose').addEventListener('click', closeEdit);
document.getElementById('editCancel').addEventListener('click', closeEdit);
editModal.addEventListener('click', (e) => {
  if (e.target === editModal) closeEdit();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !editModal.hidden) closeEdit();
});

editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editingId) return;
  editError.textContent = '';
  const body = {
    name: editForm.name.value,
    port: editForm.port.value,
    rootDir: editForm.rootDir.value,
    publicUrl: editForm.publicUrl.value,
  };
  try {
    const res = await fetch('/api/services/' + editingId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
      editError.textContent = json.error || '保存失败';
      return;
    }
    closeEdit();
    await fetchData();
  } catch {
    editError.textContent = '网络错误，请重试';
  }
});

// ---- boot ------------------------------------------------------------------
buildRangeSwitch();
fetchData();
setInterval(fetchData, REFRESH_MS);
