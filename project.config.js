module.exports = {
  port: 3912,
  title: '洞穴照明累积暴露与藻类停光复核台',
  lede: '每样点同时只保留一条未结束照明记录，重复或并发开启沿用首次记录；累计照度时长超 1800 勒克斯小时或连续照明超 10 小时即停光待复核，期间禁止开新照明，须换人连续两次复测回落（间隔不少于 12 小时）方可复光。',
  tones: {
    '可照明': 'ok',
    '照明中': 'warn',
    '停光待复核': 'bad',
    '已结束': '',
    '待复核': 'bad',
    '复测中': 'warn',
    '已复光': 'ok'
  },
  collections: {
    sites: { label: '样点档案' },
    exposures: { label: '照明记录' }
  },
  stats: [
    { label: '样点', collection: 'sites' },
    { label: '照明中', collection: 'exposures', filter: { field: 'status', values: ['照明中'] } },
    { label: '停光待复核', collection: 'sites', filter: { field: 'lightStatus', values: ['停光待复核'] } },
    { label: '复核记录', collection: 'exposures', filter: { field: 'status', values: ['待复核', '复测中'] } }
  ],
  views: [
    {
      id: 'dashboard',
      label: '复核看板',
      type: 'dashboard',
      focusTitle: '停光待复核与复测中',
      focus: { collection: 'exposures', field: 'status', values: ['待复核', '复测中'], limit: 8 }
    },
    {
      id: 'sites',
      label: '样点档案',
      collection: 'sites',
      formTitle: '新增样点',
      listTitle: '样点列表',
      submitLabel: '保存样点',
      searchPlaceholder: '搜索洞穴、分区、样点、路线',
      searchFields: ['cave', 'zone', 'pointCode', 'route'],
      statusField: 'lightStatus',
      statusOptions: ['可照明', '照明中', '停光待复核'],
      titleFields: ['pointCode', 'zone'],
      summaryFields: ['note'],
      detailFields: [
        { label: '洞穴', name: 'cave' },
        { label: '巡测路线', name: 'route' },
        { label: '敏感等级', name: 'sensitivity' },
        { label: '累计照度时长', name: 'cumulativeLuxHours', suffix: ' lx·h' },
        { label: '暴露周期', name: 'currentCycle', prefix: '第 ', suffix: ' 轮' }
      ],
      fields: [
        { label: '洞穴', name: 'cave', required: true },
        { label: '分区', name: 'zone', required: true },
        { label: '样点编号', name: 'pointCode', required: true },
        { label: '巡测路线', name: 'route', required: true },
        { label: '敏感等级', name: 'sensitivity', type: 'select', options: ['低', '中', '高'] },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'exposures',
      label: '照明记录',
      collection: 'exposures',
      formTitle: '开启照明',
      listTitle: '照明记录列表',
      submitLabel: '开启照明',
      hint: '同一样点已有未结束照明时将沿用首次记录；停光待复核期间禁止开启新照明。',
      searchPlaceholder: '搜索操作员、备注',
      searchFields: ['operator', 'note'],
      statusField: 'status',
      statusOptions: ['照明中', '已结束', '待复核', '复测中', '已复光'],
      titleFields: ['operator'],
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['cave', 'zone', 'pointCode'] },
      summaryFields: ['note'],
      detailFields: [
        { label: '照度', name: 'lux', suffix: ' lx' },
        { label: '照明时长', name: 'hours', type: 'liveHours', suffix: ' h' },
        { label: '照度时长', name: 'luxHours', type: 'liveLuxHours', suffix: ' lx·h' },
        { label: '累计照度时长', name: 'cumulativeLuxHours', suffix: ' lx·h' },
        { label: '开始时间', name: 'startedAt', type: 'datetime' },
        { label: '结束时间', name: 'endedAt', type: 'datetime' }
      ],
      fields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode'], required: true, wide: true },
        { label: '操作员', name: 'operator', required: true },
        { label: '照度(勒克斯)', name: 'lux', type: 'number', required: true },
        { label: '开始时间', name: 'startedAt', type: 'datetime-local', defaultNow: true },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    }
  ],
  actions: [
    {
      id: 'exp-end',
      label: '结束照明',
      collection: 'exposures',
      path: '/api/exposures/:id/end',
      when: [{ field: 'endedAt', empty: true }, { field: 'status', values: ['照明中', '待复核'] }],
      inputs: [
        { label: '照明时长(小时)', name: 'hours', type: 'number', step: '0.1', required: true },
        { label: '照度(勒克斯)', name: 'lux', type: 'number', prefill: 'lux' }
      ]
    },
    {
      id: 'exp-recheck',
      label: '登记复测',
      collection: 'exposures',
      path: '/api/exposures/:id/recheck',
      when: [
        { field: 'endedAt', filled: true },
        { field: 'status', values: ['待复核', '复测中'] },
        { field: 'rechecks', maxLength: 1 }
      ],
      inputs: [
        { label: '复测人（须换人）', name: 'operator', required: true },
        { label: '藻类覆盖率(%)', name: 'value', type: 'number', step: '0.1', required: true },
        { label: '复测时间', name: 'at', type: 'datetime-local', defaultNow: true }
      ]
    },
    {
      id: 'exp-resume',
      label: '确认复光',
      collection: 'exposures',
      path: '/api/exposures/:id/resume',
      when: [{ field: 'status', values: ['复测中'] }, { field: 'rechecks', minLength: 2 }],
      inputs: [
        { label: '复光确认人', name: 'operator', required: true }
      ]
    },
    {
      id: 'exp-edit',
      label: '更正记录',
      collection: 'exposures',
      type: 'edit',
      path: '/api/exposures/:id',
      inputs: [
        { label: '操作员', name: 'operator', prefill: 'operator', required: true },
        { label: '照度(勒克斯)', name: 'lux', type: 'number', prefill: 'lux', required: true },
        { label: '照明时长(小时)', name: 'hours', type: 'number', step: '0.1', prefill: 'hours' },
        { label: '开始时间', name: 'startedAt', type: 'datetime-local', prefill: 'startedAt' },
        { label: '结束时间', name: 'endedAt', type: 'datetime-local', prefill: 'endedAt' },
        { label: '备注', name: 'note', prefill: 'note', wide: true },
        { label: '更正说明', name: 'correctionNote', type: 'textarea', wide: true }
      ]
    }
  ]
};
