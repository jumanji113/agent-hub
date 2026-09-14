#!/usr/bin/env node
/* ОЖИДАНИЕ ВМЕСТО ОПРОСА.
   Процесс висит на SSE-потоке хаба: ни токенов, ни запросов, ни таймеров у агента.
   Просыпается не на всём подряд, а только на том, что требует ответа, и отдаёт
   накопленное одной пачкой — одно пробуждение вместо трёх.

   Будит, если сообщение:
     · пришло от автора из списка --wake-from (человек будит всегда и любым типом);
     · адресовано лично — текст начинается с «@имя»;
     · имеет тип из списка (по умолчанию question, blocker).
   Всё остальное (idea, update, contract, задачи) копится тихо и печатается
   тем же пробуждением как «заодно пришло» — читать в ленте отдельно не нужно.

   Два режима:
     · ожидание (для агентов, умеющих держать фоновый процесс):
       node wait_for.mjs --scope=polynya --me=<имя> --wake-from=alex
     · проверка без ожидания — «что нового с прошлого раза» (для агентов,
       которые не живут между ходами: Codex и подобные). Вызывается одной
       строкой в начале и в конце своего хода, стоит копейки:
       node wait_for.mjs --scope=polynya --me=<имя> --once
       коды выхода: 0 — есть новое, 2 — ничего нового.

   Прочитанное запоминается в data/seen-<me>.json, поэтому --once никогда
   не показывает одно и то же дважды.
*/
const arg = (k, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const flag = (k) => process.argv.slice(2).includes(`--${k}`);

const HUB = process.env.HUB || 'http://127.0.0.1:4317';
// scope может быть списком через запятую или '*' — иначе сообщение владельца,
// отправленное в соседний проект, молча проходит мимо всех
const scopeArg = arg('scope', 'polynya');
const scopes = scopeArg.split(',').map((s) => s.trim()).filter(Boolean);
const inScope = (s) => scopeArg === '*' || scopes.includes(s);
const scope = scopes[0];
const me = arg('me', '');
const wakeTypes = arg('types', 'question,blocker').split(',').filter(Boolean);
const debounceMs = Number(arg('debounce', '20')) * 1000;
const timeoutMs = Number(arg('timeout', '3600')) * 1000;
const wakeOnAll = flag('all');
/* Люди пишут редко и по делу — их сообщения будят любым типом.
   Для агентов фильтр остаётся строгим, иначе лента съест токены. */
const wakeFrom = arg('wake-from', 'alex,user,human').split(',').filter(Boolean);
const maxPerHour = Number(arg('max-per-hour', '20'));
const once = flag('once');
/* Просмотр чужой закладки не должен её двигать: иначе проверяющий
   «съедает» сообщения, адресованные другому агенту. Проверено на себе. */
const peek = flag('peek');

/* Отметка о прочитанном: без неё --once каждый раз показывал бы одно и то же.
   Файл на агента, чтобы двое не затирали друг другу закладку. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const SEEN = join(HERE, 'data', `seen-${(me || 'anon').replace(/[^\w-]/g, '')}.json`);
const readSeen = () => { try { return JSON.parse(readFileSync(SEEN, 'utf8')).lastId || 0; } catch { return 0; } };
const saveSeen = (id) => { if (peek) return; try { mkdirSync(dirname(SEEN), { recursive: true }); writeFileSync(SEEN, JSON.stringify({ lastId: id }), 'utf8'); } catch {} };

const quiet = [];   // пришло, но само по себе не будит
const seenText = new Set();   // одинаковый текст не будит дважды
const stamps = [];            // отметки пробуждений для потолка в час
let woke = null;    // первое сообщение, которое разбудило

const short = (s = '', n = 300) => (s.length > n ? s.slice(0, n) + '…' : s);
const line = (m) => `#${m.id} [${m.type || 'task'}] ${m.author}${m.file ? ' · ' + m.file : ''}\n  ${short(m.text || m.title || '')}`;

function report(code, note) {
  if (note) console.log(note);
  saveSeen(lastId);
  if (woke) {
    console.log('ТРЕБУЕТ ОТВЕТА:');
    console.log(line(woke));
  }
  if (quiet.length) {
    console.log(`\nЗАОДНО ПРИШЛО (${quiet.length}), отвечать не обязательно:`);
    quiet.forEach((m) => console.log(line(m)));
  }
  process.exit(code);
}

const hardStop = setTimeout(() => report(2, `# тишина в ленте «${scope}»: ${timeoutMs / 1000} с`), timeoutMs);

/* Решение о пробуждении — одно на оба источника: и на живой поток, и на догон
   пропущенного после разрыва связи. */
let lastId = Number(arg('since', '0')) || readSeen();
function consider(m) {
  if (!m || !m.author) return;
  // один и тот же текст, присланный повторно, — почти всегда петля воркера
  const key = `${m.author}:${(m.text || '').slice(0, 120)}`;
  if (seenText.has(key)) { if (m.id) lastId = Math.max(lastId, m.id); return; }
  seenText.add(key);
  if (m.id) lastId = Math.max(lastId, m.id);
  if (!inScope(m.scope)) return;
  if (me && m.author === me) return;                       // собственное эхо не будит
  const addressed = me && new RegExp(`^@${me}\\b`, 'i').test(m.text || '');
  // адресное чужому не будит: раньше вопрос к соседу поднимал обоих — лишние токены
  const toOther = /^@([\w-]+)/.exec(m.text || '');
  if (toOther && !/^(all|оба|все)$/i.test(toOther[1]) && toOther[1].toLowerCase() !== (me || '').toLowerCase()) { quiet.push(m); return; }
  const toAll = /^@(all|оба|все)\b/i.test(m.text || '');
  const fromHuman = wakeFrom.includes((m.author || '').toLowerCase());
  if (wakeOnAll || toAll || fromHuman || addressed || wakeTypes.includes(m.type)) {
    if (!woke) wake(m);
  } else quiet.push(m);
}

/* Разбудило — не бежим сразу: ждём окно и забираем то, что придёт следом.
   Три сообщения подряд стоят одного пробуждения, а не трёх. */
function wake(m) {
  // потолок пробуждений: если лента сошла с ума, агент не должен сгореть вместе с ней
  const hourAgo = Date.now() - 3600000;
  while (stamps.length && stamps[0] < hourAgo) stamps.shift();
  if (stamps.length >= maxPerHour) {
    console.log(`# потолок пробуждений: ${maxPerHour} за час уже было, сообщение #${m.id} отложено в ленте`);
    quiet.push(m);
    return;
  }
  stamps.push(Date.now());
  woke = m;
  clearTimeout(hardStop);
  setTimeout(() => report(0), debounceMs);
}

/* Догон: сообщение, пришедшее в момент разрыва потока, иначе потерялось бы.
   Поэтому после каждого переподключения дочитываем ленту с последнего виденного id. */
async function catchUp() {
  try {
    // сервер умеет ?after= — тянем только новое, а не всю ленту
    const r = await fetch(`${HUB}/api/messages?scope=${encodeURIComponent(scope)}&after=${lastId}`);
    const { messages = [], latest = 0 } = await r.json();
    if (lastId === 0) { lastId = latest; return; }          // первый вход: старое не будит
    messages.filter((m) => m.id > lastId).forEach(consider);
  } catch { /* хаб временно недоступен — попробуем на следующем круге */ }
}

/* Разовая проверка: ничего не ждём, просто берём всё новое с закладки.
   Это и есть способ жить в чате для агента, который не держит процессов. */
if (once) {
  clearTimeout(hardStop);
  try {
    // сервер умеет ?after= — тянем только новое, а не всю ленту
    const r = await fetch(`${HUB}/api/messages?scope=${encodeURIComponent(scope)}&after=${lastId}`);
    const { messages = [], latest = 0 } = await r.json();
    // при самом первом вызове закладки нет — не вываливаем всю ленту
    const fresh = messages.filter((m) => m.id > lastId).slice(readSeen() ? 0 : -5);
    if (!fresh.length) { lastId = latest; report(2, '# нового нет'); }
    fresh.forEach(consider);
    if (!woke && quiet.length) woke = quiet.shift();   // в разовом режиме показываем всё
    lastId = latest;
    report(woke ? 0 : 2, woke ? null : '# нового нет');
  } catch (e) {
    report(3, `# хаб недоступен (${HUB}): ${e.message}`);
  }
}

async function listen() {
  const res = await fetch(`${HUB}/api/stream`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;                                        // поток закрыт — переподключаемся
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const raw of parts) {
      if (!raw.startsWith('data: ')) continue;
      let payload;
      try { payload = JSON.parse(raw.slice(6)); } catch { continue; }
      consider(payload.message || payload.task || payload);
    }
  }
}

/* Разрыв соединения — не повод терять ожидание: молча встаём обратно.
   Хаб недоступен подряд минуту — выходим, чтобы агент об этом узнал. */
let downSince = 0;
while (!woke) {
  await catchUp();
  try {
    await listen();
    downSince = 0;
  } catch (e) {
    if (!downSince) downSince = Date.now();
    if (Date.now() - downSince > 60000) report(3, `# хаб недоступен минуту: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
