/**
 * Tab Time Limiter – Popup UI
 */

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const siteList    = document.getElementById('siteList');
const emptyState  = document.getElementById('emptyState');
const formPanel   = document.getElementById('formPanel');
const formTitle   = document.getElementById('formTitle');
const formError   = document.getElementById('formError');
const editId      = document.getElementById('editId');
const inputHost   = document.getElementById('inputHostname');
const inputLimit  = document.getElementById('inputLimit');
const inputWindow = document.getElementById('inputWindow');
const btnAddToggle = document.getElementById('btnAddToggle');
const btnSave     = document.getElementById('btnSave');
const btnCancel   = document.getElementById('btnCancel');

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  renderAll();
  // Refresh every second for real-time display
  setInterval(renderAll, 1000);
});

// ─── Form toggling ────────────────────────────────────────────────────────────

btnAddToggle.addEventListener('click', () => {
  const isHidden = formPanel.hidden;
  if (isHidden) {
    openFormForAdd();
  } else {
    closeForm();
  }
});

btnCancel.addEventListener('click', closeForm);

function openFormForAdd() {
  editId.value    = '';
  inputHost.value = '';
  inputLimit.value = '';
  inputWindow.value = '';
  formTitle.textContent = '添加网站限制';
  hideError();
  formPanel.hidden = false;
  btnAddToggle.title = '收起';
  inputHost.focus();
}

function openFormForEdit(site) {
  editId.value      = site.id;
  inputHost.value   = site.hostname;
  inputLimit.value  = site.limitMinutes;
  inputWindow.value = site.windowHours;
  formTitle.textContent = '编辑限制规则';
  hideError();
  formPanel.hidden = false;
  btnAddToggle.title = '收起';
  inputHost.focus();
}

function closeForm() {
  formPanel.hidden = true;
  btnAddToggle.title = '添加网站';
  hideError();
}

// ─── Quick presets ────────────────────────────────────────────────────────────

document.querySelectorAll('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    inputLimit.value  = btn.dataset.min;
    inputWindow.value = btn.dataset.hrs;
  });
});

// ─── Save ─────────────────────────────────────────────────────────────────────

btnSave.addEventListener('click', saveSite);
inputHost.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSite(); });

async function saveSite() {
  const hostname = normalizeHostname(inputHost.value.trim());
  const limitMin = parseInt(inputLimit.value, 10);
  const windowHrs = parseInt(inputWindow.value, 10);

  // Validation
  if (!hostname) return showError('请输入网站域名，例如：youtube.com');
  if (!isValidHostname(hostname)) return showError('域名格式无效，请输入如 youtube.com 的格式');
  if (!limitMin || limitMin < 1) return showError('时间限额至少 1 分钟');
  if (!windowHrs || windowHrs < 1) return showError('计时窗口至少 1 小时');

  const { sites = [], usage = {} } = await chrome.storage.local.get(['sites', 'usage']);

  const id = editId.value || crypto.randomUUID();
  const isEdit = Boolean(editId.value);

  // Check duplicate hostname (skip current if editing)
  const duplicate = sites.find((s) => s.hostname === hostname && s.id !== id);
  if (duplicate) return showError(`${hostname} 已存在限制规则`);

  const rule = { id, hostname, limitMinutes: limitMin, windowHours: windowHrs };

  if (isEdit) {
    const idx = sites.findIndex((s) => s.id === id);
    if (idx !== -1) sites[idx] = rule;
    // Reset usage when rule is edited so limits apply cleanly
    delete usage[id];
  } else {
    sites.push(rule);
  }

  await chrome.storage.local.set({ sites, usage });
  closeForm();
  renderAll();
}

// ─── Delete ───────────────────────────────────────────────────────────────────

async function deleteSite(id) {
  const { sites = [], usage = {} } = await chrome.storage.local.get(['sites', 'usage']);
  const filtered = sites.filter((s) => s.id !== id);
  delete usage[id];
  await chrome.storage.local.set({ sites: filtered, usage });
  renderAll();
}

// ─── Render ───────────────────────────────────────────────────────────────────

async function renderAll() {
  const { sites = [], usage = {}, activeSession = null } =
    await chrome.storage.local.get(['sites', 'usage', 'activeSession']);

  siteList.innerHTML = '';

  if (!sites.length) {
    emptyState.hidden = false;
    siteList.hidden   = true;
    return;
  }

  emptyState.hidden = true;
  siteList.hidden   = false;

  for (const site of sites) {
    const card = buildCard(site, usage[site.id], activeSession);
    siteList.appendChild(card);
  }
}

function buildCard(site, su, activeSession) {
  const now = Date.now();

  // Determine effective usage
  let secondsUsed = 0;
  let windowStart = now;
  let windowExpired = false;

  if (su) {
    windowStart = su.windowStart;
    if (now > su.windowStart + site.windowHours * 3600 * 1000) {
      windowExpired = true;
    } else {
      secondsUsed = su.secondsUsed;
    }
  }

  // Add live in-progress seconds from the active session
  const isLive = !windowExpired &&
    activeSession?.siteId === site.id &&
    activeSession?.startTime != null;
  if (isLive) {
    secondsUsed += (now - activeSession.startTime) / 1000;
  }

  const limitSeconds = site.limitMinutes * 60;
  const pct = Math.min(secondsUsed / limitSeconds, 1);
  const blocked = !windowExpired && secondsUsed >= limitSeconds;

  // Next reset time
  const windowEndMs = windowStart + site.windowHours * 3600 * 1000;
  const resetIn = windowExpired ? 0 : Math.max(0, windowEndMs - now);

  // Card element
  const card = document.createElement('div');
  card.className = 'site-card' + (blocked ? ' is-blocked' : '');

  // ── top row
  const topDiv = document.createElement('div');
  topDiv.className = 'card-top';

  const infoDiv = document.createElement('div');
  infoDiv.className = 'site-info';

  const hostnameEl = document.createElement('div');
  hostnameEl.className = 'site-hostname';
  hostnameEl.textContent = site.hostname;

  const metaEl = document.createElement('div');
  metaEl.className = 'site-meta';
  metaEl.textContent = `${site.limitMinutes} 分钟 / 每 ${site.windowHours} 小时`;

  infoDiv.appendChild(hostnameEl);
  infoDiv.appendChild(metaEl);

  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'card-actions';

  // Edit button
  const editBtn = document.createElement('button');
  editBtn.className = 'act-btn';
  editBtn.title = '编辑';
  editBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  editBtn.addEventListener('click', () => openFormForEdit(site));

  // Delete button
  const delBtn = document.createElement('button');
  delBtn.className = 'act-btn danger';
  delBtn.title = '删除';
  delBtn.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
  delBtn.addEventListener('click', () => {
    if (confirm(`确认删除 ${site.hostname} 的限制规则？`)) deleteSite(site.id);
  });

  actionsDiv.appendChild(editBtn);
  actionsDiv.appendChild(delBtn);
  topDiv.appendChild(infoDiv);
  topDiv.appendChild(actionsDiv);

  // ── progress
  const progressWrap = document.createElement('div');
  progressWrap.className = 'progress-wrap';

  const labelsRow = document.createElement('div');
  labelsRow.className = 'progress-labels';

  const usedLabel = document.createElement('span');
  usedLabel.className = 'used';
  usedLabel.textContent = formatSeconds(secondsUsed);
  if (isLive && !blocked) {
    const dot = document.createElement('span');
    dot.className = 'live-dot';
    dot.title = '计时中';
    usedLabel.appendChild(dot);
  }

  const totalLabel = document.createElement('span');
  totalLabel.textContent = `/ ${formatSeconds(limitSeconds)}`;

  labelsRow.appendChild(usedLabel);
  labelsRow.appendChild(totalLabel);

  const track = document.createElement('div');
  track.className = 'progress-track';

  const fill = document.createElement('div');
  fill.className = 'progress-fill';

  if (blocked) {
    fill.classList.add('over');
  } else if (pct >= 0.85) {
    fill.classList.add('danger');
  } else if (pct >= 0.6) {
    fill.classList.add('warn');
  } else {
    fill.classList.add('ok');
  }

  fill.style.width = (pct * 100).toFixed(1) + '%';
  track.appendChild(fill);
  progressWrap.appendChild(labelsRow);
  progressWrap.appendChild(track);

  // ── status row
  const statusRow = document.createElement('div');
  statusRow.className = 'status-row';

  const badge = document.createElement('span');
  if (blocked) {
    badge.className = 'badge badge-blocked';
    badge.innerHTML = '<span class="badge-dot"></span>已封锁';
  } else if (pct >= 0.85) {
    badge.className = 'badge badge-warn';
    badge.innerHTML = '<span class="badge-dot"></span>即将用完';
  } else {
    badge.className = 'badge badge-active';
    badge.innerHTML = '<span class="badge-dot"></span>正常';
  }

  statusRow.appendChild(badge);

  // ── window reset hint
  const resetHint = document.createElement('div');
  resetHint.className = 'window-reset';
  if (windowExpired || secondsUsed === 0) {
    resetHint.textContent = '配额已重置，可正常使用';
  } else {
    resetHint.textContent = `窗口重置：${formatCountdown(resetIn)}`;
  }

  // ── assemble card
  card.appendChild(topDiv);
  card.appendChild(progressWrap);
  card.appendChild(statusRow);
  card.appendChild(resetHint);

  return card;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatSeconds(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
  }
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatCountdown(ms) {
  if (ms <= 0) return '很快';
  const totalMins = Math.ceil(ms / 60000);
  if (totalMins < 60) return `${totalMins} 分钟后`;
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return m ? `${h} 小时 ${m} 分钟后` : `${h} 小时后`;
}

function normalizeHostname(raw) {
  // Strip protocol, path, port
  try {
    const url = raw.includes('://') ? raw : 'https://' + raw;
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return raw.toLowerCase().replace(/^www\./, '').split('/')[0];
  }
}

function isValidHostname(hostname) {
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(hostname);
}

function showError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

function hideError() {
  formError.hidden = true;
  formError.textContent = '';
}
