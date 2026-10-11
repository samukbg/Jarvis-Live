import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachLogos, ensureLogo, hostOf, iconCandidates, logoFile, sniffImage } from './logos.js';
import { cleanRevenue, cleanWebsite, fromModel } from './analyse.js';
import { dashboardData, dashboardSummary, portfolioTotals, spokenOverview, totalsSentence } from './card.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(200, 2)]);
const lookup = async () => [{ address: '93.184.216.34' }];

/** A fetch answering from a map of URL → { status, type, body }. */
function fakeFetch(routes, seen = []) {
  return async (url) => {
    seen.push(url);
    const r = routes[url] || { status: 404, type: 'text/plain', body: Buffer.from('nope') };
    return new Response(r.body, { status: r.status || 200, headers: { 'content-type': r.type || 'application/octet-stream' } });
  };
}

test('hostOf / cleanWebsite: bare public domains, never backend hosts', () => {
  assert.equal(hostOf('https://www.SpreadOut.ai/pricing'), 'spreadout.ai');
  assert.equal(hostOf('post2podcast.xyz'), 'post2podcast.xyz');
  assert.equal(hostOf('not a host'), null);
  assert.equal(cleanWebsite('https://rss2post.fly.dev'), undefined);
  assert.equal(cleanWebsite('jarvis-live.xyz'), 'jarvis-live.xyz');
});

test('iconCandidates: apple-touch-icon and big PNGs first, SVG last', () => {
  const html = `<head>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/icon-32.png" sizes="32x32">
    <link rel="apple-touch-icon" href="/apple.png" sizes="180x180">
    <link rel="mask-icon" href="/mask.svg">
  </head>`;
  assert.deepEqual(iconCandidates(html, 'https://acme.io/'), ['https://acme.io/apple.png', 'https://acme.io/icon-32.png', 'https://acme.io/favicon.svg']);
});

test('sniffImage: real bytes decide (ICO served as octet-stream), junk is refused', () => {
  assert.equal(sniffImage(PNG, 'application/octet-stream'), 'image/png');
  assert.equal(sniffImage(ICO, 'application/octet-stream'), 'image/x-icon');
  assert.equal(sniffImage(Buffer.from('<html>not an icon</html>'), 'text/html'), null);
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml'), 'image/svg+xml');
});

test('ensureLogo: the page\'s best icon, cached, reused; falls back to /favicon.ico', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-logos-'));
  const seen = [];
  const fetchImpl = fakeFetch({
    'https://acme.io/': { type: 'text/html', body: '<link rel="apple-touch-icon" href="/apple.png">' },
    'https://acme.io/apple.png': { type: 'image/png', body: PNG },
    'https://other.io/': { type: 'text/html', body: '<title>no icons</title>' },
    'https://other.io/favicon.ico': { type: 'application/octet-stream', body: ICO },
  }, seen);
  assert.equal(await ensureLogo(dataDir, 'acme.io', { fetchImpl, lookup }), '/api/business/logo/acme.io');
  assert.equal(logoFile(dataDir, 'acme.io').type, 'image/png');
  const calls = seen.length;
  assert.equal(await ensureLogo(dataDir, 'acme.io', { fetchImpl, lookup }), '/api/business/logo/acme.io');
  assert.equal(seen.length, calls, 'fresh logos come from the cache');
  assert.equal(await ensureLogo(dataDir, 'other.io', { fetchImpl, lookup }), '/api/business/logo/other.io');
  assert.equal(logoFile(dataDir, 'other.io').type, 'image/x-icon');
  assert.equal(await ensureLogo(dataDir, 'none.io', { fetchImpl, lookup }), undefined);
  assert.equal(logoFile(dataDir, '../etc/passwd'), null);
});

test('attachLogos: businesses with a website get the cached icon; the rest keep their monogram', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-logos-'));
  const fetchImpl = fakeFetch({ 'https://acme.io/': { type: 'text/html', body: '' }, 'https://acme.io/favicon.ico': { body: ICO } });
  const list = [{ name: 'Acme', website: 'acme.io' }, { name: 'Side project' }];
  await attachLogos(list, { dataDir, fetchImpl, lookup });
  assert.equal(list[0].logoUrl, '/api/business/logo/acme.io');
  assert.equal(list[1].logoUrl, undefined);
});

test('cleanRevenue + fromModel: numbers only, backend hosts dropped', () => {
  assert.deepEqual(cleanRevenue({ amount: 344.824, previous: '315.73', currency: 'usd' }), { amount: 344.82, previous: 315.73, currency: 'USD', period: 'month' });
  assert.equal(cleanRevenue({ amount: 'a lot' }), undefined);
  const base = { id: 's1', name: 'Dash', source: 'folder', location: '/x/index.html', kpis: [], highlights: [], risks: [], nextSteps: [] };
  const { overviews } = fromModel(base, { businesses: [
    { name: 'Spread Out AI', website: 'https://spreadout.ai', revenue: { amount: 378.1, previous: 340 } },
    { name: 'RSS2Post', website: 'rss2post.fly.dev', revenue: { amount: 179.1 } },
  ] });
  assert.equal(overviews[0].website, 'spreadout.ai');
  assert.deepEqual(overviews[0].revenue, { amount: 378.1, previous: 340, currency: 'USD', period: 'month' });
  assert.equal(overviews[1].website, undefined);
});

test('portfolioTotals: overall revenue and gain / loss across the businesses that state it', () => {
  const t = portfolioTotals([
    { name: 'A', revenue: { amount: 300, previous: 250, currency: 'USD', period: 'month' } },
    { name: 'B', revenue: { amount: 100, previous: 120, currency: 'USD', period: 'month' } },
    { name: 'C', revenue: { amount: 50, currency: 'USD', period: 'month' } },
    { name: 'Blog' },
  ]);
  assert.deepEqual(t, { revenue: 450, currency: 'USD', period: 'month', businesses: 3, previous: 370, change: 30, changePercent: 8.1 });
  assert.equal(portfolioTotals([{ name: 'Blog' }]), undefined);
  assert.equal(totalsSentence(t), 'Overall $450.00 a month, up $30.00 (8.1%) from last month.');
  assert.equal(totalsSentence({ revenue: 90, previous: 100, change: -10, changePercent: -10, currency: 'USD', period: 'month' }), 'Overall $90.00 a month, down $10.00 (10%) from last month.');
});

test('dashboardData carries the totals; the summary and the spoken overview say them', () => {
  const sources = [{ id: 's1', status: 'ready', overview: { id: 's1', name: 'Dash' }, overviews: [
    { id: 's1:a', name: 'A', status: 'thriving', revenue: { amount: 300, previous: 250, currency: 'USD', period: 'month' } },
    { id: 's1:b', name: 'B', status: 'steady', revenue: { amount: 100, previous: 100, currency: 'USD', period: 'month' } },
  ] }];
  const data = dashboardData(sources);
  assert.equal(data.totals.change, 50);
  assert.match(dashboardSummary(data), /Overall \$400\.00 a month, up \$50\.00 \(14\.3%\)/);
  assert.match(spokenOverview(data), /Overall \$400\.00/);
});

test('inline SVG icons (data: URLs) are kept, and their path says ?type=svg', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-logos-'));
  const svg = encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='22'/></svg>");
  const fetchImpl = fakeFetch({ 'https://orb.io/': { type: 'text/html', body: `<link rel="icon" href="data:image/svg+xml,${svg}">` } });
  assert.equal(await ensureLogo(dataDir, 'orb.io', { fetchImpl, lookup }), '/api/business/logo/orb.io?type=svg');
  assert.equal(logoFile(dataDir, 'orb.io').type, 'image/svg+xml');
});
