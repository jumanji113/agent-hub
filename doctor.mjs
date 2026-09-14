/* Диагностика связи: одна команда вместо догадок «работает или нет».
   Отвечает на вопрос владельца: дошло ли до агента и читал ли он. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const HUB = process.env.HUB || 'http://127.0.0.1:4317';
const scope = process.argv[2] || 'polynya';
const ok = (b) => (b ? '✓' : '✗');
const mins = (t) => Math.round((Date.now() - t) / 60000);

let msgs = [], latest = 0, alive = true;
try {
  const r = await fetch(`${HUB}/api/messages?scope=${scope}`);
  ({ messages: msgs = [], latest = 0 } = await r.json());
} catch { alive = false; }
console.log(`${ok(alive)} сервер хаба ${HUB}${alive ? '' : ' — не отвечает, запустите npm start'}`);
if (!alive) process.exit(1);

let sse = false;
try {
  const c = new AbortController();
  const r = await fetch(`${HUB}/api/stream`, { signal: c.signal });
  sse = r.ok; c.abort();
} catch {}
console.log(`${ok(sse)} поток событий (нужен для мгновенного триггера)`);
console.log(`  сообщений в ленте: ${msgs.length}, последнее #${latest}`);

// закладки: по ним видно, читал агент ленту или нет
let seen = [];
try { seen = readdirSync(join(HERE, 'data')).filter((f) => f.startsWith('seen-')); } catch {}
for (const f of seen) {
  const p = join(HERE, 'data', f);
  const id = JSON.parse(readFileSync(p, 'utf8')).lastId || 0;
  const who = f.replace(/^seen-|\.json$/g, '');
  // своё же сообщение непрочитанным не считается
  const behind = msgs.filter((m) => m.id > id && m.author !== who).length;
  console.log(`${ok(behind <= 2)} ${who}: прочитано до #${id}, не прочитано ${behind}, проверялся ${mins(statSync(p).mtimeMs)} мин назад`);
}
if (!seen.length) console.log('  закладок нет: ни один агент не вызывал ./hub check');

// вопросы без ответа: показывают, где переписка встала
const q = msgs.filter((m) => (m.type === 'question' || m.type === 'blocker') && m.status === 'open');
console.log(`${ok(q.length === 0)} вопросов без ответа: ${q.length}${q.length ? ' → ' + q.map((m) => '#' + m.id + ' ' + m.author).join(', ') : ''}`);
