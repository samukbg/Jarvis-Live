import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameName, compact } from './util.js';
import { wmo, compass, aqiStatus, mapForecast } from './weather.js';
import { yahooSymbol, mapChart, mapQuote } from './finance.js';
import { parseSpotify, parseLrc } from './media.js';
import { mapChain } from './wallet.js';
import { callsignOf, routeProgress, mapLive } from './flight.js';
import { findEvent, mapStats, mapScorers } from './sports.js';
import { pickDisks } from './system.js';

test('sameName matches the same entity, not unrelated ones', () => {
  assert.ok(sameName('Spaghetti alla Carbonara', 'Spaghetti Carbonara'));
  assert.ok(sameName('Benfica', 'SL Benfica'));
  assert.ok(sameName('Midnight City', 'Midnight City (Remastered)'));
  assert.ok(!sameName('Porto', 'Benfica'));
  assert.ok(!sameName('', 'x'));
});

test('compact drops missing values', () => {
  assert.deepEqual(compact({ a: 1, b: undefined, c: null, d: NaN, e: [], f: 0 }), { a: 1, f: 0 });
});

test('weather codes, compass and air quality', () => {
  assert.deepEqual(wmo(0, false), { condition: 'Clear sky', conditionCode: 'night_clear' });
  assert.equal(wmo(63).conditionCode, 'rain');
  assert.equal(compass(169), 'S');
  assert.equal(compass(350), 'N');
  assert.equal(aqiStatus(40), 'Fair');
});

test('forecast mapping labels hours and days and keeps real values only', () => {
  const f = {
    current: { temperature_2m: 19.94, is_day: 1, weather_code: 61, relative_humidity_2m: 85, visibility: 14600 },
    hourly: { time: ['2026-09-30T11:00', '2026-09-30T12:00'], temperature_2m: [20.2, 21], weather_code: [61, 3], precipitation_probability: [93, 40], is_day: [1, 1] },
    daily: { time: ['2026-09-30', '2026-10-01'], weather_code: [61, 0], temperature_2m_max: [23, 25], temperature_2m_min: [19, 15], sunrise: ['2026-09-30T07:48'], sunset: ['2026-09-30T19:31'] },
  };
  const w = mapForecast(f, { current: { european_aqi: 40 } });
  assert.equal(w.liveTemp, 19.9);
  assert.equal(w.visibility, 14.6);
  assert.equal(w.sunrise, '07:48');
  assert.deepEqual(w.hourlyForecast.map((h) => h.time), ['Now', '12:00']);
  assert.deepEqual(w.dailyForecast.map((d) => d.day), ['Today', 'Thu']);
  assert.equal(w.airQualityStatus, 'Fair');
  assert.equal(w.feelsLike, undefined, 'not reported → not invented');
});

test('finance symbols and quote mapping', () => {
  assert.equal(yahooSymbol('NVDA'), 'NVDA');
  assert.equal(yahooSymbol('btc'), 'BTC-USD');
  assert.equal(yahooSymbol('XYZ', 'Some Coin'), 'XYZ-USD');
  assert.equal(yahooSymbol('^GSPC'), '^GSPC');
  const chart = mapChart({ chart: { result: [{ meta: { regularMarketPrice: 110, chartPreviousClose: 100 }, timestamp: [1, 2, 3], indicators: { quote: [{ close: [100, null, 110] }] } }] } });
  assert.equal(chart.points.length, 2, 'gaps are skipped');
  const q = mapQuote(chart.meta, { '1D': chart.points });
  assert.equal(q.change, 10);
  assert.equal(q.changePercent, 10);
});

test('spotify output parses numbers in any locale', () => {
  const s = parseSpotify(['playing', 'Midnight City', 'M83', 'Hurry Up', '241000', '12,5', 'https://i.scdn.co/x'].join('\u001f'));
  assert.equal(s.positionSec, 12.5);
  assert.equal(s.durationSec, 241);
  assert.equal(s.isPlaying, true);
  assert.equal(parseSpotify(''), null);
});

test('synced lyrics parse to seconds', () => {
  assert.deepEqual(parseLrc('[00:37.68] Waiting in a car\n[01:14.23] \nnot a line'), [
    { t: 37.68, time: '0:37', text: 'Waiting in a car' },
    { t: 74.23, time: '1:14', text: '♪' },
  ]);
});

test('wallet mapping skips spam tokens and orients transfers', () => {
  const me = '0x00000000000000000000000000000000000000aa';
  const { network, activity } = mapChain(
    { id: 'base', name: 'Base', host: 'https://base.blockscout.com', native: { symbol: 'ETH', name: 'Ether', cg: 'ethereum' } },
    me,
    { coin_balance: '2000000000000000000', exchange_rate: '2500' },
    [
      { token: { type: 'ERC-20', symbol: 'USDC', decimals: '6', exchange_rate: '1', reputation: 'ok', holders_count: '12983105' }, value: '5000000' },
      { token: { type: 'ERC-20', symbol: 'SCAM', decimals: '18', exchange_rate: null }, value: '999000000000000000000' },
      { token: { type: 'ERC-20', symbol: 'PRICEDSPAM', decimals: '18', exchange_rate: '3', reputation: 'ok', holders_count: '40' }, value: '999000000000000000000' },
    ],
    [{ hash: '0x1', value: '1000000000000000000', to: { hash: me }, from: { hash: '0xbb' }, timestamp: '2026-09-30T10:00:00Z', status: 'ok' }],
    [],
  );
  assert.deepEqual(network.tokens.map((t) => t.symbol), ['ETH', 'USDC']);
  assert.equal(network.totalUSD, 5005);
  assert.equal(activity[0].type, 'IN');
  assert.equal(activity[0].valueUSD, 2500);
});

test('flight helpers', () => {
  assert.equal(callsignOf('BA 117'), 'BA117');
  const lhr = { latitude: 51.47, longitude: -0.46 };
  const jfk = { latitude: 40.64, longitude: -73.78 };
  assert.equal(routeProgress(lhr, jfk, lhr.latitude, lhr.longitude), 0);
  assert.equal(routeProgress(lhr, jfk, jfk.latitude, jfk.longitude), 100);
  assert.equal(mapLive({ lat: 1, lon: 2, alt_baro: 'ground', gs: 3 }).onGround, true);
  assert.equal(mapLive(undefined), null);
});

test('sports: finds the match whichever side is home and maps stats', () => {
  const events = [{ id: '1', competitions: [{ competitors: [
    { team: { id: '10', displayName: 'FC Porto' }, score: '1' },
    { team: { id: '20', displayName: 'SL Benfica' }, score: '3' },
  ] }] }];
  const hit = findEvent(events, 'Benfica', 'Porto');
  assert.equal(hit.ca.team.id, '20');
  assert.equal(findEvent(events, 'Benfica', 'Sporting'), null);
  const stats = mapStats([
    { team: { id: '20' }, statistics: [{ name: 'possessionPct', displayValue: '58.2' }, { name: 'totalShots', displayValue: '14' }] },
    { team: { id: '10' }, statistics: [{ name: 'possessionPct', displayValue: '41.8' }, { name: 'totalShots', displayValue: '9' }] },
  ], '20', '10');
  assert.deepEqual(stats[0], { label: 'Possession', valueA: '58.2%', valueB: '41.8%' });
  assert.deepEqual(mapScorers([{ type: { type: 'goal' }, team: { id: '20' }, clock: { displayValue: "12'" }, participants: [{ athlete: { displayName: 'Pavlidis' } }] }], '20'), ["Pavlidis 12'"]);
});

test('disks: macOS uses the Data volume, not the sealed system snapshot', () => {
  const GB = 1024 ** 3;
  const disks = pickDisks([
    { fs: 'a', mount: '/', size: 460 * GB, used: 12 * GB },
    { fs: 'b', mount: '/System/Volumes/Data', size: 460 * GB, used: 400 * GB },
    { fs: 'c', mount: '/System/Volumes/VM', size: 460 * GB, used: 10 * GB },
  ], 'darwin');
  assert.equal(disks[0].mount, '/System/Volumes/Data');
  assert.equal(disks.length, 1);
});
