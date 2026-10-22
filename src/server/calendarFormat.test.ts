// node --test --experimental-strip-types src/server/calendarFormat.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, caldavBody, calendarsLine, countdown, dayHeading, dayKey, durationLabel, effectiveDefault, eventPhase, formatTime, formatTimeRange,
  groupByDay, icsFileProblem, looksLikeIcs, maskLink, nextUp, normalizeIcsLink, progressOf, safeColor, shortDate, startOfDay, syncLine,
  timeAgo, validTimeZone, writableTargets, zoneCity, zoneOffsetLabel, zoneOr,
} from './calendarFormat.ts';
import { calendarClient, CalendarApiError } from './calendar.ts';
import type { CalendarAccount } from './calendar.ts';

const LIS = 'Europe/Lisbon';
const NY = 'America/New_York';
// Thu 22 Oct 2026, 14:35 in Lisbon (UTC+1, summer time until 25 Oct).
const NOW = Date.parse('2026-10-22T14:35:00+01:00');

test('time zones: validate, fall back, offsets, city', () => {
  assert.equal(validTimeZone(LIS), LIS);
  assert.equal(validTimeZone('Mars/Olympus'), null);
  assert.equal(validTimeZone(''), null);
  assert.ok(zoneOr('Not/AZone').length > 0);
  assert.equal(zoneOffsetLabel(LIS, NOW), 'GMT+1');
  assert.equal(zoneOffsetLabel(LIS, Date.parse('2026-12-01T12:00:00Z')), 'GMT');
  assert.equal(zoneOffsetLabel('Asia/Kolkata', NOW), 'GMT+5:30');
  assert.equal(zoneOffsetLabel(NY, NOW), 'GMT-4');
  assert.equal(zoneCity('America/Argentina/Buenos_Aires'), 'Buenos Aires');
});

test('days: keys in a zone, arithmetic, DST-safe midnight', () => {
  // 23:30 in New York on the 21st is already the 22nd in Lisbon.
  const t = Date.parse('2026-10-21T23:30:00-04:00');
  assert.equal(dayKey(t, NY), '2026-10-21');
  assert.equal(dayKey(t, LIS), '2026-10-22');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(startOfDay('2026-10-22', LIS), Date.parse('2026-10-22T00:00:00+01:00'));
  // Lisbon leaves summer time on 25 Oct: that day starts at +01:00, the next at +00:00.
  assert.equal(startOfDay('2026-10-25', LIS), Date.parse('2026-10-25T00:00:00+01:00'));
  assert.equal(startOfDay('2026-10-26', LIS), Date.parse('2026-10-26T00:00:00Z'));
  assert.equal(shortDate('2026-10-23'), 'Fri 23 Oct');
  assert.equal(shortDate('2027-01-04', 2026), 'Mon 4 Jan 2027');
});

test('dayHeading: today / tomorrow / yesterday / dated', () => {
  assert.equal(dayHeading('2026-10-22', LIS, NOW).label, 'Today');
  assert.equal(dayHeading('2026-10-23', LIS, NOW).label, 'Tomorrow');
  assert.equal(dayHeading('2026-10-21', LIS, NOW).label, 'Yesterday');
  assert.deepEqual(dayHeading('2026-10-24', LIS, NOW), { label: 'Sat 24 Oct', date: 'Sat 24 Oct', relative: null });
});

test('groupByDay: sorted days, all-day spans, overnight carry-over, range bounds', () => {
  const events = [
    { id: 'b', title: 'Lunch with Ana', start: '2026-10-22T13:00:00+01:00', end: '2026-10-22T14:00:00+01:00' },
    { id: 'a', title: 'Standup', start: '2026-10-22T09:30:00+01:00', end: '2026-10-22T09:45:00+01:00' },
    { id: 'trip', title: 'Porto trip', start: '2026-10-21', end: '2026-10-24', allDay: true },
    { id: 'c', title: 'Dentist', start: '2026-10-23T10:00:00+01:00' },
    // Seen from Lisbon, 20:00 in New York on the 22nd is 01:00 on the 23rd.
    { id: 'ny', title: 'Call NY', start: '2026-10-22T20:00:00-04:00', end: '2026-10-22T20:30:00-04:00' },
    { id: 'late', title: 'Night shift', start: '2026-10-21T22:00:00+01:00', end: '2026-10-22T06:00:00+01:00' },
    { id: 'bad', title: 'Broken', start: 'whenever' },
  ];
  const days = groupByDay(events, LIS, { from: '2026-10-22T00:00:00+01:00', to: '2026-10-24T00:00:00+01:00' });
  assert.deepEqual(days.map((d) => d.key), ['2026-10-22', '2026-10-23']);
  assert.deepEqual(days[0].allDay.map((e) => e.id), ['trip']);
  assert.deepEqual(days[0].timed.map((e) => e.id), ['late', 'a', 'b']);
  assert.deepEqual(days[1].allDay.map((e) => e.id), ['trip']);
  assert.deepEqual(days[1].timed.map((e) => e.id), ['ny', 'c']);
  // Without a range: the trip covers 21, 22 and 23 (end exclusive); Night shift starts on the 21st.
  const all = groupByDay(events, LIS);
  assert.deepEqual(all.map((d) => d.key), ['2026-10-21', '2026-10-22', '2026-10-23']);
  assert.deepEqual(all[0].timed.map((e) => e.id), ['late']);
  assert.deepEqual(groupByDay([], LIS), []);
});

test('formatTime / formatTimeRange in a given zone', () => {
  const s = '2026-10-22T15:00:00+01:00';
  assert.equal(formatTime(Date.parse(s), LIS, { locale: 'en-GB' }), '15:00');
  assert.equal(formatTime(Date.parse(s), NY, { locale: 'en-GB' }), '10:00');
  assert.equal(formatTime(Date.parse(s), LIS, { locale: 'en-US' }), '3:00 PM');
  assert.equal(formatTimeRange({ title: 'x', start: s, end: '2026-10-22T16:30:00+01:00' }, LIS, { locale: 'en-GB' }), '15:00 – 16:30');
  assert.equal(formatTimeRange({ title: 'x', start: '2026-10-22T22:00:00+01:00', end: '2026-10-23T01:00:00+01:00' }, LIS, { locale: 'en-GB' }), '22:00 – Fri 01:00');
  assert.equal(formatTimeRange({ title: 'x', start: '2026-10-22T22:00:00+01:00', end: '2026-10-23T00:00:00+01:00' }, LIS, { locale: 'en-GB' }), '22:00 – 00:00');
  assert.equal(formatTimeRange({ title: 'x', start: s }, LIS, { locale: 'en-GB' }), '15:00');
  assert.equal(formatTimeRange({ title: 'x', start: '2026-10-22', allDay: true }, LIS), 'All day');
  assert.equal(formatTimeRange({ title: 'x', start: '2026-10-22', end: '2026-10-23', allDay: true }, LIS), 'All day');
  assert.equal(formatTimeRange({ title: 'x', start: '2026-10-22', end: '2026-10-26' }, LIS), 'All day · until Sun 25 Oct');
});

test('durations and countdowns', () => {
  const h = 3_600_000;
  assert.equal(durationLabel(0, 45 * 60_000), '45 min');
  assert.equal(durationLabel(0, h), '1 h');
  assert.equal(durationLabel(0, 1.5 * h), '1 h 30 min');
  assert.equal(durationLabel(0, 48 * h), '2 days');
  assert.equal(durationLabel(10, 5), '');
  assert.equal(countdown(NOW + 25 * 60_000, NOW), 'in 25 min');
  assert.equal(countdown(NOW + 20_000, NOW), 'now');
  assert.equal(countdown(NOW + 65 * 60_000, NOW), 'in 1 h 5 min');
  assert.equal(countdown(NOW + 2 * h, NOW), 'in 2 h');
  assert.equal(countdown(NOW + 6.2 * h, NOW), 'in 6 h');
  assert.equal(countdown(NOW + 30 * h, NOW), 'in 1 day');
  assert.equal(countdown(NOW + 75 * h, NOW), 'in 3 days');
});

test('eventPhase, progress and nextUp', () => {
  const past = { id: 'p', title: 'Standup', start: '2026-10-22T09:30:00+01:00', end: '2026-10-22T09:45:00+01:00' };
  const on = { id: 'o', title: 'Design review', start: '2026-10-22T14:00:00+01:00', end: '2026-10-22T15:00:00+01:00' };
  const soon = { id: 's', title: 'Call with Ana', start: '2026-10-22T15:00:00+01:00', end: '2026-10-22T15:30:00+01:00' };
  const allDay = { id: 'd', title: 'Holiday', start: '2026-10-22', allDay: true };
  assert.equal(eventPhase(past, LIS, NOW), 'past');
  assert.equal(eventPhase(on, LIS, NOW), 'now');
  assert.equal(eventPhase(soon, LIS, NOW), 'upcoming');
  assert.equal(eventPhase(allDay, LIS, NOW), 'now');
  assert.equal(eventPhase(allDay, LIS, Date.parse('2026-10-23T00:00:00+01:00')), 'past');
  assert.ok(Math.abs(progressOf(on, NOW) - 35 / 60) < 1e-9);
  assert.deepEqual(nextUp([past, soon, on, allDay], NOW), { event: on, phase: 'now', label: 'now · ends in 25 min' });
  assert.deepEqual(nextUp([past, soon, allDay], NOW), { event: soon, phase: 'upcoming', label: 'in 25 min' });
  assert.equal(nextUp([past, allDay], NOW), null);
});

const account = (over: Partial<CalendarAccount> = {}): CalendarAccount => ({
  id: 'g1', kind: 'google', name: 'you@gmail.com', status: 'ready', writable: true, createdAt: '2026-10-01T10:00:00Z',
  calendars: [
    { id: 'primary', name: 'you@gmail.com', color: '#4285F4', enabled: true, writable: true, primary: true },
    { id: 'family', name: 'Family', color: '#F4511E', enabled: true, writable: true },
    { id: 'holidays', name: 'Holidays in Portugal', enabled: true, writable: false },
    { id: 'old', name: 'Old project', enabled: false, writable: true },
  ],
  ...over,
});

test('accounts: sync line, calendars line, writable targets, default', () => {
  assert.equal(syncLine({ lastSync: new Date(NOW - 2 * 60_000).toISOString(), eventCount: 124 }, NOW), 'Synced 2 min ago · 124 events');
  assert.equal(syncLine({ lastSync: new Date(NOW - 5_000).toISOString(), eventCount: 1 }, NOW), 'Synced just now · 1 event');
  assert.equal(syncLine({ eventCount: 1234 }, NOW), 'Synced · 1,234 events');
  assert.equal(syncLine({}, NOW), 'Synced');
  assert.equal(timeAgo(new Date(NOW - 3 * 3_600_000).toISOString(), NOW), '3 h ago');
  assert.equal(calendarsLine(account()), '3 of 4 calendars');
  const ics = account({ id: 'i1', kind: 'ics', name: 'Holidays', writable: false, calendars: [{ id: 'c', name: 'Holidays', enabled: true, writable: false }] });
  assert.equal(calendarsLine(ics), '1 calendar');
  const targets = writableTargets([account(), ics]);
  assert.deepEqual(targets.map((t) => t.ref.calendarId), ['primary', 'family']);
  assert.equal(effectiveDefault([account(), ics], { defaultCalendar: { accountId: 'g1', calendarId: 'family' } })?.name, 'Family');
  // A default that's gone (or read-only) falls back to the primary.
  assert.equal(effectiveDefault([account()], { defaultCalendar: { accountId: 'g1', calendarId: 'holidays' } })?.ref.calendarId, 'primary');
  assert.equal(effectiveDefault([ics], { defaultCalendar: null }), null);
  assert.deepEqual(writableTargets([account({ status: 'needs_auth' })]), []);
});

test('safeColor only lets #RRGGBB through', () => {
  assert.equal(safeColor('#4285f4', '#000000'), '#4285F4');
  assert.equal(safeColor('#abc', '#000000'), '#AABBCC');
  assert.equal(safeColor('red', '#22D3EE'), '#22D3EE');
  assert.equal(safeColor('#4285F4; background:url(x)', '#22D3EE'), '#22D3EE');
  assert.equal(safeColor(undefined, '#22D3EE'), '#22D3EE');
});

test('ICS links: normalize and mask', () => {
  assert.deepEqual(normalizeIcsLink('  webcal://p12-caldav.icloud.com/published/2/MTIzNDU2Nzg5  '), { url: 'webcal://p12-caldav.icloud.com/published/2/MTIzNDU2Nzg5' });
  assert.ok('url' in normalizeIcsLink('https://calendar.google.com/calendar/ical/x%40gmail.com/private-abc/basic.ics'));
  assert.ok('error' in normalizeIcsLink(''));
  assert.ok('error' in normalizeIcsLink('calendar.google.com/basic.ics'));
  assert.match((normalizeIcsLink('http://example.com/cal.ics') as { error: string }).error, /https/);
  assert.ok('error' in normalizeIcsLink('ftp://example.com/cal.ics'));
  assert.ok('error' in normalizeIcsLink('https://exa mple.com'));
  assert.equal(maskLink('https://calendar.google.com/calendar/ical/x%40gmail.com/private-0123456789abcdef/basic.ics'), 'calendar.google.com/…/basic.ics');
  assert.equal(maskLink('webcal://p12-caldav.icloud.com/published/2/MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkw'), 'p12-caldav.icloud.com/…');
  assert.equal(maskLink('https://outlook.office365.com/owa/calendar/abc@x.com/0f1e2d3c4b5a69788796a5b4c3d2e1f0/calendar.ics'), 'outlook.office365.com/…/calendar.ics');
  assert.equal(maskLink('https://example.com'), 'example.com');
});

test('CalDAV form → body', () => {
  assert.deepEqual(caldavBody({ provider: 'icloud', username: ' me@icloud.com ', password: 'abcd-efgh-ijkl-mnop' }),
    { body: { kind: 'caldav', provider: 'icloud', username: 'me@icloud.com', password: 'abcd-efgh-ijkl-mnop' } });
  assert.match((caldavBody({ provider: 'icloud', username: 'me', password: 'x' }) as { error: string }).error, /email/);
  assert.match((caldavBody({ provider: 'icloud', username: 'me@icloud.com', password: '' }) as { error: string }).error, /app-specific password/);
  assert.match((caldavBody({ provider: 'nextcloud', username: 'sam', password: 'x' }) as { error: string }).error, /server/);
  assert.deepEqual(caldavBody({ provider: 'nextcloud', username: 'sam', password: 'x', url: 'cloud.example.com/remote.php/dav' }),
    { body: { kind: 'caldav', provider: 'nextcloud', username: 'sam', password: 'x', url: 'https://cloud.example.com/remote.php/dav' } });
  assert.ok('error' in caldavBody({ provider: 'other', username: 'sam', password: 'x', url: 'ftp://x.y' }));
});

test('ICS files', () => {
  assert.equal(icsFileProblem({ name: 'work.ics', size: 2048 }), null);
  assert.match(icsFileProblem({ name: 'work.ics', size: 6 * 1024 * 1024 })!, /5 MB/);
  assert.match(icsFileProblem({ name: 'notes.txt', size: 10 })!, /\.ics/);
  assert.match(icsFileProblem({ name: 'work.ics', size: 0 })!, /empty/);
  assert.equal(looksLikeIcs('BEGIN:VCALENDAR\r\nVERSION:2.0'), true);
  assert.equal(looksLikeIcs('hello'), false);
});

test('calendarClient: paths, headers, bodies and errors', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let reply: () => Response = () => new Response(JSON.stringify({}), { status: 200 });
  const fake = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return reply(); }) as unknown as typeof fetch;
  const c = calendarClient(() => ({ url: 'http://pc:4000', key: 'k1' }), fake);

  reply = () => new Response(JSON.stringify({ accounts: [account()], settings: { defaultCalendar: null, timeZone: LIS }, google: { available: false, reason: 'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env.' } }));
  const o = await c.overview();
  assert.equal(calls[0].url, 'http://pc:4000/api/calendar');
  assert.equal((calls[0].init.headers as Record<string, string>)['x-api-key'], 'k1');
  assert.equal(o.accounts.length, 1);
  assert.deepEqual(o.google, { available: false, reason: 'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env.' });

  reply = () => new Response(JSON.stringify({ account: account({ id: 'a/b' }) }), { status: 201 });
  await c.updateAccount('a/b', { calendars: [{ id: 'old', enabled: true }] });
  assert.equal(calls[1].url, 'http://pc:4000/api/calendar/accounts/a%2Fb');
  assert.equal(calls[1].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { calendars: [{ id: 'old', enabled: true }] });

  reply = () => new Response(JSON.stringify({ events: [], timeZone: LIS }));
  await c.events({ from: '2026-10-22T00:00:00Z', q: '' });
  assert.equal(calls[2].url, 'http://pc:4000/api/calendar/events?from=2026-10-22T00%3A00%3A00Z');
  assert.equal(calls[2].init.body, undefined);

  reply = () => new Response(JSON.stringify({ status: 'pending' }));
  assert.deepEqual(await c.googleStatus('s t'), { status: 'pending' });
  assert.equal(calls[3].url, 'http://pc:4000/api/calendar/google/status?state=s+t');

  reply = () => new Response(JSON.stringify({ error: 'Apple ID or app-specific password is wrong' }), { status: 400 });
  await assert.rejects(c.addAccount({ kind: 'caldav', provider: 'icloud', username: 'a@b.co', password: 'x' }), (e: unknown) => e instanceof CalendarApiError && e.status === 400 && e.message === 'Apple ID or app-specific password is wrong');
  reply = () => new Response('nope', { status: 403 });
  await assert.rejects(c.removeAccount('g1'), /owner/);
  const offline = calendarClient(() => ({ url: 'http://pc:4000', key: '' }), (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
  await assert.rejects(offline.overview(), (e: unknown) => e instanceof CalendarApiError && e.status === 0);
  await assert.rejects(calendarClient(() => ({ url: '', key: '' }), fake).overview(), /Not connected/);
});

test('meeting links and range labels', async () => {
  const { meetingLink, rangeLabel } = await import('./calendarFormat.ts');
  assert.deepEqual(meetingLink('https://meet.google.com/abc-defg-hij'), { href: 'https://meet.google.com/abc-defg-hij', label: 'Join Meet' });
  assert.equal(meetingLink('https://us02web.zoom.us/j/123')?.label, 'Join Zoom');
  assert.equal(meetingLink('https://teams.microsoft.com/l/meetup-join/x')?.label, 'Join Teams');
  assert.equal(meetingLink('https://example.com/call')?.label, 'Join');
  assert.equal(meetingLink('javascript:alert(1)'), null);
  assert.equal(meetingLink('http://zoom.us/j/1'), null);
  assert.equal(meetingLink(undefined), null);
  assert.equal(rangeLabel('2026-10-22T00:00:00+01:00', '2026-10-23T00:00:00+01:00', LIS, NOW), 'Thu 22 Oct');
  assert.equal(rangeLabel('2026-10-19T00:00:00+01:00', '2026-10-26T00:00:00Z', LIS, NOW), 'Mon 19 – Sun 25 Oct');
  assert.equal(rangeLabel('2026-10-29T00:00:00Z', '2026-11-03T00:00:00Z', LIS, NOW), 'Thu 29 Oct – Mon 2 Nov');
  assert.equal(rangeLabel('', '', LIS, NOW), '');
});
