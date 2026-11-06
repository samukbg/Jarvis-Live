import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCalendarService } from './service.js';
import { createGoogleAuth, emailOfIdToken } from './googleAuth.js';
import { isoInZone } from './tz.js';

const NOW = Date.parse('2026-10-22T13:05:00Z'); // Thursday 14:05 in Lisbon
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cal-'));
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

const FILE = `BEGIN:VCALENDAR
VERSION:2.0
X-WR-CALNAME:School
BEGIN:VEVENT
UID:pta
DTSTART;TZID=Europe/Lisbon:20261022T180000
DTEND;TZID=Europe/Lisbon:20261022T190000
SUMMARY:PTA meeting
END:VEVENT
BEGIN:VEVENT
UID:lunch-dupe
DTSTART;TZID=Europe/Lisbon:20261023T130000
DTEND;TZID=Europe/Lisbon:20261023T140000
SUMMARY:Lunch with Ana
END:VEVENT
END:VCALENDAR`;

/** A Google provider in memory: one primary calendar, writable. */
function fakeGoogle() {
  const items = [
    { id: 'g1', calendarId: 'me@gmail.com', title: 'Lunch with Ana', startMs: Date.parse('2026-10-23T12:00:00Z'), endMs: Date.parse('2026-10-23T13:00:00Z') },
    { id: 'g2', calendarId: 'me@gmail.com', title: 'Dentist', startMs: Date.parse('2026-10-22T15:00:00Z'), endMs: Date.parse('2026-10-22T16:00:00Z'), location: 'Rua Augusta' },
  ];
  const iso = (ms) => isoInZone(ms, 'Europe/Lisbon');
  const toEvent = (i) => ({ ...i, uid: i.id, start: iso(i.startMs), end: iso(i.endMs), writable: true });
  let seq = 2;
  return {
    items,
    calendars: async () => [{ id: 'me@gmail.com', name: 'me@gmail.com', color: '#4285F4', enabled: true, writable: true, primary: true }],
    fetch: async (account, { fromMs, toMs }) => ({
      calendars: await (async () => [{ id: 'me@gmail.com', name: 'me@gmail.com', color: '#4285F4', enabled: account.calendars?.[0]?.enabled ?? true, writable: true, primary: true }])(),
      events: items.filter((i) => i.endMs > fromMs && i.startMs < toMs).map(toEvent),
    }),
    create: async (account, calendarId, f) => {
      const item = { id: `g${++seq}`, calendarId, title: f.title, startMs: f.startMs, endMs: f.endMs, location: f.location };
      items.push(item);
      return toEvent(item);
    },
    update: async (account, calendarId, id, ch) => {
      const i = items.find((x) => x.id === id);
      Object.assign(i, ch.title ? { title: ch.title } : {}, ch.startMs ? { startMs: ch.startMs, endMs: ch.endMs } : {});
      return toEvent(i);
    },
    remove: async (account, calendarId, id) => {
      items.splice(items.findIndex((x) => x.id === id), 1);
    },
  };
}

function setup({ google = fakeGoogle(), phoneAction = null, fetchImpl } = {}) {
  const sent = [];
  const clock = { t: NOW };
  const svc = createCalendarService({
    dataDir: tmp(), broadcast: (m) => sent.push(m), now: () => clock.t, lookup, google, phoneAction, fetchImpl,
    cloud: () => ({ url: 'https://cloud.test', authHeader: 'Machine m1.s1' }),
  });
  svc.setSettings({ timeZone: 'Europe/Lisbon' });
  return { svc, sent, google, clock };
}

/** Adds a Google account the way a finished sign-in does. */
async function addGoogle(svc) {
  const store = svc._store;
  const a = store.add({ kind: 'google', name: 'me@gmail.com', email: 'me@gmail.com', credentials: { refreshToken: 'r', accessToken: 'a', expiresAt: NOW + 3600_000 }, calendars: [{ id: 'me@gmail.com', name: 'me@gmail.com', enabled: true, writable: true, primary: true }] });
  await svc.syncAccount(a.id);
  return a;
}

test('file + Google: agenda merged, deduplicated, sorted; credentials never in the public view', async () => {
  const { svc } = setup();
  const file = await svc.addAccount({ kind: 'file', filename: 'school.ics', content: FILE });
  assert.equal(file.name, 'School');
  assert.equal(file.status, 'ready');
  assert.equal(file.eventCount, 2);
  assert.equal(file.writable, false);
  const g = await addGoogle(svc);
  const { events, timeZone } = await svc.events({ from: '2026-10-22', to: '2026-10-24' });
  assert.equal(timeZone, 'Europe/Lisbon');
  assert.deepEqual(events.map((e) => [e.title, e.start]), [
    ['Dentist', '2026-10-22T16:00:00+01:00'],
    ['PTA meeting', '2026-10-22T18:00:00+01:00'],
    ['Lunch with Ana', '2026-10-23T13:00:00+01:00'],
  ]);
  const lunch = events.find((e) => e.title === 'Lunch with Ana');
  assert.equal(lunch.accountId, g.id, 'the writable Google copy wins over the file copy');
  assert.equal(lunch.writable, true);
  const overview = svc.overview();
  assert.equal(JSON.stringify(overview).includes('refreshToken'), false);
  assert.deepEqual(overview.google, { available: true });
});

test('calendar toggles hide events; removing an account drops them', async () => {
  const { svc } = setup();
  const file = await svc.addAccount({ kind: 'file', filename: 'school.ics', content: FILE });
  await svc.updateAccount(file.id, { calendars: [{ id: 'file', enabled: false }] });
  assert.equal((await svc.events({ from: '2026-10-22', to: '2026-10-24' })).events.length, 0);
  await svc.updateAccount(file.id, { calendars: [{ id: 'file', enabled: true }] });
  assert.equal((await svc.events({ from: '2026-10-22', to: '2026-10-24' })).events.length, 2);
  assert.equal(await svc.removeAccount(file.id), true);
  assert.equal((await svc.events({ from: '2026-10-22', to: '2026-10-24' })).events.length, 0);
});

test('subscription link: webcal → https, checked and named from the feed', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://calendar.example.com/private-abc/basic.ics');
    return new Response(FILE, { status: 200, headers: { 'content-type': 'text/calendar' } });
  };
  const { svc } = setup({ fetchImpl });
  const a = await svc.addAccount({ kind: 'ics', url: 'webcal://calendar.example.com/private-abc/basic.ics' });
  assert.equal(a.name, 'School');
  assert.equal(a.detail, 'Subscribed link · calendar.example.com/…/basic.ics');
  assert.equal(JSON.stringify(a).includes('private-abc'), false, 'the secret link stays on the server');
  await assert.rejects(svc.addAccount({ kind: 'ics', url: 'https://calendar.example.com/private-abc/basic.ics' }), /already added/);
  const html = async () => new Response('<html><body>Login</body></html>', { status: 200 });
  const { svc: s2 } = setup({ fetchImpl: html });
  await assert.rejects(s2.addAccount({ kind: 'ics', url: 'https://example.com/cal' }), /web page, not a calendar/);
});

test('phone calendars: synced by the app, read-only, toggles kept across syncs', async () => {
  const { svc } = setup();
  const body = {
    deviceId: 'dev-1', deviceName: "Sam's iPhone", platform: 'ios',
    calendars: [{ id: 'cal-home', name: 'Home', color: '#ff9500' }, { id: 'cal-work', name: 'Work' }],
    events: [
      { id: 'x1', calendarId: 'cal-home', title: 'Gym', start: '2026-10-22T19:00:00+01:00', end: '2026-10-22T20:00:00+01:00' },
      { id: 'x2', calendarId: 'cal-work', title: 'Review', start: '2026-10-23T10:00:00+01:00', end: '2026-10-23T11:00:00+01:00', url: 'https://zoom.us/j/123' },
      { id: 'x3', calendarId: 'unknown', title: 'ignored', start: '2026-10-23' },
    ],
  };
  const a = svc.deviceSync(body);
  assert.equal(a.kind, 'device');
  assert.equal(a.name, "Sam's iPhone");
  assert.equal(a.eventCount, 2);
  assert.equal(a.calendars[0].color, '#FF9500');
  await svc.updateAccount(a.id, { calendars: [{ id: 'cal-work', enabled: false }] });
  const again = svc.deviceSync(body);
  assert.equal(again.id, a.id);
  assert.equal(again.calendars.find((c) => c.id === 'cal-work').enabled, false);
  const { events } = await svc.events({ from: '2026-10-22', to: '2026-10-24' });
  assert.deepEqual(events.map((e) => [e.title, e.writable]), [['Gym', false]]);
});

test('voice: agenda with refs + card, add (clash noted), move by ref, delete only when confirmed', async () => {
  const { svc, sent, clock } = setup();
  await addGoogle(svc);
  const agenda = await svc.runTool('calendar_agenda', { day: 'today' });
  assert.match(agenda, /Now: Thursday,? 22 October 2026/);
  assert.match(agenda, /16:00–17:00 Dentist at Rua Augusta \(me@gmail\.com\) \[e1\]/);
  const card = sent.findLast((m) => m.type === 'agent_result');
  assert.match(card.result, /"type":"agenda"/);

  const added = await svc.runTool('calendar_add_event', { title: 'Call with Bob', start: '2026-10-22T16:30', durationMinutes: 45 });
  assert.match(added, /Added "Call with Bob" on Thursday,? 22 October, 16:30–17:15 to the "me@gmail\.com" calendar\./);
  const clash = await svc.runTool('calendar_add_event', { title: 'Haircut', start: '2026-10-22T16:00' });
  assert.match(clash, /overlaps with "Dentist" \(16:00–17:00\) and "Call with Bob"/);

  const moved = await svc.runTool('calendar_update_event', { event: 'e1', start: '2026-10-23T09:00' });
  assert.match(moved, /Changed "Dentist" \(was 2026-10-22 16:00–17:00\): now "Dentist" on 2026-10-23 09:00–10:00\./);

  // The model saying "confirmed" first, or right after asking, deletes nothing.
  assert.match(await svc.runTool('calendar_delete_event', { event: 'haircut', confirmed: true }), /Not deleted yet\. Ask the user to confirm deleting "Haircut"/);
  assert.match(await svc.runTool('calendar_delete_event', { event: 'haircut', confirmed: true }), /Not deleted yet/);
  clock.t += 5_000; // the user answers
  const del = await svc.runTool('calendar_delete_event', { event: 'haircut', confirmed: true });
  assert.match(del, /Deleted "Haircut"/);
  assert.match(await svc.runTool('calendar_delete_event', { event: 'nothing like this' }), /No event matching/);
});

test('voice: no calendar → says so; no writable calendar → the phone adds it', async () => {
  const calls = [];
  const { svc } = setup({ phoneAction: async (a) => { calls.push(a); return 'Event added on the phone.'; } });
  assert.match(await svc.runTool('calendar_agenda', {}), /No calendar is connected/);
  await svc.addAccount({ kind: 'file', filename: 'school.ics', content: FILE });
  const out = await svc.runTool('calendar_add_event', { title: 'Swim', start: '2026-10-24T10:00' });
  assert.match(out, /Event added on the phone/);
  assert.deepEqual(calls, [{ action: 'calendar_event', text: 'Swim', value: '2026-10-24T10:00:00+01:00', target: '60' }]);
});

test('settings: default calendar must be writable; time zone validated', async () => {
  const { svc } = setup();
  const file = await svc.addAccount({ kind: 'file', filename: 'school.ics', content: FILE });
  assert.throws(() => svc.setSettings({ defaultCalendar: { accountId: file.id, calendarId: 'file' } }), /Pick a calendar/);
  assert.throws(() => svc.setSettings({ timeZone: 'Mars/Olympus' }), /Unknown time zone/);
  const g = await addGoogle(svc);
  assert.deepEqual(svc.setSettings({ defaultCalendar: { accountId: g.id, calendarId: 'me@gmail.com' } }).defaultCalendar, { accountId: g.id, calendarId: 'me@gmail.com' });
});

test('non-Live agents: the brief carries the agenda and a short-lived local token', async () => {
  const { svc } = setup();
  assert.equal(await svc.agentBrief(), null);
  await addGoogle(svc);
  const brief = await svc.agentBrief({ port: 4000 });
  assert.match(brief, /Dentist/);
  const token = /x-calendar-token: ([\w-]+)/.exec(brief)[1];
  assert.ok(svc.agentTokenOk(token));
  assert.equal(svc.agentTokenOk('nope'), false);
  assert.match(brief, /http:\/\/127\.0\.0\.1:4000\/api\/calendar\/agent\/calendar_add_event/);
});

test('Google sign-in through Jarvis Cloud: PKCE start, poll until the code arrives, tokens never stored there', async () => {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, body });
    if (url.endsWith('/v1/oauth/google/start')) return Response.json({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x', state: 'st1' });
    if (url.endsWith('/v1/oauth/google/exchange')) {
      polls++;
      if (polls < 2) return Response.json({ status: 'pending' }, { status: 202 });
      const idToken = `x.${Buffer.from(JSON.stringify({ email: 'me@gmail.com' })).toString('base64url')}.y`;
      return Response.json({ tokens: { access_token: 'at', refresh_token: 'rt', expires_in: 3599, id_token: idToken } });
    }
    return Response.json({}, { status: 404 });
  };
  let got;
  const auth = createGoogleAuth({ cloud: () => ({ url: 'https://cloud.test', authHeader: 'Machine m.s' }), fetchImpl, onTokens: async (t) => { got = t; return { id: 'acc' }; } });
  const { authUrl, state } = await auth.start();
  assert.equal(state, 'st1');
  assert.match(authUrl, /^https:\/\/accounts\.google\.com/);
  assert.match(calls[0].body.codeChallenge, /^[\w-]{43}$/);
  assert.equal(calls[0].auth, 'Machine m.s');
  assert.deepEqual(auth.status('st1'), { status: 'pending' });
  for (let i = 0; i < 40 && auth.status('st1').status === 'pending'; i++) await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(auth.status('st1'), { status: 'connected', account: { id: 'acc' } });
  assert.equal(got.refresh_token, 'rt');
  assert.equal(calls[1].body.codeVerifier.length, 64);
  assert.equal(emailOfIdToken(got.id_token), 'me@gmail.com');
});

test('Google: unavailable without Jarvis Cloud or an own OAuth client', () => {
  const auth = createGoogleAuth({ cloud: () => null, env: {} });
  assert.equal(auth.available().available, false);
  assert.match(auth.available().reason, /Link this computer to Jarvis Cloud/);
  assert.equal(createGoogleAuth({ cloud: () => null, env: { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 's' } }).available().available, true);
});

test('voice context: the next 7 days are in the Live prompt unless the user turns it off', async () => {
  const { svc } = setup();
  assert.doesNotMatch(svc.prompt(), /next 7 days/, 'no calendar: no digest');
  await addGoogle(svc);
  await svc.refreshDigest();
  assert.match(svc.prompt(), /Thu 22 Oct: 16:00–17:00 Dentist @ Rua Augusta/);
  assert.match(svc.prompt(), /Fri 23 Oct: 13:00–14:00 Lunch with Ana/);
  assert.equal(svc.setSettings({ shareWithVoice: false }).shareWithVoice, false);
  assert.doesNotMatch(svc.prompt(), /Dentist/);
  assert.equal(svc.overview().settings.shareWithVoice, false);
});
