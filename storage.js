/**
 * 存储层：db.json 的读取与串行化写入。
 * 所有变更经 mutate 进入同一 promise 队列，避免并发写坏文件，
 * 也保证"同一时刻只开一条照明"的判定在并发下仍然成立。
 */
const fs = require('fs/promises');
const path = require('path');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');

let state = null;
let queue = Promise.resolve();

async function load() {
  if (!state) {
    const raw = await fs.readFile(DB_FILE, 'utf8');
    state = JSON.parse(raw);
  }
  return state;
}

async function persist() {
  const tmp = `${DB_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
  await fs.rename(tmp, DB_FILE);
}

function getState() {
  return state;
}

// fn 返回 { error } 时不落盘
function mutate(fn) {
  const run = queue.then(async () => {
    await load();
    const result = await fn(state);
    if (!result || !result.error) await persist();
    return result;
  });
  queue = run.then(() => {}, () => {});
  return run;
}

module.exports = { load, getState, mutate };
