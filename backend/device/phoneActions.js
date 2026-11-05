// Gemini → the user's phone. Gemini calls the `phone_action` tool; the backend
// forwards it to a connected phone over its WebSocket ({ type: 'device_action' }),
// the app executes it natively or through the "Jarvis Actions" Shortcut, and
// answers with { type: 'device_action_result' }, which becomes the tool response.

/** Every action the phone may run. `settings` values are the Shortcut's branches. */
export const PHONE_ACTIONS = {
  flashlight: 'Turn the flashlight on or off. value: "on" | "off".',
  brightness: 'Set screen brightness. value: 0-100.',
  music: 'Control Apple Music playback. value: "play" | "pause" | "next" | "previous".',
  alarm: 'Set an alarm. value: time "HH:mm" (24 h). text: optional label.',
  timer: 'Start a timer. value: duration in seconds. text: optional label.',
  reminder: 'Add a reminder. text: what to remember. value: optional due date-time (ISO 8601).',
  calendar_event: 'Add a calendar event. text: title. value: start (ISO 8601). target: optional duration in minutes (default 60).',
  message: 'Prepare a text message; the user taps Send. target: contact name or phone number. text: the message.',
  call: 'Call someone; iOS asks the user to confirm. target: contact name or phone number.',
  navigate: 'Start directions in Maps. target: destination.',
  open_app: 'Open an app. target: app name (e.g. Spotify, WhatsApp, Settings, Camera).',
  open_url: 'Open a web page or app link. value: the URL.',
  settings: 'Change a phone setting. value: one of ' +
    'wifi_on, wifi_off, bluetooth_on, bluetooth_off, cellular_on, cellular_off, airplane_on, airplane_off, ' +
    'low_power_on, low_power_off, dark_mode, light_mode, focus_on, focus_off, ' +
    'volume_0, volume_25, volume_50, volume_75, volume_100.',
  shortcut: "Run one of the user's own Shortcuts by name. target: shortcut name. text: optional input.",
};

export const SETTINGS_VALUES = [
  'wifi_on', 'wifi_off', 'bluetooth_on', 'bluetooth_off', 'cellular_on', 'cellular_off',
  'airplane_on', 'airplane_off', 'low_power_on', 'low_power_off', 'dark_mode', 'light_mode',
  'focus_on', 'focus_off', 'volume_0', 'volume_25', 'volume_50', 'volume_75', 'volume_100',
];

const SETTING_BASES = { wifi: 'wifi', 'wi-fi': 'wifi', bluetooth: 'bluetooth', cellular: 'cellular', 'mobile data': 'cellular', airplane: 'airplane', 'airplane mode': 'airplane', 'low power': 'low_power', 'low power mode': 'low_power', focus: 'focus', 'do not disturb': 'focus', dnd: 'focus' };
const ACTION_ALIASES = {
  open: 'open_app', app: 'open_app', launch: 'open_app', directions: 'navigate', maps: 'navigate', navigation: 'navigate',
  text: 'message', sms: 'message', send_message: 'message', phone_call: 'call', remind: 'reminder', event: 'calendar_event',
  torch: 'flashlight', play_music: 'music', media: 'music', run_shortcut: 'shortcut', url: 'open_url',
};
const words = (v) => String(v ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
const onOff = (v) => (/\b(off|disable|false|stop|deactivate)\b/.test(words(v)) ? 'off' : /\b(on|enable|true|start|activate)\b/.test(words(v)) ? 'on' : '');

/** "5 minutes", "1h30", "00:05:00", "90" → seconds as a string ('' when unreadable). */
export function durationSeconds(v) {
  const t = words(v);
  if (/^\d+$/.test(t)) return t;
  const hms = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (hms) return String(hms[3] !== undefined ? (+hms[1]) * 3600 + (+hms[2]) * 60 + (+hms[3]) : (+hms[1]) * 60 + (+hms[2]));
  let total = 0;
  let found = false;
  for (const [, n, unit] of t.matchAll(/(\d+(?:\.\d+)?)\s*(h|hours?|hrs?|m|mins?|minutes?|s|secs?|seconds?)\b/g)) {
    found = true;
    total += parseFloat(n) * (unit.startsWith('h') ? 3600 : unit.startsWith('m') ? 60 : 1);
  }
  if (/\bhalf an hour\b/.test(t)) { total += 1800; found = true; }
  return found ? String(Math.round(total)) : '';
}

/** "7am", "7:30 PM", "19:30", "7" → "07:00" / "19:30" ('' when unreadable). */
export function clockTime(v) {
  const t = words(v).replace(/\./g, '');
  const m = /(\d{1,2})(?:[:h](\d{2}))?\s*(am|pm|a m|p m)?/.exec(t);
  if (!m) return '';
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  const ap = (m[3] || '').replace(' ', '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Tool arguments as the phone expects them. Voice models (the 2B LFM model above all) answer
 * "wifi" + "off", "do not disturb", "5 minutes" or "7am": mapped to settings/wifi_off,
 * focus_on, 300, 07:00 instead of failing on the phone.
 */
export function normalizePhoneArgs(args = {}) {
  const out = { ...args };
  let action = words(out.action).replace(/ /g, '_');
  const base = SETTING_BASES[words(out.action)];
  if (SETTINGS_VALUES.includes(action)) {
    // "bluetooth_on" given as the action.
    out.value = action;
    action = 'settings';
  } else if (base) {
    out.value = `${base}_${onOff(out.value) || 'on'}`;
    action = 'settings';
  } else if (action === 'volume') {
    action = 'settings';
    out.value = `volume_${out.value}`;
  } else if (['dark_mode', 'light_mode'].includes(action)) {
    out.value = action;
    action = 'settings';
  }
  action = ACTION_ALIASES[action] || action;
  out.action = action;
  if (action === 'settings') {
    const v = words(out.value);
    if (!SETTINGS_VALUES.includes(String(out.value))) {
      const vol = /volume\D*(\d+)/.exec(v) || (/^\d+$/.test(v) ? [null, v] : null);
      const named = Object.keys(SETTING_BASES).find((k) => new RegExp(`\\b${k}\\b`).test(v));
      if (vol) out.value = `volume_${[0, 25, 50, 75, 100].reduce((a, b) => (Math.abs(b - vol[1]) < Math.abs(a - vol[1]) ? b : a))}`;
      else if (named) out.value = `${SETTING_BASES[named]}_${onOff(v) || 'on'}`;
      else if (/\bdark\b/.test(v)) out.value = 'dark_mode';
      else if (/\blight\b/.test(v)) out.value = 'light_mode';
      else out.value = v.replace(/ /g, '_');
    }
  }
  if (action === 'timer' && out.value !== undefined) out.value = durationSeconds(out.value) || out.value;
  if (action === 'alarm' && out.value !== undefined) out.value = clockTime(out.value) || out.value;
  if (action === 'flashlight') out.value = onOff(out.value) || 'on';
  if (action === 'brightness' && out.value !== undefined) out.value = String(out.value).replace(/[^\d]/g, '') || out.value;
  if (action === 'music' && out.value !== undefined) {
    const v = words(out.value);
    out.value = /\b(pause|stop)\b/.test(v) ? 'pause' : /\b(next|skip)\b/.test(v) ? 'next' : /\b(previous|back|last)\b/.test(v) ? 'previous' : /\b(play|resume|start)\b/.test(v) ? 'play' : out.value;
  }
  return out;
}

/** Gemini function declaration (Live API schema). */
export const PHONE_ACTION_TOOL = {
  name: 'phone_action',
  description:
    "Act on the user's phone (the iPhone they are talking to Jarvis from). Actions:\n" +
    Object.entries(PHONE_ACTIONS).map(([name, doc]) => `- ${name}: ${doc}`).join('\n'),
  parameters: {
    type: 'OBJECT',
    properties: {
      action: { type: 'STRING', enum: Object.keys(PHONE_ACTIONS), description: 'Which action to run.' },
      value: { type: 'STRING', description: 'Main value (see the action).' },
      target: { type: 'STRING', description: 'Who or what the action is for (see the action).' },
      text: { type: 'STRING', description: 'Free text: label, message body, reminder or event title.' },
    },
    required: ['action'],
  },
};

/** Added to Gemini's system instruction wherever the tool is declared. */
export const PHONE_ACTION_PROMPT =
  "You can act on the user's phone with the `phone_action` tool (alarms, timers, reminders, calendar, " +
  'music, flashlight, brightness, Wi-Fi/Bluetooth/Focus/volume and other settings, opening apps, directions, ' +
  "calls, messages, and the user's own Shortcuts). Use it whenever the user asks for something on their phone; " +
  'say a short acknowledgement first, then call the tool, then tell them the result. For messages and calls, ' +
  'read back the recipient (and the message) before calling the tool — iOS then asks the user to confirm.';

const DEFAULT_TIMEOUT_MS = 25_000; // Shortcuts may need a moment to switch apps and back

/**
 * Routes `phone_action` calls to a connected phone and waits for its answer.
 * A phone registers with { type: 'device_hello', platform, actions } on connect.
 */
export class PhoneBridge {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.phones = new Map(); // client → { platform, actions:Set, at }
    this.pending = new Map(); // id → { resolve, timer }
    this.seq = 0;
  }

  register(client, { platform = 'unknown', actions = [] } = {}) {
    this.phones.set(client, { platform, actions: new Set(actions), at: Date.now() });
    this.log(`[PHONE] ${platform} phone registered (${actions.length} actions)`);
  }

  unregister(client) {
    this.phones.delete(client);
  }

  /** The most recently registered open phone that supports `action`. */
  pick(action) {
    let best = null;
    for (const [client, info] of this.phones) {
      if (client.readyState !== undefined && client.readyState !== 1) continue;
      if (!info.actions.has(action)) continue;
      if (!best || info.at > best.info.at) best = { client, info };
    }
    return best?.client ?? null;
  }

  /** Validates and runs one tool call; always resolves to a sentence for Gemini. */
  async run(rawArgs = {}) {
    const args = normalizePhoneArgs(rawArgs);
    const action = String(args.action || '').trim();
    if (!PHONE_ACTIONS[action]) return `Unknown phone action "${action}".`;
    if (action === 'settings' && !SETTINGS_VALUES.includes(String(args.value))) {
      return `Unsupported setting "${args.value}". Use one of: ${SETTINGS_VALUES.join(', ')}.`;
    }
    const client = this.pick(action);
    if (!client) {
      return this.phones.size
        ? `The connected phone cannot do "${action}".`
        : "No phone is connected to Jarvis right now, so I can't do that on the phone.";
    }
    const id = `pa${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    const request = { type: 'device_action', id, action };
    for (const key of ['value', 'target', 'text']) {
      if (args[key] !== undefined && args[key] !== null && args[key] !== '') request[key] = String(args[key]);
    }
    this.log(`[PHONE] → ${action} ${JSON.stringify({ value: request.value, target: request.target })}`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(`The phone did not answer in time; "${action}" may not have run.`);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        client.send(JSON.stringify(request));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(`Could not reach the phone: ${e.message}`);
      }
    });
  }

  /** { type: 'device_action_result', id, ok, result } from the phone. */
  handleResult(msg = {}) {
    const entry = this.pending.get(msg.id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);
    const detail = String(msg.result || (msg.ok ? 'Done.' : 'It failed.'));
    this.log(`[PHONE] ← ${msg.ok ? 'ok' : 'failed'}: ${detail}`);
    entry.resolve(msg.ok ? detail : `It didn't work on the phone: ${detail}`);
    return true;
  }
}
