import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || '127.0.0.1';
// Overridable so tests run against a throwaway file, not the live feed.
const DATA_FILE = process.env.HUB_DATA_FILE || join(ROOT, 'data', 'messages.json');
const PUBLIC = join(ROOT, 'public');
const MAX_BODY = 32 * 1024;
const TYPES = new Set(['idea', 'contract', 'question', 'blocker', 'update', 'task']);
let messages = [];
let tasks = [];
const clients = new Set();

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function load() {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  try {
    const raw = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    messages = Array.isArray(raw) ? raw : (raw.messages || []);
    tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  } catch { messages = []; tasks = []; }
}

// Writes are chained: two concurrent requests sharing one .tmp made the second rename fail with ENOENT.
let writing = Promise.resolve();
function persist() {
  const tmp = `${DATA_FILE}.tmp`;
  writing = writing.catch(() => {}).then(async () => {
    await writeFile(tmp, JSON.stringify({ messages, tasks }, null, 2), 'utf8');
    await rename(tmp, DATA_FILE);
  });
  return writing;
}

// Any web page can send a "simple" text/plain POST to localhost; the worker turns such a task into
// a write-enabled Codex run. So: Host must be ours (DNS rebinding), writes need JSON and our Origin.
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `127.0.0.1:${PORT}`, `localhost:${PORT}`]);
function foreign(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return 'Недопустимый Host.';
  if (req.method === 'GET') return null;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return 'Недопустимый Origin.';
  if (req.method !== 'DELETE' && !(req.headers['content-type'] || '').startsWith('application/json')) return 'Нужен content-type: application/json.';
  return null;
}

function broadcast(message) {
  const payload = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
  for (const res of clients) res.write(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; let raw = '';
    req.setEncoding('utf8');
    req.on('data', (part) => {
      size += Buffer.byteLength(part);
      if (size > MAX_BODY) reject(new Error('Сообщение длиннее 32 КБ'));
      else raw += part;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Нужен JSON')); }
    });
    req.on('error', reject);
  });
}

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function staticFile(pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[a-zA-Z0-9._/-]+$/.test(name) || name.includes('..')) return null;
  return join(PUBLIC, name);
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

await load();
const server = http.createServer(async (req, res) => {
  const rejected = foreign(req);
  if (rejected) return json(res, 403, { error: rejected });
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/messages') {
      const after = Number(url.searchParams.get('after') || 0);
      const scope = clean(url.searchParams.get('scope'), 60);
      const list = messages.filter((m) => m.id > after && (!scope || m.scope === scope));
      return json(res, 200, { messages: list, latest: messages.at(-1)?.id || 0 });
    }
    if (req.method === 'POST' && url.pathname === '/api/messages') {
      const body = await readBody(req);
      const author = clean(body.author, 40);
      const text = clean(body.text, 8000);
      const scope = clean(body.scope, 60) || 'general';
      const type = TYPES.has(body.type) ? body.type : 'update';
      const file = clean(body.file, 240);
      if (!author || !text) return json(res, 422, { error: 'Нужны author и text.' });
      const message = {
        id: (messages.at(-1)?.id || 0) + 1,
        at: new Date().toISOString(), author, scope, type, text, file,
        status: 'open',
      };
      messages.push(message);
      await persist();
      broadcast(message);
      return json(res, 201, { message });
    }
    if (req.method === 'PATCH' && /^\/api\/messages\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/').at(-1));
      const message = messages.find((m) => m.id === id);
      if (!message) return json(res, 404, { error: 'Сообщение не найдено.' });
      const body = await readBody(req);
      if (!['open', 'read', 'accepted', 'closed'].includes(body.status)) return json(res, 422, { error: 'Недопустимый status.' });
      message.status = body.status;
      message.updatedAt = new Date().toISOString();
      await persist();
      broadcast(message);
      return json(res, 200, { message });
    }
    if (req.method === 'DELETE' && /^\/api\/messages\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/').at(-1));
      if (!messages.some((m) => m.id === id)) return json(res, 404, { error: 'Сообщение не найдено.' });
      messages = messages.filter((m) => m.id !== id);
      await persist();
      return json(res, 200, { deleted: id });
    }
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const scope = clean(url.searchParams.get('scope'), 60);
      return json(res, 200, { tasks: tasks.filter((t) => !scope || t.scope === scope) });
    }
    if (req.method === 'POST' && url.pathname === '/api/tasks') {
      const body = await readBody(req);
      const title = clean(body.title, 180);
      const scope = clean(body.scope, 60) || 'general';
      if (!title) return json(res, 422, { error: 'У задачи должен быть заголовок.' });
      const task = { id: (tasks.at(-1)?.id || 0) + 1, title, scope, assignee: clean(body.assignee, 40), file: clean(body.file, 240), note: clean(body.note, 2000), state: 'inbox', createdAt: new Date().toISOString() };
      tasks.push(task); await persist(); broadcast({ event: 'task', task });
      return json(res, 201, { task });
    }
    if (req.method === 'PATCH' && /^\/api\/tasks\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/').at(-1));
      const task = tasks.find((t) => t.id === id);
      if (!task) return json(res, 404, { error: 'Задача не найдена.' });
      const body = await readBody(req);
      if (body.state && !['inbox', 'progress', 'review', 'done', 'backlog'].includes(body.state)) return json(res, 422, { error: 'Недопустимое состояние.' });
      if (body.state) task.state = body.state;
      for (const key of ['title', 'scope', 'assignee', 'file', 'note']) if (body[key] !== undefined) task[key] = clean(body[key], key === 'note' ? 2000 : key === 'title' ? 180 : 240);
      task.updatedAt = new Date().toISOString(); await persist(); broadcast({ event: 'task', task });
      return json(res, 200, { task });
    }
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 2000\n\n'); clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET') {
      const path = staticFile(url.pathname);
      if (!path) return json(res, 404, { error: 'Не найдено.' });
      const content = await readFile(path);
      res.writeHead(200, { 'content-type': mime[extname(path)] || 'application/octet-stream' });
      return res.end(content);
    }
    return json(res, 405, { error: 'Метод не поддерживается.' });
  } catch (error) {
    return json(res, 400, { error: error.message || 'Ошибка запроса.' });
  }
});

server.listen(PORT, HOST, () => console.log(`Agent Hub: http://${HOST}:${PORT}`));
