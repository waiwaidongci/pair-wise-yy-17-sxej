// 存储模块：负责 data/db.json 的读写与串行化
// 所有读写经 transact 排队执行，并发请求（如同时开灯）不会互相覆盖。

const fs = require('fs/promises');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'db.json');

let queue = Promise.resolve();

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  const db = JSON.parse(raw);
  db.sites = Array.isArray(db.sites) ? db.sites : [];
  db.exposures = Array.isArray(db.exposures) ? db.exposures : [];
  return db;
}

async function writeDb(db) {
  const tmp = `${DB_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2) + '\n');
  await fs.rename(tmp, DB_FILE);
}

// fn(db) 的返回值会透传给调用方；返回 { skipWrite: true } 可跳过落盘（如只读且未发生重算）
function transact(fn) {
  const run = queue.then(async () => {
    const db = await readDb();
    const result = await fn(db);
    if (!result || result.skipWrite !== true) await writeDb(db);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

module.exports = { readDb, writeDb, transact, DB_FILE };
