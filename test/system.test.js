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
  assert.equal(health.schemaVersion, 5);
  assert.equal(health.version, require('../package.json').version);
  assert.equal(health.timezone, 'Asia/Shanghai');
  const state = await ok(f, 'GET', '/api/state');
  for (const list of ['tasks', 'goals', 'reading', 'petitions', 'digests', 'checkins', 'runs', 'proposals', 'growthAssessments', 'thinkingCases', 'growthExperiments']) assert.deepEqual(state[list], []);
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

function reviewChecks() {
  return ['feasibility', 'coverage', 'risk', 'resources'].map(key => ({ key, passed: true, reason: `已按具体计划检查 ${key}，有可执行步骤与明确边界。` }));
}

function acceptanceChecks(proposal) {
  return proposal.taskIds.map(taskId => ({ taskId, passed: true, reason: '已核对该行动的完成证据与原验收标准。' }));
}

async function courtTransition(f, proposal, action, body = {}) {
  const gate = action === 'review' && body.decision === 'approve' ? { note: '计划的可行性、覆盖、风险与资源均已逐项核对。', checks: reviewChecks() } : action === 'accept' ? { checks: acceptanceChecks(proposal) } : {};
  return ok(f, 'POST', `/api/court/proposals/${proposal.id}/${action}`, { revision: proposal.revision, ...gate, ...body });
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
  assert.deepEqual(await ok(f, 'GET', '/api/export'), before, 'Rejected mutation must not change records, revisions, or events');
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
    f.request('POST', `/api/court/proposals/${proposal.id}/review`, { revision: proposal.revision, decision: 'approve', note: '第一次审批', checks: reviewChecks() }),
    f.request('POST', `/api/court/proposals/${proposal.id}/review`, { revision: proposal.revision, decision: 'approve', note: '并发审批', checks: reviewChecks() })
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
  assert.deepEqual(court.stats, { drafts: 1, review: 1, returned: 1, approved: 1, executing: 1, completed: 1, paused: 0, cancelled: 0 });
  assert.equal(court.departments.find(department => department.id === '户部').active, 1);
  assert.equal(court.departments.find(department => department.id === '户部').estimatedMinutes, 40);
  assert.equal(court.departments.find(department => department.id === '户部').goalCount, 1);
  assert.equal(court.departments.find(department => department.id === '礼部').active, 1);
  assert.equal(court.departments.find(department => department.id === '礼部').completed, 1);
  assert.equal(court.departments.find(department => department.id === '礼部').overdue, 1);
  assert.equal(court.unassignedCount, 1);
  assert.deepEqual((await ok(f, 'GET', '/api/state')).court, court);
  const saved = await ok(f, 'GET', '/api/export');
  assert.equal(saved.schemaVersion, 5);
  assert.deepEqual(saved.legacyMetadata, legacy.legacyMetadata);
  assert.deepEqual(saved.reading, legacy.reading);
  assert.equal(saved.proposals.length, 6);
  await f.restart();
  assert.deepEqual(await ok(f, 'GET', '/api/export'), saved);
  assert.deepEqual(await ok(f, 'GET', '/api/court'), court);
});

const DIMENSION_IDS = ['reasoning', 'learning', 'execution', 'strategy', 'expression', 'reflection'];

function thinkingBody(overrides = {}) {
  return {
    title: '为什么读完很多材料，却迟迟没有形成成果？',
    subjectType: 'self', context: '在工作和学习之间安排有限时间',
    facts: '本周阅读三次，但只有一次留下实践记录。',
    assumptions: '可能是学习内容与实际问题联系不够。',
    question: '下一周怎样验证知识转化的真实阻碍？',
    lensIds: ['economics', 'confucian', 'critical'], sourceIds: [],
    ...overrides
  };
}

async function thinkingCase(f, overrides = {}) {
  return (await ok(f, 'POST', '/api/thinking/cases', thinkingBody(overrides))).thinkingCase;
}

function thinkingReflection(overrides = {}) {
  return {
    claim: '实践目标不清晰可能是主要阻碍。', counterargument: '精力不足也可以解释同样的结果。',
    causalExplanation: '目标不明确导致无法选择练习内容，因而没有输出。', alternative: '睡眠不足可能同时降低阅读理解与执行。',
    test: '固定学习时段和精力水平，比较有无明确问题的两次阅读。', conclusion: '先保留两个解释，用观察结果更新判断。',
    ...overrides
  };
}

function experimentBody(overrides = {}) {
  return {
    title: '每天一次小型知识转化实验', dimension: 'execution',
    hypothesis: '先确定一个实际问题，会提高阅读转化率。',
    intervention: '开始阅读前写下一个待解决问题，结束后完成一次实践。',
    metric: '有实际结果记录的阅读次数', baseline: '上周 1 次', target: '本周至少 3 次',
    reviewAt: '2026-10-05T01:00:00.000Z', minutes: 25,
    ...overrides
  };
}

function experimentReview(overrides = {}) {
  return {
    outcome: 'supported', observation: '进行了三次实践并保留结果。',
    lesson: '先提问能够减少无目的输入。', adjustment: '继续一周，比较是否仍然有效。', decision: 'keep',
    ...overrides
  };
}

function aiThinkingAnswer(item, overrides = {}) {
  const sourceId = `case:${item.id}`;
  return {
    summary: '当前证据不足以确认原因，先用小规模实验比较解释。',
    lenses: item.lensIds.map(lensId => ({
      lensId, claim: '资源分配可能影响知识转化。', counterargument: '也可能是成果定义不清晰。',
      test: '在相同时间预算下比较两种学习安排。', sourceIds: [sourceId]
    })),
    causes: [{ cause: '未设定实际问题', effect: '阅读后缺少成果', mechanism: '难以选择要练习的知识', alternative: '可能受到疲劳影响', test: '记录精力并比较两组阅读安排' }],
    disagreements: [{ thesis: '应提高执行约束', antithesis: '也应保留自由探索', test: '比较固定实践日与自由探索日的成果' }],
    unknowns: ['样本数量太少，无法排除偶然性。'],
    actions: [{ title: '做一次对照实践', reason: '用观察结果区分解释', dimension: 'execution', metric: '实践记录数量' }],
    citations: [sourceId], ...overrides
  };
}

function mockAi(t, handler) {
  const originalFetch = global.fetch;
  global.fetch = handler;
  t.after(() => { global.fetch = originalFetch; delete process.env.PERSONAL_AGENT_AI_KEY; });
}

async function configureMockAi(f) {
  await ok(f, 'POST', '/api/settings', { ai: { enabled: true, baseUrl: 'https://thinking-model.invalid/v1', model: 'test-thinking-model' } });
  process.env.PERSONAL_AGENT_AI_KEY = 'test-placeholder-not-a-real-key';
}

function aiResponse(answer) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('growth starts without invented scores and retains separate evidence-based assessment snapshots', async t => {
  const f = await fixture(t, { clock: () => new Date('2026-09-28T01:00:00.000Z') });
  const empty = await ok(f, 'GET', '/api/growth');
  assert.deepEqual(empty.dimensions.map(item => item.id), DIMENSION_IDS);
  assert.equal(empty.latestAssessment, null);
  assert.equal(empty.previousAssessment, null);
  assert.deepEqual(empty.evidence, []);
  assert.deepEqual(empty.strengths, []);
  assert.deepEqual(empty.focus, []);
  assert.deepEqual(empty.strategies, []);
  assert(empty.dimensions.every(item => !Object.hasOwn(item, 'score') || item.score === null), 'Missing observations must not be displayed as measured scores');
  assert.deepEqual((await ok(f, 'GET', '/api/state')).growth, empty);
  const { task } = await ok(f, 'POST', '/api/tasks', { title: '独立完成一次知识实践' });
  await ok(f, 'PATCH', `/api/tasks/${task.id}`, { status: 'done', evidence: '保存了实际结果与一次失败的原因。' });
  const withoutRating = await ok(f, 'GET', '/api/growth');
  assert.equal(withoutRating.latestAssessment, null, 'Task counts must never automatically become ability scores');
  assert(withoutRating.evidence.some(item => item.id === `task:${task.id}`));
  const first = (await ok(f, 'POST', '/api/growth/assessments', {
    context: '本周回顾', ratings: [
      { dimension: 'execution', score: 4, note: '本周独立完成实践，但复杂任务还需要帮助。', sourceIds: [`task:${task.id}`] },
      { dimension: 'reflection', score: 2, note: '只有一次复盘，证据有限。', sourceIds: [] }
    ]
  })).assessment;
  assert.equal(first.ratings.length, 2);
  assert.deepEqual(first.ratings[0].sourceIds, [`task:${task.id}`]);
  const second = (await ok(f, 'POST', '/api/growth/assessments', {
    context: '下一次回顾', ratings: [{ dimension: 'reflection', score: 3, note: '能够说清反例，仍需验证。', sourceIds: [`task:${task.id}`] }]
  })).assessment;
  const result = await ok(f, 'GET', '/api/growth');
  assert.equal(result.latestAssessment.id, second.id);
  assert.equal(result.previousAssessment.id, first.id);
  assert.equal(first.createdAt, second.createdAt, 'Same-time assessments still have a deterministic latest snapshot');
  assert.equal((await ok(f, 'GET', '/api/state')).growthAssessments.length, 2);
  await f.restart();
  assert.deepEqual(await ok(f, 'GET', '/api/growth'), result);
});

test('growth rejects invalid scores, duplicate dimensions and missing evidence atomically', async t => {
  const f = await fixture(t);
  const rating = { dimension: 'reasoning', score: 3, note: '可以区分已知事实和推测。', sourceIds: [] };
  const invalidRatings = [
    [], [{ ...rating, score: 0 }], [{ ...rating, score: 6 }], [{ ...rating, score: 2.5 }], [{ ...rating, score: '3' }],
    [{ ...rating, dimension: 'invented' }], [{ ...rating, note: '  ' }], [rating, { ...rating, score: 4 }],
    [{ ...rating, sourceIds: ['task:missing'] }], [{ ...rating, sourceIds: 'task:missing' }]
  ];
  for (const ratings of invalidRatings) {
    await rejectedUnchanged(f, 'POST', '/api/growth/assessments', { context: '拒绝错误评分', ratings }, [400, 404]);
  }
  assert.equal((await ok(f, 'GET', '/api/growth')).latestAssessment, null);
});

test('thinking cases preserve facts versus assumptions and reject stale edits without changing saved analysis', async t => {
  const f = await fixture(t);
  let item = await thinkingCase(f);
  assert.equal(item.revision, 1);
  assert.equal(item.analysis.mode, 'guided');
  assert.equal(item.facts, thinkingBody().facts);
  assert.equal(item.assumptions, thinkingBody().assumptions);
  assert.deepEqual(item.analysis.lenses.map(lens => lens.lensId).sort(), item.lensIds.slice().sort());
  assert(item.analysis.lenses.every(lens => lens.claim && lens.counterargument && lens.test));
  assert(item.analysis.causes.length && item.analysis.disagreements.length && item.analysis.unknowns.length && item.analysis.actions.length);
  assert.deepEqual(item.aiHistory, []);
  for (const patch of [
    { facts: '' }, { question: '' }, { subjectType: 'unknown' }, { lensIds: ['economics', 'critical'] },
    { lensIds: ['economics', 'critical', 'critical'] }, { lensIds: ['economics', 'critical', 'invented'] },
    { sourceIds: ['task:does-not-exist'] }
  ]) await rejectedUnchanged(f, 'POST', '/api/thinking/cases', thinkingBody(patch), [400, 404]);
  await rejectedUnchanged(f, 'PATCH', `/api/thinking/cases/${item.id}`, { ...thinkingBody(), revision: 0 }, 400);
  item = (await ok(f, 'PATCH', `/api/thinking/cases/${item.id}`, { ...thinkingBody({ facts: '补充观察：两次阅读发生在精力较低的晚上。' }), revision: item.revision })).thinkingCase;
  assert.equal(item.revision, 2);
  assert.equal(item.analysis.mode, 'guided');
  await rejectedUnchanged(f, 'PATCH', `/api/thinking/cases/${item.id}`, { ...thinkingBody({ title: '过期编辑' }), revision: 1 }, 409);
  assert.deepEqual((await ok(f, 'GET', `/api/thinking/cases/${item.id}`)).thinkingCase, item);
  const reflectRoute = `/api/thinking/cases/${item.id}/reflect`;
  for (const field of Object.keys(thinkingReflection())) {
    await rejectedUnchanged(f, 'POST', reflectRoute, { ...thinkingReflection({ [field]: '' }), revision: item.revision }, 400);
  }
  const firstReflectionRevision = item.revision;
  item = (await ok(f, 'POST', reflectRoute, { ...thinkingReflection(), revision: item.revision })).thinkingCase;
  assert.equal(item.revision, firstReflectionRevision + 1);
  assert.equal(item.reflections.length, 1);
  assert.equal(item.reflections[0].caseRevision, firstReflectionRevision);
  assert.equal(item.reflections[0].claim, thinkingReflection().claim);
  const firstReflection = item.reflections[0];
  await rejectedUnchanged(f, 'POST', reflectRoute, { ...thinkingReflection(), revision: firstReflectionRevision }, 409);
  item = (await ok(f, 'POST', reflectRoute, { ...thinkingReflection({ conclusion: '新增一次观察，仍然需要进一步验证。' }), revision: item.revision })).thinkingCase;
  assert.equal(item.reflections.length, 2);
  assert.deepEqual(item.reflections[1], firstReflection);
  assert.equal(item.analysis.mode, 'guided');
  await f.restart();
  assert.deepEqual((await ok(f, 'GET', `/api/thinking/cases/${item.id}`)).thinkingCase, item);
  assert.equal((await ok(f, 'GET', '/api/tasks')).length, 0, 'Guided recommendations do not execute themselves');
});

test('thinking AI approval binds exact case, evidence, configuration and expiry before any external call', async t => {
  const f = await fixture(t);
  let calls = 0;
  mockAi(t, async () => { calls++; throw new Error('No provider request should be made in this test'); });
  const book = await reading(f);
  let item = await thinkingCase(f, { sourceIds: [`reading:${book.id}`] });
  const previewRoute = `/api/thinking/cases/${item.id}/ai/preview`;
  const runRoute = `/api/thinking/cases/${item.id}/ai/run`;
  assert.equal((await f.request('POST', previewRoute, { revision: item.revision })).status, 412);
  await configureMockAi(f);
  let preview = await ok(f, 'POST', previewRoute, { revision: item.revision });
  assert.equal(preview.destination, 'https://thinking-model.invalid/v1/chat/completions');
  assert.equal(preview.model, 'test-thinking-model');
  assert(JSON.stringify(preview.payload).includes(item.facts));
  assert(JSON.stringify(preview.payload).includes(item.question));
  assert(!JSON.stringify(preview).includes('test-placeholder-not-a-real-key'));
  await rejectedUnchanged(f, 'POST', runRoute, { revision: item.revision, previewId: preview.previewId, approved: false }, 412);
  item = (await ok(f, 'PATCH', `/api/thinking/cases/${item.id}`, { ...thinkingBody({ sourceIds: [`reading:${book.id}`], facts: '观察事实发生变化。' }), revision: item.revision })).thinkingCase;
  await rejectedUnchanged(f, 'POST', runRoute, { revision: item.revision, previewId: preview.previewId, approved: true }, 409);
  preview = await ok(f, 'POST', previewRoute, { revision: item.revision });
  await reading(f, { note: '预览之后来源笔记改变了。' });
  await rejectedUnchanged(f, 'POST', runRoute, { revision: item.revision, previewId: preview.previewId, approved: true }, 409);
  preview = await ok(f, 'POST', previewRoute, { revision: item.revision });
  await ok(f, 'POST', '/api/settings', { ai: { enabled: true, baseUrl: 'https://thinking-model.invalid/v1', model: 'other-test-model' } });
  await rejectedUnchanged(f, 'POST', runRoute, { revision: item.revision, previewId: preview.previewId, approved: true }, 409);
  preview = await ok(f, 'POST', previewRoute, { revision: item.revision });
  item = (await ok(f, 'POST', `/api/thinking/cases/${item.id}/reflect`, { ...thinkingReflection(), revision: item.revision })).thinkingCase;
  await rejectedUnchanged(f, 'POST', runRoute, { revision: item.revision, previewId: preview.previewId, approved: true }, 409);
  preview = await ok(f, 'POST', previewRoute, { revision: item.revision });
  assert(JSON.stringify(preview.payload).includes(thinkingReflection().conclusion), 'AI disclosure must include the personal reflection that it will analyze');
  const realDateNow = Date.now;
  try {
    Date.now = () => realDateNow() + 60 * 60 * 1000;
    await rejectedUnchanged(f, 'POST', runRoute, { revision: item.revision, previewId: preview.previewId, approved: true }, 409);
  } finally { Date.now = realDateNow; }
  assert.equal(calls, 0);
});

test('thinking AI validates competing perspectives and citations, consumes approvals once, and archives revisions', async t => {
  const f = await fixture(t);
  let item = await thinkingCase(f);
  let answer = aiThinkingAnswer(item);
  let calls = 0;
  mockAi(t, async (destination, options) => {
    calls++;
    assert.equal(destination, 'https://thinking-model.invalid/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-placeholder-not-a-real-key');
    assert(!options.body.includes('test-placeholder-not-a-real-key'));
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'test-thinking-model');
    assert(payload.messages[0].content.includes('不可信'));
    assert(payload.messages[1].content.includes(item.facts));
    return aiResponse(answer);
  });
  await configureMockAi(f);
  const previewRoute = `/api/thinking/cases/${item.id}/ai/preview`;
  const runRoute = `/api/thinking/cases/${item.id}/ai/run`;
  const preview = await ok(f, 'POST', previewRoute, { revision: item.revision });
  item = (await ok(f, 'POST', runRoute, { revision: item.revision, previewId: preview.previewId, approved: true })).thinkingCase;
  assert.equal(item.revision, 2);
  assert.equal(item.analysis.mode, 'ai');
  assert.equal(item.analysis.lenses.length, 3);
  assert.deepEqual(item.analysis.citations, [`case:${item.id}`]);
  await rejectedUnchanged(f, 'POST', runRoute, { revision: item.revision, previewId: preview.previewId, approved: true }, 409);
  assert.equal(calls, 1);
  const savedAi = JSON.parse(JSON.stringify(item.analysis));
  await f.restart();
  assert.deepEqual((await ok(f, 'GET', `/api/thinking/cases/${item.id}`)).thinkingCase, item);
  item = (await ok(f, 'PATCH', `/api/thinking/cases/${item.id}`, { ...thinkingBody({ facts: '新增事实：后续两次实践出现了与原假设相反的结果。', question: '补充问题后重新分析，不沿用旧结论。' }), revision: item.revision })).thinkingCase;
  assert.equal(item.analysis.mode, 'guided');
  assert.equal(item.aiHistory.length, 1);
  assert(JSON.stringify(item.aiHistory[0]).includes(savedAi.summary), 'An edit must retain the previous AI analysis for traceability');
  assert.equal(item.aiHistory[0].caseRevision, 1, 'Archived analysis keeps its input case revision rather than the newer case revision');
  assert.deepEqual(item.aiHistory[0].inputSnapshot, preview.payload, 'Archived analysis retains the approved original facts and sources even after the case facts change');
  const validAnswer = aiThinkingAnswer(item);
  const invalidAnswers = [
    { ...validAnswer, citations: ['case:invented'] },
    { ...validAnswer, lenses: validAnswer.lenses.map((lens, index) => index ? lens : { ...lens, sourceIds: ['task:invented'] }) },
    { ...validAnswer, lenses: validAnswer.lenses.slice(1) },
    { ...validAnswer, lenses: [validAnswer.lenses[0], validAnswer.lenses[0], validAnswer.lenses[2]] },
    { ...validAnswer, lenses: validAnswer.lenses.map((lens, index) => index ? lens : { ...lens, counterargument: '' }) },
    { ...validAnswer, causes: [] },
    { ...validAnswer, disagreements: [] },
    { ...validAnswer, actions: [{ ...validAnswer.actions[0], dimension: 'invented' }] }
  ];
  for (answer of invalidAnswers) {
    const invalidPreview = await ok(f, 'POST', previewRoute, { revision: item.revision });
    await rejectedUnchanged(f, 'POST', runRoute, { revision: item.revision, previewId: invalidPreview.previewId, approved: true }, 502);
    const callsAfterRejection = calls;
    await rejectedUnchanged(f, 'POST', runRoute, { revision: item.revision, previewId: invalidPreview.previewId, approved: true }, 409);
    assert.equal(calls, callsAfterRejection, 'Rejected provider output still consumes the one-time approval');
  }
  assert.equal((await ok(f, 'GET', '/api/tasks')).length, 0);
});

test('thinking AI cannot overwrite a case edited while a provider request is pending', async t => {
  const f = await fixture(t);
  let item = await thinkingCase(f);
  const original = item;
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  mockAi(t, async () => { markStarted(); return new Promise(resolve => { release = () => resolve(aiResponse(aiThinkingAnswer(original))); }); });
  await configureMockAi(f);
  const preview = await ok(f, 'POST', `/api/thinking/cases/${item.id}/ai/preview`, { revision: item.revision });
  const pending = f.request('POST', `/api/thinking/cases/${item.id}/ai/run`, { revision: item.revision, previewId: preview.previewId, approved: true });
  await Promise.race([started, pending.then(response => { throw new Error(`AI request returned ${response.status} before reaching mocked fetch`); })]);
  try {
    item = (await ok(f, 'PATCH', `/api/thinking/cases/${item.id}`, { ...thinkingBody({ facts: 'AI 分析等待期间增加了决定性反例。' }), revision: item.revision })).thinkingCase;
    const afterEdit = await ok(f, 'GET', '/api/export');
    release();
    assert.equal((await pending).status, 409);
    assert.deepEqual(await ok(f, 'GET', '/api/export'), afterEdit, 'A late AI answer must not replace a newer case');
    assert.equal(item.analysis.mode, 'guided');
  } finally { if (release) release(); }
});

test('growth experiments create one real task and require observed evidence before retaining or changing strategies', async t => {
  const current = new Date('2026-10-06T01:00:00.000Z');
  const f = await fixture(t, { clock: () => current });
  const item = await thinkingCase(f);
  for (const patch of [
    { dimension: 'invented' }, { caseId: 'missing-case' }, { hypothesis: '' }, { intervention: '' },
    { metric: '' }, { baseline: '' }, { target: '' }, { reviewAt: 'not-a-date' }, { minutes: 0 }, { minutes: 1441 }
  ]) await rejectedUnchanged(f, 'POST', '/api/growth/experiments', experimentBody(patch), [400, 404]);
  let experiment = (await ok(f, 'POST', '/api/growth/experiments', experimentBody({ caseId: item.id }))).experiment;
  assert.equal(experiment.status, 'planned');
  assert.equal(experiment.revision, 1);
  assert.deepEqual(experiment.reviews, []);
  const startRoute = `/api/growth/experiments/${experiment.id}/start`;
  const reviewRoute = `/api/growth/experiments/${experiment.id}/review`;
  await rejectedUnchanged(f, 'POST', reviewRoute, { ...experimentReview(), revision: experiment.revision }, 409);
  await rejectedUnchanged(f, 'POST', startRoute, { revision: 0 }, 400);
  await rejectedUnchanged(f, 'POST', startRoute, { revision: 2 }, 409);
  const started = await ok(f, 'POST', startRoute, { revision: experiment.revision });
  experiment = started.experiment;
  assert.equal(experiment.status, 'running');
  assert.equal(experiment.revision, 2);
  assert.equal(started.task.title, experiment.intervention);
  assert.notEqual(started.task.isDemo, true);
  assert.equal(started.task.experimentId, experiment.id);
  assert.equal(started.task.minutes, 25);
  for (const patch of [{ title: '悄悄改变实验安排' }, { minutes: 50 }, { dept: '工部' }]) {
    await rejectedUnchanged(f, 'PATCH', `/api/tasks/${started.task.id}`, patch, 409);
  }
  const beforeRepeat = await ok(f, 'GET', '/api/export');
  const repeated = await ok(f, 'POST', startRoute, { revision: 1 });
  assert.equal(repeated.task.id, started.task.id);
  assert.deepEqual(await ok(f, 'GET', '/api/export'), beforeRepeat);
  await rejectedUnchanged(f, 'POST', reviewRoute, { ...experimentReview(), revision: experiment.revision }, 409);
  await rejectedUnchanged(f, 'PATCH', `/api/tasks/${started.task.id}`, { status: 'done' }, 400);
  const evidence = '实践日志：三次学习均有问题、输出与验证结果，仍需更长时间验证。';
  await ok(f, 'PATCH', `/api/tasks/${started.task.id}`, { status: 'done', evidence });
  await rejectedUnchanged(f, 'POST', reviewRoute, { ...experimentReview(), revision: experiment.revision }, 409);
  experiment = (await ok(f, 'GET', '/api/state')).growthExperiments.find(value => value.id === experiment.id);
  assert(experiment.revision > 2, 'New task evidence must invalidate an older review revision');
  for (const patch of [{ observation: '' }, { lesson: '' }, { adjustment: '' }, { outcome: 'refuted', decision: 'keep' }, { outcome: 'inconclusive', decision: 'keep' }]) {
    await rejectedUnchanged(f, 'POST', reviewRoute, { ...experimentReview(patch), revision: experiment.revision }, 400);
  }
  await rejectedUnchanged(f, 'POST', reviewRoute, { ...experimentReview(), revision: 1 }, 409);
  const reviewRevision = experiment.revision;
  experiment = (await ok(f, 'POST', reviewRoute, { ...experimentReview(), revision: experiment.revision })).experiment;
  assert.equal(experiment.status, 'reviewed');
  assert.equal(experiment.revision, reviewRevision + 1);
  assert.equal(experiment.reviews.length, 1);
  assert(JSON.stringify(experiment.reviews[0]).includes(evidence), 'Review must snapshot the actual task evidence');
  const growth = await ok(f, 'GET', '/api/growth');
  assert.equal(growth.strategies.length, 1);
  assert(JSON.stringify(growth.strategies[0]).includes(experiment.id), 'Retained strategy must link back to its experiment');
  for (const patch of [{ status: 'doing' }, { evidence: '复盘后覆盖旧证据' }]) {
    await rejectedUnchanged(f, 'PATCH', `/api/tasks/${started.task.id}`, patch, 409);
  }
  await rejectedUnchanged(f, 'POST', reviewRoute, { ...experimentReview(), revision: experiment.revision }, 409);
  const saved = await ok(f, 'GET', '/api/export');
  const repeatAfterReview = await ok(f, 'POST', startRoute, { revision: 1 });
  assert.equal(repeatAfterReview.task.id, started.task.id);
  assert.deepEqual(await ok(f, 'GET', '/api/export'), saved);
  await f.restart();
  assert.deepEqual(await ok(f, 'GET', '/api/export'), saved);
  assert.deepEqual((await ok(f, 'GET', '/api/growth')).strategies, growth.strategies);
});

test('schema-4 migration preserves existing court work and excludes demo records from growth evidence', async t => {
  const f = await fixture(t, { start: false });
  const legacy = {
    schemaVersion: 4, customMetadata: { keep: 'existing extension' },
    tasks: [
      { id: 'old-real', title: '真实已完成任务', dept: '礼部', status: '已完成', evidence: '真实执行结果', completedAt: '2026-09-28T01:00:00.000Z' },
      { id: 'old-demo', title: '演示任务', dept: '工部', status: '已完成', evidence: '虚构完成记录', isDemo: true, completedAt: '2026-09-28T01:00:00.000Z' }
    ],
    proposals: [{ id: 'old-proposal', title: '保留旧公文', status: 'draft', revision: 3, steps: [], taskIds: [], history: [] }]
  };
  fs.writeFileSync(path.join(f.directory, 'store.json'), JSON.stringify(legacy), 'utf8');
  await f.start();
  const exported = await ok(f, 'GET', '/api/export');
  assert.equal(exported.schemaVersion, 5);
  assert.deepEqual(exported.tasks, legacy.tasks);
  assert.deepEqual(exported.proposals, legacy.proposals);
  assert.deepEqual(exported.customMetadata, legacy.customMetadata);
  for (const key of ['growthAssessments', 'thinkingCases', 'growthExperiments']) assert.deepEqual(exported[key], []);
  const growth = await ok(f, 'GET', '/api/growth');
  assert(growth.evidence.some(item => item.id === 'task:old-real'));
  assert(!growth.evidence.some(item => item.id === 'task:old-demo'));
  assert.equal(growth.latestAssessment, null, 'Migration must not turn old task counts into personal capability scores');
  await rejectedUnchanged(f, 'POST', '/api/growth/assessments', { context: '演示不构成证据', ratings: [{ dimension: 'execution', score: 5, note: '不能基于演示评分', sourceIds: ['task:old-demo'] }] }, [400, 404]);
  await rejectedUnchanged(f, 'POST', '/api/thinking/cases', thinkingBody({ sourceIds: ['task:old-demo'] }), [400, 404]);
  await f.restart();
  assert.deepEqual(await ok(f, 'GET', '/api/export'), exported);
});

test('unsuccessful growth experiments retain corrective strategies and leave the review queue after review', async t => {
  const f = await fixture(t, { clock: () => new Date('2026-10-06T01:00:00.000Z') });
  const expected = [
    { outcome: 'refuted', decision: 'adjust', title: '未达到预期的学习安排', observation: '增加阅读时间后，实践次数没有增加。', lesson: '时间投入不是唯一瓶颈。', adjustment: '把阅读的一半时间改为反馈和练习。' },
    { outcome: 'inconclusive', decision: 'stop', title: '证据不足的复杂计划', observation: '本周只有一次记录，无法区分不同解释。', lesson: '当前计划的收集成本太高。', adjustment: '停止当前方案，重新设计低成本观察。' }
  ];
  for (const review of expected) {
    let experiment = (await ok(f, 'POST', '/api/growth/experiments', experimentBody({ title: review.title }))).experiment;
    assert((await ok(f, 'GET', '/api/growth')).dueExperiments.some(value => value.id === experiment.id));
    const started = await ok(f, 'POST', `/api/growth/experiments/${experiment.id}/start`, { revision: experiment.revision });
    await ok(f, 'PATCH', `/api/tasks/${started.task.id}`, { status: 'done', evidence: review.observation });
    experiment = (await ok(f, 'GET', '/api/state')).growthExperiments.find(value => value.id === experiment.id);
    await ok(f, 'POST', `/api/growth/experiments/${experiment.id}/review`, { ...review, revision: experiment.revision });
    const result = await ok(f, 'GET', '/api/growth');
    assert(!result.dueExperiments.some(value => value.id === experiment.id));
    const strategy = result.strategies.find(value => value.experimentId === experiment.id);
    assert.equal(strategy.decision, review.decision);
    assert.equal(strategy.lesson, review.lesson);
    assert.equal(strategy.adjustment, review.adjustment);
  }
  assert.equal((await ok(f, 'GET', '/api/growth')).strategies.length, 2);
});

test('growth strategy loop feeds AI disclosure, period reports and conflict-safe Obsidian export', async t => {
  const f = await fixture(t, { clock: () => new Date('2026-10-06T01:00:00.000Z') });
  mockAi(t, async () => { throw new Error('Preview must not send an external AI request'); });
  const vault = path.join(f.directory, 'growth-export-vault');
  fs.mkdirSync(vault);
  const rootReadme = '# Existing personal knowledge base\n';
  fs.writeFileSync(path.join(vault, 'README.md'), rootReadme, 'utf8');
  await ok(f, 'POST', '/api/settings', { vaultPath: vault });
  const assessment = (await ok(f, 'POST', '/api/growth/assessments', { context: '为学习实验建立基线', ratings: [{ dimension: 'reflection', score: 2, note: '需要更多真实的反证记录。', sourceIds: [] }] })).assessment;
  let item = await thinkingCase(f);
  item = (await ok(f, 'POST', `/api/thinking/cases/${item.id}/reflect`, { ...thinkingReflection(), revision: item.revision })).thinkingCase;
  let experiment = (await ok(f, 'POST', '/api/growth/experiments', experimentBody({ caseId: item.id }))).experiment;
  const started = await ok(f, 'POST', `/api/growth/experiments/${experiment.id}/start`, { revision: experiment.revision });
  const evidence = '真实观察：三次实践都有输出，但两次未获得外部反馈。';
  await ok(f, 'PATCH', `/api/tasks/${started.task.id}`, { status: 'done', evidence });
  experiment = (await ok(f, 'GET', '/api/state')).growthExperiments.find(value => value.id === experiment.id);
  const review = experimentReview({ outcome: 'inconclusive', decision: 'adjust', observation: evidence, lesson: '输出数量不能代替理解质量。', adjustment: '下一轮增加一次同伴反馈并记录反例。' });
  experiment = (await ok(f, 'POST', `/api/growth/experiments/${experiment.id}/review`, { ...review, revision: experiment.revision })).experiment;
  const overdue = (await ok(f, 'POST', '/api/growth/experiments', experimentBody({ title: '需要回头检查的到期实验' }))).experiment;
  const report = (await ok(f, 'POST', '/api/organize/run', { period: 'daily' })).digest;
  assert.equal(report.stats.experimentsReviewed, 1);
  assert.equal(report.stats.experimentsDue, 1);
  assert(report.markdown.includes('成长实验与策略修订'));
  assert(report.markdown.includes(review.adjustment));
  assert(report.markdown.includes('到期实验提醒'));
  assert(report.markdown.includes(overdue.title));
  assert(report.sourceIds.includes(experiment.id));
  assert(report.sourceIds.includes(overdue.id));
  await configureMockAi(f);
  const aiPreview = await ok(f, 'POST', `/api/thinking/cases/${item.id}/ai/preview`, { revision: item.revision });
  assert(aiPreview.payload.strategies.some(strategy => strategy.experimentId === experiment.id && strategy.adjustment === review.adjustment), 'New analysis can inspect prior strategies with their experiment provenance');
  let preview = await ok(f, 'POST', '/api/obsidian/preview', {});
  for (const section of ['Growth', 'Thinking', 'Experiments']) assert(preview.files.some(file => file.path.startsWith(`PersonalCourt/${section}/`)));
  assert(preview.files.every(file => /^PersonalCourt\/(Reading|Digests|Goals|Growth|Thinking|Experiments)\/[a-f0-9]{64}\.md$/.test(file.path)));
  const growthFile = preview.files.find(file => file.path.startsWith('PersonalCourt/Growth/'));
  assert(growthFile.content.includes(assessment.ratings[0].note));
  const thinkingFile = preview.files.find(file => file.path.startsWith('PersonalCourt/Thinking/'));
  assert(thinkingFile.content.includes(thinkingReflection().counterargument));
  const experimentFile = preview.files.find(file => file.path.startsWith('PersonalCourt/Experiments/') && file.content.includes(review.adjustment));
  assert(experimentFile && experimentFile.content.includes(evidence));
  item = (await ok(f, 'POST', `/api/thinking/cases/${item.id}/reflect`, { ...thinkingReflection({ conclusion: '增加反馈后再决定是否保留策略。' }), revision: item.revision })).thinkingCase;
  await rejectedUnchanged(f, 'POST', '/api/obsidian/export', { previewId: preview.previewId, approved: true }, 409);
  preview = await ok(f, 'POST', '/api/obsidian/preview', {});
  const exported = await ok(f, 'POST', '/api/obsidian/export', { previewId: preview.previewId, approved: true });
  assert.equal(exported.written.length, preview.files.length);
  assert.equal(fs.readFileSync(path.join(vault, 'README.md'), 'utf8'), rootReadme);
  const unchanged = await ok(f, 'POST', '/api/obsidian/preview', {});
  assert(unchanged.files.every(file => file.status === 'unchanged'));
  const noDuplicate = await ok(f, 'POST', '/api/obsidian/export', { previewId: unchanged.previewId, approved: true });
  assert.deepEqual(noDuplicate.written, []);
  const exportedThinkingPath = path.join(vault, thinkingFile.path);
  fs.writeFileSync(exportedThinkingPath, '# Independent reflection must survive\n', 'utf8');
  const conflictPreview = await ok(f, 'POST', '/api/obsidian/preview', {});
  assert.equal(conflictPreview.files.find(file => file.path === thinkingFile.path).status, 'conflict');
  const skipped = await ok(f, 'POST', '/api/obsidian/export', { previewId: conflictPreview.previewId, approved: true });
  assert(skipped.conflicts.some(file => file.path === thinkingFile.path));
  assert.equal(fs.readFileSync(exportedThinkingPath, 'utf8'), '# Independent reflection must survive\n');
});

test('court approval requires four explicit passed checks and concrete review notes', async t => {
  const f = await fixture(t);
  let proposal = await courtProposal(f);
  proposal = (await courtTransition(f, proposal, 'submit')).proposal;
  const route = `/api/court/proposals/${proposal.id}/review`;
  const valid = { revision: proposal.revision, decision: 'approve', note: '逐项检查通过，按当前计划执行。', checks: reviewChecks() };
  const invalid = [
    { checks: undefined }, { checks: [] }, { checks: reviewChecks().slice(1) },
    { checks: [...reviewChecks(), reviewChecks()[0]] },
    { checks: reviewChecks().map((check, index) => index ? check : { ...check, key: 'unknown' }) },
    { checks: reviewChecks().map((check, index) => index === 1 ? { ...check, key: 'feasibility' } : check) },
    ...[false, 'true', 1, null].map(passed => ({ checks: reviewChecks().map((check, index) => index ? check : { ...check, passed }) })),
    { checks: reviewChecks().map((check, index) => index ? check : { ...check, reason: '   ' }) },
    { note: '' }, { note: undefined }
  ];
  for (const patch of invalid) await rejectedUnchanged(f, 'POST', route, { ...valid, ...patch }, 400);
  proposal = (await ok(f, 'POST', route, valid)).proposal;
  assert.equal(proposal.status, 'approved');
  assert.equal(proposal.review.gateVersion, 1);
  assert.deepEqual(proposal.review.checks, valid.checks);
  assert.equal(proposal.review.note, valid.note);
  await f.restart();
  assert.deepEqual((await ok(f, 'GET', `/api/court/proposals/${proposal.id}`)).proposal.review, proposal.review);
  let returned = await courtProposal(f);
  returned = (await courtTransition(f, returned, 'submit')).proposal;
  returned = (await courtTransition(f, returned, 'review', { decision: 'return', note: '缺少风险边界，退回补充。' })).proposal;
  assert.equal(returned.status, 'returned', 'Returning a proposal needs a reason but does not assert passed checks');
});

test('court acceptance checks cover each dispatched task exactly once and preserve their verification reasons', async t => {
  const f = await fixture(t);
  const started = await courtTransition(f, await courtApproved(f), 'dispatch');
  for (const task of started.tasks) await ok(f, 'PATCH', `/api/tasks/${task.id}`, { status: 'done', evidence: `${task.title}的实际成果与验证记录。` });
  let proposal = (await ok(f, 'GET', `/api/court/proposals/${started.proposal.id}`)).proposal;
  const checks = acceptanceChecks(proposal);
  const route = `/api/court/proposals/${proposal.id}/accept`;
  const valid = { revision: proposal.revision, note: '逐项核对完成证据。', checks };
  for (const invalidChecks of [
    undefined, [], checks.slice(1), [...checks, checks[0]], [checks[0], checks[0]],
    checks.map((check, index) => index ? check : { ...check, taskId: 'other-task' }),
    checks.map((check, index) => index ? check : { ...check, passed: false }),
    checks.map((check, index) => index ? check : { ...check, passed: 'true' }),
    checks.map((check, index) => index ? check : { ...check, reason: '' })
  ]) await rejectedUnchanged(f, 'POST', route, { ...valid, checks: invalidChecks }, 400);
  proposal = (await ok(f, 'POST', route, valid)).proposal;
  assert.equal(proposal.status, 'completed');
  assert.deepEqual(proposal.acceptance.checks, checks);
  assert.deepEqual(proposal.acceptance.evidence.map(item => item.taskId).sort(), proposal.taskIds.slice().sort());
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/cancel`, { revision: proposal.revision, note: '不能撤销已经完成的历史。' }, 409);
});

test('pausing and cancelling court work preserve task history while removing active recommendations and workload', async t => {
  const f = await fixture(t, { clock: () => new Date('2026-09-29T01:00:00.000Z') });
  const started = await courtTransition(f, await courtApproved(f, { dept: '工部' }), 'dispatch');
  await ok(f, 'PATCH', `/api/tasks/${started.tasks[0].id}`, { status: 'done', evidence: '暂停前已经验证的成果。' });
  await ok(f, 'PATCH', `/api/tasks/${started.tasks[1].id}`, { status: 'doing', evidence: '尚在推进的中间记录。' });
  let proposal = (await ok(f, 'GET', `/api/court/proposals/${started.proposal.id}`)).proposal;
  const originalTasks = await ok(f, 'GET', '/api/tasks');
  assert.equal((await ok(f, 'GET', '/api/overview')).activeTasks, 1);
  assert((await ok(f, 'GET', '/api/morning')).tasks.some(task => task.id === started.tasks[1].id));
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/pause`, { revision: proposal.revision, note: '' }, 400);
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/pause`, { revision: 1, note: '旧版本暂停' }, 409);
  proposal = (await courtTransition(f, proposal, 'pause', { note: '资源不足，保留执行现场后暂停。' })).proposal;
  assert.equal(proposal.status, 'paused');
  assert.equal(proposal.pausedFrom, 'executing');
  assert.deepEqual(await ok(f, 'GET', '/api/tasks'), originalTasks);
  assert.equal((await ok(f, 'GET', '/api/overview')).activeTasks, 0);
  assert.equal((await ok(f, 'GET', '/api/overview')).completedToday, 1);
  assert.deepEqual((await ok(f, 'GET', '/api/morning')).tasks, []);
  const pausedCourt = await ok(f, 'GET', '/api/court');
  const pausedDept = pausedCourt.departments.find(department => department.id === '工部');
  assert.equal(pausedCourt.stats.paused, 1);
  assert.equal(pausedDept.active, 0);
  assert.equal(pausedDept.estimatedMinutes, 0);
  assert.equal(pausedDept.completed, 1);
  for (const task of originalTasks) for (const patch of [{ status: 'doing' }, { evidence: '暂停时不得改变记录。' }]) {
    await rejectedUnchanged(f, 'PATCH', `/api/tasks/${task.id}`, patch, 409);
  }
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/dispatch`, { revision: proposal.revision }, 409);
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/accept`, { revision: proposal.revision, note: '暂停中不可验收', checks: acceptanceChecks(proposal) }, 409);
  await f.restart();
  assert.deepEqual(await ok(f, 'GET', '/api/tasks'), originalTasks);
  assert.equal((await ok(f, 'GET', '/api/overview')).activeTasks, 0);
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/resume`, { revision: proposal.revision, note: '' }, 400);
  proposal = (await courtTransition(f, proposal, 'resume', { note: '所需资源已恢复，继续原计划。' })).proposal;
  assert.equal(proposal.status, 'executing');
  assert.deepEqual(await ok(f, 'GET', '/api/tasks'), originalTasks);
  assert.equal((await ok(f, 'GET', '/api/overview')).activeTasks, 1);
  assert((await ok(f, 'GET', '/api/morning')).tasks.some(task => task.id === started.tasks[1].id));
  proposal = (await courtTransition(f, proposal, 'pause', { note: '再次暂停，准备评估取消。' })).proposal;
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/cancel`, { revision: proposal.revision, note: '' }, 400);
  proposal = (await courtTransition(f, proposal, 'cancel', { note: '目标已改变，停止剩余投入并保留成果。' })).proposal;
  assert.equal(proposal.status, 'cancelled');
  assert.deepEqual(await ok(f, 'GET', '/api/tasks'), originalTasks);
  assert.equal((await ok(f, 'GET', '/api/overview')).activeTasks, 0);
  assert.equal((await ok(f, 'GET', '/api/overview')).completedToday, 1);
  assert.deepEqual((await ok(f, 'GET', '/api/morning')).tasks, []);
  assert.equal((await ok(f, 'GET', '/api/court')).stats.cancelled, 1);
  for (const action of ['resume', 'pause', 'submit', 'dispatch', 'cancel']) {
    await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/${action}`, { revision: proposal.revision, note: '取消是终态，不可恢复。' }, 409);
  }
  for (const task of originalTasks) await rejectedUnchanged(f, 'PATCH', `/api/tasks/${task.id}`, { status: 'doing' }, 409);
});

test('court cancellation works before dispatch, suspension restores its original stage, and deferred tasks leave today', async t => {
  const f = await fixture(t);
  for (const stage of ['draft', 'review', 'returned', 'approved']) {
    let proposal = await courtProposal(f, { title: `在${stage}阶段停止` });
    if (stage !== 'draft') proposal = (await courtTransition(f, proposal, 'submit')).proposal;
    if (stage === 'returned') proposal = (await courtTransition(f, proposal, 'review', { decision: 'return', note: '缺少资源说明。' })).proposal;
    if (stage === 'approved') {
      proposal = (await courtTransition(f, proposal, 'review', { decision: 'approve' })).proposal;
      proposal = (await courtTransition(f, proposal, 'pause', { note: '先等待时间窗口。' })).proposal;
      assert.equal(proposal.pausedFrom, 'approved');
      proposal = (await courtTransition(f, proposal, 'resume', { note: '时间窗口已到。' })).proposal;
      assert.equal(proposal.status, 'approved');
      assert.deepEqual(proposal.taskIds, []);
    } else {
      await rejectedUnchanged(f, 'POST', `/api/court/proposals/${proposal.id}/pause`, { revision: proposal.revision, note: '此阶段不可暂停。' }, 409);
    }
    proposal = (await courtTransition(f, proposal, 'cancel', { note: '优先级变化，取消本次计划。' })).proposal;
    assert.equal(proposal.status, 'cancelled');
  }
  assert.deepEqual(await ok(f, 'GET', '/api/tasks'), []);
  assert.equal((await ok(f, 'GET', '/api/court')).stats.cancelled, 4);
  const { task } = await ok(f, 'POST', '/api/tasks', { title: '主动顺延的独立任务', priority: '高' });
  await ok(f, 'PATCH', `/api/tasks/${task.id}`, { status: 'deferred' });
  assert(!(await ok(f, 'GET', '/api/morning')).tasks.some(item => item.id === task.id));
  assert(!(await ok(f, 'GET', '/api/overview')).todayTasks.some(item => item.id === task.id));
});

test('legacy approvals must pass the new gate and suspended overdue work never inflates active department metrics', async t => {
  const f = await fixture(t, { start: false, clock: () => new Date('2026-09-29T01:00:00.000Z') });
  const base = proposalBody({ dept: '礼部', steps: [{ id: 'old-step', title: '历史步骤', minutes: 20, acceptance: '保存验证记录' }] });
  const approved = { ...base, id: 'old-approved', status: 'approved', revision: 3, taskIds: [], history: [], review: { decision: 'approve', note: '旧版批准，没有四项核对' } };
  const executing = { ...base, id: 'old-executing', status: 'executing', revision: 4, taskIds: ['old-task'], history: [] };
  const task = { id: 'old-task', title: '历史步骤', dept: '礼部', minutes: 20, status: '执行中', evidence: '已有的执行记录', completedAt: null, proposalId: executing.id, proposalStepId: 'old-step', dueAt: '2026-09-27T01:00:00.000Z' };
  fs.writeFileSync(path.join(f.directory, 'store.json'), JSON.stringify({ schemaVersion: 5, proposals: [approved, executing], tasks: [task] }), 'utf8');
  await f.start();
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${approved.id}/dispatch`, { revision: approved.revision }, 409);
  let reviewed = (await courtTransition(f, approved, 'submit')).proposal;
  assert.equal(reviewed.status, 'review');
  reviewed = (await courtTransition(f, reviewed, 'review', { decision: 'approve' })).proposal;
  assert.equal(reviewed.review.gateVersion, 1);
  assert.equal((await courtTransition(f, reviewed, 'dispatch')).tasks.length, 1);
  const before = (await ok(f, 'GET', '/api/court')).departments.find(department => department.id === '礼部');
  assert.equal(before.overdue, 1);
  assert.equal(before.active, 2);
  let paused = (await courtTransition(f, executing, 'pause', { note: '先暂停旧任务，核对后再继续。' })).proposal;
  const after = (await ok(f, 'GET', '/api/court')).departments.find(department => department.id === '礼部');
  assert.equal(after.overdue, 0);
  assert.equal(after.active, 1);
  assert.equal(after.estimatedMinutes, 20);
  assert.deepEqual((await ok(f, 'GET', '/api/tasks')).find(item => item.id === task.id), task);
  paused = (await courtTransition(f, paused, 'resume', { note: '继续执行历史步骤。' })).proposal;
  await ok(f, 'PATCH', `/api/tasks/${task.id}`, { status: 'done', evidence: '旧任务真实完成结果。' });
  const ready = (await ok(f, 'GET', `/api/court/proposals/${executing.id}`)).proposal;
  await rejectedUnchanged(f, 'POST', `/api/court/proposals/${ready.id}/accept`, { revision: ready.revision, note: '旧执行中计划仍需逐项验收。' }, 400);
  const completed = (await courtTransition(f, ready, 'accept', { note: '旧任务已按新标准验收。' })).proposal;
  assert.equal(completed.status, 'completed');
  await rejectedUnchanged(f, 'PATCH', `/api/tasks/${task.id}`, { evidence: '不允许改动归档证据。' }, 409);
});

test('thinking analysis locks by case identity across edits and releases after conflicts and provider failures', async t => {
  const f = await fixture(t);
  let item = await thinkingCase(f);
  const original = item;
  let calls = 0;
  let release;
  let notifyStarted;
  let invalid = false;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  mockAi(t, async () => {
    calls++;
    if (calls === 1) {
      const response = new Promise(resolve => { release = () => resolve(aiResponse(aiThinkingAnswer(original))); });
      notifyStarted();
      return response;
    }
    return aiResponse(invalid ? { summary: '缺少必需视角与引用的无效结果' } : aiThinkingAnswer(item));
  });
  await configureMockAi(f);
  const previewRoute = `/api/thinking/cases/${item.id}/ai/preview`;
  const runRoute = `/api/thinking/cases/${item.id}/ai/run`;
  const first = await ok(f, 'POST', previewRoute, { revision: item.revision });
  const second = await ok(f, 'POST', previewRoute, { revision: item.revision });
  const pending = f.request('POST', runRoute, { revision: item.revision, previewId: first.previewId, approved: true });
  try {
    await Promise.race([started, pending.then(response => { throw new Error(`Initial analysis returned ${response.status} without reaching the mocked provider`); })]);
    await rejectedUnchanged(f, 'POST', runRoute, { revision: item.revision, previewId: second.previewId, approved: true }, 409);
    assert.equal(calls, 1, 'A second approved preview must not start a duplicate provider request');
    item = (await ok(f, 'PATCH', `/api/thinking/cases/${item.id}`, { ...thinkingBody({ facts: '模型等待期间记录了新的反例。' }), revision: item.revision })).thinkingCase;
    const editedPreview = await ok(f, 'POST', previewRoute, { revision: item.revision });
    await rejectedUnchanged(f, 'POST', runRoute, { revision: item.revision, previewId: editedPreview.previewId, approved: true }, 409);
    assert.equal(calls, 1, 'Changing the case revision must not bypass the case identity lock');
    const afterEdit = await ok(f, 'GET', '/api/export');
    release();
    assert.equal((await pending).status, 409);
    assert.deepEqual(await ok(f, 'GET', '/api/export'), afterEdit);
    const afterConflict = await ok(f, 'POST', previewRoute, { revision: item.revision });
    item = (await ok(f, 'POST', runRoute, { revision: item.revision, previewId: afterConflict.previewId, approved: true })).thinkingCase;
    assert.equal(calls, 2, 'A failed final revision check must release the running lock');
    invalid = true;
    const badPreview = await ok(f, 'POST', previewRoute, { revision: item.revision });
    await rejectedUnchanged(f, 'POST', runRoute, { revision: item.revision, previewId: badPreview.previewId, approved: true }, 502);
    invalid = false;
    const afterFailure = await ok(f, 'POST', previewRoute, { revision: item.revision });
    item = (await ok(f, 'POST', runRoute, { revision: item.revision, previewId: afterFailure.previewId, approved: true })).thinkingCase;
    assert.equal(item.analysis.mode, 'ai');
    assert.equal(calls, 4, 'An invalid provider response must also release the running lock');
  } finally { if (release) release(); await pending; }
});

test('different thinking cases may analyze concurrently without sharing a global case lock', async t => {
  const f = await fixture(t);
  const items = [await thinkingCase(f), await thinkingCase(f, { title: '第二个独立的分析案例' })];
  const releases = [];
  const notifications = [];
  const started = items.map(() => new Promise(resolve => { notifications.push(resolve); }));
  mockAi(t, async (destination, options) => {
    const payload = JSON.parse(JSON.parse(options.body).messages[1].content);
    const caseId = payload.records.find(record => record.type === 'case').id.slice('case:'.length);
    const item = items.find(record => record.id === caseId);
    assert(item);
    const response = new Promise(resolve => { releases.push(() => resolve(aiResponse(aiThinkingAnswer(item)))); });
    notifications[releases.length - 1]();
    return response;
  });
  await configureMockAi(f);
  const previews = [];
  for (const item of items) previews.push(await ok(f, 'POST', `/api/thinking/cases/${item.id}/ai/preview`, { revision: item.revision }));
  const requests = [];
  try {
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const request = f.request('POST', `/api/thinking/cases/${item.id}/ai/run`, { revision: item.revision, previewId: previews[index].previewId, approved: true });
      requests.push(request);
      await Promise.race([started[index], request.then(response => { throw new Error(`Independent case ${index} returned ${response.status} before starting its provider request`); })]);
    }
    assert.equal(releases.length, 2, 'Each distinct case may have its own provider request in flight');
    releases.forEach(release => release());
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert(responses.every(response => response.body.thinkingCase.analysis.mode === 'ai'));
  } finally { releases.forEach(release => release()); await Promise.all(requests); }
});

test('general AI analysis permits only one provider request at a time and unlocks after failure', async t => {
  const f = await fixture(t);
  await reading(f);
  let calls = 0;
  let release;
  let notifyStarted;
  let invalid = false;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  mockAi(t, async (destination, options) => {
    calls++;
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    const sourceId = input.records[0].id;
    const response = aiResponse(invalid ? { summary: '不完整的通用分析' } : { summary: '只依据当前阅读资料提出小型实践。', actions: [{ title: '做一次可验证实践', reason: '检验理解而非重复输入', sourceIds: [sourceId] }], citations: [sourceId] });
    if (calls !== 1) return response;
    const held = new Promise(resolve => { release = () => resolve(response); });
    notifyStarted();
    return held;
  });
  await configureMockAi(f);
  const questions = ['哪些观点值得实践？', '下一周怎样安排练习？'];
  const first = await ok(f, 'POST', '/api/ai/preview', { question: questions[0] });
  const second = await ok(f, 'POST', '/api/ai/preview', { question: questions[1] });
  const pending = f.request('POST', '/api/ai/run', { question: questions[0], previewId: first.previewId, approved: true });
  try {
    await Promise.race([started, pending.then(response => { throw new Error(`Initial generic AI request returned ${response.status} before mocked fetch`); })]);
    await rejectedUnchanged(f, 'POST', '/api/ai/run', { question: questions[1], previewId: second.previewId, approved: true }, 409);
    assert.equal(calls, 1, 'Another question must not bypass the generic analysis lock');
    release();
    assert.equal((await pending).status, 200);
    invalid = true;
    const badPreview = await ok(f, 'POST', '/api/ai/preview', { question: questions[1] });
    await rejectedUnchanged(f, 'POST', '/api/ai/run', { question: questions[1], previewId: badPreview.previewId, approved: true }, 502);
    invalid = false;
    const retry = await ok(f, 'POST', '/api/ai/preview', { question: questions[1] });
    await ok(f, 'POST', '/api/ai/run', { question: questions[1], previewId: retry.previewId, approved: true });
    assert.equal(calls, 3);
    assert.equal((await ok(f, 'GET', '/api/state')).aiAnalyses.length, 2);
  } finally { if (release) release(); await pending; }
});
