import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { analyse, deterministicOverview, fromModel, mergeOverview, overviewPrompt, parseFirstJson, rankKpis, scrub, statTiles } from './analyse.js';
import { dashboardData, dashboardText, resolveFocus, spokenOverview } from './card.js';
import { createBusinessStore, normalizeTarget, publicView, validateHeaders } from './store.js';
import { createBusinessService } from './service.js';
import { registerBusinessRoutes } from './routes.js';
import { detectSpecialContent } from '../cards/detect.generated.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-biz-'));
const NOW = Date.parse('2026-10-11T12:00:00Z');
const DAY = 86_400_000;

const repoFacts = {
  source: 'folder', format: 'directory', location: '/x/acme', name: 'acme-app', hasCode: true,
  manifest: { type: 'npm', name: 'acme-app', version: '0.4.1', description: 'Invoices for freelancers' },
  languages: [{ name: 'TypeScript', files: 40 }], fileCount: 60, todoCount: 7,
  texts: [{ label: 'README', text: '# Acme\n\nAcme sends invoices for freelancers and tracks who paid, with reminders.' }],
  git: {
    commitsPerWeek: Array.from({ length: 12 }, (_, i) => ({ t: NOW - (12 - i) * 7 * DAY, value: i })),
    commits30: 30, commitsPrev30: 18, contributors90: 2,
    lastCommit: { date: new Date(NOW - 2 * DAY).toISOString(), subject: 'Add export' }, latestTag: 'v0.4.1', branch: 'main',
  },
};

test('deterministic overview: real numbers, momentum health, short strings', () => {
  const o = deterministicOverview(repoFacts, { id: 'b1', now: NOW });
  assert.equal(o.id, 'b1');
  assert.equal(o.kind, 'project');
  assert.equal(o.source, 'folder');
  assert.equal(o.tagline, 'Invoices for freelancers');
  assert.match(o.summary, /sends invoices/);
  assert.deepEqual(o.kpis[0], { label: 'Commits (30d)', value: '30', hint: '18 the 30 days before', trend: 'up' });
  assert.ok(o.kpis.length <= 4);
  assert.ok(o.kpis.some((k) => k.value === 'v0.4.1'));
  assert.equal(o.activity.points.length, 12);
  assert.ok(o.health >= 70 && o.status === 'thriving');
  assert.equal(o.stage, 'Early development');
  assert.match(o.highlights[0], /Last commit 2 days ago: Add export/);
  const idle = deterministicOverview({ ...repoFacts, git: { ...repoFacts.git, commits30: 0, commitsPrev30: 3, lastCommit: { date: new Date(NOW - 200 * DAY).toISOString(), subject: 'old' } } }, { id: 'b2', now: NOW });
  assert.equal(idle.status, 'needs attention');
  assert.ok(idle.risks.includes('No commits in the last 30 days'));
});

test('KPIs by importance: money, then paying customers, then users, then the rest', () => {
  assert.deepEqual(rankKpis([{ label: 'Total posts', value: '4,204' }, { label: 'Users', value: '27' }, { label: 'Paying', value: '2' }, { label: 'Est. MRR', value: '$39.80' }]).map((k) => k.label), ['Est. MRR', 'Paying', 'Users', 'Total posts']);
  const base = deterministicOverview(repoFacts, { id: 'b1', now: NOW });
  assert.equal(mergeOverview(base, { name: 'Acme', kpis: [{ label: 'Plan price', value: '$9/mo' }] }).kpis[0].label, 'Plan price');
});

test('stat tiles from a rendered dashboard', () => {
  assert.deepEqual(statTiles('Overview\nUsers\n1,204\nPaying users\n87\nMRR\n$2,310\nLast sync 2 min ago'), [
    { label: 'Users', value: '1,204' }, { label: 'Paying users', value: '87' }, { label: 'MRR', value: '$2,310' },
  ]);
  assert.deepEqual(statTiles('1,204\nUsers'), [{ label: 'Users', value: '1,204' }]);
});

test('scrub removes e-mails and key-like tokens; the prompt is scrubbed and says facts only', () => {
  assert.equal(scrub('mail ann@shop.io key sk_live_51HxQ2abcdefghijklmnopqrstuvwx12'), 'mail [email] key [redacted]');
  const p = overviewPrompt({ ...repoFacts, texts: [{ label: 'Page', text: 'Contact bob@acme.io' }] });
  assert.ok(!p.includes('bob@acme.io'));
  assert.match(p, /Use ONLY the facts/);
  assert.match(p, /30 commits in the last 30 days/);
});

test('model answer merged over real numbers; several businesses become overviews', () => {
  const base = deterministicOverview(repoFacts, { id: 'b1', now: NOW });
  const merged = mergeOverview(base, {
    name: 'Acme', tagline: 'x'.repeat(200), health: 10, status: 'needs attention',
    kpis: [{ label: 'Commits', value: '999' }, { label: 'Pricing', value: '$9/mo' }, { label: 'Target', value: '100 users' }],
    highlights: ['a', 'b', 'c', 'd'],
  });
  assert.equal(merged.name, 'Acme');
  assert.ok(merged.tagline.length <= 80);
  assert.equal(merged.kpis.find((k) => k.label === 'Commits (30d)').value, '30', 'git numbers win over the model');
  assert.ok(!merged.kpis.some((k) => k.value === '999'));
  assert.ok(merged.kpis.some((k) => k.label === 'Pricing'));
  assert.equal(merged.health, base.health, 'momentum health stays');
  assert.equal(merged.highlights.length, 3);
  assert.equal(merged.activity, base.activity);

  const multi = fromModel(base, {
    portfolio: { name: 'Portfolio', summary: 'Nine apps' },
    businesses: [{ name: 'Spread Out', health: 80, kpis: [{ label: 'Users', value: '1,204' }] }, { name: 'VTO', status: 'steady' }, { name: 'VTO' }],
  });
  assert.equal(multi.overview.name, 'Portfolio');
  assert.deepEqual(multi.overviews.map((o) => o.id), ['b1:spread-out', 'b1:vto', 'b1:vto-2']);
  assert.equal(multi.overviews[0].status, 'thriving');
  assert.equal(multi.overviews[1].status, 'steady');
  assert.equal(parseFirstJson('Sure!\n```json\n{"a": {"b": "}"}}\n```').a.b, '}');
});

test('analyse: Gemini with the server key first, then an agent CLI, then the facts alone', async () => {
  const geminiFetch = async (url, init) => {
    assert.match(url, /gemini-flash-latest:generateContent$/);
    assert.equal(init.headers['x-goog-api-key'], 'K');
    const body = JSON.parse(init.body);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ businesses: [{ name: 'Acme', summary: 'Invoices.' }] }) }] } }] }) };
  };
  const g = await analyse(repoFacts, { id: 'b1', env: { GEMINI_API_KEY: 'K' }, fetchImpl: geminiFetch, now: NOW });
  assert.equal(g.analyser, 'gemini');
  assert.equal(g.overview.summary, 'Invoices.');

  // A retired model (404 for newer keys): the next one in the chain.
  const urls = [];
  const retired = async (url, init) => { urls.push(url.match(/models\/([^:]+)/)[1]); return urls.length === 1 ? { ok: false, status: 404 } : geminiFetch(url.replace('gemini-2.5-flash', 'gemini-flash-latest'), init); };
  const busy = async (url, init) => { urls.push('busy'); return urls.length === 3 ? { ok: false, status: 503 } : geminiFetch(url, init); };
  assert.equal((await analyse(repoFacts, { id: 'b1', env: { GEMINI_API_KEY: 'K' }, fetchImpl: retired, now: NOW })).analyser, 'gemini');
  assert.deepEqual(urls, ['gemini-flash-latest', 'gemini-2.5-flash']);
  // Overloaded (503): the same model again a moment later.
  assert.equal((await analyse(repoFacts, { id: 'b1', env: { GEMINI_API_KEY: 'K' }, fetchImpl: busy, now: NOW })).analyser, 'gemini');
  assert.equal(urls.length, 4);

  const failing = async () => ({ ok: false, status: 500 });
  const c = await analyse(repoFacts, { id: 'b1', env: { GEMINI_API_KEY: 'K' }, fetchImpl: failing, agentCli: async () => ({ id: 'claude', json: { businesses: [{ name: 'Acme CLI', summary: 'Invoices for freelancers.' }] } }), now: NOW });
  assert.equal(c.analyser, 'claude');
  assert.equal(c.overview.name, 'Acme CLI');

  const f = await analyse(repoFacts, { id: 'b1', env: {}, agentCli: null, now: NOW });
  assert.equal(f.analyser, 'facts');
  assert.equal(f.overview.name, 'acme-app');
  // A rendered dashboard without a model: views with stat tiles become businesses.
  const dash = await analyse({ source: 'file', format: 'html', location: '/d/index.html', name: 'Apps Dashboard', hasCode: false, rendered: true,
    texts: [{ label: 'Page (rendered)', text: 'Overview\nTotal users\n3,000' }],
    views: [{ label: 'Spread Out', text: 'Users\n1,204\nMRR\n$900' }, { label: 'VTO', text: 'Users\n88' }, { label: 'Settings', text: 'Theme' }] }, { id: 'd1', env: {}, agentCli: null, now: NOW });
  assert.deepEqual(dash.overviews.map((o) => o.name), ['Spread Out', 'VTO']);
  assert.deepEqual(dash.overview.kpis, [{ label: 'Total users', value: '3,000' }]);
});

const ready = (id, overview, overviews) => ({ id, kind: 'folder', target: `/x/${id}`, name: id, status: 'ready', overview, ...(overviews ? { overviews } : {}) });
const ov = (id, name, extra = {}) => ({ id, name, kind: 'business', source: 'folder', location: '/x', status: 'steady', kpis: [{ label: 'Users', value: '10' }], highlights: ['h1', 'h2', 'h3'], risks: ['r1', 'r2', 'r3'], ...extra });

test('card: data from ready sources, focus by business id / source id / name, compact when crowded', () => {
  const sources = [
    ready('s1', ov('s1', 'Acme')),
    ready('s2', ov('s2', 'Portfolio'), [ov('s2:spread-out', 'Spread Out', { status: 'thriving' }), ov('s2:vto', 'VTO', { status: 'needs attention' }), ov('s2:rss', 'RSS2Post')]),
    { id: 's3', kind: 'website', target: 'https://x.io', name: 'x', status: 'analysing' },
  ];
  const data = dashboardData(sources);
  assert.deepEqual(data.businesses.map((b) => b.id), ['s1', 's2:spread-out', 's2:vto', 's2:rss']);
  assert.equal(data.businesses[0].highlights.length, 2, 'trimmed: more than 3 businesses');
  assert.equal(resolveFocus(sources, 's1'), 's1', 'a single-business source: its business');
  assert.equal(resolveFocus(sources, 's2'), undefined, 'a portfolio source: the All grid');
  assert.equal(resolveFocus(sources, 's2:vto'), 's2:vto');
  assert.equal(resolveFocus(sources, 'spread out'), 's2:spread-out');
  assert.equal(resolveFocus(sources, 'nothing like it'), undefined);
  assert.equal(dashboardData(sources, { focus: 's2' }).focusId, undefined);

  const text = dashboardText(data);
  assert.match(text.split('\n')[0], /4 businesses; Spread Out is thriving; VTO needs attention/);
  const detected = detectSpecialContent(text);
  assert.equal(detected.type, 'business_dashboard');
  assert.equal(detected.data.businesses.length, 4);

  const empty = dashboardData([]);
  assert.deepEqual(empty, { businesses: [], empty: true });
  assert.equal(detectSpecialContent(dashboardText(empty)).type, 'business_dashboard');
  assert.match(spokenOverview(empty), /Settings → Businesses/);
  assert.match(spokenOverview(data), /VTO: needs attention; Users 10\. Risk: r1/);
  assert.match(spokenOverview(dashboardData(sources, { focus: 'acme' })), /focused on this business:\n- Acme/);
});

test('store: add, duplicate, update, delete; headers kept 0600 and never shown', () => {
  const dir = tmp();
  const store = createBusinessStore({ dataDir: dir });
  const a = store.add({ kind: 'website', target: 'Example.com/', headers: { 'X-Admin-Api-Key': 'HDR_SECRET' } });
  assert.equal(a.target, 'https://example.com');
  assert.equal(a.name, 'example.com');
  assert.throws(() => store.add({ kind: 'website', target: 'https://EXAMPLE.com' }), (e) => e.code === 'duplicate');
  const f = store.add({ kind: 'folder', target: '~/Documents/acme/' });
  assert.equal(f.target, path.join(os.homedir(), 'Documents', 'acme'));
  assert.throws(() => store.add({ kind: 'folder', target: path.join(os.homedir(), 'Documents', 'acme') }), /already added/);
  store.update(f.id, { status: 'ready', error: null });
  const reread = createBusinessStore({ dataDir: dir });
  assert.equal(reread.get(f.id).status, 'ready');
  assert.equal(reread.get(a.id).headers['X-Admin-Api-Key'], 'HDR_SECRET');
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  const pub = publicView(reread.get(a.id));
  assert.deepEqual(pub.headerNames, ['X-Admin-Api-Key']);
  assert.ok(!JSON.stringify(pub).includes('HDR_SECRET'));
  assert.ok(store.remove(f.id));
  assert.ok(!store.remove(f.id));
  assert.throws(() => validateHeaders({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }), /At most 5/);
  assert.throws(() => validateHeaders({ 'Bad Name': 'x' }), /Invalid header name/);
  assert.throws(() => validateHeaders({ X: 'a\r\nInjected: 1' }), /Invalid value/);
  assert.throws(() => normalizeTarget('website', 'ftp://x.io'), /http/);
});

/** An express app with the business routes; the caller's role comes from the x-role header. */
async function testServer(serviceOpts = {}) {
  const sent = [];
  const service = createBusinessService({
    dataDir: tmp(),
    broadcast: (m) => sent.push(m),
    lookup: async () => [{ address: '93.184.216.34' }],
    scan: async (source) => {
      if (source.target.includes('broken')) throw new Error('HTTP 500 from broken.io');
      return { source: 'website', format: 'web', location: source.target, name: 'Acme', hasCode: false, texts: [{ label: 'Home page', text: 'Acme sells invoices software to freelancers, from $9/mo.' }], site: { prices: ['$9/mo'], pages: [{ url: source.target }] } };
    },
    analyse: async (facts, { id }) => ({ overview: deterministicOverview(facts, { id, now: NOW }), analyser: 'facts' }),
    ...serviceOpts,
  });
  const app = express();
  app.use(express.json());
  registerBusinessRoutes(app, { service, role: (req) => req.headers['x-role'] || null, avatarOrigin: () => 'watch' });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { role = 'owner', body } = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-role': role }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { service, sent, call, close: () => server.close() };
}

test('routes: add → analysing → ready (card announced to the adding device), duplicates, masking, delete', async () => {
  const t = await testServer();
  try {
    const add = await t.call('POST', '/api/business/sources', { role: 'app', body: { kind: 'link', target: 'acme.io', headers: { Authorization: 'Bearer HDR_SECRET' }, origin: 'iphone' } });
    assert.equal(add.status, 201);
    assert.equal(add.body.source.status, 'analysing');
    assert.equal(add.body.source.kind, 'website');
    assert.deepEqual(add.body.source.headerNames, ['Authorization']);
    assert.equal((await t.call('POST', '/api/business/sources', { body: { kind: 'website', target: 'https://acme.io/' } })).status, 409);
    await t.service.idle();
    const list = await t.call('GET', '/api/business/sources');
    assert.equal(list.body.sources[0].status, 'ready');
    assert.equal(list.body.sources[0].format, 'web');
    assert.equal(list.body.sources[0].overview.name, 'Acme');
    assert.ok(!JSON.stringify(list.body).includes('HDR_SECRET'), 'header values never returned');
    assert.ok(!JSON.stringify(t.sent).includes('HDR_SECRET'), 'nor broadcast');
    const card = t.sent.find((m) => m.type === 'agent_result');
    assert.equal(card.origin, 'iphone');
    assert.equal(card.agentId, 'jarvis');
    assert.equal(card.agentName, 'Jarvis');
    assert.equal(detectSpecialContent(card.result).data.focusId, add.body.source.id);
    assert.ok(t.sent.some((m) => m.type === 'business_sources'));

    const dash = await t.call('GET', `/api/business/dashboard?focus=${add.body.source.id}`);
    assert.equal(dash.body.card.type, 'business_dashboard');
    assert.equal(dash.body.card.data.focusId, add.body.source.id);
    assert.equal(detectSpecialContent(dash.body.text).type, 'business_dashboard');

    const broken = await t.call('POST', '/api/business/sources', { body: { kind: 'website', target: 'https://broken.io', announce: false } });
    await t.service.idle();
    const after = (await t.call('GET', '/api/business/sources')).body.sources.find((s) => s.id === broken.body.source.id);
    assert.equal(after.status, 'error');
    assert.match(after.error, /HTTP 500/);
    assert.equal(t.sent.filter((m) => m.type === 'agent_result').length, 1, 'announce: false → no card');

    assert.equal((await t.call('POST', `/api/business/sources/${broken.body.source.id}/refresh`)).body.source.status, 'analysing');
    await t.service.idle();
    assert.equal((await t.call('POST', '/api/business/sources/nope/refresh')).status, 404);
    assert.deepEqual((await t.call('DELETE', `/api/business/sources/${broken.body.source.id}`)).body, { ok: true });
    assert.equal((await t.call('DELETE', `/api/business/sources/${broken.body.source.id}`)).status, 404);
  } finally {
    t.close();
  }
});

test('routes: validation and who may do what', async () => {
  const t = await testServer();
  try {
    assert.equal((await t.call('POST', '/api/business/sources', { body: { kind: 'boat', target: 'x' } })).status, 400);
    assert.match((await t.call('POST', '/api/business/sources', { body: { kind: 'folder', target: '/definitely/not/here' } })).body.error, /Not found/);
    assert.match((await t.call('POST', '/api/business/sources', { body: { kind: 'website', target: 'http://localhost:3000' }, role: 'app' })).body.error, /not a public/);
    assert.equal((await t.call('POST', '/api/business/sources', { body: { kind: 'folder', target: os.tmpdir(), headers: { A: 'b' } } })).status, 400);
    for (const role of ['cloud', 'avatar', '']) {
      assert.equal((await t.call('GET', '/api/business/sources', { role })).status, 403, role);
      assert.equal((await t.call('POST', '/api/business/sources', { role, body: { kind: 'website', target: 'acme.io' } })).status, 403, role);
      assert.equal((await t.call('GET', '/api/business/dashboard', { role })).status, 403, role);
    }
    // The live avatar may open the card (for the device that started it), nothing else.
    const shown = await t.call('POST', '/api/business/show', { role: 'avatar', body: { name: 'acme', via: 'avatar' } });
    assert.equal(shown.status, 200);
    assert.match(shown.body.result, /No businesses added yet/);
    const card = t.sent.find((m) => m.type === 'agent_result');
    assert.equal(card.origin, 'watch');
    assert.equal(detectSpecialContent(card.result).data.empty, true);
    assert.equal((await t.call('POST', '/api/business/show', { role: 'cloud' })).status, 403);
    const own = await t.call('POST', '/api/business/show', { body: { origin: 'web' } });
    assert.equal(own.body.ok, true);
    assert.equal(t.sent.filter((m) => m.type === 'agent_result').at(-1).origin, 'web');
  } finally {
    t.close();
  }
});

test('a restart re-analyses sources left in analysis, quietly', async () => {
  const dir = tmp();
  const store = createBusinessStore({ dataDir: dir });
  const s = store.add({ kind: 'website', target: 'acme.io' });
  const sent = [];
  const service = createBusinessService({
    dataDir: dir, broadcast: (m) => sent.push(m),
    scan: async () => ({ source: 'website', format: 'web', location: 'https://acme.io', name: 'Acme', texts: [] }),
    analyse: async (facts, { id }) => ({ overview: deterministicOverview(facts, { id }), analyser: 'facts' }),
  });
  await service.idle();
  assert.equal(service.store.get(s.id).status, 'ready');
  assert.ok(!sent.some((m) => m.type === 'agent_result'));
});
