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
  async run(args = {}) {
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
