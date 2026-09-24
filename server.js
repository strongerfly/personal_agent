const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const DIST_DIR = path.join(__dirname, 'dist');
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const OBSIDIAN_VAULT_DIR = process.env.OBSIDIAN_VAULT_PATH ? path.resolve(process.env.OBSIDIAN_VAULT_PATH) : path.join(DATA_DIR, 'obsidian-vault');

const seedTasks = [
  { id: 1, title: '补齐客户方案的成本测算页', dept: '兵部', owner: '尚书省调度', due: '今天 14:00', status: '执行中', priority: '高', tone: 'red' },
  { id: 2, title: '完成数据分析练习：分组对比', dept: '礼部', owner: '吏部成长计划', due: '今天 16:00', status: '待确认', priority: '中', tone: 'orange' },
  { id: 3, title: '把会议纪要转成三个行动项', dept: '兵部', owner: '通政司', due: '今天 11:30', status: '已完成', priority: '中', tone: 'jade' },
  { id: 4, title: '整理本周视频引用与时间码', dept: '翰林院', owner: '史官周报', due: '今天 17:00', status: '执行中', priority: '低', tone: 'blue' },
  { id: 5, title: '复盘两个顺延任务的估时偏差', dept: '刑部', owner: '史馆复盘', due: '明天 10:00', status: '待确认', priority: '中', tone: 'orange' },
  { id: 6, title: '清理一个重复的自动化提醒', dept: '工部', owner: '系统维护', due: '今天 18:00', status: '已完成', priority: '低', tone: 'jade' }
];

const freshStore = () => ({
  schemaVersion: 2,
  tasks: seedTasks.map(task => ({ ...task })),
  petitions: [],
  reading: [],
  digests: [],
  events: [],
  automation: { enabled: false, dailyHour: 21, weeklyDay: 0, weeklyHour: 21, lastDailyRunDate: null, lastWeeklyRunDate: null },
  integrations: { obsidian: { lastExportAt: null, lastExportFiles: [] } }
});

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, JSON.stringify(freshStore(), null, 2), 'utf8');
}

function readStore() {
  ensureStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    const base = freshStore();
    return {
      ...base,
      ...parsed,
      schemaVersion: 2,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : base.tasks,
      petitions: Array.isArray(parsed.petitions) ? parsed.petitions : [],
      reading: Array.isArray(parsed.reading) ? parsed.reading : [],
      digests: Array.isArray(parsed.digests) ? parsed.digests : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      automation: { ...base.automation, ...(parsed.automation || {}) },
      integrations: { ...base.integrations, ...(parsed.integrations || {}), obsidian: { ...base.integrations.obsidian, ...((parsed.integrations || {}).obsidian || {}) } }
    };
  } catch (error) {
    console.warn('store.json 无法读取，已恢复演示数据:', error.message);
    const fallback = freshStore();
    fs.writeFileSync(STORE_FILE, JSON.stringify(fallback, null, 2), 'utf8');
    return fallback;
  }
}

let store = readStore();

function persist() {
  const tempFile = `${STORE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tempFile, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tempFile, STORE_FILE);
}

function writeTextAtomic(filePath, content) {
  const tempFile = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempFile, content, 'utf8');
  fs.renameSync(tempFile, filePath);
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (error) { reject(new Error('请求必须是 JSON')); }
    });
    req.on('error', reject);
  });
}

function cleanText(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function findById(items, id) {
  return items.find(item => String(item.id) === String(id));
}

function timestamp(value) {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordEvent(type, payload = {}) {
  store.events.unshift({ id: makeId('e'), type, createdAt: new Date().toISOString(), payload });
  store.events = store.events.slice(0, 500);
}

function normalizeReadingItem(item, source = 'wechat_reading') {
  if (!item || typeof item !== 'object') return null;
  const title = cleanText(item.title, 240);
  if (!title) return null;
  const tags = Array.isArray(item.tags) ? item.tags.map(tag => cleanText(tag, 40)).filter(Boolean).slice(0, 12) : [];
  const effectiveSource = cleanText(item.source, 60) || source;
  const fingerprint = crypto.createHash('sha1').update([effectiveSource, title, cleanText(item.author, 160), cleanText(item.quote, 2000), cleanText(item.finishedAt, 40)].join('|')).digest('hex');
  return {
    id: cleanText(item.id, 100) || makeId('r'),
    source: effectiveSource,
    title,
    author: cleanText(item.author, 160),
    progress: Math.max(0, Math.min(100, Number(item.progress) || 0)),
    note: cleanText(item.note, 2000),
    quote: cleanText(item.quote, 2000),
    url: cleanText(item.url, 500),
    tags,
    finishedAt: cleanText(item.finishedAt, 40),
    importedAt: cleanText(item.importedAt, 40) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fingerprint
  };
}

function slugify(value) {
  return cleanText(value, 100).replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'note';
}

function buildDigest(period, trigger = 'manual') {
  const days = period === 'weekly' ? 7 : 1;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const completedTasks = store.tasks.filter(task => task.status === '已完成' && timestamp(task.updatedAt || task.createdAt) >= since);
  const pendingTasks = store.tasks.filter(task => task.status !== '已完成');
  const recentReading = store.reading.filter(item => timestamp(item.importedAt || item.updatedAt) >= since);
  const recentEvents = store.events.filter(event => timestamp(event.createdAt) >= since).slice(0, 20);
  const focusTasks = pendingTasks.filter(task => task.priority === '高' || task.status === '待确认').slice(0, 3);
  const actionItems = focusTasks.map(task => ({ title: task.title, dept: task.dept, status: task.status, priority: task.priority }));
  const highlights = [
    ...completedTasks.slice(0, 5).map(task => `已完成：${task.title}`),
    ...recentReading.slice(0, 5).map(item => `阅读：${item.title}${item.progress ? `（${item.progress}%）` : ''}`)
  ];
  if (!highlights.length) highlights.push('本周期还没有足够的完成记录，建议先捕获一条真实事务。');
  const title = period === 'weekly' ? '本周整理' : '今日整理';
  const markdown = [`# ${title}`, '', `生成时间：${new Date().toLocaleString('zh-CN')}`, '', '## 关键进展', ...highlights.map(item => `- ${item}`), '', '## 下一步动作', ...(actionItems.length ? actionItems.map(item => `- [ ] ${item.title}（${item.dept} · ${item.priority}）`) : ['- [ ] 暂无明确动作，请先补充输入']), '', '## 数据统计', `- 完成任务：${completedTasks.length}`, `- 待处理任务：${pendingTasks.length}`, `- 新增阅读：${recentReading.length}`, `- 记录事件：${recentEvents.length}`].join('\n');
  const digest = { id: makeId('d'), period, trigger, createdAt: new Date().toISOString(), windowStart: new Date(since).toISOString(), stats: { completedTasks: completedTasks.length, pendingTasks: pendingTasks.length, reading: recentReading.length, events: recentEvents.length }, highlights, actionItems, markdown };
  store.digests.unshift(digest);
  store.digests = store.digests.slice(0, 100);
  recordEvent('organize.run', { period, trigger, digestId: digest.id });
  persist();
  return digest;
}

function exportToObsidian() {
  const readingDir = path.join(OBSIDIAN_VAULT_DIR, '10-阅读');
  const digestDir = path.join(OBSIDIAN_VAULT_DIR, '20-整理');
  fs.mkdirSync(readingDir, { recursive: true });
  fs.mkdirSync(digestDir, { recursive: true });
  const files = [];
  for (const item of store.reading) {
    const fileName = `${slugify(item.title)}-${String(item.id).slice(-8)}.md`;
    const content = [`# ${item.title}`, '', item.author ? `作者：${item.author}` : '', `来源：${item.source}`, `进度：${item.progress}%`, item.url ? `原文：${item.url}` : '', '', '## 摘要与笔记', item.note || '暂无笔记', '', '## 摘录', item.quote || '暂无摘录', '', item.tags.length ? `标签：${item.tags.map(tag => `#${slugify(tag)}`).join(' ')}` : ''].filter(Boolean).join('\n');
    writeTextAtomic(path.join(readingDir, fileName), `${content}\n`);
    files.push(path.join('10-阅读', fileName));
  }
  for (const digest of store.digests.slice(0, 20)) {
    const fileName = `${digest.createdAt.slice(0, 10)}-${digest.period}-${digest.id.slice(-8)}.md`;
    writeTextAtomic(path.join(digestDir, fileName), `${digest.markdown}\n`);
    files.push(path.join('20-整理', fileName));
  }
  const index = ['# 个人朝廷 OS', '', '这个目录由个人朝廷 OS 自动生成。', '', '## 最近整理', ...store.digests.slice(0, 20).map(digest => `- [[20-整理/${digest.createdAt.slice(0, 10)}-${digest.period}-${digest.id.slice(-8)}]]`), '', '## 阅读记录', ...store.reading.slice(0, 100).map(item => `- [[10-阅读/${slugify(item.title)}-${String(item.id).slice(-8)}]]`)].join('\n');
  writeTextAtomic(path.join(OBSIDIAN_VAULT_DIR, 'README.md'), `${index}\n`);
  files.push('README.md');
  store.integrations.obsidian.lastExportAt = new Date().toISOString();
  store.integrations.obsidian.lastExportFiles = files;
  recordEvent('obsidian.export', { vaultPath: OBSIDIAN_VAULT_DIR, fileCount: files.length });
  persist();
  return { vaultPath: OBSIDIAN_VAULT_DIR, files, exportedAt: store.integrations.obsidian.lastExportAt };
}

function overview() {
  return {
    tasks: { total: store.tasks.length, pending: store.tasks.filter(task => task.status !== '已完成').length, completed: store.tasks.filter(task => task.status === '已完成').length },
    petitionsPending: store.petitions.filter(petition => petition.status !== '已转任务').length,
    readingCount: store.reading.length,
    digestCount: store.digests.length,
    latestDigest: store.digests[0] || null,
    automation: store.automation,
    obsidian: { ...store.integrations.obsidian, vaultPath: OBSIDIAN_VAULT_DIR }
  };
}

function checkAutomationSchedule() {
  if (!store.automation.enabled) return;
  const now = new Date();
  const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false, hourCycle: 'h23' }).format(now)) % 24;
  const weekdayName = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(now);
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekdayName];
  if (hour === store.automation.dailyHour && store.automation.lastDailyRunDate !== dateKey) {
    buildDigest('daily', 'schedule');
    store.automation.lastDailyRunDate = dateKey;
    persist();
    console.log(`已完成 ${dateKey} 的每日整理`);
  }
  if (weekday === store.automation.weeklyDay && hour === store.automation.weeklyHour && store.automation.lastWeeklyRunDate !== dateKey) {
    buildDigest('weekly', 'schedule');
    store.automation.lastWeeklyRunDate = dateKey;
    persist();
    console.log(`已完成 ${dateKey} 的每周整理`);
  }
}

function handleApi(req, res, pathname, query) {
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'personal-court-os', storage: 'data/store.json', overview: overview() });
  }

  if (req.method === 'GET' && pathname === '/api/overview') {
    return sendJson(res, 200, overview());
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    const limit = Math.max(1, Math.min(100, Number(query.get('limit')) || 30));
    return sendJson(res, 200, { events: store.events.slice(0, limit) });
  }

  if (req.method === 'GET' && pathname === '/api/digests') {
    const period = query.get('period');
    const digests = period ? store.digests.filter(digest => digest.period === period) : store.digests;
    return sendJson(res, 200, { digests: digests.slice(0, 50) });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/digests/')) {
    const digest = findById(store.digests, decodeURIComponent(pathname.slice('/api/digests/'.length)));
    return digest ? sendJson(res, 200, { digest }) : sendError(res, 404, '整理记录不存在');
  }

  if (req.method === 'POST' && pathname === '/api/organize/run') {
    return readBody(req).then(body => {
      const period = body.period === 'weekly' ? 'weekly' : 'daily';
      sendJson(res, 201, { digest: buildDigest(period, 'manual') });
    }).catch(error => sendError(res, 400, error.message));
  }

  if (req.method === 'GET' && pathname === '/api/automation/config') {
    return sendJson(res, 200, { automation: store.automation });
  }

  if ((req.method === 'PATCH' || req.method === 'PUT') && pathname === '/api/automation/config') {
    return readBody(req).then(body => {
      if (body.enabled !== undefined) store.automation.enabled = typeof body.enabled === 'string' ? body.enabled.toLowerCase() === 'true' : body.enabled === true;
      if (body.dailyHour !== undefined) store.automation.dailyHour = Math.max(0, Math.min(23, Number(body.dailyHour) || 0));
      if (body.weeklyDay !== undefined) store.automation.weeklyDay = Math.max(0, Math.min(6, Number(body.weeklyDay) || 0));
      if (body.weeklyHour !== undefined) store.automation.weeklyHour = Math.max(0, Math.min(23, Number(body.weeklyHour) || 0));
      persist();
      sendJson(res, 200, { automation: store.automation });
    }).catch(error => sendError(res, 400, error.message));
  }

  if (req.method === 'GET' && pathname === '/api/reading') {
    return sendJson(res, 200, { reading: store.reading });
  }

  if (req.method === 'POST' && (pathname === '/api/reading/import' || pathname === '/api/integrations/wechat-reading/import')) {
    return readBody(req).then(body => {
      const source = cleanText(body.source, 60) || 'wechat_reading';
      const input = Array.isArray(body) ? body : body.items;
      if (!Array.isArray(input)) return sendError(res, 400, 'items 必须是数组');
      const imported = [];
      const skipped = [];
      for (const rawItem of input.slice(0, 500)) {
        const item = normalizeReadingItem(rawItem, source);
        if (!item) { skipped.push('缺少标题'); continue; }
        const duplicate = store.reading.find(existing => existing.fingerprint === item.fingerprint || (existing.source === item.source && existing.id === item.id));
        if (duplicate) { skipped.push(item.title); continue; }
        store.reading.unshift(item);
        imported.push(item);
      }
      recordEvent('reading.import', { source, imported: imported.length, skipped: skipped.length });
      persist();
      sendJson(res, 201, { imported, skipped, total: store.reading.length });
    }).catch(error => sendError(res, 400, error.message));
  }

  if (req.method === 'GET' && pathname === '/api/obsidian/status') {
    return sendJson(res, 200, { obsidian: { ...store.integrations.obsidian, vaultPath: OBSIDIAN_VAULT_DIR } });
  }

  if (req.method === 'POST' && pathname === '/api/obsidian/preview') {
    const files = ['README.md', ...store.reading.map(item => path.join('10-阅读', `${slugify(item.title)}-${String(item.id).slice(-8)}.md`).replace(/\\/g, '/')), ...store.digests.slice(0, 20).map(digest => path.join('20-整理', `${digest.createdAt.slice(0, 10)}-${digest.period}-${digest.id.slice(-8)}.md`).replace(/\\/g, '/'))];
    return sendJson(res, 200, { vaultPath: OBSIDIAN_VAULT_DIR, files, requiresApproval: true });
  }

  if (req.method === 'POST' && pathname === '/api/obsidian/export') {
    return readBody(req).then(body => {
      if (body.approved !== true) return sendError(res, 400, '导出前需要 approved=true');
      sendJson(res, 201, { export: exportToObsidian() });
    }).catch(error => sendError(res, 400, error.message));
  }

  if (req.method === 'GET' && pathname === '/api/tasks') {
    const tasks = store.tasks.filter(task => (!query.get('dept') || task.dept === query.get('dept')) && (!query.get('status') || task.status === query.get('status')));
    return sendJson(res, 200, { tasks });
  }

  if (req.method === 'PATCH' && pathname.startsWith('/api/tasks/')) {
    const task = findById(store.tasks, decodeURIComponent(pathname.slice('/api/tasks/'.length)));
    if (!task) return sendError(res, 404, '任务不存在');
    return readBody(req).then(body => {
      if (!['待确认', '执行中', '已完成'].includes(body.status)) return sendError(res, 400, '不支持的任务状态');
      task.status = body.status;
      task.updatedAt = new Date().toISOString();
      recordEvent('task.status_changed', { taskId: task.id, status: task.status });
      persist();
      sendJson(res, 200, { task });
    }).catch(error => sendError(res, 400, error.message));
  }

  if (req.method === 'GET' && pathname === '/api/petitions') {
    return sendJson(res, 200, { petitions: store.petitions });
  }

  if (req.method === 'POST' && pathname === '/api/petitions') {
    return readBody(req).then(body => {
      const title = cleanText(body.title, 200);
      if (!title) return sendError(res, 400, '事务标题不能为空');
      const status = body.status === '草稿' ? '草稿' : '已递交';
      const petition = {
        id: makeId('p'),
        title,
        dept: cleanText(body.dept, 30) || '兵部',
        priority: ['高', '中', '低'].includes(body.priority) ? body.priority : '中',
        dueAt: cleanText(body.dueAt, 40),
        note: cleanText(body.note, 1000),
        status,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      store.petitions.unshift(petition);
      recordEvent('petition.created', { petitionId: petition.id, status: petition.status, dept: petition.dept });
      persist();
      sendJson(res, 201, { petition });
    }).catch(error => sendError(res, 400, error.message));
  }

  if (req.method === 'PATCH' && pathname.startsWith('/api/petitions/')) {
    const petition = findById(store.petitions, decodeURIComponent(pathname.slice('/api/petitions/'.length)));
    if (!petition) return sendError(res, 404, '奏折不存在');
    return readBody(req).then(body => {
      if (!['草稿', '已递交', '已转任务'].includes(body.status)) return sendError(res, 400, '不支持的奏折状态');
      petition.status = body.status;
      petition.updatedAt = Date.now();
      recordEvent('petition.status_changed', { petitionId: petition.id, status: petition.status });
      persist();
      sendJson(res, 200, { petition });
    }).catch(error => sendError(res, 400, error.message));
  }

  if (req.method === 'POST' && pathname.startsWith('/api/petitions/') && pathname.endsWith('/convert')) {
    const id = decodeURIComponent(pathname.slice('/api/petitions/'.length, -'/convert'.length));
    const petition = findById(store.petitions, id);
    if (!petition) return sendError(res, 404, '奏折不存在');
    if (petition.status !== '已递交') return sendError(res, 409, '只有已递交的奏折可以转成任务');
    const task = {
      id: Date.now(),
      sourcePetitionId: petition.id,
      title: petition.title,
      dept: petition.dept,
      owner: '尚书省调度',
      due: petition.dueAt ? new Date(petition.dueAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '待排期',
      status: '待确认',
      priority: petition.priority,
      tone: petition.priority === '高' ? 'red' : petition.priority === '低' ? 'blue' : 'orange',
      createdAt: new Date().toISOString()
    };
    store.tasks.unshift(task);
    petition.status = '已转任务';
    petition.updatedAt = Date.now();
    recordEvent('petition.converted_to_task', { petitionId: petition.id, taskId: task.id });
    persist();
    return sendJson(res, 201, { task, petition });
  }

  if (req.method === 'POST' && pathname === '/api/reset') {
    store = freshStore();
    recordEvent('store.reset', {});
    persist();
    return sendJson(res, 200, store);
  }

  if (req.method === 'GET' && pathname === '/api/export') {
    const body = JSON.stringify({ ...store, exportedAt: new Date().toISOString() }, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="personal-court-os-data.json"' });
    return res.end(body);
  }

  return false;
}

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (requestUrl.pathname.startsWith('/api/')) {
    try {
      const handled = handleApi(req, res, requestUrl.pathname, requestUrl.searchParams);
      if (handled === false) sendError(res, 404, 'API 路径不存在');
      else Promise.resolve(handled).catch(error => sendError(res, 500, error.message));
    } catch (error) {
      sendError(res, 500, error.message);
    }
    return;
  }

  const requestedFile = requestUrl.pathname === '/' ? 'index.html' : requestUrl.pathname.replace(/^\/+/, '');
  const filePath = path.resolve(DIST_DIR, requestedFile);
  if (filePath !== DIST_DIR && !filePath.startsWith(`${DIST_DIR}${path.sep}`)) return sendError(res, 403, '禁止访问');
  fs.readFile(filePath, (error, content) => {
    if (error) return sendError(res, error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? '页面不存在' : '读取页面失败');
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(content);
  });
});

const automationTimer = setInterval(checkAutomationSchedule, 60 * 1000);
automationTimer.unref();
checkAutomationSchedule();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`个人朝廷 OS 已启动：http://127.0.0.1:${PORT}`);
  console.log(`数据文件：${STORE_FILE}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
