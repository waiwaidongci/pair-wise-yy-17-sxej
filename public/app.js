const state = {
  config: null,
  db: {},
  activeTab: ''
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

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function toLocalInput(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 未结束记录的实时时长/照度时长，与 rules.js 的口径一致
function liveHours(item) {
  const stored = Number(item.hours) || 0;
  if (item.endedAt) return stored;
  const start = new Date(item.startedAt || item.createdAt).getTime();
  if (!Number.isFinite(start)) return stored;
  return Math.max(stored, (Date.now() - start) / 3600000);
}

function liveLuxHours(item) {
  if (item.endedAt) return Number(item.luxHours) || 0;
  return (Number(item.lux) || 0) * liveHours(item);
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

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  if (field.type === 'datetime-local') {
    const value = field.defaultNow ? `value="${toLocalInput()}"` : '';
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="datetime-local" name="${field.name}" ${value} ${required}></label>`;
  }
  const step = field.type === 'number' ? 'step="any"' : '';
  const value = field.default ? `value="${escapeHtml(field.default)}"` : '';
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${step} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 6).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function rechecksHtml(item) {
  const rechecks = item.rechecks || [];
  if (!rechecks.length) return '';
  return `<div class="rechecks"><strong>复测记录（藻类覆盖率）</strong>${rechecks.map((entry, index) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>第${index + 1}次 · ${escapeHtml(entry.operator)} · ${escapeHtml(String(entry.value))}%</span></div>
  `).join('')}</div>`;
}

function detailValue(item, field) {
  const raw = item[field.name];
  let value;
  if (field.type === 'datetime') value = raw ? fmtDate(raw) : '-';
  else if (field.type === 'liveHours') value = String(round2(liveHours(item)));
  else if (field.type === 'liveLuxHours') value = String(round2(liveLuxHours(item)));
  else if (field.type === 'relation') value = relationLabel(field, raw);
  else if (raw === null || raw === undefined || raw === '') value = '-';
  else value = String(raw);
  if (value !== '-' && (field.prefix || field.suffix)) return `${field.prefix || ''}${value}${field.suffix || ''}`;
  return value;
}

// 动作可见条件：values 枚举 / empty 为空 / filled 非空 / minLength / maxLength
function matchWhen(item, when = []) {
  return when.every((cond) => {
    const value = item[cond.field];
    if (cond.values) return cond.values.includes(value);
    if (cond.empty) return value === null || value === undefined || value === '';
    if (cond.filled) return !(value === null || value === undefined || value === '');
    if (cond.minLength !== undefined) return (value || []).length >= cond.minLength;
    if (cond.maxLength !== undefined) return (value || []).length <= cond.maxLength;
    return true;
  });
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(detailValue(item, field))}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const actions = state.config.actions
    .filter((action) => action.collection === collection && matchWhen(item, action.when))
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${rechecksHtml(item)}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter
      ? items.filter((item) => (stat.filter.values || [stat.filter.value]).includes(item[stat.filter.field])).length
      : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无待复核事项</div>'}</div></div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        ${view.hint ? `<p class="hint">${escapeHtml(view.hint)}</p>` : ''}
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => view.type === 'dashboard' ? renderDashboardView(view) : renderCrudView(view)).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

// ---- 动作弹窗 ----
const modalState = { action: null, item: null };

function modalFieldHtml(field, item) {
  const required = field.required ? 'required' : '';
  let value = field.prefill ? item[field.prefill] ?? '' : '';
  if (field.type === 'datetime-local') value = value ? toLocalInput(value) : (field.defaultNow ? toLocalInput() : '');
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}>${escapeHtml(String(value))}</textarea></label>`;
  }
  const step = field.type === 'number' ? `step="${field.step || 'any'}"` : '';
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" value="${escapeHtml(String(value))}" ${step} ${required}></label>`;
}

function openModal(action, item) {
  modalState.action = action;
  modalState.item = item;
  $('#modalTitle').textContent = action.label;
  $('#modalFields').innerHTML = action.inputs.map((field) => modalFieldHtml(field, item)).join('');
  $('#modal').hidden = false;
}

function closeModal() {
  $('#modal').hidden = true;
  modalState.action = null;
  modalState.item = null;
}

$('#modalForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const { action, item } = modalState;
  if (!action || !item) return;
  const data = new FormData(event.target);
  const payload = {};
  for (const field of action.inputs) {
    let value = data.get(field.name);
    if (field.type === 'number') value = value === '' || value === null ? '' : Number(value);
    if (field.type === 'datetime-local') value = value ? new Date(value).toISOString() : '';
    payload[field.name] = value;
  }
  try {
    await api(action.path.replace(':id', item.id), {
      method: action.type === 'edit' ? 'PATCH' : 'POST',
      body: JSON.stringify(payload)
    });
    closeModal();
    await load();
    toast('已更新');
  } catch (error) {
    toast(error.message);
  }
});

$('#modalCancel').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (event) => {
  if (event.target.id === 'modal') closeModal();
});

// ---- 全局事件 ----
document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const button = event.target.closest('[data-action]');
  if (tab) setTab(tab.dataset.tab);
  if (button) {
    const action = state.config.actions.find((entry) => entry.id === button.dataset.action);
    const item = (state.db[action?.collection] || []).find((entry) => entry.id === button.dataset.id);
    if (!action || !item) return;
    if (action.inputs?.length) {
      openModal(action, item);
      return;
    }
    try {
      await api(action.path.replace(':id', item.id), { method: action.type === 'edit' ? 'PATCH' : 'POST', body: '{}' });
      await load();
      toast('已更新');
    } catch (error) {
      toast(error.message);
    }
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

function formValues(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
    if (field.type === 'datetime-local') payload[field.name] = payload[field.name] ? new Date(payload[field.name]).toISOString() : '';
  }
  return { ...view.defaults, ...payload };
}

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  try {
    const res = await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(formValues(form, view)) });
    form.reset();
    await load();
    toast(res?.reused ? '该样点已有未结束照明，沿用首次记录' : '已保存');
  } catch (error) {
    toast(error.message);
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
