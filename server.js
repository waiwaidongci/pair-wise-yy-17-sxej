// HTTP 接口层：仅做请求与规则模块之间的映射，业务判断全部在 rules.js
const path = require('path');
const express = require('express');
const config = require('./project.config');
const rules = require('./rules');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || config.port || 3912;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

app.get('/api/config', (req, res) => {
  res.json({ ...config, limits: rules.LIMITS });
});

// 读取前重算派生状态，保证列表、统计与履历刷新后一致
app.get('/api/db', async (req, res) => {
  try {
    const { db } = await store.transact(async (db) => {
      const changed = rules.recalcDb(db);
      return { db, skipWrite: !changed };
    });
    for (const key of Object.keys(db)) {
      if (Array.isArray(db[key])) db[key].sort(sortNewest);
    }
    res.json(db);
  } catch (error) {
    res.status(500).json({ error: '读取数据失败' });
  }
});

function handle(fn) {
  return async (req, res) => {
    try {
      const out = await store.transact((db) => fn(db, req));
      if (!out || out.error) return res.status(409).json({ error: (out && out.error) || '操作失败' });
      if (out.reused) return res.status(200).json({ item: out.item, reused: true });
      if (out.created) return res.status(201).json({ item: out.item });
      return res.json({ item: out.item });
    } catch (error) {
      res.status(500).json({ error: '服务器错误' });
    }
  };
}

app.post('/api/sites', handle((db, req) => rules.createSite(db, req.body)));
app.post('/api/exposures', handle((db, req) => rules.openExposure(db, req.body)));
app.post('/api/exposures/:id/end', handle((db, req) => rules.endExposure(db, req.params.id, req.body)));
app.post('/api/exposures/:id/recheck', handle((db, req) => rules.addRecheck(db, req.params.id, req.body)));
app.post('/api/exposures/:id/resume', handle((db, req) => rules.resumeLighting(db, req.params.id, req.body)));
app.patch('/api/exposures/:id', handle((db, req) => rules.correctExposure(db, req.params.id, req.body)));

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
