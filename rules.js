/**
 * 规则层：照明累积暴露与藻类停光复核
 * 全部为纯函数与针对 db 对象的变更操作，不做任何 IO。
 * 限值常量仅此一处，页面经 /api/config 读取展示。
 */
const LIMITS = {
  EXPOSURE_LUX_HOURS: 1800, // 累计照度时长限值（勒克斯小时）
  CONTINUOUS_HOURS: 10, // 单次连续照明限值（小时）
  RECHECK_REQUIRED: 2, // 复光所需连续回落复测次数
  RECHECK_INTERVAL_HOURS: 12 // 相邻两次回落复测的最小间隔（小时）
};

const HOUR_MS = 3600 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function stamp(action, note) {
  return { at: nowIso(), action, note: note || '' };
}

function pushHistory(item, action, note) {
  item.history = item.history || [];
  item.history.unshift(stamp(action, note));
  item.updatedAt = nowIso();
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function hoursBetween(from, to) {
  return (new Date(to).getTime() - new Date(from).getTime()) / HOUR_MS;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function fmtMoment(value) {
  return new Date(value).toISOString().slice(0, 16).replace('T', ' ');
}

// ---------- 派生计算 ----------

function recordDurationHours(record, at) {
  const end = record.endedAt ? new Date(record.endedAt) : at || new Date();
  return Math.max(0, round2(hoursBetween(record.startedAt, end)));
}

function recordExposure(record, at) {
  return round2(Number(record.lux) * recordDurationHours(record, at));
}

// 某时刻之前最近一次复光放行，界定了"本周期"的起点
function cycleStartFor(db, siteId, at) {
  const releases = db.lightings
    .filter((r) => r.siteId === siteId && r.status === '已复光' && r.releasedAt && new Date(r.releasedAt) <= new Date(at))
    .sort((a, b) => new Date(b.releasedAt) - new Date(a.releasedAt));
  return releases.length ? new Date(releases[0].releasedAt).getTime() : 0;
}

// 判定用：该记录结束时刻，本周期内（含自身）的累计照度时长
function cumulativeAt(db, record) {
  const start = cycleStartFor(db, record.siteId, record.startedAt);
  const mine = new Date(record.startedAt).getTime();
  return round2(
    db.lightings
      .filter((r) => r.siteId === record.siteId)
      .filter((r) => new Date(r.startedAt).getTime() > start && new Date(r.startedAt).getTime() <= mine)
      .reduce((sum, r) => sum + recordExposure(r), 0)
  );
}

// 展示用：当前周期的实时累计暴露（进行中的记录按当前时间计）
function cycleExposure(db, siteId, at) {
  const start = cycleStartFor(db, siteId, at || new Date());
  return round2(
    db.lightings
      .filter((r) => r.siteId === siteId && new Date(r.startedAt).getTime() > start)
      .reduce((sum, r) => sum + recordExposure(r, at), 0)
  );
}

function openLightingFor(db, siteId) {
  return db.lightings.find((r) => r.siteId === siteId && r.status === '照明中') || null;
}

function pendingReviewFor(db, siteId) {
  return db.lightings.filter((r) => r.siteId === siteId && r.status === '待复核');
}

function siteStatus(db, siteId) {
  if (pendingReviewFor(db, siteId).length) return '停光待复核';
  if (openLightingFor(db, siteId)) return '照明中';
  return '可照明';
}

// 超限判定：累计照度时长超限 或 单次连续照明超限
function evaluateTrip(db, record) {
  const reasons = [];
  const duration = recordDurationHours(record);
  if (duration > LIMITS.CONTINUOUS_HOURS) {
    reasons.push(`连续照明 ${duration} 小时超过 ${LIMITS.CONTINUOUS_HOURS} 小时限值`);
  }
  const cumulative = cumulativeAt(db, record);
  if (cumulative > LIMITS.EXPOSURE_LUX_HOURS) {
    reasons.push(`累计照度时长 ${cumulative} 勒克斯时超过 ${LIMITS.EXPOSURE_LUX_HOURS} 限值`);
  }
  return { tripped: reasons.length > 0, reasons };
}

function validRechecks(db, lightingId) {
  return db.rechecks
    .filter((r) => r.lightingId === lightingId && !r.invalidated)
    .sort((a, b) => new Date(a.measuredAt) - new Date(b.measuredAt));
}

// 复测链：以停光时藻类指数为基准，逐次判定是否回落
function chainWithFlags(record, rechecks) {
  let prev = Number(record.endAlgaeIndex);
  return rechecks.map((rc) => {
    const decline = Number(rc.algaeIndex) < prev;
    prev = Number(rc.algaeIndex);
    return { rc, decline };
  });
}

function declineRun(chain) {
  let run = 0;
  for (let i = chain.length - 1; i >= 0 && chain[i].decline; i -= 1) run += 1;
  return run;
}

// 复光判定：连续两次复测回落，且相邻两次间隔达到十二小时
function evaluateRelease(record, rechecks) {
  const chain = chainWithFlags(record, rechecks);
  const run = declineRun(chain);
  if (run < LIMITS.RECHECK_REQUIRED) return { released: false, run };
  const tail = chain.slice(-run);
  const last = tail[tail.length - 1].rc;
  const prev = tail[tail.length - 2].rc;
  const gap = round2(hoursBetween(prev.measuredAt, last.measuredAt));
  if (gap < LIMITS.RECHECK_INTERVAL_HOURS) {
    return {
      released: false,
      run,
      gap,
      reason: `相邻两次回落复测间隔 ${gap} 小时，不足 ${LIMITS.RECHECK_INTERVAL_HOURS} 小时`
    };
  }
  return { released: true, run, gap };
}

function reviewProgress(db, record) {
  const rechecks = validRechecks(db, record.id);
  const chain = chainWithFlags(record, rechecks);
  const run = declineRun(chain);
  const last = rechecks[rechecks.length - 1] || null;
  const verdict = evaluateRelease(record, rechecks);
  let hint;
  if (run >= LIMITS.RECHECK_REQUIRED && !verdict.released) {
    hint = `回落次数已满足，但相邻间隔 ${verdict.gap} 小时不足 ${LIMITS.RECHECK_INTERVAL_HOURS} 小时，需再次复测`;
  } else if (run > 0) {
    hint = `已换人连续回落 ${run}/${LIMITS.RECHECK_REQUIRED} 次，还需 ${LIMITS.RECHECK_REQUIRED - run} 次且与上次间隔 ≥${LIMITS.RECHECK_INTERVAL_HOURS} 小时`;
  } else {
    hint = `需换人连续 ${LIMITS.RECHECK_REQUIRED} 次复测回落，两次间隔 ≥${LIMITS.RECHECK_INTERVAL_HOURS} 小时`;
  }
  return {
    total: rechecks.length,
    declineRun: run,
    required: LIMITS.RECHECK_REQUIRED,
    intervalHours: LIMITS.RECHECK_INTERVAL_HOURS,
    lastMeasuredAt: last ? last.measuredAt : null,
    hint
  };
}

// ---------- 变更操作（在存储层串行锁内执行） ----------

function createSite(db, input) {
  for (const key of ['cave', 'zone', 'pointCode', 'route']) {
    if (!String(input[key] || '').trim()) return { error: '洞穴、分区、样点编号、巡测路线均为必填' };
  }
  const dup = db.sites.find((s) => s.cave === input.cave.trim() && s.zone === input.zone.trim() && s.pointCode === input.pointCode.trim());
  if (dup) return { error: '相同洞穴分区下的样点编号已存在' };
  const site = {
    id: newId('site'),
    cave: input.cave.trim(),
    zone: input.zone.trim(),
    pointCode: input.pointCode.trim(),
    route: input.route.trim(),
    sensitivity: input.sensitivity || '中',
    note: input.note || '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    history: [stamp('创建', '样点建档')]
  };
  db.sites.push(site);
  return { item: site };
}

function openLighting(db, input) {
  const site = db.sites.find((s) => s.id === input.siteId);
  if (!site) return { error: '样点不存在', status: 404 };
  const operator = String(input.operator || '').trim();
  if (!operator) return { error: '需填写操作员' };
  const lux = Number(input.lux);
  if (!Number.isFinite(lux) || lux <= 0) return { error: '照度需为大于 0 的数值' };
  const startedAt = input.startedAt ? new Date(input.startedAt) : new Date();
  if (Number.isNaN(startedAt.getTime())) return { error: '开始时间无效' };
  // 停光复核期间禁止开新照明
  if (pendingReviewFor(db, site.id).length) {
    return { error: '该样点停光复核期间禁止开新照明' };
  }
  // 每样点同时只允许一条未结束照明记录，重复或并发沿用首次记录
  const existing = openLightingFor(db, site.id);
  if (existing) return { item: existing, reused: true };
  const record = {
    id: newId('lighting'),
    siteId: site.id,
    operator,
    lux,
    startedAt: startedAt.toISOString(),
    endedAt: null,
    endAlgaeIndex: null,
    status: '照明中',
    reviewReasons: [],
    releasedAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    history: [stamp('开灯', `${operator} 开灯，照度 ${lux} lux`)]
  };
  db.lightings.push(record);
  return { item: record };
}

function endLighting(db, id, input) {
  const record = db.lightings.find((r) => r.id === id);
  if (!record) return { error: '照明记录不存在', status: 404 };
  if (record.status !== '照明中') return { error: '仅照明中的记录可以结束' };
  const endedAt = input.endedAt ? new Date(input.endedAt) : new Date();
  if (Number.isNaN(endedAt.getTime())) return { error: '结束时间无效' };
  if (endedAt <= new Date(record.startedAt)) return { error: '结束时间必须晚于开始时间' };
  const algae = Number(input.endAlgaeIndex);
  if (!Number.isFinite(algae) || algae < 0) return { error: '需登记停光时藻类指数（不小于 0）' };
  record.endedAt = endedAt.toISOString();
  record.endAlgaeIndex = algae;
  const duration = recordDurationHours(record);
  const exposure = recordExposure(record);
  const trip = evaluateTrip(db, record);
  if (trip.tripped) {
    record.status = '待复核';
    record.reviewReasons = trip.reasons;
    pushHistory(record, '停光转待复核', `时长 ${duration} 小时、暴露 ${exposure} 勒克斯时；${trip.reasons.join('；')}`);
  } else {
    record.status = '已结束';
    pushHistory(record, '结束照明', `时长 ${duration} 小时、暴露 ${exposure} 勒克斯时，停光藻类指数 ${algae}`);
  }
  return { item: record };
}

function addRecheck(db, lightingId, input) {
  const record = db.lightings.find((r) => r.id === lightingId);
  if (!record) return { error: '照明记录不存在', status: 404 };
  if (record.status !== '待复核') return { error: '仅待复核记录可登记复测' };
  const operator = String(input.operator || '').trim();
  if (!operator) return { error: '需填写复测操作员' };
  // 复光须换人：复测操作员不能是原照明操作员
  if (operator === record.operator) return { error: '复光须换人复测：复测操作员不能是原照明操作员' };
  const algae = Number(input.algaeIndex);
  if (!Number.isFinite(algae) || algae < 0) return { error: '藻类指数需为不小于 0 的数值' };
  const measuredAt = input.measuredAt ? new Date(input.measuredAt) : new Date();
  if (Number.isNaN(measuredAt.getTime())) return { error: '复测时间无效' };
  const rc = {
    id: newId('recheck'),
    lightingId: record.id,
    siteId: record.siteId,
    operator,
    algaeIndex: algae,
    measuredAt: measuredAt.toISOString(),
    invalidated: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    history: [stamp('复测登记', `${operator} 复测藻类指数 ${algae}`)]
  };
  db.rechecks.push(rc);
  const chain = chainWithFlags(record, validRechecks(db, record.id));
  const flag = chain.find((entry) => entry.rc.id === rc.id);
  pushHistory(record, '复测登记', `${operator} 复测藻类指数 ${algae}，${flag && flag.decline ? '回落' : '未回落'}`);
  const verdict = evaluateRelease(record, validRechecks(db, record.id));
  if (verdict.released) {
    record.status = '已复光';
    record.releasedAt = nowIso();
    pushHistory(record, '复光放行', `换人连续 ${LIMITS.RECHECK_REQUIRED} 次复测回落，间隔 ${verdict.gap} 小时，样点恢复可照明`);
  }
  return { item: rc, record, released: verdict.released, verdict };
}

function correctLighting(db, id, input) {
  const record = db.lightings.find((r) => r.id === id);
  if (!record) return { error: '照明记录不存在', status: 404 };
  const next = {
    lux: record.lux,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    endAlgaeIndex: record.endAlgaeIndex,
    operator: record.operator
  };
  const changes = [];
  if (input.lux !== undefined && input.lux !== '' && Number(input.lux) !== Number(record.lux)) {
    if (!Number.isFinite(Number(input.lux)) || Number(input.lux) <= 0) return { error: '照度需为大于 0 的数值' };
    next.lux = Number(input.lux);
    changes.push(`照度 ${record.lux}→${next.lux} lux`);
  }
  if (input.operator && input.operator.trim() && input.operator.trim() !== record.operator) {
    next.operator = input.operator.trim();
    changes.push(`操作员 ${record.operator}→${next.operator}`);
  }
  if (input.startedAt) {
    const d = new Date(input.startedAt);
    if (Number.isNaN(d.getTime())) return { error: '开始时间无效' };
    if (d.getTime() !== new Date(record.startedAt).getTime()) {
      next.startedAt = d.toISOString();
      changes.push(`开始时间 ${fmtMoment(record.startedAt)}→${fmtMoment(next.startedAt)}`);
    }
  }
  if (record.endedAt) {
    if (input.endedAt) {
      const d = new Date(input.endedAt);
      if (Number.isNaN(d.getTime())) return { error: '结束时间无效' };
      if (d.getTime() !== new Date(record.endedAt).getTime()) {
        next.endedAt = d.toISOString();
        changes.push(`结束时间 ${fmtMoment(record.endedAt)}→${fmtMoment(next.endedAt)}`);
      }
    }
    if (input.endAlgaeIndex !== undefined && input.endAlgaeIndex !== '' && Number(input.endAlgaeIndex) !== Number(record.endAlgaeIndex)) {
      if (!Number.isFinite(Number(input.endAlgaeIndex)) || Number(input.endAlgaeIndex) < 0) return { error: '藻类指数需为不小于 0 的数值' };
      next.endAlgaeIndex = Number(input.endAlgaeIndex);
      changes.push(`停光藻类指数 ${record.endAlgaeIndex}→${next.endAlgaeIndex}`);
    }
  }
  if (!changes.length) return { error: '没有需要更正的字段' };
  if (next.endedAt && new Date(next.endedAt) <= new Date(next.startedAt)) return { error: '结束时间必须晚于开始时间' };
  Object.assign(record, next);
  // 原记录更正：旧复测结论全部失效
  const affected = validRechecks(db, record.id);
  for (const rc of affected) {
    rc.invalidated = true;
    pushHistory(rc, '结论失效', '原照明记录更正，复测结论作废，需重新复测');
  }
  // 重算结论
  record.releasedAt = null;
  if (!record.endedAt) {
    record.status = '照明中';
    record.reviewReasons = [];
  } else {
    const trip = evaluateTrip(db, record);
    record.status = trip.tripped ? '待复核' : '已结束';
    record.reviewReasons = trip.tripped ? trip.reasons : [];
  }
  const notes = [changes.join('，')];
  if (affected.length) notes.push(`${affected.length} 条复测结论失效`);
  notes.push(`重算状态：${record.status}`);
  if (input.note) notes.push(String(input.note).trim());
  pushHistory(record, '更正重算', notes.join('；'));
  return { item: record, invalidated: affected.length };
}

// ---------- 读取装饰：列表、统计、履历共用同一份派生结果 ----------

function decorate(db) {
  const at = new Date();
  const lightings = db.lightings.map((r) => ({
    ...r,
    durationHours: recordDurationHours(r, at),
    exposureLuxHours: recordExposure(r, at),
    overtime: !r.endedAt && recordDurationHours(r, at) > LIMITS.CONTINUOUS_HOURS,
    review: r.status === '待复核' ? reviewProgress(db, r) : null
  }));
  const sites = db.sites.map((s) => ({
    ...s,
    lightingStatus: siteStatus(db, s.id),
    cycleExposureLuxHours: cycleExposure(db, s.id, at)
  }));
  const flags = new Map();
  for (const record of db.lightings) {
    for (const entry of chainWithFlags(record, validRechecks(db, record.id))) {
      flags.set(entry.rc.id, entry.decline);
    }
  }
  const rechecks = db.rechecks.map((rc) => ({
    ...rc,
    status: rc.invalidated ? '已失效' : '有效',
    decline: rc.invalidated ? null : Boolean(flags.get(rc.id))
  }));
  const sortNewest = (a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
  return {
    sites: sites.sort(sortNewest),
    lightings: lightings.sort(sortNewest),
    rechecks: rechecks.sort(sortNewest)
  };
}

module.exports = {
  LIMITS,
  decorate,
  createSite,
  openLighting,
  endLighting,
  addRecheck,
  correctLighting
};
