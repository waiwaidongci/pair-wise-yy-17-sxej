/**
 * HTTP 层：仅做请求/响应适配，业务规则全部在 rules.js，持久化全部在 storage.js。
 */
const express = require('express');
const path = require('path');

const config = require('./project.config');
const rules = require('./rules');
const storage = require('./storage');

const app = express();
const PORT = process.env.PORT || config.port || 3912;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({ ...config, limits: rules.LIMITS });
});

app.get('/api/db', async (req, res) => {
  try {
    await storage.load();
    res.json(rules.decorate(storage.getState()));
  } catch (error) {
    res.status(500).json({ error: '读取数据失败' });
  }
});

function handle(fn, okStatus = 201) {
  return async (req, res) => {
    try {
      const result = await storage.mutate((db) => fn(db, req));
      if (!result) return res.status(500).json({ error: '操作失败' });
      if (result.error) return res.status(result.status || 409).json({ error: result.error });
      res.status(result.reused ? 200 : okStatus).json(result);
    } catch (error) {
      res.status(500).json({ error: '服务器错误' });
    }
  };
}

app.post('/api/sites', handle((db, req) => rules.createSite(db, req.body)));
app.post('/api/lightings', handle((db, req) => rules.openLighting(db, req.body)));
app.post('/api/lightings/:id/end', handle((db, req) => rules.endLighting(db, req.params.id, req.body), 200));
app.post('/api/lightings/:id/correct', handle((db, req) => rules.correctLighting(db, req.params.id, req.body), 200));
app.post('/api/lightings/:id/rechecks', handle((db, req) => rules.addRecheck(db, req.params.id, req.body)));

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
