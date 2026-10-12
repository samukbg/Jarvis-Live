import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

// resultHistory.ts is shared byte-for-byte with the mobile app, so its imports carry no
// extension (Metro / Vite resolve them). Node's ESM loader does not: retry with ".ts".
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (e) {
    if (specifier.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(specifier)) return next(specifier + '.ts', context);
    throw e;
  }
}`)}`);

const { addToHistory, dayLabel, historyTitle, parseHistory, HISTORY_MAX } = await import('../components/overlayCards/resultHistory.ts');

const answers: Array<{ expected: string; answer: string }> = JSON.parse(readFileSync(new URL('../../backend/cards/fixtures/agent-answers.json', import.meta.url), 'utf8'));
const answer = (type: string, i = 0) => answers.filter((a) => a.expected === type)[i].answer;
const NOW = new Date(2026, 9, 12, 14, 5).getTime();

test('history: titles come from the card headline', () => {
  const weather = historyTitle(answer('weather', 1));
  assert.equal(weather.type, 'weather');
  assert.match(weather.title, /23°/);

  const finance = historyTitle(answer('finance', 1));
  assert.equal(finance.type, 'finance');
  assert.match(finance.title, /Tesla|TSLA/);
  assert.match(finance.title, /\$380/);

  const flight = historyTitle(answer('flight', 1));
  assert.equal(flight.type, 'flight');
  assert.match(flight.title, /BA117/);
  assert.match(flight.title, /LHR → JFK · Landed/);

  const sports = historyTitle(answer('sports', 1));
  assert.equal(sports.type, 'sports');
  assert.match(sports.title, /Real Madrid|Atl/);

  const biz = historyTitle(answer('business_dashboard'));
  assert.equal(biz.type, 'business_dashboard');
  assert.match(biz.title, /Acme Invoices/);
});

test('history: every fixture gets a non-empty, one-line, clipped title', () => {
  for (const a of answers) {
    const { title } = historyTitle(a.answer);
    assert.ok(title.length > 0 && title.length <= 90, `${a.expected}: ${title}`);
    assert.ok(!/\n/.test(title), `${a.expected}: ${title}`);
  }
});

test('history: plain text answers use their first sentence, without markdown', () => {
  const r = historyTitle('**Done.** I renamed the files in `~/Downloads`. Nothing else changed.');
  assert.equal(r.type, null);
  assert.equal(r.title, 'Done. I renamed the files in ~/Downloads.');
  assert.equal(historyTitle('The meeting moved to Friday at 3 pm. I updated your calendar.').title, 'The meeting moved to Friday at 3 pm.');
  assert.equal(historyTitle('All set.').title, 'All set.');
  assert.equal(historyTitle('   ').title, 'Result');
  assert.equal(historyTitle('x'.repeat(200)).title.length, 90);
});

test('history: newest first, deduplicated, capped', () => {
  let list = addToHistory([], { agentId: 'gemini', agentName: 'Antigravity', result: 'First answer.' }, NOW);
  list = addToHistory(list, { agentId: 'gemini', agentName: 'Antigravity', result: 'Second answer.' }, NOW + 1);
  assert.deepEqual(list.map((e) => e.result), ['Second answer.', 'First answer.']);
  list = addToHistory(list, { agentId: 'claude', agentName: 'Claude', result: 'First answer.' }, NOW + 2);
  assert.deepEqual(list.map((e) => e.result), ['First answer.', 'Second answer.']);
  assert.equal(list[0].agentName, 'Claude');
  assert.equal(list[0].at, NOW + 2);
  assert.equal(addToHistory(list, { agentId: 'x', agentName: 'X', result: '  \n' }), list);
  for (let i = 0; i < HISTORY_MAX + 10; i++) list = addToHistory(list, { agentId: 'a', agentName: 'A', result: `Answer ${i}.` }, NOW + 10 + i);
  assert.equal(list.length, HISTORY_MAX);
  assert.equal(list[0].result, `Answer ${HISTORY_MAX + 9}.`);
  assert.equal(new Set(list.map((e) => e.id)).size, HISTORY_MAX);
});

test('history: parse drops malformed entries', () => {
  const good = addToHistory([], { agentId: 'a', agentName: 'A', result: 'Ok.' }, NOW);
  assert.deepEqual(parseHistory(JSON.stringify(good)), good);
  assert.deepEqual(parseHistory(JSON.stringify([...good, null, { id: 1 }, { id: 'x', at: 'y', result: 'z' }])), good);
  assert.deepEqual(parseHistory('not json'), []);
  assert.deepEqual(parseHistory('{"a":1}'), []);
  assert.deepEqual(parseHistory(null), []);
});

test('history: day labels', () => {
  assert.equal(dayLabel(NOW - 60_000, NOW), 'Today');
  assert.equal(dayLabel(new Date(2026, 9, 11, 23, 59).getTime(), NOW), 'Yesterday');
  assert.equal(dayLabel(new Date(2026, 9, 9, 8).getTime(), NOW), 'Oct 9');
  assert.equal(dayLabel(new Date(2025, 11, 30).getTime(), NOW), 'Dec 30, 2025');
});
