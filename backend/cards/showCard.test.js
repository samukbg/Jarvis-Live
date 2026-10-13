import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showCard, statedCard, SHOW_CARD_TOOL, CARD_KINDS } from './showCard.js';
import { detectSpecialContent } from './detect.generated.js';

const fakeEnrich = (patches) => async (type) => (patches[type] ? { data: patches[type], prefer: type === 'weather' ? 'stated' : 'live' } : null);

test('a spoken weather answer becomes a weather card with the live temperature', async () => {
  const sent = [];
  const r = await showCard(
    { kind: 'weather', summary: 'In Paris today it is 19 degrees and overcast.', place: 'Paris', day: 'today' },
    { broadcast: (m) => sent.push(m), origin: 'web', enrich: fakeEnrich({ weather: { city: 'Paris', liveTemp: 19.1, condition: 'Overcast', high: 24, low: 15 } }) },
  );
  assert.equal(r.shown, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'agent_result');
  assert.equal(sent[0].origin, 'web');
  const card = detectSpecialContent(sent[0].result);
  assert.equal(card.type, 'weather');
  assert.equal(card.data.city, 'Paris');
  assert.equal(card.data.temp, 19.1);
  assert.match(r.result, /Paris now: 19\.1°C, Overcast, high 24°C, low 15°C/);
});

test('no card is sent when the real data cannot fill it', async () => {
  const sent = [];
  const r = await showCard({ kind: 'weather', summary: 'x', place: 'Nowhere' }, { broadcast: (m) => sent.push(m), enrich: fakeEnrich({}) });
  assert.equal(r.shown, false);
  assert.equal(sent.length, 0);
  assert.match(r.result, /in words/);
});

test('stated figures are enough without live data, and enrichment failures are survived', async () => {
  const sent = [];
  const r = await showCard(
    { kind: 'finance', summary: 'Apple is at 231 dollars.', symbol: 'aapl', price: 231.4 },
    { broadcast: (m) => sent.push(m), enrich: async () => { throw new Error('offline'); } },
  );
  assert.equal(r.shown, true);
  assert.equal(detectSpecialContent(sent[0].result).data.symbol, 'AAPL');
});

test('long series stay out of the broadcast (the apps fetch them again)', async () => {
  const sent = [];
  const history = Array.from({ length: 400 }, (_, i) => ({ time: String(i), value: i }));
  await showCard({ kind: 'finance', summary: 's', symbol: 'BTC' }, { broadcast: (m) => sent.push(m), enrich: fakeEnrich({ finance: { symbol: 'BTC', price: 83900, history } }) });
  assert.equal(detectSpecialContent(sent[0].result).data.history, undefined);
});

test('statedCard maps every kind and rejects others', () => {
  for (const kind of CARD_KINDS) assert.ok(statedCard({ kind }), kind);
  assert.equal(statedCard({ kind: 'poem' }), null);
  assert.deepEqual(statedCard({ kind: 'sports', teamA: 'PSG', teamB: 'OM', scoreA: 3, scoreB: 1 }).data, { teamA: { name: 'PSG', score: 3 }, teamB: { name: 'OM', score: 1 } });
  assert.equal(statedCard({ kind: 'weather', place: 'Lisbon', day: 'tomorrow' }).data.forecastDay, 1);
  assert.deepEqual(SHOW_CARD_TOOL.parameters.required, ['kind', 'summary']);
});

test('POST /api/cards/show opens the card on the device that started the avatar', async () => {
  const { default: express } = await import('express');
  const { registerCardRoutes } = await import('./index.js');
  const sent = [];
  const app = express();
  app.use(express.json());
  registerCardRoutes(app, { broadcast: (m) => sent.push(m), avatarOrigin: () => 'iphone' });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/cards/show`;
    const post = (body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const ok = await post({ kind: 'sports', summary: 'PSG won 3-1.', teamA: 'Zzz United', teamB: 'Qqq City', scoreA: 3, scoreB: 1, via: 'avatar' });
    assert.equal(ok.shown, true);
    assert.equal(sent.at(-1).origin, 'iphone');
    const bad = await post({ kind: 'poem', summary: 'x' });
    assert.equal(bad.shown, false);
    assert.equal(typeof bad.result, 'string');
  } finally {
    server.close();
  }
});

test("today's live weather replaces the model's guessed temperature", async () => {
  const sent = [];
  await showCard({ kind: 'weather', summary: 's', place: 'Tokyo', temperature: 15, condition: 'Sunny' }, { broadcast: (m) => sent.push(m), enrich: fakeEnrich({ weather: { city: 'Tokyo', liveTemp: 21.4, condition: 'Overcast', conditionCode: 'cloudy' } }) });
  const card = detectSpecialContent(sent[0].result);
  assert.equal(card.data.temp, 21.4);
  assert.equal(card.data.condition, 'Overcast');
});
