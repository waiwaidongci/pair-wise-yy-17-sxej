const state = {
  config: null,
  db: { sites: [], lightings: [], rechecks: [] },
  activeTab: 'dashboard'
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function toLocalInput(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

function siteById(id) {
  return state.db.sites.find((site) => site.id === id);
}

function lightingById(id) {
  return state.db.lightings.find((record) => record.id === id);
}

function siteLabel(site) {
  if (!site) return '未关联样点';
  return `${site.cave} / ${site.zone} / ${site.pointCode}`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function pill(value) {
  return `<span class="pill ${toneFor(value)}">${escapeHtml(value || '-')}</span>`;
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 6).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

// ---------- 卡片 ----------

function lightingCard(record) {
  const site = siteById(record.siteId);
  const review = record.status === '待复核' && record.review ? `
    <div class="review-box">
      <div><strong>触发原因</strong>：${(record.reviewReasons || []).map(escapeHtml).join('；')}</div>
      <div><strong>复测进度</strong>：连续回落 ${record.review.declineRun}/${record.review.required} 次${record.review.lastMeasuredAt ? ` · 上次复测 ${fmtDate(record.review.lastMeasuredAt)}` : ''}</div>
      <div class="meta">${escapeHtml(record.review.hint)}</div>
    </div>` : '';
  const released = record.status === '已复光' && record.releasedAt
    ? `<div class="meta">复光放行于 ${fmtDate(record.releasedAt)}</div>` : '';
  const actions = [];
  if (record.status === '照明中') actions.push(`<button data-act="end" data-id="${record.id}">结束照明</button>`);
  if (record.status === '待复核') actions.push(`<button data-act="recheck" data-id="${record.id}">登记复测</button>`);
  actions.push(`<button class="ghost" data-act="correct" data-id="${record.id}">更正记录</button>`);
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(siteLabel(site))}</h3>${pill(record.status)}</div>
    <div class="meta">操作员 ${escapeHtml(record.operator)} · 开始 ${fmtDate(record.startedAt)} · ${record.endedAt ? `结束 ${fmtDate(record.endedAt)}` : '未结束'}</div>
    <div class="detail">
      <div>照度<br><strong>${record.lux} lux</strong></div>
      <div>时长<br><strong>${record.durationHours} 小时${record.overtime ? '（超限）' : ''}</strong></div>
      <div>暴露<br><strong>${record.exposureLuxHours} 勒克斯时</strong></div>
    </div>
    ${record.endAlgaeIndex !== null && record.endAlgaeIndex !== undefined ? `<div class="meta">停光时藻类指数 ${record.endAlgaeIndex}</div>` : ''}
    ${review}
    ${released}
    <div class="actions">${actions.join('')}</div>
    ${historyHtml(record)}
  </article>`;
}

function siteCard(site) {
  const limit = state.config.limits.EXPOSURE_LUX_HOURS;
  const pct = Math.min(100, Math.round((site.cycleExposureLuxHours / limit) * 100));
  const over = site.cycleExposureLuxHours > limit;
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(site.pointCode)} / ${escapeHtml(site.zone)}</h3>${pill(site.lightingStatus)}</div>
    <div class="meta">${escapeHtml(site.cave)} · ${escapeHtml(site.route)} · 敏感等级 ${escapeHtml(site.sensitivity || '-')}</div>
    ${site.note ? `<p>${escapeHtml(site.note)}</p>` : ''}
    <div class="exposure">
      <div class="exposure-bar"><span class="${over ? 'over' : ''}" style="width:${pct}%"></span></div>
      <div class="meta">本周期累计暴露 ${site.cycleExposureLuxHours} / ${limit} 勒克斯时</div>
    </div>
    ${historyHtml(site)}
  </article>`;
}

function recheckCard(rc) {
  const record = lightingById(rc.lightingId);
  const site = siteById(rc.siteId);
  const declinePill = rc.invalidated ? '' : pill(rc.decline ? '回落' : '未回落');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(siteLabel(site))}</h3><span class="pill-group">${pill(rc.status)}${declinePill}</span></div>
    <div class="meta">复测员 ${escapeHtml(rc.operator)} · 复测时间 ${fmtDate(rc.measuredAt)} · 原照明操作员 ${escapeHtml(record?.operator || '-')}</div>
    <div class="detail">
      <div>复测藻类指数<br><strong>${rc.algaeIndex}</strong></div>
      <div>停光时指数<br><strong>${record?.endAlgaeIndex ?? '-'}</strong></div>
      <div>照明记录状态<br><strong>${escapeHtml(record?.status || '-')}</strong></div>
    </div>
    ${historyHtml(rc)}
  </article>`;
}

// ---------- 视图 ----------

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    let value;
    if (stat.type === 'sum') {
      value = Math.round(items.reduce((sum, item) => sum + Number(item[stat.field] || 0), 0) * 100) / 100;
    } else {
      value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    }
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function dashboardView() {
  const limits = state.config.limits;
  const pending = state.db.lightings.filter((r) => r.status === '待复核');
  const active = state.db.lightings.filter((r) => r.status === '照明中');
  return `<section class="view" id="dashboard">
    ${renderStats()}
    <p class="meta rule-line">规则：本周期累计照度时长 &gt; ${limits.EXPOSURE_LUX_HOURS} 勒克斯时 或 连续照明 &gt; ${limits.CONTINUOUS_HOURS} 小时 → 停光待复核，期间禁止开新照明；复光须换人连续 ${limits.RECHECK_REQUIRED} 次复测回落，间隔 ≥${limits.RECHECK_INTERVAL_HOURS} 小时；原记录更正后旧结论失效重算。</p>
    <div class="grid">
      <div class="panel"><h2>停光待复核</h2><div class="list">${pending.length ? pending.map(lightingCard).join('') : '<div class="empty">暂无待复核记录</div>'}</div></div>
      <div class="panel"><h2>照明中</h2><div class="list">${active.length ? active.map(lightingCard).join('') : '<div class="empty">暂无照明中的记录</div>'}</div></div>
    </div>
  </section>`;
}

function formFieldHtml(field) {
  const required = field.required ? 'required' : '';
  const wide = field.wide ? 'wide' : '';
  if (field.type === 'textarea') {
    return `<label class="${wide}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${wide}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  return `<label class="${wide}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${required}></label>`;
}

function sitesView() {
  return `<section class="view" id="sites">
    <div class="grid">
      <form class="panel" data-form="site">
        <h2>新增样点</h2>
        <div class="form-grid">${state.config.siteFields.map(formFieldHtml).join('')}</div>
        <div class="actions"><button>保存样点</button></div>
      </form>
      <div class="panel">
        <h2>样点列表</h2>
        <div class="toolbar"><input id="search-sites" placeholder="搜索洞穴、分区、样点、路线"></div>
        <div class="list" id="list-sites">${renderSiteList()}</div>
      </div>
    </div>
  </section>`;
}

function renderSiteList() {
  const query = ($('#search-sites')?.value || '').trim();
  let items = [...state.db.sites];
  if (query) {
    items = items.filter((site) => ['cave', 'zone', 'pointCode', 'route'].some((key) => String(site[key] || '').includes(query)));
  }
  return items.length ? items.map(siteCard).join('') : '<div class="empty">暂无样点</div>';
}

function lightingsView() {
  const siteOptions = state.db.sites.map((site) =>
    `<option value="${site.id}">${escapeHtml(siteLabel(site))}（${site.lightingStatus}）</option>`).join('');
  return `<section class="view" id="lightings">
    <div class="grid">
      <form class="panel" data-form="lighting">
        <h2>开灯登记</h2>
        <div class="form-grid">
          <label class="wide">样点<select name="siteId" required>${siteOptions}</select></label>
          <label>操作员<input name="operator" required></label>
          <label>照度 (lux)<input type="number" name="lux" min="1" step="any" required></label>
          <label class="wide">开始时间（留空取当前）<input type="datetime-local" name="startedAt"></label>
        </div>
        <p class="meta">每样点同时只允许一条未结束照明，重复或并发提交将沿用首次记录；停光复核期间禁止开新照明。</p>
        <div class="actions"><button>开灯</button></div>
      </form>
      <div class="panel">
        <h2>照明记录</h2>
        <div class="toolbar">
          <input id="search-lightings" placeholder="搜索操作员、样点">
          <select id="status-lightings">
            <option value="">全部状态</option>
            ${state.config.lightingStatuses.map((s) => `<option>${escapeHtml(s)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-lightings">${renderLightingList()}</div>
      </div>
    </div>
  </section>`;
}

function renderLightingList() {
  const query = ($('#search-lightings')?.value || '').trim();
  const status = $('#status-lightings')?.value || '';
  let items = [...state.db.lightings];
  if (status) items = items.filter((record) => record.status === status);
  if (query) {
    items = items.filter((record) => {
      const site = siteById(record.siteId);
      return String(record.operator || '').includes(query) || siteLabel(site).includes(query);
    });
  }
  return items.length ? items.map(lightingCard).join('') : '<div class="empty">暂无照明记录</div>';
}

function rechecksView() {
  return `<section class="view" id="rechecks">
    <div class="panel">
      <h2>复测履历</h2>
      <div class="toolbar">
        <input id="search-rechecks" placeholder="搜索复测员、样点">
        <select id="status-rechecks">
          <option value="">全部状态</option>
          ${state.config.recheckStatuses.map((s) => `<option>${escapeHtml(s)}</option>`).join('')}
        </select>
      </div>
      <div class="list" id="list-rechecks">${renderRecheckList()}</div>
    </div>
  </section>`;
}

function renderRecheckList() {
  const query = ($('#search-rechecks')?.value || '').trim();
  const status = $('#status-rechecks')?.value || '';
  let items = [...state.db.rechecks];
  if (status) items = items.filter((rc) => rc.status === status);
  if (query) {
    items = items.filter((rc) => String(rc.operator || '').includes(query) || siteLabel(siteById(rc.siteId)).includes(query));
  }
  return items.length ? items.map(recheckCard).join('') : '<div class="empty">暂无复测记录</div>';
}

// ---------- 弹窗 ----------

function modalFieldHtml(field) {
  const required = field.required ? 'required' : '';
  const value = field.value !== undefined && field.value !== null ? `value="${escapeHtml(field.value)}"` : '';
  const hint = field.hint ? `<span class="hint">${escapeHtml(field.hint)}</span>` : '';
  const wide = field.wide === false ? '' : 'wide';
  if (field.type === 'textarea') {
    return `<label class="${wide}">${field.label}<textarea name="${field.name}" ${required}>${escapeHtml(field.value || '')}</textarea>${hint}</label>`;
  }
  return `<label class="${wide}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${required}>${hint}</label>`;
}

function openModal({ title, fields, submitLabel, onSubmit }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal"><form>
    <h2>${escapeHtml(title)}</h2>
    <div class="form-grid">${fields.map(modalFieldHtml).join('')}</div>
    <div class="actions">
      <button type="submit">${escapeHtml(submitLabel || '提交')}</button>
      <button type="button" class="ghost" data-close>取消</button>
    </div>
  </form></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-close]')) overlay.remove();
  });
  overlay.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.target).entries());
    try {
      const result = await onSubmit(payload);
      overlay.remove();
      await load();
      return result;
    } catch (error) {
      toast(error.message);
    }
  });
}

function openEndModal(record) {
  const site = siteById(record.siteId);
  openModal({
    title: `结束照明 · ${siteLabel(site)}`,
    submitLabel: '结束照明',
    fields: [
      { label: '结束时间', name: 'endedAt', type: 'datetime-local', value: toLocalInput(new Date()), hint: `开始于 ${fmtDate(record.startedAt)}` },
      { label: '停光时藻类指数', name: 'endAlgaeIndex', type: 'number', required: true, hint: '作为后续复测回落判定的基准' }
    ],
    onSubmit: async (payload) => {
      await api(`/api/lightings/${record.id}/end`, {
        method: 'POST',
        body: JSON.stringify({
          endedAt: payload.endedAt ? new Date(payload.endedAt).toISOString() : undefined,
          endAlgaeIndex: Number(payload.endAlgaeIndex)
        })
      });
      toast('已结束照明');
    }
  });
}

function openRecheckModal(record) {
  const site = siteById(record.siteId);
  openModal({
    title: `登记复测 · ${siteLabel(site)}`,
    submitLabel: '保存复测',
    fields: [
      { label: '复测操作员', name: 'operator', required: true, hint: `复光须换人：不能是原照明操作员 ${record.operator}` },
      { label: '复测藻类指数', name: 'algaeIndex', type: 'number', required: true, hint: `停光时指数 ${record.endAlgaeIndex}，需连续两次回落` },
      { label: '复测时间', name: 'measuredAt', type: 'datetime-local', value: toLocalInput(new Date()), hint: `与上次回落复测间隔须 ≥${state.config.limits.RECHECK_INTERVAL_HOURS} 小时` }
    ],
    onSubmit: async (payload) => {
      const result = await api(`/api/lightings/${record.id}/rechecks`, {
        method: 'POST',
        body: JSON.stringify({
          operator: payload.operator,
          algaeIndex: Number(payload.algaeIndex),
          measuredAt: payload.measuredAt ? new Date(payload.measuredAt).toISOString() : undefined
        })
      });
      toast(result.released ? '复测已登记，样点复光放行' : '复测已登记');
    }
  });
}

function openCorrectModal(record) {
  const fields = [
    { label: '照度 (lux)', name: 'lux', type: 'number', value: record.lux },
    { label: '操作员', name: 'operator', value: record.operator },
    { label: '开始时间', name: 'startedAt', type: 'datetime-local', value: toLocalInput(record.startedAt) }
  ];
  if (record.endedAt) {
    fields.push({ label: '结束时间', name: 'endedAt', type: 'datetime-local', value: toLocalInput(record.endedAt) });
    fields.push({ label: '停光时藻类指数', name: 'endAlgaeIndex', type: 'number', value: record.endAlgaeIndex });
  }
  fields.push({ label: '更正说明', name: 'note', hint: '更正后旧复测结论失效，状态重算' });
  openModal({
    title: '更正照明记录',
    submitLabel: '更正并重算',
    fields,
    onSubmit: async (payload) => {
      const body = { note: payload.note };
      if (payload.lux !== '') body.lux = Number(payload.lux);
      if (payload.operator) body.operator = payload.operator;
      if (payload.startedAt) body.startedAt = new Date(payload.startedAt).toISOString();
      if (payload.endedAt) body.endedAt = new Date(payload.endedAt).toISOString();
      if (payload.endAlgaeIndex !== undefined && payload.endAlgaeIndex !== '') body.endAlgaeIndex = Number(payload.endAlgaeIndex);
      const result = await api(`/api/lightings/${record.id}/correct`, { method: 'POST', body: JSON.stringify(body) });
      toast(result.invalidated ? `已更正重算，${result.invalidated} 条复测结论失效` : '已更正重算');
    }
  });
}

// ---------- 渲染与事件 ----------

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#tabs').innerHTML = state.config.tabs.map((tab) =>
    `<button class="tab${tab.id === state.activeTab ? ' active' : ''}" data-tab="${tab.id}">${escapeHtml(tab.label)}</button>`).join('');
  $('#main').innerHTML = dashboardView() + sitesView() + lightingsView() + rechecksView();
  setTab(state.activeTab);
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

async function load() {
  state.db = await api('/api/db');
  render();
}

document.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) setTab(tab.dataset.tab);
  const actBtn = event.target.closest('[data-act]');
  if (actBtn) {
    const record = lightingById(actBtn.dataset.id);
    if (!record) return;
    if (actBtn.dataset.act === 'end') openEndModal(record);
    if (actBtn.dataset.act === 'recheck') openRecheckModal(record);
    if (actBtn.dataset.act === 'correct') openCorrectModal(record);
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'search-sites') $('#list-sites').innerHTML = renderSiteList();
  if (event.target.id === 'search-lightings' || event.target.id === 'status-lightings') {
    $('#list-lightings').innerHTML = renderLightingList();
  }
  if (event.target.id === 'search-rechecks' || event.target.id === 'status-rechecks') {
    $('#list-rechecks').innerHTML = renderRecheckList();
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    if (form.dataset.form === 'site') {
      await api('/api/sites', { method: 'POST', body: JSON.stringify(payload) });
      toast('已保存样点');
    }
    if (form.dataset.form === 'lighting') {
      const body = {
        siteId: payload.siteId,
        operator: payload.operator,
        lux: Number(payload.lux)
      };
      if (payload.startedAt) body.startedAt = new Date(payload.startedAt).toISOString();
      const result = await api('/api/lightings', { method: 'POST', body: JSON.stringify(body) });
      toast(result.reused ? '该样点已有未结束照明，沿用首次记录' : '已开灯');
    }
    form.reset();
    await load();
  } catch (error) {
    toast(error.message);
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  state.activeTab = state.config.tabs[0].id;
  await load();
}

boot().catch((error) => toast(error.message));
