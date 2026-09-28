'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// The test process never reads or uses the host's AI credential.
delete process.env.PERSONAL_AGENT_AI_KEY;
const { createApp } = require('../server');

const DAY = 86400000;

function httpRequest(base, method, route, body, extraHeaders = {}) {
  const url = new URL(route, base);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = { ...extraHeaders };
  if (payload !== undefined) {
    if (!Object.hasOwn(headers, 'content-type')) headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: url.port, path: url.pathname + url.search, method, headers, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          const content = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode, headers: response.headers, body: content ? JSON.parse(content) : null });
        } catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error('Test HTTP request timed out')));
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

async function fixture(t, options = {}) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'personal-agent-system-test-'));
  const createdDirectory = fs.realpathSync(directory);
  let app;
  let base;
  t.after(async () => {
    if (app) await app.close();
    if (!fs.existsSync(directory)) return;
    const current = fs.realpathSync(directory);
    const relative = path.relative(temporaryRoot, current);
    assert.equal(current, createdDirectory, 'Refuse cleanup if the temporary directory has moved or become a link');
    assert(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`), 'Cleanup must remain within os.tmpdir()');
    assert(path.basename(current).startsWith('personal-agent-system-test-'));
    fs.rmSync(current, { recursive: true, force: false });
  });
  async function start() {
    app = createApp({ dataDir: directory, schedule: false, ...(options.clock ? { clock: options.clock } : {}) });
    await new Promise((resolve, reject) => {
      const failed = error => reject(error);
      app.server.once('error', failed);
      app.server.listen(0, '127.0.0.1', () => { app.server.removeListener('error', failed); resolve(); });
    });
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  if (options.start !== false) await start();
  return {
    directory,
    get app() { return app; },
    get base() { return base; },
    request: (method, route, body, headers) => httpRequest(base, method, route, body, headers),
    async restart() { if (app) await app.close(); await start(); },
    start
  };
}

async function ok(f, method, route, body, headers) {
  const response = await f.request(method, route, body, headers);
  assert.equal(response.status, 200, `${method} ${route}: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function reading(f, item = {}) {
  await ok(f, 'POST', '/api/reading/import', { items: [{ source: 'test', sourceId: 'book-1', title: '测试阅读', note: '原始笔记', ...item }] });
  return (await ok(f, 'GET', '/api/reading'))[0];
}

test('fresh API has empty real data, a working health endpoint, and no destructive reset', async t => {
  const f = await fixture(t);
  const health = await ok(f, 'GET', '/api/health');
  assert.equal(health.ok, true);
  assert.equal(health.schemaVersion, 4);
  assert.match(health.version, /^0\.3\./);
  assert.equal(health.timezone, 'Asia/Shanghai');
  const state = await ok(f, 'GET', '/api/state');
  for (const list of ['tasks', 'goals', 'reading', 'petitions', 'digests', 'checkins', 'runs', 'proposals']) assert.deepEqual(state[list], []);
  assert.equal(state.overview.activeTasks, 0);
  assert.equal(state.overview.completionRate, null);
  assert.deepEqual((await ok(f, 'GET', '/api/morning')).tasks, []);
  assert.equal((await f.request('POST', '/api/reset', {})).status, 410);
  assert.equal((await f.request('GET', '/api/unknown')).status, 404);
  assert(!fs.existsSync(path.join(f.directory, 'obsidian-vault')), 'Reading integration status must not create a Vault');
});

test('goals and tasks require completion evidence and preserve a single completion event', async t => {
  let current = new Date('2026-09-28T01:00:00.000Z');
  const f = await fixture(t, { clock: () => current });
  const { goal } = await ok(f, 'POST', '/api/goals', { title: '完成一次真实学习实践', why: '用证据衡量成长', targetDate: '2026-10-01T00:00:00+08:00' });
  const { task } = await ok(f, 'POST', '/api/tasks', { title: '写出实践记录', goalId: goal.id, priority: '高', minutes: 20 });
  assert.equal(task.goalId, goal.id);
  assert.equal((await f.request('PATCH', `/api/tasks/${task.id}`, { status: 'done' })).status, 400);
  assert.equal((await ok(f, 'GET', '/api/tasks'))[0].status, '待确认', 'Rejected mutation must not change memory or disk');
  const completed = await ok(f, 'PATCH', `/api/tasks/${task.id}`, { status: 'done', evidence: '笔记中附有实践结果和验证步骤' });
  assert.equal(completed.task.status, '已完成');
  assert.equal(completed.task.completedAt, current.toISOString());
  current = new Date(+current + 60000);
  const repeated = await ok(f, 'PATCH', `/api/tasks/${task.id}`, { status: 'done' });
  assert.equal(repeated.task.completedAt, completed.task.completedAt);
  const events = await ok(f, 'GET', '/api/events');
  assert.equal(events.filter(event => event.type === 'task.completed' && event.sourceId === task.id).length, 1);
  assert.equal((await ok(f, 'GET', '/api/overview')).completedToday, 1);
  assert.equal((await f.request('POST', '/api/tasks', { title: '错误目标', goalId: 'missing-goal' })).status, 404);
  await ok(f, 'PATCH', `/api/goals/${goal.id}`, { status: 'completed' });
  assert.equal((await ok(f, 'GET', '/api/goals'))[0].status, 'completed');
});

test('data survives restart and converting the same captured idea is idempotent', async t => {
  const f = await fixture(t);
  const { petition } = await ok(f, 'POST', '/api/petitions', { title: '从输入转成行动', note: '持久化检查' });
  const first = await ok(f, 'POST', `/api/petitions/${petition.id}/convert`, {});
  const second = await ok(f, 'POST', `/api/petitions/${petition.id}/convert`, {});
  assert.equal(second.task.id, first.task.id);
  await reading(f);
  await ok(f, 'POST', '/api/checkins', { energy: 3, note: '完成了有证据的小行动' });
  const before = await ok(f, 'GET', '/api/export');
  await f.restart();
  const after = await ok(f, 'GET', '/api/export');
  assert.deepEqual(after, before);
  assert.equal(after.tasks.length, 1);
  assert(fs.existsSync(path.join(f.directory, 'store.backup.json')));
});

test('an occupied recovery mutex blocks competing starters without deleting their lock', async t => {
  const f = await fixture(t, { start: false });
  const lockFile = path.join(f.directory, 'server.lock');
  fs.writeFileSync(lockFile, `${process.pid}:other-owner`);
  fs.mkdirSync(path.join(f.directory, 'server.lock-recovery'));
  assert.throws(() => createApp({ dataDir: f.directory, schedule: false }), error => error.statusCode === 503 && error.message.includes('恢复'));
  assert.equal(fs.readFileSync(lockFile, 'utf8'), `${process.pid}:other-owner`);
  assert(fs.existsSync(path.join(f.directory, 'server.lock-recovery')));
  assert(!fs.existsSync(path.join(f.directory, 'store.json')));
});

test('corrupt storage is preserved and a second app cannot take an active data-directory lock', async t => {
  const f = await fixture(t, { start: false });
  const storeFile = path.join(f.directory, 'store.json');
  const damaged = '{ damaged JSON must never be replaced }';
  fs.writeFileSync(storeFile, damaged, 'utf8');
  assert.throws(() => createApp({ dataDir: f.directory, schedule: false }), /未覆盖原文件/);
  assert.equal(fs.readFileSync(storeFile, 'utf8'), damaged);
  assert(!fs.existsSync(path.join(f.directory, 'server.lock')));
  // This is a deliberately created test fixture, never a user's store.
  fs.writeFileSync(storeFile, JSON.stringify({ schemaVersion: 3, tasks: [], goals: [] }), 'utf8');
  await f.start();
  const lock = fs.readFileSync(path.join(f.directory, 'server.lock'), 'utf8');
  assert.throws(() => createApp({ dataDir: f.directory, schedule: false }), /另一个进程/);
  assert.equal(fs.readFileSync(path.join(f.directory, 'server.lock'), 'utf8'), lock);
  assert.equal((await ok(f, 'GET', '/api/health')).ok, true);
  await f.restart();
  assert.equal((await ok(f, 'GET', '/api/health')).ok, true);
});

test('reading imports isolate invalid records, deduplicate, and update the same source record', async t => {
  const f = await fixture(t);
  const item = { source: 'test', sourceId: 'book-unique', title: '持续更新的书', progress: 20, note: '第一条笔记', url: 'https://weread.qq.com/web/reader/example' };
  const first = await ok(f, 'POST', '/api/reading/import', { items: [null, item, 'invalid', { title: '' }] });
  assert.deepEqual({ imported: first.imported, failed: first.failed, total: first.total }, { imported: 1, failed: 3, total: 1 });
  assert.deepEqual(first.errors.map(error => error.index), [0, 2, 3]);
  const original = (await ok(f, 'GET', '/api/reading'))[0];
  const duplicate = await ok(f, 'POST', '/api/reading/import', { items: [item] });
  assert.equal(duplicate.skipped, 1);
  assert.equal(duplicate.imported, 0);
  const update = await ok(f, 'POST', '/api/reading/import', { items: [{ ...item, progress: 65, note: '新增实践结果' }] });
  assert.equal(update.updated, 1);
  const records = await ok(f, 'GET', '/api/reading');
  assert.equal(records.length, 1);
  assert.equal(records[0].id, original.id);
  assert.equal(records[0].progress, 65);
  assert.equal(records[0].note, '新增实践结果');
  assert.equal(records[0].url, item.url);
  assert.equal((await f.request('POST', '/api/reading/import', null)).status, 400);
  assert.equal((await f.request('POST', '/api/reading/import', { format: 'json', text: 'null' })).status, 400);
  const markdown = await ok(f, 'POST', '/api/reading/import', { format: 'markdown', text: '# 手动笔记\n\n> 摘录\n\n自己的理解' });
  assert.equal(markdown.imported, 1);
});

test('reading review schedules follow-up intervals and actions do not duplicate', async t => {
  let current = new Date('2026-09-28T02:00:00.000Z');
  const f = await fixture(t, { clock: () => current });
  const item = await reading(f);
  assert.equal((await ok(f, 'GET', '/api/overview')).dueReviews, 1);
  assert.equal((await f.request('POST', `/api/reading/${item.id}/review`, { rating: 'good', answer: '   ' })).status, 400);
  assert.equal((await ok(f, 'GET', '/api/reading'))[0].reviewCount, 0);
  const first = await ok(f, 'POST', `/api/reading/${item.id}/review`, { rating: 'good', answer: '能用自己的话解释，并给出例子' });
  assert.equal(first.reading.nextReviewAt, new Date(+current + DAY).toISOString());
  assert.equal(first.reading.reviewCount, 1);
  assert.equal((await ok(f, 'GET', '/api/overview')).dueReviews, 0);
  current = new Date(+current + DAY);
  const second = await ok(f, 'POST', `/api/reading/${item.id}/review`, { rating: 'good', answer: '再次解释核心观点，并与上次实践作比较' });
  assert.equal(second.reading.nextReviewAt, new Date(+current + 3 * DAY).toISOString());
  const again = await ok(f, 'POST', `/api/reading/${item.id}/review`, { rating: 'again', answer: '还需要重新理解' });
  assert.equal(again.reading.nextReviewAt, new Date(+current + 10 * 60000).toISOString());
  assert.equal(again.reading.reviewStep, 0);
  assert.equal(again.reading.reviews.length, 3);
  const actionA = await ok(f, 'POST', `/api/reading/${item.id}/task`, {});
  const actionB = await ok(f, 'POST', `/api/reading/${item.id}/task`, {});
  assert.equal(actionA.task.id, actionB.task.id);
  await reading(f, { note: '更新笔记仍保留复习历史' });
  const updated = (await ok(f, 'GET', '/api/reading'))[0];
  assert.equal(updated.reviewCount, 3);
  assert.equal(updated.nextReviewAt, again.reading.nextReviewAt);
});

test('daily and weekly reports use Shanghai calendar boundaries and stable period IDs', async t => {
  let current = new Date('2026-09-27T15:59:59.000Z'); // Sunday 23:59:59 in Shanghai.
  const f = await fixture(t, { clock: () => current });
  const oldTask = (await ok(f, 'POST', '/api/tasks', { title: '上一自然日的行动' })).task;
  await ok(f, 'PATCH', `/api/tasks/${oldTask.id}`, { status: 'done', evidence: '星期日完成' });
  await reading(f, { sourceId: 'previous-book', title: '上一周阅读' });
  current = new Date('2026-09-27T16:00:00.000Z'); // Monday 00:00:00 in Shanghai.
  const newTask = (await ok(f, 'POST', '/api/tasks', { title: '新自然日的行动' })).task;
  await ok(f, 'PATCH', `/api/tasks/${newTask.id}`, { status: 'done', evidence: '星期一完成' });
  await reading(f, { sourceId: 'current-book', title: '本周阅读' });
  await ok(f, 'POST', '/api/checkins', { energy: 4, note: '星期一签到' });
  const daily = (await ok(f, 'POST', '/api/organize/run', { period: 'daily' })).digest;
  assert.equal(daily.periodKey, 'daily:2026-09-28');
  assert.equal(daily.periodStart, '2026-09-27T16:00:00.000Z');
  assert.equal(daily.periodEnd, '2026-09-28T16:00:00.000Z');
  assert.equal(daily.stats.completedTasks, 1);
  assert.equal(daily.stats.readingAdded, 1);
  assert.equal(daily.stats.checkins, 1);
  assert.equal(daily.stats.averageEnergy, 4);
  assert(daily.sourceIds.includes(newTask.id));
  assert(!daily.sourceIds.includes(oldTask.id));
  const weekly = (await ok(f, 'POST', '/api/organize/run', { period: 'weekly' })).digest;
  assert.equal(weekly.periodKey, 'weekly:2026-09-28');
  assert.equal(weekly.periodStart, daily.periodStart);
  assert.equal(weekly.periodEnd, '2026-10-04T16:00:00.000Z');
  assert.equal(weekly.stats.completedTasks, 1);
  assert.equal((await ok(f, 'POST', '/api/organize/run', { period: 'daily' })).digest.id, daily.id);
  assert.equal((await ok(f, 'POST', '/api/organize/run', { period: 'weekly' })).digest.id, weekly.id);
  assert.equal((await ok(f, 'GET', '/api/digests')).length, 2);
  const actionIndex = daily.actionItems.findIndex(action => action.sourceType === 'reading');
  assert(actionIndex >= 0);
  const actionA = await ok(f, 'POST', `/api/digests/${daily.id}/actions/${actionIndex}`, {});
  const actionB = await ok(f, 'POST', `/api/digests/${daily.id}/actions/${actionIndex}`, {});
  assert.equal(actionA.task.id, actionB.task.id);
});

test('scheduler catches up only the latest missed daily and weekly runs and persists idempotency', async t => {
  let current = new Date('2026-09-28T02:00:00.000Z');
  const f = await fixture(t, { clock: () => current });
  await ok(f, 'PATCH', '/api/automation/config', { enabled: true, dailyHour: 21, weeklyDay: 0, weeklyHour: 21 });
  const first = await ok(f, 'POST', '/api/automation/tick', {});
  assert.equal(first.runs.length, 2);
  assert(first.runs.every(run => run.status === 'success'));
  let runs = await ok(f, 'GET', '/api/runs');
  assert.deepEqual(runs.map(run => run.key).sort(), ['daily:2026-09-27', 'weekly:2026-09-27']);
  assert.equal((await ok(f, 'POST', '/api/automation/tick', {})).runs.length, 0);
  await f.restart();
  assert.equal((await ok(f, 'POST', '/api/automation/tick', {})).runs.length, 0);
  current = new Date('2026-09-28T14:00:00.000Z');
  const next = await ok(f, 'POST', '/api/automation/tick', {});
  assert.equal(next.runs.length, 1);
  assert.equal(next.runs[0].period, 'daily');
  runs = await ok(f, 'GET', '/api/runs');
  assert.equal(runs.length, 3);
  assert(runs.some(run => run.key === 'daily:2026-09-28'));
});

test('scheduler records import failures, backs off, and retries after the local source is repaired', async t => {
  let current = new Date('2026-09-28T02:00:00.000Z');
  const f = await fixture(t, { clock: () => current });
  await ok(f, 'PATCH', '/api/automation/config', { enabled: true, autoImport: true });
  const failed = f.app.tick();
  assert.equal(failed.runs.length, 2);
  assert(failed.runs.every(run => run.status === 'failed'));
  assert.equal((await ok(f, 'GET', '/api/digests')).length, 0);
  current = new Date(+current + 30000);
  assert.equal(f.app.tick().runs.length, 0);
  const source = path.join(f.directory, 'obsidian-vault', 'WeRead');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'repaired.md'), '---\ntitle: 本地恢复的阅读\nwereadBookId: repaired-book\n---\n# 本地恢复的阅读\n\n> 一个观点\n', 'utf8');
  current = new Date(+current + 30000);
  const retried = f.app.tick();
  assert.equal(retried.runs.length, 2);
  assert(retried.runs.every(run => run.status === 'success'));
  const runs = await ok(f, 'GET', '/api/runs');
  assert.equal(runs.filter(run => run.status === 'failed').length, 2);
  assert.equal(runs.filter(run => run.status === 'success' && run.attempt === 2).length, 2);
  assert.equal((await ok(f, 'GET', '/api/reading')).length, 1);
  assert.equal((await ok(f, 'POST', '/api/automation/tick', {})).runs.length, 0);
});

test('write endpoints reject cross-site and non-JSON requests and enforce loopback Host', async t => {
  const f = await fixture(t);
  const body = { title: '安全来源的行动' };
  assert.equal((await f.request('POST', '/api/tasks', body, { origin: 'https://other-site.invalid' })).status, 403);
  assert.equal((await f.request('POST', '/api/tasks', body, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.request('POST', '/api/tasks', body, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await f.request('GET', '/api/state', undefined, { host: 'untrusted-host.invalid' })).status, 403);
  assert.equal((await ok(f, 'GET', '/api/tasks')).length, 0);
  await ok(f, 'POST', '/api/tasks', body, { origin: f.base, 'sec-fetch-site': 'same-origin' });
  assert.equal((await ok(f, 'GET', '/api/tasks')).length, 1);
});

test('Obsidian export requires a current preview, preserves conflicts, and never overwrites root README', async t => {
  const f = await fixture(t);
  const vault = path.join(f.directory, 'configured-vault');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'README.md'), '# User-owned root README\n', 'utf8');
  await ok(f, 'POST', '/api/settings', { vaultPath: vault });
  await reading(f, { sourceId: '../safe-hashed-id' });
  await ok(f, 'POST', '/api/goals', { title: '导出目标' });
  await ok(f, 'POST', '/api/organize/run', { period: 'daily' });
  const first = await ok(f, 'POST', '/api/obsidian/preview', {});
  assert.equal(first.files.length, 3);
  assert(first.files.every(file => /^PersonalCourt\/(Reading|Digests|Goals)\/[a-f0-9]{64}\.md$/.test(file.path)));
  assert(first.files.every(file => file.status === 'create' && file.content.startsWith('---\n')));
  assert(!fs.existsSync(path.join(vault, 'PersonalCourt')));
  assert.equal((await f.request('POST', '/api/obsidian/export', { previewId: first.previewId })).status, 412);
  await reading(f, { sourceId: '../safe-hashed-id', note: '预览后内容变化' });
  assert.equal((await f.request('POST', '/api/obsidian/export', { previewId: first.previewId, approved: true })).status, 409);
  const fresh = await ok(f, 'POST', '/api/obsidian/preview', {});
  const exported = await ok(f, 'POST', '/api/obsidian/export', { previewId: fresh.previewId, approved: true });
  assert.equal(exported.written.length, 3);
  assert.equal(fs.readFileSync(path.join(vault, 'README.md'), 'utf8'), '# User-owned root README\n');
  assert.equal((await f.request('POST', '/api/obsidian/export', { previewId: fresh.previewId, approved: true })).status, 409);
  const unchanged = await ok(f, 'POST', '/api/obsidian/preview', {});
  assert(unchanged.files.every(file => file.status === 'unchanged'));
  const notePath = unchanged.files.find(file => file.path.includes('/Reading/')).path;
  fs.writeFileSync(path.join(vault, notePath), '# My independent edits\n', 'utf8');
  assert.equal((await f.request('POST', '/api/obsidian/export', { previewId: unchanged.previewId, approved: true })).status, 409);
  const conflict = await ok(f, 'POST', '/api/obsidian/preview', {});
  assert.equal(conflict.files.filter(file => file.status === 'conflict').length, 1);
  const skipped = await ok(f, 'POST', '/api/obsidian/export', { previewId: conflict.previewId, approved: true });
  assert.equal(skipped.conflicts.length, 1);
  assert.equal(skipped.conflicts[0].path, notePath);
  assert.equal(fs.readFileSync(path.join(vault, notePath), 'utf8'), '# My independent edits\n');
  assert.equal(fs.readFileSync(path.join(vault, 'README.md'), 'utf8'), '# User-owned root README\n');
});

test('local WeRead Markdown imports stable records and skips hidden or unrelated files', async t => {
  const f = await fixture(t);
  const source = path.join(f.directory, 'obsidian-vault', 'WeRead');
  fs.mkdirSync(source, { recursive: true });
  const file = path.join(source, 'book.md');
  const note = '---\ntitle: "带出处的书"\nauthor: "作者"\nwereadBookId: stable-book\nurl: "https://weread.qq.com/web/reader/example"\ntags: [实践, 阅读]\n---\n# 带出处的书\n## 高亮划线\n> 保留出处和引用\n## 想法\n自己的理解\n';
  fs.writeFileSync(file, note, 'utf8');
  fs.writeFileSync(path.join(source, '.hidden.md'), '# 不应导入', 'utf8');
  fs.writeFileSync(path.join(source, 'unrelated.json'), '{"title":"不应导入"}', 'utf8');
  const first = await ok(f, 'POST', '/api/obsidian/import', {});
  assert.equal(first.imported, 1);
  const initial = (await ok(f, 'GET', '/api/reading'))[0];
  assert.equal(initial.sourceId, 'weread:stable-book');
  assert.equal(initial.source, 'obsidian_weread');
  assert.equal(initial.title, '带出处的书');
  assert.equal(initial.author, '作者');
  assert(initial.quote.includes('保留出处和引用'));
  assert.equal(initial.url, 'https://weread.qq.com/web/reader/example');
  assert.equal((await ok(f, 'POST', '/api/obsidian/import', {})).skipped, 1);
  fs.writeFileSync(file, `${note}\n新增理解\n`, 'utf8');
  assert.equal((await ok(f, 'POST', '/api/obsidian/import', {})).updated, 1);
  const updated = (await ok(f, 'GET', '/api/reading'))[0];
  assert.equal(updated.id, initial.id);
  assert(updated.note.includes('新增理解'));
  assert.equal((await f.request('POST', '/api/settings', { readingFolder: '../outside' })).status, 400);
  assert.equal((await f.request('POST', '/api/settings', { readingFolder: 'PersonalCourt/Reading' })).status, 400);
  assert.equal((await f.request('POST', '/api/settings', { readingFolder: 'personalcourt' })).status, 400);
  await ok(f, 'POST', '/api/reading/import', { items: [{ source: initial.source, sourceId: initial.sourceId, title: initial.title, progress: 80 }] });
  await ok(f, 'POST', '/api/obsidian/import', {});
  assert.equal((await ok(f, 'GET', '/api/reading'))[0].progress, 80, 'Missing Markdown progress must preserve an existing snapshot');
});

test('AI endpoints preview disclosure, require approval, and reject invented references with mocked fetch', async t => {
  const f = await fixture(t);
  let calls = 0;
  let inventedReference = false;
  const originalFetch = global.fetch;
  global.fetch = async (destination, options) => {
    calls++;
    assert.equal(destination, 'https://model-service.invalid/v1/chat/completions');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-placeholder-not-a-real-key');
    assert(!options.body.includes('test-placeholder-not-a-real-key'));
    const payload = JSON.parse(options.body);
    assert(payload.messages[0].content.includes('不可信资料'));
    const input = JSON.parse(payload.messages[1].content);
    assert(input.records.length <= 60);
    const sourceId = inventedReference ? 'not-a-provided-record' : input.records[0].id;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '基于所提供资料的分析', actions: [{ title: '执行一次小实践', reason: '用实际结果验证理解', sourceIds: [sourceId] }], citations: [sourceId] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { global.fetch = originalFetch; delete process.env.PERSONAL_AGENT_AI_KEY; });
  await reading(f);
  await ok(f, 'POST', '/api/tasks', { title: '关联行动' });
  assert.equal((await f.request('POST', '/api/ai/preview', { question: '下一步做什么？' })).status, 412);
  await ok(f, 'POST', '/api/settings', { ai: { enabled: true, baseUrl: 'https://model-service.invalid/v1', model: 'fixture-model' } });
  assert.equal((await f.request('POST', '/api/ai/preview', { question: '下一步做什么？' })).status, 412);
  process.env.PERSONAL_AGENT_AI_KEY = 'test-placeholder-not-a-real-key';
  let preview = await ok(f, 'POST', '/api/ai/preview', { question: '下一步做什么？' });
  assert.equal(preview.recordCount, 2);
  assert(preview.fields.includes('note'));
  assert.equal(preview.destination, 'https://model-service.invalid/v1/chat/completions');
  assert.equal(calls, 0);
  assert.equal((await f.request('POST', '/api/ai/run', { question: '下一步做什么？', previewId: preview.previewId, approved: false })).status, 412);
  assert.equal(calls, 0);
  await reading(f, { note: '预览后更新了笔记，需要重新审阅发送内容' });
  assert.equal((await f.request('POST', '/api/ai/run', { question: '下一步做什么？', previewId: preview.previewId, approved: true })).status, 409);
  assert.equal(calls, 0, 'A stale AI preview must not cause a provider request');
  preview = await ok(f, 'POST', '/api/ai/preview', { question: '下一步做什么？' });
  const result = await ok(f, 'POST', '/api/ai/run', { question: '下一步做什么？', previewId: preview.previewId, approved: true });
  assert.equal(calls, 1);
  assert.equal(result.analysis.actions.length, 1);
  const validIds = new Set(preview.sources.map(source => source.id));
  assert(result.analysis.citations.every(citation => validIds.has(citation)));
  assert.equal((await f.request('POST', '/api/ai/run', { question: '下一步做什么？', previewId: preview.previewId, approved: true })).status, 409);
  assert.equal(calls, 1, 'Reusing an AI approval must not cause another provider request');
  const savedAnalysis = (await ok(f, 'GET', '/api/state')).aiAnalyses;
  assert.equal(savedAnalysis.length, 1);
  assert.equal(savedAnalysis[0].id, result.analysis.id);
  assert.equal(savedAnalysis[0].question, '下一步做什么？');
  await f.restart();
  assert.deepEqual((await ok(f, 'GET', '/api/state')).aiAnalyses, savedAnalysis);
  inventedReference = true;
  const secondPreview = await ok(f, 'POST', '/api/ai/preview', { question: '下一步做什么？' });
  assert.equal((await f.request('POST', '/api/ai/run', { question: '下一步做什么？', previewId: secondPreview.previewId, approved: true })).status, 502);
  assert.equal((await ok(f, 'GET', '/api/state')).aiAnalyses.length, 1, 'Rejected AI output must not be recorded as a successful analysis');
  assert.equal((await ok(f, 'GET', '/api/tasks')).length, 1, 'AI suggestions must not execute or create tasks');
});

function proposalBody(overrides = {}) {
  return {
    title: '让每一份计划形成可验收成果',
    intent: '减少只记录不执行的计划，保留真实完成证据',
    dept: '工部', priority: '高',
    steps: [
      { title: '实现一个可验证步骤', minutes: 25, acceptance: '提供实际运行结果' },
      { title: '记录验证过程', minutes: 15, acceptance: '写明输入、结果和局限' }
    ],
    ...overrides
  };
}

async function courtProposal(f, overrides = {}) {
  return (await ok(f, 'POST', '/api/court/proposals', proposalBody(overrides))).proposal;
}

async function courtTransition(f, proposal, action, body = {}) {
  return ok(f, 'POST', `/api/court/proposals/${proposal.id}/${action}`, { revision: proposal.revision, ...body });
}

async function courtApproved(f, overrides = {}) {
  let proposal = await courtProposal(f, overrides);
  proposal = (await courtTransition(f, proposal, 'submit')).proposal;
  return (await courtTransition(f, proposal, 'review', { decision: 'approve', note: '计划有明确目的与验收条件' })).proposal;
}

async function rejectedUnchanged(f, method, route, body, expected = [400, 409]) {
  const before = await ok(f, 'GET', '/api/export');
  const response = await f.request(method, route, body);
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert(allowed.includes(response.status), `${method} ${route}: expected ${allowed.join('/')}, got ${response.status}: ${JSON.stringify(response.body)}`);
  assert.deepEqual(await ok(f, 'GET', '/api/export'), before, 'Rejected court mutation must not change records, revisions, or events');
  return response;
}

test('court lifecycle links real tasks, enforces evidence, and freezes accepted work', async t => {
  const f = await fixture(t);
  const { goal } = await ok(f, 'POST', '/api/goals', { title: '有验收证据的个人工作闭环' });
  let proposal = await courtProposal(f, { goalId: goal.id });
  assert.equal(proposal.status, 'draft');
  assert.equal(proposal.revision, 1);
  assert.equal(proposal.steps.length, 2);
  assert(proposal.steps.every(step => typeof step.id === 'string' && step.id));
  assert.equal(new Set(proposal.steps.map(step => step.id)).size, 2);
  const initialStepIds = proposal.steps.map(step => step.id);
  proposal = (await courtTransition(f, proposal, 'submit')).proposal;
  assert.equal(proposal.status, 'review');
  assert.equal(proposal.revision, 2);
  proposal = (await courtTransition(f, proposal, 'review', { decision: 'approve' })).proposal;
  assert.equal(proposal.status, 'approved');
  assert.equal(proposal.revision, 3);
  const dispatched = await courtTransition(f, proposal, 'dispatch');
  proposal = dispatched.proposal;
  assert.equal(proposal.status, 'executing');
  assert.equal(proposal.revision, 4);
  assert.equal(dispatched.tasks.length, 2);
  assert.deepEqual(proposal.steps.map(step => step.id), initialStepIds);
  for (let index = 0; index < dispatched.tasks.length; index++) {
    const task = dispatched.tasks[index];
    assert.equal(task.proposalId, proposal.id);
    assert.equal(task.acceptance, proposal.steps[index].acceptance);
    assert.equal(task.dept, '工部');
    assert.equal(task.goalId, goal.id);
    assert.equal(task.sourceType, 'proposal');
    assert.equal(task.sourceId, `${proposal.id}:${proposal.steps[index].id}`);
  }
  const first = dispatched.tasks[0];
  for (const patch of [{ title: '绕过审批改标题' }, { dept: '吏部' }, { priority: '低' }, { minutes: 60 }, { goalId: '' }, { dueAt: '2026-12-01T00:00:00Z' }]) {
    await rejectedUnchanged(f, 'PATCH', `/api/tasks/${first.id}`, patch);
  }
  await rejectedUnchanged(f, 'PATCH', `/api/tasks/${first.id}`, { status: 'done' }, 400);
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/accept`, { revision: proposal.revision, note: '不能验收尚未完成的步骤' });
  for (const task of dispatched.tasks) await ok(f, 'PATCH', `/api/tasks/${task.id}`, { status: 'done', evidence: `${task.title}：已记录实际运行结果与验证步骤` });
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/accept`, { revision: proposal.revision, note: '证据已变化，旧版不得验收' }, 409);
  proposal = (await ok(f, 'GET', `/api/court/proposals/${proposal.id}`)).proposal;
  assert(proposal.revision > 4, 'Actual task progress must invalidate an earlier acceptance revision');
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/accept`, { revision: proposal.revision, note: '   ' }, 400);
  const acceptanceRevision = proposal.revision;
  proposal = (await courtTransition(f, proposal, 'accept', { note: '逐项核对证据，完成本轮验收' })).proposal;
  assert.equal(proposal.status, 'completed');
  assert.equal(proposal.revision, acceptanceRevision + 1);
  await rejectedUnchanged(f, 'PATCH', `/api/tasks/${first.id}`, { status: 'doing' });
  await rejectedUnchanged(f, 'PATCH', `/api/tasks/${first.id}`, { evidence: '验收后覆盖原证据' });
  assert.equal((await ok(f, 'GET', '/api/court')).stats.completed, 1);
});

test('returned court proposals can be revised and resubmitted while preserving step identities', async t => {
  const f = await fixture(t);
  let proposal = await courtProposal(f);
  const stepIds = proposal.steps.map(step => step.id);
  proposal = (await courtTransition(f, proposal, 'submit')).proposal;
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/review`, { revision: proposal.revision, decision: 'return', note: '' }, 400);
  proposal = (await courtTransition(f, proposal, 'review', { decision: 'return', note: '请补充如何验证真实运行结果' })).proposal;
  assert.equal(proposal.status, 'returned');
  assert.equal(proposal.revision, 3);
  proposal = (await ok(f, 'PATCH', `/api/court/proposals/${proposal.id}`, {
    ...proposalBody({ title: '补充验收证据后的计划', steps: proposal.steps.map((step, index) => ({ ...step, acceptance: `${step.acceptance}；验证条目 ${index + 1}` })) }),
    revision: proposal.revision
  })).proposal;
  assert.equal(proposal.revision, 4);
  assert(['draft', 'returned'].includes(proposal.status));
  assert.deepEqual(proposal.steps.map(step => step.id), stepIds);
  assert.equal(proposal.title, '补充验收证据后的计划');
  proposal = (await courtTransition(f, proposal, 'submit')).proposal;
  assert.equal(proposal.status, 'review');
  assert.equal(proposal.revision, 5);
  proposal = (await courtTransition(f, proposal, 'review', { decision: 'approve', note: '修改后满足验收要求' })).proposal;
  assert.equal(proposal.status, 'approved');
  assert.equal(proposal.revision, 6);
  await rejectedUnchanged(f, 'PATCH', `/api/court/proposals/${proposal.id}`, { ...proposalBody(), revision: proposal.revision });
});

test('court rejects approval bypasses and incomplete execution plans without creating tasks', async t => {
  const f = await fixture(t);
  const draft = await courtProposal(f);
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${draft.id}/review`, { revision: draft.revision, decision: 'approve' });
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${draft.id}/dispatch`, { revision: draft.revision });
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${draft.id}/accept`, { revision: draft.revision, note: '跳过审批与执行' });
  const underReview = (await courtTransition(f, draft, 'submit')).proposal;
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${draft.id}/dispatch`, { revision: underReview.revision });
  const badPlans = [
    { intent: '' }, { steps: [] },
    { steps: [{ title: '', minutes: 20, acceptance: '有结果' }] },
    { steps: [{ title: '没有验收条件', minutes: 20, acceptance: '' }] },
    { steps: [{ title: '无效估时', minutes: 0, acceptance: '有结果' }] },
    { steps: [{ title: '超出估时上限', minutes: 1441, acceptance: '有结果' }] },
    { steps: Array.from({ length: 9 }, (_, index) => ({ title: `步骤 ${index}`, minutes: 10, acceptance: '有结果' })) }
  ];
  for (const patch of badPlans) {
    const before = await ok(f, 'GET', '/api/export');
    const created = await f.request('POST', '/api/court/proposals', proposalBody(patch));
    if (created.status === 400) {
      assert.deepEqual(await ok(f, 'GET', '/api/export'), before);
      continue;
    }
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const incomplete = created.body.proposal;
    await rejectedUnchanged(f, 'POST', `/api/court/proposals/${incomplete.id}/submit`, { revision: incomplete.revision }, 400);
  }
  assert.equal((await ok(f, 'GET', '/api/tasks')).length, 0);
  await rejectedUnchanged(f, 'POST', '/api/court/proposals', proposalBody({ dept: '不存在的部门' }), 400);
});

test('court stale revisions reject atomically and competing approvals have only one winner', async t => {
  const f = await fixture(t);
  let proposal = await courtProposal(f);
  await rejectedUnchanged(f, 'PATCH', `/api/court/proposals/${proposal.id}`, { ...proposalBody({ title: '无效版本' }), revision: 0 }, 400);
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/submit`, { revision: 0 }, 400);
  proposal = (await ok(f, 'PATCH', `/api/court/proposals/${proposal.id}`, { ...proposalBody({ title: '当前草稿版本', steps: proposal.steps }), revision: proposal.revision })).proposal;
  await rejectedUnchanged(f, 'PATCH', `/api/court/proposals/${proposal.id}`, { ...proposalBody({ title: '过期修改' }), revision: 1 }, 409);
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/submit`, { revision: 1 }, 409);
  proposal = (await courtTransition(f, proposal, 'submit')).proposal;
  const reviewRevision = proposal.revision;
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/review`, { revision: reviewRevision - 1, decision: 'approve' }, 409);
  const approvals = await Promise.all([
    f.request('POST', `/api/court/proposals/${proposal.id}/review`, { revision: proposal.revision, decision: 'approve', note: '第一次审批' }),
    f.request('POST', `/api/court/proposals/${proposal.id}/review`, { revision: proposal.revision, decision: 'approve', note: '并发审批' })
  ]);
  assert.deepEqual(approvals.map(response => response.status).sort(), [200, 409]);
  proposal = approvals.find(response => response.status === 200).body.proposal;
  assert.equal(proposal.revision, reviewRevision + 1);
  const approvedRevision = proposal.revision;
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/dispatch`, { revision: reviewRevision }, 409);
  const dispatched = await courtTransition(f, proposal, 'dispatch');
  proposal = dispatched.proposal;
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/accept`, { revision: approvedRevision, note: '过期验收' }, 409);
  for (const task of dispatched.tasks) await ok(f, 'PATCH', `/api/tasks/${task.id}`, { status: 'done', evidence: '实际验证完成' });
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/accept`, { revision: approvedRevision, note: '完成后仍不可用过期版本验收' }, 409);
  proposal = (await ok(f, 'GET', `/api/court/proposals/${proposal.id}`)).proposal;
  const accepted = await courtTransition(f, proposal, 'accept', { note: '使用当前版本验收' });
  assert.equal(accepted.proposal.status, 'completed');
});

test('repeated dispatches return the same tasks without duplicating tasks or audit events', async t => {
  const f = await fixture(t);
  let proposal = await courtApproved(f);
  const approvedRevision = proposal.revision;
  const first = await courtTransition(f, proposal, 'dispatch');
  proposal = first.proposal;
  const beforeRepeats = await ok(f, 'GET', '/api/export');
  const repeats = await Promise.all([
    f.request('POST', `/api/court/proposals/${proposal.id}/dispatch`, { revision: approvedRevision }),
    f.request('POST', `/api/court/proposals/${proposal.id}/dispatch`, { revision: 1 }),
    f.request('POST', `/api/court/proposals/${proposal.id}/dispatch`, { revision: proposal.revision })
  ]);
  for (const response of repeats) {
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.tasks.map(task => task.id), first.tasks.map(task => task.id));
    assert.equal(response.body.proposal.revision, proposal.revision);
  }
  assert.deepEqual(await ok(f, 'GET', '/api/export'), beforeRepeats, 'Idempotent dispatch must not append duplicate audit events');
  for (const task of first.tasks) await ok(f, 'PATCH', `/api/tasks/${task.id}`, { status: 'done', evidence: '验证步骤对应结果' });
  proposal = (await ok(f, 'GET', `/api/court/proposals/${proposal.id}`)).proposal;
  proposal = (await courtTransition(f, proposal, 'accept', { note: '验收步骤与证据一致' })).proposal;
  const beforeCompletedRepeat = await ok(f, 'GET', '/api/export');
  const repeatedAfterCompletion = await ok(f, 'POST', `/api/court/proposals/${proposal.id}/dispatch`, { revision: 1 });
  assert.deepEqual(repeatedAfterCompletion.tasks.map(task => task.id), first.tasks.map(task => task.id));
  assert.equal(repeatedAfterCompletion.proposal.status, 'completed');
  assert.deepEqual(await ok(f, 'GET', '/api/export'), beforeCompletedRepeat);
});

test('court counts only real work per department and preserves schema-3 data through restart', async t => {
  const current = new Date('2026-09-28T04:00:00.000Z');
  const f = await fixture(t, { start: false, clock: () => current });
  const legacy = {
    schemaVersion: 3,
    legacyMetadata: { retained: 'custom schema-3 extension' },
    goals: [{ id: 'legacy-goal', title: '旧目标仍存在', status: 'active', createdAt: '2026-09-27T01:00:00.000Z' }],
    tasks: [
      { id: 'demo-task', title: '演示不参与统计', dept: '兵部', status: '已完成', minutes: 900, evidence: 'demo', isDemo: true, completedAt: current.toISOString() },
      { id: 'legacy-active', title: '真实旧任务', dept: '礼部', status: '执行中', minutes: 20, goalId: 'legacy-goal', dueAt: '2026-09-27T01:00:00.000Z', createdAt: '2026-09-27T00:00:00.000Z' },
      { id: 'legacy-done', title: '真实已完成任务', dept: '工部', status: '已完成', minutes: 30, evidence: '旧任务完成证据', completedAt: current.toISOString() },
      { id: 'legacy-unassigned', title: '未知部门待归类', dept: '旧分类', status: '待确认', minutes: 5, createdAt: current.toISOString() }
    ],
    reading: [{ id: 'legacy-book', title: '旧阅读记录', note: '迁移后保留', source: 'manual', sourceId: 'legacy-book', createdAt: current.toISOString(), reviews: [] }]
  };
  fs.writeFileSync(path.join(f.directory, 'store.json'), JSON.stringify(legacy), 'utf8');
  await f.start();
  const initial = await ok(f, 'GET', '/api/court');
  assert.equal(initial.provinces.length, 3);
  assert(initial.provinces.every(province => province.id && province.name && province.role && Number.isInteger(province.pending)));
  assert.deepEqual(initial.departments.map(department => department.id).sort(), ['吏部', '户部', '礼部', '兵部', '刑部', '工部'].sort());
  assert(initial.departments.every(department => department.name && department.role && department.description));
  assert.equal(initial.unassignedCount, 1);
  const initialRites = initial.departments.find(department => department.id === '礼部');
  assert.equal(initialRites.active, 1);
  assert.equal(initialRites.completed, 0);
  assert.equal(initialRites.estimatedMinutes, 20);
  assert.equal(initialRites.overdue, 1);
  assert.equal(initialRites.goalCount, 1);
  const military = initial.departments.find(department => department.id === '兵部');
  assert.equal(military.active, 0);
  assert.equal(military.completed, 0);
  assert.equal(military.estimatedMinutes, 0);
  assert.equal(initial.departments.find(department => department.id === '工部').completed, 1);

  await courtProposal(f, { title: '仍在拟议', dept: '兵部' });
  const reviewing = await courtProposal(f, { title: '门下待审', dept: '工部' });
  await courtTransition(f, reviewing, 'submit');
  let returned = await courtProposal(f, { title: '退回补充', dept: '刑部' });
  returned = (await courtTransition(f, returned, 'submit')).proposal;
  await courtTransition(f, returned, 'review', { decision: 'return', note: '补充验收标准' });
  await courtApproved(f, { title: '待尚书派发', dept: '吏部' });
  const executing = await courtApproved(f, { title: '户部实际执行', dept: '户部', goalId: 'legacy-goal', steps: [{ title: '核对资源', minutes: 40, acceptance: '给出核对结果' }] });
  await courtTransition(f, executing, 'dispatch');
  const ready = await courtApproved(f, { title: '礼部已经验收', dept: '礼部', steps: [{ title: '学习实践', minutes: 15, acceptance: '提交实践证据' }] });
  const completed = await courtTransition(f, ready, 'dispatch');
  await ok(f, 'PATCH', `/api/tasks/${completed.tasks[0].id}`, { status: 'done', evidence: '实践结果已记录' });
  const acceptanceProposal = (await ok(f, 'GET', `/api/court/proposals/${completed.proposal.id}`)).proposal;
  await courtTransition(f, acceptanceProposal, 'accept', { note: '核对实际结果后验收' });
  const court = await ok(f, 'GET', '/api/court');
  assert.deepEqual(court.stats, { drafts: 1, review: 1, returned: 1, approved: 1, executing: 1, completed: 1 });
  assert.equal(court.departments.find(department => department.id === '户部').active, 1);
  assert.equal(court.departments.find(department => department.id === '户部').estimatedMinutes, 40);
  assert.equal(court.departments.find(department => department.id === '户部').goalCount, 1);
  assert.equal(court.departments.find(department => department.id === '礼部').active, 1);
  assert.equal(court.departments.find(department => department.id === '礼部').completed, 1);
  assert.equal(court.departments.find(department => department.id === '礼部').overdue, 1);
  assert.equal(court.unassignedCount, 1);
  assert.deepEqual((await ok(f, 'GET', '/api/state')).court, court);
  const saved = await ok(f, 'GET', '/api/export');
  assert.equal(saved.schemaVersion, 4);
  assert.deepEqual(saved.legacyMetadata, legacy.legacyMetadata);
  assert.deepEqual(saved.reading, legacy.reading);
  assert.equal(saved.proposals.length, 6);
  await f.restart();
  assert.deepEqual(await ok(f, 'GET', '/api/export'), saved);
  assert.deepEqual(await ok(f, 'GET', '/api/court'), court);
});
