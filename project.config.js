/**
 * 展示配置：标题、色调、统计口径、页签与表单字段。
 * 业务限值不在此处，由 rules.js 的 LIMITS 经 /api/config 下发。
 */
module.exports = {
  port: 3912,
  title: '洞穴照明累积暴露与藻类停光复核台',
  lede: '按样点管控照明开停：每样点同时只允许一条未结束照明；累计照度时长超限或连续照明超限即停光待复核，期间禁止开新照明；复光须换人连续两次复测回落、间隔十二小时；原记录更正后旧结论失效重算。',
  tones: {
    '可照明': 'ok',
    '照明中': 'warn',
    '停光待复核': 'bad',
    '已结束': '',
    '待复核': 'bad',
    '已复光': 'ok',
    '有效': 'ok',
    '已失效': 'bad',
    '回落': 'ok',
    '未回落': 'warn'
  },
  tabs: [
    { id: 'dashboard', label: '复核看板' },
    { id: 'sites', label: '样点档案' },
    { id: 'lightings', label: '照明记录' },
    { id: 'rechecks', label: '复测履历' }
  ],
  stats: [
    { label: '监测样点', type: 'count', collection: 'sites' },
    { label: '照明中', type: 'count', collection: 'lightings', filter: { field: 'status', value: '照明中' } },
    { label: '停光待复核', type: 'count', collection: 'lightings', filter: { field: 'status', value: '待复核' } },
    { label: '本周期累计暴露(勒克斯时)', type: 'sum', collection: 'sites', field: 'cycleExposureLuxHours' }
  ],
  siteFields: [
    { label: '洞穴', name: 'cave', required: true },
    { label: '分区', name: 'zone', required: true },
    { label: '样点编号', name: 'pointCode', required: true },
    { label: '巡测路线', name: 'route', required: true },
    { label: '敏感等级', name: 'sensitivity', type: 'select', options: ['低', '中', '高'] },
    { label: '备注', name: 'note', type: 'textarea', wide: true }
  ],
  lightingStatuses: ['照明中', '已结束', '待复核', '已复光'],
  recheckStatuses: ['有效', '已失效']
};
