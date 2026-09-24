const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const DIST_DIR = path.join(__dirname, 'dist');
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

const seedTasks = [
  { id: 1, title: '补齐客户方案的成本测算页', dept: '兵部', owner: '尚书省调度', due: '今天 14:00', status: '执行中', priority: '高', tone: 'red' },
  { id: 2, title: '完成数据分析练习：分组对比', dept: '礼部', owner: '吏部成长计划', due: '今天 16:00', status: '待确认', priority: '中', tone: 'orange' },
  { id: 3, title: '把会议纪要转成三个行动项', dept: '兵部', owner: '通政司', due: '今天 11:30', status: '已完成', priority: '中', tone: 'jade' },
  { id: 4, title: '整理本周视频引用与时间码', dept: '翰林院', owner: '史官周报', due: '今天 17:00', status: '执行中', priority: '低', tone: 'blue' },
  { id: 5, title: '复盘两个顺延任务的估时偏差', dept: '刑部', owner: '史馆复盘', due: '明天 10:00', status: '待确认', priority: '中', tone: 'orange' },
  { id: 6, title: '清理一个重复的自动化提醒', dept: '工部', owner: '系统维护', due: '今天 18:00', status: '已完成', priority: '低', tone: 'jade' }
];

const freshStore = () => ({ schemaVersion: 1, tasks: seedTasks.map(task => ({ ...task })), petitions: [] });

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, JSON.stringify(freshStore(), null, 2), 'utf8');
}

function readStore() {
  ensureStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return { schemaVersion: 1, tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [], petitions: Array.isArray(parsed.petitions) ? parsed.petitions : [] };
  } catch (error) {
    console.warn('store.json 无法读取，已恢复演示数据:', error.message);
    const fallback = freshStore();
    fs.writeFileSync(STORE_FILE, JSON.stringify(fallback, null, 2), 'utf8');
    return fallback;
  }
}

let store = readStore();

function persist() {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
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

function handleApi(req, res, pathname, query) {
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'personal-court-os', storage: 'data/store.json' });
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
    persist();
    return sendJson(res, 201, { task, petition });
  }

  if (req.method === 'POST' && pathname === '/api/reset') {
    store = freshStore();
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
    Promise.resolve(handleApi(req, res, requestUrl.pathname, requestUrl.searchParams)).catch(error => sendError(res, 500, error.message));
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`个人朝廷 OS 已启动：http://127.0.0.1:${PORT}`);
  console.log(`数据文件：${STORE_FILE}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
