import test from 'node:test';
import assert from 'node:assert/strict';
import { agendaData, agendaText, calendarPrompt, resolveRange, spokenAgenda, timeLabel, CALENDAR_TOOLS, CALENDAR_TOOL_PATHS } from './card.js';
import { agendaQuery, mentionsCalendar, spokenShort } from './intent.js';

const tz = 'Europe/Lisbon';
// Thursday 22 October 2026, 14:05 in Lisbon.
const now = Date.parse('2026-10-22T13:05:00Z');
const r = (q) => {
  const x = resolveRange(q, { tz, now });
  return [new Date(x.fromMs).toISOString(), new Date(x.toMs).toISOString(), x.title];
};

test('ranges: days and weeks as people say them (weeks start on Monday)', () => {
  assert.deepEqual(r({ day: 'today' }), ['2026-10-21T23:00:00.000Z', '2026-10-22T23:00:00.000Z', 'Today']);
  assert.deepEqual(r({ day: 'tomorrow' }), ['2026-10-22T23:00:00.000Z', '2026-10-23T23:00:00.000Z', 'Tomorrow']);
  assert.deepEqual(r({ day: 'this week' }), ['2026-10-21T23:00:00.000Z', '2026-10-26T00:00:00.000Z', 'This week']);
  assert.deepEqual(r({ day: 'next week' }).slice(0, 2), ['2026-10-26T00:00:00.000Z', '2026-11-02T00:00:00.000Z']);
  assert.deepEqual(r({ day: 'this weekend' }).slice(0, 2), ['2026-10-23T23:00:00.000Z', '2026-10-26T00:00:00.000Z']);
  assert.deepEqual(r({ day: 'friday' }), ['2026-10-22T23:00:00.000Z', '2026-10-23T23:00:00.000Z', 'Tomorrow']);
  assert.deepEqual(r({ day: 'saturday' })[2], 'Sat 24 Oct');
  assert.equal(r({ day: 'thursday' })[2], 'Today');
  assert.equal(r({ day: 'next thursday' })[0], '2026-10-29T00:00:00.000Z');
  assert.equal(r({ day: 'wednesday' })[0], '2026-10-28T00:00:00.000Z');
  assert.deepEqual(r({ day: 'this month' }).slice(1), ['2026-11-01T00:00:00.000Z', 'October']);
  assert.deepEqual(r({ day: '2026-12-24' }), ['2026-12-24T00:00:00.000Z', '2026-12-25T00:00:00.000Z', 'Thu 24 Dec']);
  assert.deepEqual(r({ from: '2026-10-23T09:00', to: '2026-10-23T12:00' }).slice(0, 2), ['2026-10-23T08:00:00.000Z', '2026-10-23T11:00:00.000Z']);
  assert.throws(() => resolveRange({ day: 'someday' }, { tz, now }), /Unknown day/);
});

const events = [
  { id: 'a', title: 'Standup', start: '2026-10-22T09:30:00+01:00', end: '2026-10-22T09:45:00+01:00', meetingUrl: 'https://meet.google.com/x', calendarName: 'Work', color: '#4285F4' },
  { id: 'b', title: 'Dentist', start: '2026-10-22T15:00:00+01:00', end: '2026-10-22T16:00:00+01:00', location: 'Rua Augusta 1' },
  { id: 'c', title: 'Trip', start: '2026-10-24', end: '2026-10-26', allDay: true },
];

test('agenda card: data, text block and the spoken list', () => {
  const data = agendaData(events, { title: 'Next 7 days', fromMs: now, toMs: now + 7 * 86400_000, tz, highlightId: 'b' });
  assert.equal(data.events.length, 3);
  assert.equal(data.events[0].calendar, 'Work');
  assert.equal(data.highlightId, 'b');
  const text = agendaText(data);
  const block = JSON.parse(text.split('```json\n')[1].split('\n```')[0]);
  assert.equal(block.type, 'agenda');
  assert.equal(block.summary, '3 events for Next 7 days.');
  const spoken = spokenAgenda(events, { title: 'Next 7 days', tz, now, refOf: (e) => `e${e.id}` });
  assert.match(spoken, /^Now: Thursday 22 October 2026 at 14:05 \(Europe\/Lisbon\)\.|^Now: Thursday, 22 October 2026/);
  assert.match(spoken, /- 09:30–09:45 Standup video call \(Work\) \[ea\]/);
  assert.match(spoken, /- 15:00–16:00 Dentist at Rua Augusta 1 \[eb\]/);
  assert.match(spoken, /- all day Trip \[ec\]/);
  assert.match(spoken, /Next: "Dentist" in 55 min\./);
  assert.equal(timeLabel(events[2]), 'all day');
  assert.equal(agendaData([], { title: 'Today', fromMs: now, toMs: now, tz, empty: true }).empty, true);
});

test('tools: four declarations, a path each for the avatar, a prompt with today', () => {
  assert.deepEqual(CALENDAR_TOOLS.map((t) => t.name), ['calendar_agenda', 'calendar_add_event', 'calendar_update_event', 'calendar_delete_event']);
  assert.deepEqual(CALENDAR_TOOL_PATHS, CALENDAR_TOOLS.map((t) => `/api/calendar/tool/${t.name}`));
  assert.match(calendarPrompt({ now, tz }), /Today is Thursday,? 22 October 2026 \(Europe\/Lisbon\)\./);
});

test('non-Live: agenda questions in four languages, changes go to the agent', () => {
  assert.deepEqual(agendaQuery("What's on my calendar tomorrow?"), { day: 'tomorrow' });
  assert.deepEqual(agendaQuery('o que tenho na agenda amanhã?'), { day: 'tomorrow' });
  assert.deepEqual(agendaQuery('Qué reuniones tengo la próxima semana'), { day: 'next week' });
  assert.deepEqual(agendaQuery("quels rendez-vous ai-je aujourd'hui ?"), { day: 'today' });
  assert.deepEqual(agendaQuery('Am I free on Friday?'), { day: 'friday' });
  assert.equal(agendaQuery('Add lunch with Ana to my calendar on Friday'), null);
  assert.equal(agendaQuery('What do I have to change in the code?'), null);
  assert.ok(mentionsCalendar('move my dentist appointment'));
  assert.equal(spokenShort(events.slice(0, 2), { day: 'today' }), 'You have 2 events today: Standup at 09:30 and Dentist at 15:00.');
  assert.equal(spokenShort([], { day: 'tomorrow', lang: 'pt' }), 'Não tens nada na agenda amanhã.');
});

test('digest: every one of the next 7 days, free ones too, multi-day all-day events on each day', async () => {
  const { agendaDigest } = await import('./card.js');
  const d = agendaDigest(events, { tz, now });
  const lines = d.split('\n');
  assert.equal(lines.length, 7);
  assert.equal(lines[0], 'Thu 22 Oct: 09:30–09:45 Standup (video); 15:00–16:00 Dentist @ Rua Augusta 1');
  assert.equal(lines[1], 'Fri 23 Oct: nothing');
  assert.equal(lines[2], 'Sat 24 Oct: all day Trip');
  assert.equal(lines[3], 'Sun 25 Oct: all day Trip');
  assert.equal(lines[4], 'Mon 26 Oct: nothing');
  const prompt = calendarPrompt({ now, tz, digest: d });
  assert.match(prompt, /next 7 days \(times in Europe\/Lisbon\)/);
  assert.match(prompt, /Fri 23 Oct: nothing/);
  assert.doesNotMatch(calendarPrompt({ now, tz }), /next 7 days/);
});

test('non-Live: schedule questions without a calendar word still get the agenda', async () => {
  const { aboutSchedule } = await import('./intent.js');
  for (const t of ['When do I see Ana next?', 'Am I busy tonight?', 'Do I have time for a haircut on Friday?', "What's my week like?", 'Estou livre amanhã à tarde?', 'Qué planes tengo el sábado']) assert.ok(aboutSchedule(t), t);
  for (const t of ['Open Spotify', 'Write a Python script that renames my photos', 'What is the capital of Peru?']) assert.equal(aboutSchedule(t), false, t);
});
