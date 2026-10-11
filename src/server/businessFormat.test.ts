import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countable, displayLocation, sourceTitle, initialOf, initialView, normalizeWebsite, portfolioLine, statusTone, timeAgo, toMs, validateLocalPath } from './businessFormat.ts';

const NOW = Date.parse('2026-10-11T12:00:00Z');

test('business: time ago', () => {
  assert.equal(timeAgo(undefined, NOW), '');
  assert.equal(timeAgo('not a date', NOW), '');
  assert.equal(timeAgo('2026-10-11T11:59:50Z', NOW), 'just now');
  assert.equal(timeAgo('2026-10-11T11:55:00Z', NOW), '5 min ago');
  assert.equal(timeAgo('2026-10-11T10:00:00Z', NOW), '2 h ago');
  assert.equal(timeAgo('2026-10-10T10:00:00Z', NOW), 'yesterday');
  assert.equal(timeAgo('2026-10-08T12:00:00Z', NOW), '3 days ago');
  assert.equal(timeAgo('2026-09-08T12:00:00Z', NOW), 'Sep 8');
  assert.equal(timeAgo('2026-10-11T12:05:00Z', NOW), 'just now', 'a clock a little ahead is not "in the future"');
});

test('business: website validation', () => {
  assert.deepEqual(normalizeWebsite('example.com'), { url: 'https://example.com' });
  assert.deepEqual(normalizeWebsite('  https://www.Shop.io/store/ '), { url: 'https://www.shop.io/store' });
  assert.deepEqual(normalizeWebsite('http://localhost:3000'), { url: 'http://localhost:3000' });
  assert.ok('error' in normalizeWebsite(''));
  assert.ok('error' in normalizeWebsite('my site'));
  assert.ok('error' in normalizeWebsite('ftp://example.com'));
  assert.ok('error' in normalizeWebsite('example'));
});

test('business: typed local paths must be absolute', () => {
  assert.deepEqual(validateLocalPath(' /Users/me/app '), { path: '/Users/me/app' });
  assert.deepEqual(validateLocalPath('"~/Projects/x/index.html"'), { path: '~/Projects/x/index.html' });
  assert.deepEqual(validateLocalPath('C:\\Users\\me\\app'), { path: 'C:\\Users\\me\\app' });
  assert.ok('error' in validateLocalPath('Projects/app'));
  assert.ok('error' in validateLocalPath(''));
});

test('business: locations read short', () => {
  assert.equal(displayLocation('folder', '/Users/sam/Projects/app'), '~/Projects/app');
  assert.equal(displayLocation('file', '/home/sam/dash/index.html'), '~/dash/index.html');
  assert.equal(displayLocation('folder', 'C:\\Users\\sam\\app'), '~\\app');
  assert.equal(displayLocation('folder', '/opt/app'), '/opt/app');
  assert.equal(displayLocation('website', 'https://www.example.com/'), 'example.com');
  assert.equal(displayLocation('website', 'https://shop.example.com/store/'), 'shop.example.com/store');
});

test('business: monogram, tone, first view', () => {
  assert.equal(initialOf('  spread out'), 'S');
  assert.equal(initialOf('2Post'), '2');
  assert.equal(initialOf('Équipe'), 'É');
  assert.equal(initialOf(''), '•');
  assert.equal(statusTone('needs attention', 95), 'warning', 'the reported status wins');
  assert.equal(statusTone(undefined, 80), 'success');
  assert.equal(statusTone(undefined, 50), 'accent');
  assert.equal(statusTone(undefined, 10), 'warning');
  assert.equal(statusTone(), 'muted');
  const two = { businesses: [{ id: 'a' }, { id: 'b' }] };
  assert.equal(initialView(two), 'all');
  assert.equal(initialView({ ...two, focusId: 'b' }), 'b');
  assert.equal(initialView({ ...two, focusId: 'gone' }), 'all');
  assert.equal(initialView({ businesses: [{ id: 'a' }] }), 'a');
});

test('business: counting numbers, seconds vs ms, portfolio line', () => {
  assert.deepEqual(countable('1,240'), { n: 1240, decimals: 0 });
  assert.deepEqual(countable('12.5'), { n: 12.5, decimals: 1 });
  assert.equal(countable('$12k'), null);
  assert.equal(countable('4.8★'), null);
  assert.equal(countable('1,24'), null);
  assert.equal(toMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(toMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(portfolioLine([{ status: 'thriving' }, { status: 'thriving' }, { status: 'needs attention' }, {}]), '4 businesses · 2 thriving · 1 needs attention');
  assert.equal(portfolioLine([{}]), '1 business');
});

test('business: a source\'s title before it is named', () => {
  assert.equal(sourceTitle('folder', '/Users/sam/Desktop/Investor update Q3.pdf'), 'Investor update Q3.pdf');
  assert.equal(sourceTitle('folder', '/Users/sam/Projects/app/'), 'app');
  assert.equal(sourceTitle('file', 'C:\\Users\\sam\\dash.html'), 'dash.html');
  assert.equal(sourceTitle('website', 'https://www.example.com/v1/stats'), 'example.com');
});
