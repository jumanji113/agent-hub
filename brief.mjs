/* Сводка при запуске: что делает второй агент, что взял с доски, что написал.
   Заменяет лайв-чат: при старте одна команда вместо чтения ленты. */
const HUB = process.env.HUB || 'http://127.0.0.1:4317';
const scope = process.argv[2] || 'polynya';
const me = process.argv[3] || '';
const short = (s = '', n = 160) => (s.length > n ? s.slice(0, n) + '…' : s).replace(/\s+/g, ' ');

const [mres, tres] = await Promise.all([
  fetch(`${HUB}/api/messages?scope=${scope}`).then((r) => r.json()).catch(() => ({ messages: [] })),
  fetch(`${HUB}/api/tasks?scope=${scope}`).then((r) => r.json()).catch(() => ({ tasks: [] })),
]);
const msgs = mres.messages || [];
const tasks = tres.tasks || [];
const agents = [...new Set(msgs.map((m) => m.author))];

console.log(`СВОДКА · scope ${scope} · сообщений ${msgs.length} · задач ${tasks.length}`);
for (const a of agents) {
  const last = msgs.filter((m) => m.author === a).at(-1);
  const mine = tasks.filter((t) => t.assignee === a);
  const work = mine.filter((t) => t.state === 'progress' || t.state === 'review');
  console.log(`\n${a}${a === me ? ' (это вы)' : ''}`);
  console.log(`  последнее #${last.id} [${last.type}]: ${short(last.text)}`);
  console.log(`  в работе: ${work.length ? work.map((t) => `#${t.id} ${t.title} [${t.state}]`).join('; ') : '—'}`);
  const queued = mine.filter((t) => t.state === 'inbox');
  if (queued.length) console.log(`  во входящих: ${queued.map((t) => `#${t.id} ${t.title}`).join('; ')}`);
}
const open = msgs.filter((m) => m.status === 'open' && m.author !== me);
if (open.length) {
  console.log(`\nБЕЗ ОТВЕТА (${open.length}):`);
  open.slice(-3).forEach((m) => console.log(`  #${m.id} ${m.author}: ${short(m.text, 110)}`));
}
