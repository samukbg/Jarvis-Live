import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEventCalendar, expandEvents, meetingUrlOf, parseCalendar, updateEventCalendar, calendarMeta } from './ics.js';
import { ianaZone, isoInZone, parseWhen, zonedToUtc, dateInZone, offsetMinutes } from './tz.js';

const LISBON = 'Europe/Lisbon';
const win = (from, to, tz = LISBON) => ({ fromMs: Date.parse(from), toMs: Date.parse(to), tz });

const FEED = `BEGIN:VCALENDAR
VERSION:2.0
X-WR-CALNAME:Team
X-APPLE-CALENDAR-COLOR:#34aadcff
BEGIN:VTIMEZONE
TZID:Custom Zone
BEGIN:STANDARD
DTSTART:19701025T030000
TZOFFSETFROM:+0300
TZOFFSETTO:+0300
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:standup
DTSTART;TZID=W. Europe Standard Time:20261019T090000
DTEND;TZID=W. Europe Standard Time:20261019T091500
RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
EXDATE;TZID=W. Europe Standard Time:20261021T090000
SUMMARY:Standup
LOCATION:https://meet.google.com/abc-defg-hij
END:VEVENT
BEGIN:VEVENT
UID:standup
RECURRENCE-ID;TZID=W. Europe Standard Time:20261022T090000
DTSTART;TZID=W. Europe Standard Time:20261022T110000
DTEND;TZID=W. Europe Standard Time:20261022T111500
SUMMARY:Standup (moved)
END:VEVENT
BEGIN:VEVENT
UID:standup
RECURRENCE-ID;TZID=W. Europe Standard Time:20261023T090000
DTSTART;TZID=W. Europe Standard Time:20261023T090000
STATUS:CANCELLED
SUMMARY:Standup
END:VEVENT
BEGIN:VEVENT
UID:custom
DTSTART;TZID=Custom Zone:20261024T120000
DURATION:PT1H
SUMMARY:Call with Riyadh
END:VEVENT
BEGIN:VEVENT
UID:trip
DTSTART;VALUE=DATE:20261024
DTEND;VALUE=DATE:20261026
SUMMARY:Weekend trip
END:VEVENT
BEGIN:VEVENT
UID:utc
DTSTART:20261020T150000Z
DTEND:20261020T160000Z
SUMMARY:Dentist
DESCRIPTION:Bring the form\\, please
END:VEVENT
BEGIN:VEVENT
UID:old
DTSTART:20250101T100000Z
SUMMARY:Long ago
END:VEVENT
END:VCALENDAR`;

test('tz: Windows, Mozilla and quoted TZIDs map to IANA zones', () => {
  assert.equal(ianaZone('W. Europe Standard Time'), 'Europe/Berlin');
  assert.equal(ianaZone('/mozilla.org/20050126_1/Europe/Paris'), 'Europe/Paris');
  assert.equal(ianaZone('"America/New_York"'), 'America/New_York');
  assert.equal(ianaZone('(UTC+01:00) Romance Standard Time'), 'Europe/Paris');
  assert.equal(ianaZone('Custom Zone'), null);
});

test('tz: wall time ↔ instant across DST, ISO with the offset', () => {
  // 25 Oct 2026: Lisbon leaves summer time at 02:00.
  const summer = zonedToUtc({ y: 2026, mo: 10, d: 24, h: 12 }, LISBON);
  assert.equal(new Date(summer).toISOString(), '2026-10-24T11:00:00.000Z');
  const winter = zonedToUtc({ y: 2026, mo: 10, d: 26, h: 12 }, LISBON);
  assert.equal(new Date(winter).toISOString(), '2026-10-26T12:00:00.000Z');
  assert.equal(isoInZone(summer, LISBON), '2026-10-24T12:00:00+01:00');
  assert.equal(offsetMinutes(winter, 'America/St_Johns'), -150); // NDT until November
  assert.equal(dateInZone(Date.parse('2026-10-21T23:30:00Z'), LISBON), '2026-10-22');
});

test('tz: parseWhen reads dates, local times and offsets', () => {
  assert.deepEqual(parseWhen('2026-10-23', LISBON), { ms: Date.parse('2026-10-22T23:00:00Z'), date: '2026-10-23', allDay: true });
  assert.equal(parseWhen('2026-10-23T13:00', LISBON).ms, Date.parse('2026-10-23T12:00:00Z'));
  assert.equal(parseWhen('2026-10-23T13:00:00Z', LISBON).ms, Date.parse('2026-10-23T13:00:00Z'));
  assert.equal(parseWhen('2026-10-23T13:00-0300', LISBON).ms, Date.parse('2026-10-23T16:00:00Z'));
  assert.throws(() => parseWhen('next friday', LISBON), /Not a date/);
  assert.throws(() => parseWhen('2026-02-30', LISBON), /Not a/);
});

test('ics: recurrences expanded with exdates, moved and cancelled occurrences', () => {
  const events = expandEvents(parseCalendar(FEED), win('2026-10-19T00:00:00Z', '2026-10-27T00:00:00Z'));
  const standups = events.filter((e) => e.uid === 'standup');
  // Mon 19, Tue 20, (Wed 21 excluded), Thu 22 moved to 11:00, (Fri 23 cancelled), Mon 26.
  assert.deepEqual(standups.map((e) => [e.start, e.title]), [
    ['2026-10-19T08:00:00+01:00', 'Standup'],
    ['2026-10-20T08:00:00+01:00', 'Standup'],
    ['2026-10-22T10:00:00+01:00', 'Standup (moved)'],
    ['2026-10-26T08:00:00+00:00', 'Standup'],
  ]);
  assert.ok(standups.every((e) => e.recurring && e.writable === false));
  assert.equal(standups[0].meetingUrl, 'https://meet.google.com/abc-defg-hij');
  assert.equal(new Set(standups.map((e) => e.id)).size, 4, 'each occurrence has its own id');
});

test('ics: custom VTIMEZONE, all-day ranges, UTC times, escaped text, window bounds', () => {
  const events = expandEvents(parseCalendar(FEED), win('2026-10-19T00:00:00Z', '2026-10-27T00:00:00Z'));
  const custom = events.find((e) => e.uid === 'custom');
  assert.equal(custom.start, '2026-10-24T10:00:00+01:00'); // 12:00 at +03:00
  assert.equal(custom.end, '2026-10-24T11:00:00+01:00');
  const trip = events.find((e) => e.uid === 'trip');
  assert.deepEqual([trip.start, trip.end, trip.allDay], ['2026-10-24', '2026-10-26', true]);
  const dentist = events.find((e) => e.uid === 'utc');
  assert.equal(dentist.start, '2026-10-20T16:00:00+01:00');
  assert.equal(dentist.description, 'Bring the form, please');
  assert.equal(events.find((e) => e.uid === 'old'), undefined);
  assert.deepEqual(calendarMeta(parseCalendar(FEED)), { name: 'Team', color: '#34AADC' });
});

test('ics: not a calendar → 400', () => {
  assert.throws(() => parseCalendar('<html>nope</html>'), (e) => e.status === 400);
});

test('ics: meeting links from Zoom, Teams and Meet', () => {
  assert.equal(meetingUrlOf(undefined, 'Join: https://us02web.zoom.us/j/8123456789?pwd=abc.'), 'https://us02web.zoom.us/j/8123456789?pwd=abc');
  assert.equal(meetingUrlOf('Room 4', 'https://teams.microsoft.com/l/meetup-join/19%3ameeting'), 'https://teams.microsoft.com/l/meetup-join/19%3ameeting');
  assert.equal(meetingUrlOf('Office'), undefined);
});

test('ics: a new event round-trips, and an update keeps other properties', () => {
  const startMs = Date.parse('2026-10-23T12:00:00Z');
  const { uid, text } = buildEventCalendar({ title: 'Lunch, with Ana; maybe', startMs, endMs: startMs + 3600_000, location: 'Time Out Market' }, { now: Date.parse('2026-10-22T10:00:00Z') });
  assert.match(uid, /@jarvis-live\.xyz$/);
  assert.match(text, /\r\nSUMMARY:Lunch\\, with Ana\\; maybe\r\n/);
  const [ev] = expandEvents(parseCalendar(text), win('2026-10-23T00:00:00Z', '2026-10-24T00:00:00Z'));
  assert.equal(ev.title, 'Lunch, with Ana; maybe');
  assert.equal(ev.start, '2026-10-23T13:00:00+01:00');
  const withAlarm = text.replace('END:VEVENT', 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT');
  const updated = updateEventCalendar(withAlarm, { startMs: startMs + 3600_000, endMs: startMs + 7200_000, title: 'Lunch' });
  assert.match(updated, /BEGIN:VALARM/);
  assert.match(updated, /SEQUENCE:1/);
  const [moved] = expandEvents(parseCalendar(updated), win('2026-10-23T00:00:00Z', '2026-10-24T00:00:00Z'));
  assert.deepEqual([moved.title, moved.start], ['Lunch', '2026-10-23T14:00:00+01:00']);
  const allDay = buildEventCalendar({ title: 'Holiday', allDay: true, startDate: '2026-12-24', endDate: '2026-12-26' });
  assert.match(allDay.text, /DTSTART;VALUE=DATE:20261224/);
});

test('ics: a repeating event is not changed by Jarvis', () => {
  const series = FEED.split('BEGIN:VEVENT\nUID:standup')[0] + 'BEGIN:VEVENT\nUID:x\nDTSTART:20261019T090000Z\nRRULE:FREQ=DAILY\nSUMMARY:x\nEND:VEVENT\nEND:VCALENDAR';
  assert.throws(() => updateEventCalendar(series, { title: 'y' }), (e) => e.status === 409);
});
