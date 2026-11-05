import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhoneBridge, PHONE_ACTION_TOOL, PHONE_ACTIONS } from './phoneActions.js';

function fakePhone(bridge, { actions = Object.keys(PHONE_ACTIONS), reply = (req) => ({ ok: true, result: `did ${req.action}` }) } = {}) {
  const sent = [];
  const phone = {
    readyState: 1,
    send(raw) {
      const req = JSON.parse(raw);
      sent.push(req);
      if (reply) setImmediate(() => bridge.handleResult({ type: 'device_action_result', id: req.id, ...reply(req) }));
    },
  };
  bridge.register(phone, { platform: 'ios', actions });
  return { phone, sent };
}

test('declares every action in the tool schema', () => {
  assert.deepEqual(PHONE_ACTION_TOOL.parameters.properties.action.enum, Object.keys(PHONE_ACTIONS));
  assert.match(PHONE_ACTION_TOOL.description, /alarm: Set an alarm/);
});

test('sends the call to the phone and returns its answer', async () => {
  const bridge = new PhoneBridge();
  const { sent } = fakePhone(bridge);
  const result = await bridge.run({ action: 'alarm', value: '07:30', text: 'Gym', target: '' });
  assert.equal(result, 'did alarm');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'device_action');
  assert.equal(sent[0].value, '07:30');
  assert.equal(sent[0].text, 'Gym');
  assert.ok(!('target' in sent[0]), 'empty fields are not sent');
});

test('reports failures from the phone', async () => {
  const bridge = new PhoneBridge();
  fakePhone(bridge, { reply: () => ({ ok: false, result: 'Calendar access denied' }) });
  assert.equal(await bridge.run({ action: 'calendar_event', text: 'Dentist', value: '2026-10-02T10:00' }),
    "It didn't work on the phone: Calendar access denied");
});

test('times out when the phone never answers', async () => {
  const bridge = new PhoneBridge({ timeoutMs: 20 });
  fakePhone(bridge, { reply: null });
  assert.match(await bridge.run({ action: 'flashlight', value: 'on' }), /did not answer in time/);
  assert.equal(bridge.pending.size, 0);
});

test('explains when no phone is connected or the phone lacks the action', async () => {
  const bridge = new PhoneBridge();
  assert.match(await bridge.run({ action: 'flashlight', value: 'on' }), /No phone is connected/);
  fakePhone(bridge, { actions: ['flashlight'] });
  assert.match(await bridge.run({ action: 'alarm', value: '07:00' }), /cannot do "alarm"/);
});

test('rejects unknown actions and settings without bothering the phone', async () => {
  const bridge = new PhoneBridge();
  const { sent } = fakePhone(bridge);
  assert.match(await bridge.run({ action: 'format_disk' }), /Unknown phone action/);
  assert.match(await bridge.run({ action: 'settings', value: 'self_destruct' }), /Unsupported setting/);
  assert.equal(sent.length, 0);
});

test('uses the most recently connected open phone', async () => {
  const bridge = new PhoneBridge();
  const old = fakePhone(bridge);
  await new Promise((r) => setTimeout(r, 2));
  const recent = fakePhone(bridge);
  await bridge.run({ action: 'music', value: 'play' });
  assert.equal(old.sent.length, 0);
  assert.equal(recent.sent.length, 1);
  recent.phone.readyState = 3; // closed
  await bridge.run({ action: 'music', value: 'pause' });
  assert.equal(old.sent.length, 1);
});

test('normalizePhoneArgs: what voice models say becomes what the phone runs', async () => {
  const { normalizePhoneArgs: n, durationSeconds, clockTime } = await import('./phoneActions.js');
  assert.deepEqual(n({ action: 'wifi', value: 'off' }), { action: 'settings', value: 'wifi_off' });
  assert.deepEqual(n({ action: 'bluetooth_on' }), { action: 'settings', value: 'bluetooth_on' });
  assert.deepEqual(n({ action: 'settings', value: 'do not disturb' }), { action: 'settings', value: 'focus_on' });
  assert.deepEqual(n({ action: 'settings', value: 'volume 60' }), { action: 'settings', value: 'volume_50' });
  assert.deepEqual(n({ action: 'timer', value: '5 minutes' }), { action: 'timer', value: '300' });
  assert.deepEqual(n({ action: 'alarm', value: '7am' }), { action: 'alarm', value: '07:00' });
  assert.deepEqual(n({ action: 'music', value: 'stop' }), { action: 'music', value: 'pause' });
  assert.deepEqual(n({ action: 'open', target: 'WhatsApp' }), { action: 'open_app', target: 'WhatsApp' });
  assert.deepEqual(n({ action: 'flashlight', value: 'off' }), { action: 'flashlight', value: 'off' });
  assert.equal(durationSeconds('1 hour 30 minutes'), '5400');
  assert.equal(durationSeconds('00:05:00'), '300');
  assert.equal(clockTime('6:45 pm'), '18:45');
  assert.equal(clockTime('12 am'), '00:00');
});

test('a sloppy call runs normalized on the phone', async () => {
  const bridge = new PhoneBridge({ log: () => {} });
  const { sent } = fakePhone(bridge);
  assert.equal(await bridge.run({ action: 'wifi', value: 'off' }), 'did settings');
  assert.deepEqual([sent[0].action, sent[0].value], ['settings', 'wifi_off']);
});
