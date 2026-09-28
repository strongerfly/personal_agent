const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { createIntegrations, validateSettings } = require('./lib/integrations');

const DAY = 86400000;
const ZONE = 8 * 3600000;
const DEMOS = ['补齐客户方案的成本测算页', '完成数据分析练习：分组对比', '把会议纪要转成三个行动项', '整理本周视频引用与时间码', '复盘两个顺延任务的估时偏差', '清理一个重复的自动化提醒'];
const id = () => crypto.randomUUID();
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const dayKey = date => new Date(+new Date(date) + ZONE).toISOString().slice(0, 10);
const dayStart = date => Date.parse(`${dayKey(date)}T00:00:00+08:00`);
const inRange = (value, start, end) => Number.isFinite(Date.parse(value)) && Date.parse(value) >= start && Date.parse(value) < end;
const done = task => task.status === '已完成';
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const text = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function required(value, label, max = 300) {
  const result = text(value, max);
  if (!result) throw fail(`请填写${label}`);
  return result;
}
function dateValue(value) {
  if (!value) return '';
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw fail('日期格式无效');
  return new Date(value).toISOString();
}
function taskStatus(value) {
  const status = ({ todo: '待确认', doing: '执行中', done: '已完成', deferred: '已顺延' })[value] || value;
  if (!['待确认', '执行中', '已完成', '已顺延'].includes(status)) throw fail('任务状态无效');
  return status;
}
function freshStore() {
  return {
    schemaVersion: 3, tasks: [], petitions: [], reading: [], digests: [], goals: [], checkins: [], runs: [], events: [], aiAnalyses: [],
    settings: { vaultPath: '', readingFolder: 'WeRead', ai: { enabled: false, baseUrl: '', model: '' } },
    automation: { enabled: false, dailyHour: 21, weeklyDay: 0, weeklyHour: 21, autoImport: false, timezone: 'Asia/Shanghai', lastDailyRunDate: null, lastWeeklyRunDate: null },
    integrations: { obsidian: { lastExportAt: null, lastExportFiles: [] } }
  };
}
function migrate(parsed) {
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw fail('数据文件结构无效，原文件已保留', 500);
  const base = freshStore();
  for (const key of ['tasks', 'petitions', 'reading', 'digests', 'goals', 'checkins', 'runs', 'events', 'aiAnalyses']) {
    if (parsed[key] !== undefined && !Array.isArray(parsed[key])) throw fail(`数据字段 ${key} 无效，原文件已保留`, 500);
  }
  const result = { ...base, ...parsed, schemaVersion: 3 };
  result.settings = { ...base.settings, ...parsed.settings, ai: { ...base.settings.ai, ...parsed.settings?.ai } };
  result.automation = { ...base.automation, ...parsed.automation, timezone: 'Asia/Shanghai' };
  result.integrations = { ...base.integrations, ...parsed.integrations };
  if ((parsed.schemaVersion || 1) < 3) {
    result.tasks = result.tasks.map(task => ({ ...task, isDemo: task.isDemo || (typeof task.id === 'number' && DEMOS[task.id - 1] === task.title), completedAt: task.completedAt || (done(task) ? task.updatedAt : undefined) }));
    result.reading = result.reading.map(item => ({ ...item, createdAt: item.createdAt || item.importedAt || item.updatedAt, reviewCount: item.reviewCount || 0, reviews: item.reviews || [] }));
  }
  return result;
}

function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.PERSONAL_AGENT_DATA_DIR || path.join(__dirname, 'data'));
  const now = () => new Date(options.clock ? options.clock() : Date.now());
  const stamp = () => now().toISOString();
  fs.mkdirSync(dataDir, { recursive: true });
  const storeFile = path.join(dataDir, 'store.json');
  const lockFile = path.join(dataDir, 'server.lock');
  const lockToken = `${process.pid}:${id()}`;
  try { fs.writeFileSync(lockFile, lockToken, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // mkdir is an exclusive recovery mutex: competing starters cannot remove a new lock.
    const recoveryDir = path.join(dataDir, 'server.lock-recovery');
    try { fs.mkdirSync(recoveryDir); }
    catch { throw fail('另一个进程正在恢复服务锁；若恢复中断，请确认服务已停止后检查 server.lock-recovery', 503); }
    try {
      if (fs.existsSync(lockFile)) {
        const pid = Number(fs.readFileSync(lockFile, 'utf8').split(':')[0]);
        let active = true;
        try { process.kill(pid, 0); } catch (probe) { if (probe.code === 'ESRCH') active = false; }
        if (active || !Number.isInteger(pid) || pid < 1) throw fail('此数据目录已被另一个进程使用，请先停止原服务', 503);
        fs.unlinkSync(lockFile);
      }
      fs.writeFileSync(lockFile, lockToken, { flag: 'wx' });
    } finally { fs.rmdirSync(recoveryDir); }
  }
  const release = () => { if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8') === lockToken) fs.unlinkSync(lockFile); };
  let store;
  try {
    store = fs.existsSync(storeFile) ? migrate(JSON.parse(fs.readFileSync(storeFile, 'utf8'))) : freshStore();
    if (!fs.existsSync(storeFile)) fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), { flag: 'wx' });
  } catch { release(); throw fail('无法读取数据文件；未覆盖原文件。请检查 store.json 或从 store.backup.json 恢复。', 500); }
  function mutate(operation) {
    const draft = structuredClone(store);
    const result = operation(draft);
    const temporary = `${storeFile}.${process.pid}.tmp`;
    const backupTemp = path.join(dataDir, `store.backup.${process.pid}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(draft, null, 2), { mode: 0o600 });
    fs.copyFileSync(storeFile, backupTemp);
    fs.renameSync(backupTemp, path.join(dataDir, 'store.backup.json'));
    fs.renameSync(temporary, storeFile);
    store = draft;
    return result;
  }
  const event = (draft, type, sourceId, detail = '') => draft.events.push({ id: id(), type, sourceId, detail: text(detail, 300), createdAt: stamp() });
  const integrations = createIntegrations({ dataDir, getStore: () => store });
  const lookup = (draft, list, itemId) => {
    const item = draft[list].find(entry => String(entry.id) === String(itemId));
    if (!item) throw fail('记录不存在', 404);
    return item;
  };
  function newTask(draft, body, source = {}) {
    if (source.sourceId) {
      const existing = draft.tasks.find(task => task.sourceId === source.sourceId && task.sourceType === source.sourceType);
      if (existing) return existing;
    }
    const goalId = text(body.goalId);
    if (goalId) lookup(draft, 'goals', goalId);
    const minutes = body.minutes === undefined || body.minutes === '' ? 25 : Number(body.minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw fail('预计时间需在 1–1440 分钟之间');
    const priority = ['高', '中', '低'].includes(body.priority) ? body.priority : '中';
    const task = { id: id(), title: required(body.title, '行动标题'), dept: text(body.dept, 30) || '兵部', priority, status: '待确认', goalId, dueAt: dateValue(body.dueAt), minutes, evidence: '', createdAt: stamp(), updatedAt: stamp(), ...source };
    draft.tasks.push(task); event(draft, 'task.created', task.id); return task;
  }
  function parseReading(body) {
    if (Array.isArray(body.items)) return body.items;
    if (body.format === 'json') {
      let parsed;
      try { parsed = JSON.parse(body.text); } catch { throw fail('JSON 格式无效，请检查括号和引号'); }
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.items)) return parsed.items;
      throw fail('JSON 应为数组或包含 items 数组的对象');
    }
    const raw = required(body.text, '导入内容', 200000);
    const title = text(body.title, 300) || text(raw.match(/^#\s+(.+)$/m)?.[1], 300) || text(raw.split('\n').find(line => line.trim()), 80);
    const quote = raw.split('\n').filter(line => /^>\s?/.test(line)).map(line => line.replace(/^>\s?/, '')).join('\n');
    return [{ title, note: raw, quote, source: body.format === 'markdown' ? 'markdown' : 'manual', sourceId: hash(raw) }];
  }
  function importReading(items, origin = 'manual') {
    if (!Array.isArray(items) || items.length > 500) throw fail('每批最多导入 500 条记录');
    return mutate(draft => {
      let imported = 0, updated = 0, skipped = 0;
      const errors = [];
      items.forEach((item, index) => {
        try {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw fail('记录应为对象');
          const title = required(item.title || item.bookTitle, '书名');
          const source = text(item.source, 60) || origin;
          const sourceId = text(String(item.sourceId || item.bookId || item.id || ''), 500) || hash([title, text(item.author), text(item.quote)].join('\n'));
          const readingId = hash(`${source}:${sourceId}`);
          let record = draft.reading.find(entry => entry.id === readingId || (entry.source === source && (entry.sourceId === sourceId || String(entry.id) === String(item.id) || (!entry.sourceId && entry.title === title && text(entry.author) === text(item.author) && text(entry.quote) === text(item.quote)))));
          const progress = item.progress === undefined ? record?.progress : Number(item.progress);
          if (progress !== undefined && (!Number.isFinite(progress) || progress < 0 || progress > 100)) throw fail('阅读进度需在 0–100 之间');
          const content = { title, author: text(item.author, 200), note: text(item.note || item.notes || item.content, 30000), quote: text(item.quote || item.highlight, 20000), tags: Array.isArray(item.tags) ? item.tags.filter(tag => typeof tag === 'string').slice(0, 30).map(tag => text(tag, 60)) : [], progress, source, sourceId, sourcePath: text(item.sourcePath, 1000), url: /^https?:\/\//i.test(text(item.url)) ? text(item.url, 2000) : '', sourceUpdatedAt: item.sourceUpdatedAt ? dateValue(item.sourceUpdatedAt) : '' };
          const fingerprint = hash(JSON.stringify(content));
          if (record?.fingerprint === fingerprint) { skipped++; return; }
          if (record) { Object.assign(record, content, { fingerprint, updatedAt: stamp() }); updated++; }
          else {
            record = { id: readingId, ...content, fingerprint, createdAt: stamp(), updatedAt: stamp(), nextReviewAt: stamp(), reviewCount: 0, reviewStep: 0, reviews: [] };
            draft.reading.push(record); imported++;
          }
          event(draft, 'reading.imported', record.id);
        } catch (error) { errors.push({ index, message: error.statusCode ? error.message : '此记录无法解析' }); }
      });
      return { imported, updated, skipped, failed: errors.length, errors, total: draft.reading.length };
    });
  }
  function morning() {
    const energy = [...store.checkins].reverse().find(checkin => dayKey(checkin.createdAt) === dayKey(now()))?.energy || 3;
    const activeGoals = new Set(store.goals.filter(goal => goal.status === 'active').map(goal => goal.id));
    const score = task => (task.dueAt && Date.parse(task.dueAt) < +now() + DAY ? 5 : 0) + (activeGoals.has(task.goalId) ? 4 : 0) + ({ 高: 3, 中: 2, 低: 1 }[task.priority] || 1) + (energy <= 2 && (task.minutes || 25) <= 25 ? 2 : 0);
    const tasks = store.tasks.filter(task => !task.isDemo && !done(task)).sort((a, b) => score(b) - score(a) || String(a.createdAt).localeCompare(String(b.createdAt))).slice(0, 3);
    return { tasks, energy, reason: energy <= 2 ? '优先临近截止与目标相关的行动，低精力时倾向短任务。' : '按截止时间、目标关联和优先级排序，每次聚焦最多三件事。' };
  }
  function overview() {
    const tasks = store.tasks.filter(task => !task.isDemo);
    const start = dayStart(now());
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = start - (6 - index) * DAY;
      return { date: dayKey(date), completed: tasks.filter(task => done(task) && inRange(task.completedAt, date, date + DAY)).length, reading: store.reading.filter(item => inRange(item.createdAt, date, date + DAY)).length };
    });
    let streak = 0;
    const activeDays = new Set([...tasks.filter(done).map(task => task.completedAt).filter(Boolean), ...store.checkins.map(item => item.createdAt)].map(dayKey));
    let cursor = activeDays.has(dayKey(start)) ? start : start - DAY;
    while (activeDays.has(dayKey(cursor)) && streak < 36500) { streak++; cursor -= DAY; }
    return { activeTasks: tasks.filter(task => !done(task)).length, completedToday: days[6].completed, activeGoals: store.goals.filter(goal => goal.status === 'active').length, readingCount: store.reading.length, dueReviews: store.reading.filter(item => !item.nextReviewAt || Date.parse(item.nextReviewAt) <= +now()).length, completionRate: tasks.length ? Math.round(tasks.filter(done).length / tasks.length * 100) : null, streak, days, todayTasks: morning().tasks };
  }
  function digest(period, at = now()) {
    if (!['daily', 'weekly'].includes(period)) throw fail('整理周期应为 daily 或 weekly');
    let start = dayStart(at);
    if (period === 'weekly') start -= ((new Date(start + ZONE).getUTCDay() + 6) % 7) * DAY;
    const end = start + (period === 'weekly' ? 7 : 1) * DAY;
    const key = `${period}:${dayKey(start)}`;
    return mutate(draft => {
      const completed = draft.tasks.filter(task => !task.isDemo && done(task) && inRange(task.completedAt, start, end));
      const readings = draft.reading.filter(item => inRange(item.createdAt, start, end));
      const reviews = draft.reading.flatMap(item => (item.reviews || []).filter(review => inRange(review.createdAt, start, end)).map(review => ({ ...review, sourceId: item.id })));
      const checkins = draft.checkins.filter(item => inRange(item.createdAt, start, end));
      const highlights = completed.map(task => ({ text: task.title, sourceId: task.id, evidence: task.evidence || '' }));
      const actionItems = morning().tasks.map(task => ({ title: task.title, reason: task.goalId ? '推进关联目标' : '完成现有承诺', sourceIds: [task.id], taskId: task.id }));
      if (actionItems.length < 3 && readings.length) actionItems.push({ title: `应用《${readings[0].title}》中的一个观点，写下实践结果`, reason: '让阅读形成实际产出', sourceIds: [readings[0].id], sourceType: 'reading' });
      const stats = { completedTasks: completed.length, evidenceTasks: completed.filter(task => text(task.evidence)).length, readingAdded: readings.length, reviews: reviews.length, checkins: checkins.length, averageEnergy: checkins.length ? Number((checkins.reduce((sum, item) => sum + item.energy, 0) / checkins.length).toFixed(1)) : null };
      const markdown = [`# ${dayKey(start)} ${period === 'weekly' ? '周复盘' : '日复盘'}`, '', `周期：${dayKey(start)} 至 ${dayKey(end - 1)}（Asia/Shanghai）`, `生成时间：${stamp()}；当前周期数据随重新生成更新。`, '', '## 实际进展', `- 已完成行动：${stats.completedTasks}（有证据 ${stats.evidenceTasks}）`, `- 新增阅读：${stats.readingAdded}；复习：${stats.reviews} 次`, `- 精力：${stats.averageEnergy === null ? '尚未记录' : `${stats.averageEnergy}/5`}；签到 ${stats.checkins} 次`, '', '## 完成证据', ...(highlights.length ? highlights.map(item => `- ${item.text}\n  - 证据：${item.evidence || '旧记录未提供'}\n  - 来源：${item.sourceId}`) : ['本周期尚无已完成行动。']), '', '## 阅读与思考', ...(readings.length ? readings.map(item => `- 《${item.title}》：${(item.note || item.quote || '待补充自己的理解').slice(0, 400)}\n  - 来源：${item.id}`) : ['本周期没有新增阅读记录。']), '', '## 阻碍与调整', ...(checkins.length ? checkins.map(item => `- ${item.note || '已记录精力'}${item.blocker ? `；阻碍：${item.blocker}` : ''}${item.tomorrow ? `；下一步：${item.tomorrow}` : ''}`) : ['尚未记录，可用一次简短签到补充。']), '', '## 下一步', ...actionItems.map(item => `- [ ] ${item.title}（${item.reason}；来源：${item.sourceIds.join(', ')}）`), '', '> 本报告由本地规则整理，不代表 AI 已验证或知识已掌握。'].join('\n');
      const previous = draft.digests.find(item => item.periodKey === key);
      const report = { id: previous?.id || id(), period, periodKey: key, periodStart: new Date(start).toISOString(), periodEnd: new Date(end).toISOString(), createdAt: previous?.createdAt || stamp(), updatedAt: stamp(), markdown, stats, highlights, actionItems, sourceIds: [...new Set([...completed, ...readings, ...checkins].map(item => item.id).concat(reviews.map(item => item.sourceId)))] };
      if (previous) draft.digests[draft.digests.indexOf(previous)] = report; else draft.digests.unshift(report);
      event(draft, 'digest.generated', report.id); return report;
    });
  }
  let ticking = false;
  function tick({ manual = false } = {}) {
    if (!store.automation.enabled || ticking) return { skipped: true, reason: ticking ? '任务正在运行' : '自动整理未开启' };
    ticking = true;
    const results = [];
    try {
      const auto = store.automation;
      const start = dayStart(now());
      let daily = start + auto.dailyHour * 3600000;
      if (daily > +now()) daily -= DAY;
      let weekly = start - ((new Date(start + ZONE).getUTCDay() - auto.weeklyDay + 7) % 7) * DAY + auto.weeklyHour * 3600000;
      if (weekly > +now()) weekly -= 7 * DAY;
      for (const [period, scheduledAt] of [['daily', daily], ['weekly', weekly]]) {
        const runKey = `${period}:${dayKey(scheduledAt)}`;
        const runs = store.runs.filter(run => run.key === runKey);
        if (runs.some(run => run.status === 'success') || (!manual && runs.length >= 3)) continue;
        const last = runs[runs.length - 1];
        if (!manual && last && +now() - Date.parse(last.createdAt) < runs.length * 60000) continue;
        const runId = id();
        mutate(draft => draft.runs.push({ id: runId, key: runKey, type: period, status: 'running', attempt: runs.length + 1, scheduledAt: new Date(scheduledAt).toISOString(), createdAt: stamp() }));
        try {
          const warnings = [];
          if (auto.autoImport) {
            const incoming = integrations.readVault();
            const result = importReading(incoming.items, 'obsidian');
            warnings.push(...(incoming.warnings || []), ...result.errors.map(error => `记录 ${error.index + 1}：${error.message}`));
          }
          const report = digest(period, new Date(scheduledAt));
          mutate(draft => {
            Object.assign(lookup(draft, 'runs', runId), { status: 'success', digestId: report.id, warnings, finishedAt: stamp() });
            draft.automation[period === 'daily' ? 'lastDailyRunDate' : 'lastWeeklyRunDate'] = dayKey(scheduledAt);
          });
          results.push({ period, status: 'success', digestId: report.id, warnings });
        } catch (error) {
          const message = error.statusCode ? error.message : '本次整理失败，请检查数据目录权限';
          mutate(draft => Object.assign(lookup(draft, 'runs', runId), { status: 'failed', error: message, finishedAt: stamp() }));
          results.push({ period, status: 'failed', error: message });
        }
      }
      return { runs: results };
    } finally { ticking = false; }
  }
  if (store.runs.some(run => run.status === 'running')) mutate(draft => draft.runs.forEach(run => {
    if (run.status === 'running') Object.assign(run, { status: 'failed', error: '上次服务中断，将按重试策略恢复', finishedAt: stamp() });
  }));
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let bytes = 0;
      req.on('data', chunk => { bytes += chunk.length; if (bytes <= 1024 * 1024) chunks.push(chunk); });
      req.on('end', () => {
        if (bytes > 1024 * 1024) return reject(fail('请求超过 1 MB，请分批导入', 413));
        try {
          const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail('请求应为 JSON 对象');
          resolve(parsed);
        } catch { reject(fail('请求 JSON 格式无效')); }
      });
      req.on('error', reject);
    });
  }
  function send(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  }
  async function api(req, res, url) {
    const route = url.pathname, method = req.method;
    const write = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method);
    if (write) {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw fail('写入请求需要 application/json', 415);
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw fail('不允许跨站写入', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fail('不允许跨站写入', 403);
    }
    const body = write ? await readBody(req) : {};
    if (method === 'GET' && route === '/api/health') return { ok: true, version: '0.2.0', schemaVersion: 3, timezone: 'Asia/Shanghai' };
    if (method === 'GET' && route === '/api/state') return { ...store, events: store.events.slice(-100).reverse(), runs: store.runs.slice(-100).reverse(), overview: overview(), integrations: integrations.status() };
    if (method === 'GET' && route === '/api/overview') return overview();
    if (method === 'GET' && route === '/api/morning') return morning();
    if (method === 'GET' && route === '/api/export') { res.setHeader('Content-Disposition', 'attachment; filename="personal-court-backup.json"'); return store; }
    for (const list of ['tasks', 'petitions', 'reading', 'digests', 'goals', 'checkins', 'events', 'runs']) {
      if (method === 'GET' && route === `/api/${list}`) return store[list].filter(item => !url.searchParams.get('dept') || item.dept === url.searchParams.get('dept')).filter(item => !url.searchParams.get('status') || item.status === url.searchParams.get('status'));
    }
    if (method === 'POST' && route === '/api/tasks') return { task: mutate(draft => newTask(draft, body)) };
    let match = route.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === 'PATCH' && match) return { task: mutate(draft => {
      const task = lookup(draft, 'tasks', match[1]);
      if (body.title !== undefined) task.title = required(body.title, '行动标题');
      if (body.evidence !== undefined) task.evidence = text(body.evidence, 4000);
      if (done(task) && body.status === undefined && !text(task.evidence)) throw fail('已完成行动需要保留完成证据');
      if (body.dueAt !== undefined) task.dueAt = dateValue(body.dueAt);
      if (body.goalId !== undefined) { if (body.goalId) lookup(draft, 'goals', body.goalId); task.goalId = text(body.goalId); }
      if (body.status !== undefined) {
        const status = taskStatus(body.status);
        if (status === '已完成' && !text(task.evidence)) throw fail('请记录完成证据：做出了什么、如何验证');
        if (status === '已完成' && !done(task)) { task.completedAt = stamp(); event(draft, 'task.completed', task.id); }
        if (status !== '已完成') task.completedAt = null;
        task.status = status;
      }
      task.updatedAt = stamp(); return task;
    }) };
    if (method === 'POST' && route === '/api/goals') return { goal: mutate(draft => {
      const goal = { id: id(), title: required(body.title, '目标'), why: text(body.why), targetDate: dateValue(body.targetDate), status: 'active', createdAt: stamp() };
      draft.goals.push(goal); event(draft, 'goal.created', goal.id); return goal;
    }) };
    match = route.match(/^\/api\/goals\/([^/]+)$/);
    if (method === 'PATCH' && match) return { goal: mutate(draft => {
      const goal = lookup(draft, 'goals', match[1]);
      if (!['active', 'completed'].includes(body.status)) throw fail('目标状态无效');
      goal.status = body.status; goal.updatedAt = stamp(); return goal;
    }) };
    if (method === 'POST' && route === '/api/petitions') return { petition: mutate(draft => {
      const petition = { id: id(), title: required(body.title, '想法标题'), note: text(body.note, 10000), status: '待澄清', createdAt: stamp() };
      draft.petitions.push(petition); event(draft, 'capture.created', petition.id); return petition;
    }) };
    match = route.match(/^\/api\/petitions\/([^/]+)\/convert$/);
    if (method === 'POST' && match) return { task: mutate(draft => {
      const petition = lookup(draft, 'petitions', match[1]);
      const task = newTask(draft, { title: petition.title }, { sourceType: 'petition', sourceId: petition.id });
      petition.status = '已转行动'; petition.taskId = task.id; return task;
    }) };
    if (method === 'POST' && route === '/api/checkins') return { checkin: mutate(draft => {
      const energy = Number(body.energy);
      if (!Number.isInteger(energy) || energy < 1 || energy > 5) throw fail('精力评分应为 1–5');
      const checkin = { id: id(), energy, note: text(body.note), blocker: text(body.blocker), tomorrow: text(body.tomorrow), createdAt: stamp() };
      draft.checkins.push(checkin); event(draft, 'checkin.created', checkin.id); return checkin;
    }) };
    if (method === 'POST' && ['/api/reading/import', '/api/integrations/wechat-reading/import'].includes(route)) return importReading(parseReading(body), text(body.source, 60) || (route.includes('wechat-reading') ? 'wechat_reading' : 'manual'));
    match = route.match(/^\/api\/reading\/([^/]+)\/(review|task)$/);
    if (method === 'POST' && match) return mutate(draft => {
      const item = lookup(draft, 'reading', match[1]);
      if (match[2] === 'task') return { task: newTask(draft, { title: body.title || `应用《${item.title}》中的一个观点` }, { sourceType: 'reading', sourceId: item.id }) };
      if (!['again', 'good'].includes(body.rating)) throw fail('复习反馈应为 again 或 good');
      const answer = required(body.answer, '自己的回忆内容或遗忘之处', 4000);
      const steps = [1, 3, 7, 14, 30], step = body.rating === 'again' ? 0 : Math.min(item.reviewStep || 0, steps.length - 1);
      item.nextReviewAt = new Date(+now() + (body.rating === 'again' ? 10 * 60000 : steps[step] * DAY)).toISOString();
      item.reviewStep = body.rating === 'again' ? 0 : Math.min(step + 1, steps.length - 1);
      item.reviewCount = (item.reviewCount || 0) + 1;
      item.reviews = [...(item.reviews || []), { id: id(), rating: body.rating, answer, createdAt: stamp() }];
      item.updatedAt = stamp(); event(draft, 'reading.reviewed', item.id); return { reading: item };
    });
    if (method === 'POST' && route === '/api/organize/run') return { digest: digest(body.period || 'daily') };
    match = route.match(/^\/api\/digests\/([^/]+)\/actions\/(\d+)$/);
    if (method === 'POST' && match) return { task: mutate(draft => {
      const report = lookup(draft, 'digests', match[1]), action = report.actionItems?.[Number(match[2])];
      if (!action) throw fail('建议不存在', 404);
      if (action.taskId) return lookup(draft, 'tasks', action.taskId);
      const task = newTask(draft, { title: action.title }, { sourceType: 'digest', sourceId: `${report.id}:${hash(action.title)}`, sourceIds: action.sourceIds });
      action.taskId = task.id; return task;
    }) };
    if (method === 'POST' && route === '/api/settings') return { settings: mutate(draft => { draft.settings = validateSettings(draft.settings, body); return draft.settings; }) };
    if (method === 'GET' && route === '/api/automation/config') return store.automation;
    if (method === 'PATCH' && route === '/api/automation/config') return { automation: mutate(draft => {
      for (const field of ['dailyHour', 'weeklyDay', 'weeklyHour']) if (body[field] !== undefined) {
        const value = Number(body[field]);
        if (!Number.isInteger(value) || value < 0 || value > (field === 'weeklyDay' ? 6 : 23)) throw fail('调度时间无效');
        draft.automation[field] = value;
      }
      for (const field of ['enabled', 'autoImport']) if (body[field] !== undefined) {
        if (typeof body[field] !== 'boolean') throw fail('开关应为布尔值');
        draft.automation[field] = body[field];
      }
      return draft.automation;
    }) };
    if (method === 'POST' && route === '/api/automation/tick') return tick({ manual: true });
    if (method === 'GET' && route === '/api/obsidian/status') return integrations.status();
    if (method === 'POST' && route === '/api/obsidian/import') {
      const incoming = integrations.readVault();
      return { ...importReading(incoming.items, 'obsidian'), warnings: incoming.warnings || [] };
    }
    if (method === 'POST' && route === '/api/obsidian/preview') return integrations.preview();
    if (method === 'POST' && route === '/api/obsidian/export') {
      const result = integrations.exportVault(body);
      mutate(draft => { draft.integrations.obsidian = { ...draft.integrations.obsidian, lastExportAt: stamp(), lastExportFiles: result.files || [] }; event(draft, 'obsidian.exported', '', '本地 Markdown 导出'); });
      return result;
    }
    if (method === 'POST' && route === '/api/ai/preview') return integrations.aiPreview(body);
    if (method === 'POST' && route === '/api/ai/run') {
      const result = await integrations.analyze(body);
      const analysis = { ...result, id: id(), question: text(body.question), createdAt: stamp() };
      mutate(draft => { draft.aiAnalyses.unshift(analysis); draft.aiAnalyses = draft.aiAnalyses.slice(0, 50); event(draft, 'ai.analyzed', analysis.id); });
      return { analysis };
    }
    if (route === '/api/reset') throw fail('已停用重置接口，请使用数据导出备份', 410);
    throw fail('接口不存在', 404);
  }
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) throw fail('仅允许本机访问', 403);
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname.startsWith('/api/')) { const result = await api(req, res, url); if (!res.writableEnded) send(res, 200, result); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw fail('请求方法不支持', 405);
      const dist = path.join(__dirname, 'dist');
      const file = path.resolve(dist, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
      if (!file.startsWith(dist + path.sep)) throw fail('路径无效', 403);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw fail('页面不存在', 404);
      const contentType = ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
    } catch (error) { send(res, error.statusCode || 500, { error: error.statusCode ? error.message : '操作失败，请检查本地服务或数据目录权限' }); }
  });
  server.requestTimeout = 35000;
  let timer;
  if (options.schedule !== false) {
    timer = setInterval(() => { try { tick(); } catch { console.error('自动整理执行失败，请检查数据目录权限'); } }, 60000);
    timer.unref();
    server.once('listening', () => { try { tick(); } catch { console.error('启动补跑失败，请在运行记录中检查'); } });
  }
  const close = () => new Promise(resolve => {
    clearInterval(timer);
    if (server.listening) { server.close(() => { release(); resolve(); }); server.closeIdleConnections?.(); }
    else { release(); resolve(); }
  });
  return { server, close, tick, getStore: () => structuredClone(store), dataDir };
}
if (require.main === module) {
  try {
    const app = createApp(), port = Number(process.env.PORT || 3000);
    app.server.on('error', async error => { console.error(error.code === 'EADDRINUSE' ? '端口已被占用，请更换 PORT 或停止原服务' : '服务启动失败'); await app.close(); process.exitCode = 1; });
    app.server.listen(port, '127.0.0.1', () => console.log(`个人朝廷 OS：http://127.0.0.1:${port}`));
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; await app.close(); process.exit(0); });
  } catch (error) { console.error(error.statusCode ? error.message : '服务启动失败，请检查数据目录权限'); process.exitCode = 1; }
}
module.exports = { createApp, dayKey, dayStart };
