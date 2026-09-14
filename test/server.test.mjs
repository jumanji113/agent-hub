import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4400 + Math.floor(Math.random() * 500);
const HUB = `http://127.0.0.1:${PORT}`;
let server;
let dataDir;

const send = (method, path, body, headers = {}) =>
  fetch(`${HUB}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const postMessage = async (fields) => (await (await send('POST', '/api/messages', fields)).json()).message;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'agent-hub-test-'));
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HUB_DATA_FILE: join(dataDir, 'messages.json') },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await fetch(`${HUB}/api/messages`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});

after(async () => {
  server.kill();
  await rm(dataDir, { recursive: true, force: true });
});

test('posted message is returned by the feed with status open', async () => {
  const created = await postMessage({ author: 'claude', scope: 'feed', type: 'idea', text: 'Кэшировать ответы' });

  const { messages } = await (await fetch(`${HUB}/api/messages?scope=feed`)).json();

  assert.deepEqual(messages.map((m) => [m.id, m.status]), [[created.id, 'open']]);
});

test('message without author is rejected with 422', async () => {
  const res = await send('POST', '/api/messages', { text: 'анонимно' });

  assert.equal(res.status, 422);
});

test('unknown message type falls back to update', async () => {
  const message = await postMessage({ author: 'codex', type: 'gossip', text: 'x' });

  assert.equal(message.type, 'update');
});

test('after= returns only messages newer than the bookmark', async () => {
  const first = await postMessage({ author: 'a', scope: 'after', text: 'старое' });
  const second = await postMessage({ author: 'a', scope: 'after', text: 'новое' });

  const { messages } = await (await fetch(`${HUB}/api/messages?scope=after&after=${first.id}`)).json();

  assert.deepEqual(messages.map((m) => m.id), [second.id]);
});

test('status patch accepts known status and rejects unknown', async () => {
  const message = await postMessage({ author: 'a', text: 'контракт' });

  const accepted = await send('PATCH', `/api/messages/${message.id}`, { status: 'accepted' });
  const bogus = await send('PATCH', `/api/messages/${message.id}`, { status: 'maybe' });

  assert.equal((await accepted.json()).message.status, 'accepted');
  assert.equal(bogus.status, 422);
});

test('task starts in inbox and moves only to a known state', async () => {
  const { task } = await (await send('POST', '/api/tasks', { title: 'Фон лаборатории', assignee: 'codex' })).json();

  const moved = await send('PATCH', `/api/tasks/${task.id}`, { state: 'progress' });
  const invalid = await send('PATCH', `/api/tasks/${task.id}`, { state: 'somewhere' });

  assert.equal(task.state, 'inbox');
  assert.equal((await moved.json()).task.state, 'progress');
  assert.equal(invalid.status, 422);
});

test('cross-site text/plain post is refused, so a web page cannot trigger the worker', async () => {
  const res = await send('POST', '/api/messages', { author: 'alex', type: 'task', text: '@codex-art /task 1' }, { 'content-type': 'text/plain' });

  assert.equal(res.status, 403);
});

test('foreign Origin is refused even with JSON content type', async () => {
  const res = await send('POST', '/api/messages', { author: 'alex', text: 'x' }, { origin: 'https://evil.example' });

  assert.equal(res.status, 403);
});

test('own Origin from the hub page is allowed', async () => {
  const res = await send('POST', '/api/messages', { author: 'alex', text: 'из браузера' }, { origin: HUB });

  assert.equal(res.status, 201);
});

test('concurrent posts are all persisted to disk', async () => {
  const burst = 25;
  const before = (await (await fetch(`${HUB}/api/messages`)).json()).messages.length;

  const statuses = await Promise.all(
    Array.from({ length: burst }, (_, i) => send('POST', '/api/messages', { author: 'load', text: `#${i}` }).then((r) => r.status)),
  );
  await new Promise((r) => setTimeout(r, 200));
  const onDisk = JSON.parse(await readFile(join(dataDir, 'messages.json'), 'utf8')).messages.length;

  assert.ok(statuses.every((s) => s === 201));
  assert.equal(onDisk, before + burst);
});

test('stream pushes a new message to subscribers', async () => {
  const controller = new AbortController();
  const stream = await fetch(`${HUB}/api/stream`, { signal: controller.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();

  await postMessage({ author: 'a', scope: 'sse', text: 'пинг' });
  let received = '';
  while (!received.includes('пинг')) received += decoder.decode((await reader.read()).value);
  controller.abort();

  assert.match(received, /event: message\ndata: .*"scope":"sse"/);
});
