// 业务规则：洞穴照明累积暴露与藻类停光复核
// 纯函数模块，不依赖存储与 HTTP，所有派生状态（记录状态、样点状态、累计值）
// 都由本模块根据既有事实重算，保证列表、统计与履历在刷新后一致。

const LIMITS = {
  luxHours: 1800, // 累计照度时长上限（勒克斯·小时）
  continuousHours: 10, // 连续照明上限（小时）
  recheckIntervalHours: 12 // 两次复测最小间隔（小时）
};

const SITE_STATUS = {
  IDLE: '可照明',
  LIGHTING: '照明中',
  LOCKED: '停光待复核'
};

const HOUR_MS = 3600000;

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function toTime(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function makeId(prefix, now) {
  return `${prefix}-${now}-${Math.random().toString(16).slice(2, 7)}`;
}

function pushHistory(item, action, note, now) {
  item.history = item.history || [];
  item.history.unshift({ at: new Date(now).toISOString(), action, note: note || '' });
}

function touch(item, now) {
  item.updatedAt = new Date(now).toISOString();
}

// 单条记录照明时长：已结束用登记时长；未结束取登记时长与已流逝时长的较大值
function hoursOf(record, now) {
  const stored = Number(record.hours) || 0;
  if (record.endedAt) return stored;
  const start = toTime(record.startedAt || record.createdAt);
  if (start === null) return stored;
  const elapsed = (now - start) / HOUR_MS;
  return round2(Math.max(stored, elapsed, 0));
}

function luxHoursOf(record, now) {
  return round2((Number(record.lux) || 0) * hoursOf(record, now));
}

function sortByStart(a, b) {
  return (toTime(a.startedAt || a.createdAt) || 0) - (toTime(b.startedAt || b.createdAt) || 0);
}

function findSite(db, siteId) {
  return (db.sites || []).find((site) => site.id === siteId);
}

function findExposure(db, id) {
  return (db.exposures || []).find((record) => record.id === id);
}

// 重算单个样点：按暴露周期累计照度时长，推导每条记录状态与样点状态。
// 仅在状态真实变化时写履历，重复执行（刷新）结果保持一致。
function recalcSite(db, site, now) {
  let changed = false;
  const records = (db.exposures || []).filter((record) => record.siteId === site.id).sort(sortByStart);
  const cycles = [...new Set([...records.map((record) => record.cycle || 1), site.currentCycle || 1])].sort((a, b) => a - b);
  let locked = false;
  let lighting = false;
  let currentCumulative = 0;

  for (const cycle of cycles) {
    let cumulative = 0;
    for (const record of records.filter((entry) => (entry.cycle || 1) === cycle)) {
      const hours = hoursOf(record, now);
      const luxHours = luxHoursOf(record, now);
      cumulative = round2(cumulative + luxHours);

      if (record.endedAt && record.luxHours !== luxHours) {
        record.luxHours = luxHours;
        changed = true;
      }
      if (record.cumulativeLuxHours !== cumulative) {
        record.cumulativeLuxHours = cumulative;
        changed = true;
      }

      let status;
      let reason = '';
      if (record.reviewVerdict === '已复光') {
        status = '已复光';
      } else if ((record.rechecks || []).length > 0) {
        status = '复测中';
      } else if (cumulative > LIMITS.luxHours) {
        status = '待复核';
        reason = `累计照度时长 ${cumulative} 勒克斯小时，超过 ${LIMITS.luxHours}`;
      } else if (hours > LIMITS.continuousHours) {
        status = '待复核';
        reason = `连续照明 ${hours} 小时，超过 ${LIMITS.continuousHours} 小时`;
      } else if (record.endedAt) {
        status = '已结束';
      } else {
        status = '照明中';
      }

      if (record.status !== status) {
        if (status === '待复核') pushHistory(record, '超限转待复核', reason, now);
        if (record.status === '待复核' && status === '已结束') pushHistory(record, '复核解除', '更正后未超限', now);
        record.status = status;
        changed = true;
      }

      if (status === '待复核' || status === '复测中') locked = true;
      if (!record.endedAt && (status === '照明中' || status === '待复核')) lighting = true;
      if (cycle === (site.currentCycle || 1)) currentCumulative = cumulative;
    }
  }

  const nextStatus = locked ? SITE_STATUS.LOCKED : lighting ? SITE_STATUS.LIGHTING : SITE_STATUS.IDLE;
  if (site.lightStatus !== nextStatus) {
    site.lightStatus = nextStatus;
    changed = true;
  }
  if (site.cumulativeLuxHours !== currentCumulative) {
    site.cumulativeLuxHours = currentCumulative;
    changed = true;
  }
  return changed;
}

function recalcDb(db, now = Date.now()) {
  let changed = false;
  for (const site of db.sites || []) {
    if (recalcSite(db, site, now)) changed = true;
  }
  return changed;
}

function createSite(db, input, now = Date.now()) {
  for (const field of ['cave', 'zone', 'pointCode', 'route']) {
    if (!input[field]) return { error: '请完整填写洞穴、分区、样点编号与巡测路线' };
  }
  const site = {
    id: makeId('sites', now),
    cave: input.cave,
    zone: input.zone,
    pointCode: input.pointCode,
    route: input.route,
    sensitivity: input.sensitivity || '中',
    note: input.note || '',
    lightStatus: SITE_STATUS.IDLE,
    cumulativeLuxHours: 0,
    currentCycle: 1,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    history: []
  };
  pushHistory(site, '创建', input.note || '样点建档', now);
  db.sites.push(site);
  return { created: true, item: site };
}

// 开启照明：每样点同时只允许一条未结束记录，重复或并发开启沿用首次记录
function openExposure(db, input, now = Date.now()) {
  const site = findSite(db, input.siteId);
  if (!site) return { error: '样点不存在' };
  const operator = (input.operator || '').trim();
  if (!operator) return { error: '请填写操作员' };
  const lux = Number(input.lux);
  if (!Number.isFinite(lux) || lux < 0) return { error: '请填写有效照度' };

  recalcSite(db, site, now);
  if (site.lightStatus === SITE_STATUS.LOCKED) {
    return { error: '停光复核期间禁止开启新照明' };
  }
  const existing = (db.exposures || [])
    .filter((record) => record.siteId === site.id && !record.endedAt && (record.cycle || 1) === (site.currentCycle || 1))
    .sort(sortByStart)[0];
  if (existing) return { reused: true, item: existing };

  const record = {
    id: makeId('exposures', now),
    siteId: site.id,
    cycle: site.currentCycle || 1,
    operator,
    lux,
    hours: 0,
    luxHours: 0,
    cumulativeLuxHours: site.cumulativeLuxHours || 0,
    startedAt: input.startedAt && toTime(input.startedAt) !== null ? new Date(input.startedAt).toISOString() : new Date(now).toISOString(),
    endedAt: null,
    status: '照明中',
    rechecks: [],
    reviewVerdict: null,
    note: input.note || '',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    history: []
  };
  pushHistory(record, '开启照明', `${operator} 开启，照度 ${lux} 勒克斯`, now);
  db.exposures.push(record);
  recalcSite(db, site, now);
  return { created: true, item: record };
}

// 结束照明：登记时长（可顺带更正视照度），随后重算是否超限
function endExposure(db, id, input, now = Date.now()) {
  const record = findExposure(db, id);
  if (!record) return { error: '记录不存在' };
  if (record.endedAt) return { error: '该记录照明已结束' };
  const hours = Number(input.hours);
  if (!Number.isFinite(hours) || hours < 0) return { error: '请填写有效照明时长' };
  if (input.lux !== undefined && input.lux !== null && input.lux !== '') {
    const lux = Number(input.lux);
    if (!Number.isFinite(lux) || lux < 0) return { error: '请填写有效照度' };
    record.lux = lux;
  }
  record.hours = round2(hours);
  record.endedAt = new Date(now).toISOString();
  pushHistory(record, '结束照明', `时长 ${record.hours} 小时 · 照度 ${record.lux} 勒克斯`, now);
  touch(record, now);
  const site = findSite(db, record.siteId);
  if (site) recalcSite(db, site, now);
  return { item: record };
}

// 登记复测：须停光（已结束）、换人操作；第二次须与首次间隔十二小时且数值回落
function addRecheck(db, id, input, now = Date.now()) {
  const record = findExposure(db, id);
  if (!record) return { error: '记录不存在' };
  const site = findSite(db, record.siteId);
  if (site) recalcSite(db, site, now);
  if (record.status !== '待复核' && record.status !== '复测中') {
    return { error: '当前状态无需复测' };
  }
  if (!record.endedAt) return { error: '请先结束照明，停光后再复测' };
  const operator = (input.operator || '').trim();
  if (!operator) return { error: '请填写复测人' };
  if (operator === record.operator) return { error: '复测须换人操作（不得为原照明操作员）' };
  const value = Number(input.value);
  if (!Number.isFinite(value)) return { error: '请填写有效复测值' };
  const at = input.at ? toTime(input.at) : now;
  if (at === null) return { error: '复测时间无效' };

  record.rechecks = record.rechecks || [];
  if (record.rechecks.length >= 2) return { error: '已有两次有效复测，请确认复光' };
  if (record.rechecks.length === 1) {
    const first = record.rechecks[0];
    const gap = (at - toTime(first.at)) / HOUR_MS;
    if (gap < LIMITS.recheckIntervalHours) {
      return { error: `两次复测间隔须不少于 ${LIMITS.recheckIntervalHours} 小时` };
    }
    if (!(value < first.value)) {
      return { error: '复测值未回落，须继续停光观察' };
    }
  }
  record.rechecks.push({ operator, value, at: new Date(at).toISOString() });
  pushHistory(record, record.rechecks.length === 1 ? '首次复测' : '二次复测回落', `${operator} 复测值 ${value}`, now);
  touch(record, now);
  if (site) recalcSite(db, site, now);
  return { item: record };
}

// 确认复光：复核通过后进入新一轮暴露周期，累计照度时长重新起算
function resumeLighting(db, id, input, now = Date.now()) {
  const record = findExposure(db, id);
  if (!record) return { error: '记录不存在' };
  const site = findSite(db, record.siteId);
  if (site) recalcSite(db, site, now);
  const rechecks = record.rechecks || [];
  if (record.status !== '复测中' || rechecks.length < 2) {
    return { error: `须由他人连续两次复测回落（间隔不少于 ${LIMITS.recheckIntervalHours} 小时）方可复光` };
  }
  const [first, second] = rechecks;
  const valid = second.value < first.value
    && (toTime(second.at) - toTime(first.at)) / HOUR_MS >= LIMITS.recheckIntervalHours
    && first.operator !== record.operator
    && second.operator !== record.operator;
  if (!valid) return { error: '复测结论无效，请重新复测' };

  record.reviewVerdict = '已复光';
  pushHistory(record, '确认复光', `${(input.operator || '').trim() || second.operator} 确认：两次复测回落，恢复照明并重新累计`, now);
  touch(record, now);
  if (site) {
    site.currentCycle = (site.currentCycle || 1) + 1;
    pushHistory(site, '复光', `照明记录复核通过，累计照度时长进入第 ${site.currentCycle} 轮`, now);
    touch(site, now);
    recalcSite(db, site, now);
  }
  return { item: record };
}

const CORRECTABLE = ['operator', 'lux', 'hours', 'startedAt', 'endedAt', 'note'];
const FIELD_LABELS = { operator: '操作员', lux: '照度', hours: '时长', startedAt: '开始时间', endedAt: '结束时间', note: '备注' };

// 更正原记录：已有复测或复光结论的一律作废，随后按更正后的事实重算
function correctExposure(db, id, input, now = Date.now()) {
  const record = findExposure(db, id);
  if (!record) return { error: '记录不存在' };
  const changedFields = [];
  for (const field of CORRECTABLE) {
    if (!(field in input)) continue;
    let value = input[field];
    if (field === 'lux' || field === 'hours') {
      value = value === '' || value === null ? 0 : Number(value);
      if (!Number.isFinite(value) || value < 0) return { error: '更正数值无效' };
      value = field === 'hours' ? round2(value) : value;
    }
    if (field === 'startedAt' || field === 'endedAt') {
      if (value === '' || value === null) {
        value = null;
      } else {
        const time = toTime(value);
        if (time === null) return { error: '更正时间无效' };
        value = new Date(time).toISOString();
      }
    }
    if ((record[field] ?? null) !== (value ?? null)) {
      record[field] = value;
      changedFields.push(field);
    }
  }
  if (!changedFields.length && !input.correctionNote) return { error: '没有需要更正的内容' };

  if ((record.rechecks || []).length > 0 || record.reviewVerdict) {
    record.rechecks = [];
    record.reviewVerdict = null;
    pushHistory(record, '旧复核结论失效', '原记录被更正，复测与复光结论作废，重新计算', now);
  }
  const fields = changedFields.map((field) => FIELD_LABELS[field] || field).join('、') || '无';
  pushHistory(record, '更正记录', `更正字段：${fields}${input.correctionNote ? `；${input.correctionNote}` : ''}`, now);
  touch(record, now);
  const site = findSite(db, record.siteId);
  if (site) recalcSite(db, site, now);
  return { item: record };
}

module.exports = {
  LIMITS,
  SITE_STATUS,
  hoursOf,
  luxHoursOf,
  recalcSite,
  recalcDb,
  createSite,
  openExposure,
  endExposure,
  addRecheck,
  resumeLighting,
  correctExposure
};
