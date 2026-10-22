// Calendar on the connected Jarvis Server (backend/calendar/API.md): the accounts Settings →
// Calendar manages, the Google sign-in relay, and the events themselves. Typed, store-free (the
// caller hands in the server URL and key) so the phone app can share it as it is.

export type CalendarAccountKind = 'google' | 'caldav' | 'ics' | 'file' | 'device';
export type CaldavProvider = 'icloud' | 'fastmail' | 'nextcloud' | 'yahoo' | 'other';
export type CalendarAccountStatus = 'syncing' | 'ready' | 'error' | 'needs_auth';

export interface CalendarInfo {
  id: string;
  name: string;
  /** '#RRGGBB' */
  color?: string;
  /** Its events count (agenda, voice); toggled in Settings. */
  enabled: boolean;
  /** Jarvis can add / change events in it. */
  writable: boolean;
  primary?: boolean;
}

export interface CalendarAccount {
  id: string;
  kind: CalendarAccountKind;
  /** caldav only */
  provider?: CaldavProvider;
  /** "you@gmail.com", "iCloud", "Holidays in Portugal", "work.ics", "Ana's iPhone" */
  name: string;
  /** Secondary line: "Google Calendar", "caldav.fastmail.com", "Subscribed link · calendar.google.com"… */
  detail?: string;
  status: CalendarAccountStatus;
  /** Why (status error / needs_auth), ready to show. */
  error?: string;
  /** ISO */
  lastSync?: string;
  /** Events cached (7 days back … 90 days ahead). */
  eventCount?: number;
  /** Any writable + enabled calendar. */
  writable: boolean;
  calendars: CalendarInfo[];
  createdAt: string;
}

export interface CalendarRef { accountId: string; calendarId: string }

export interface CalendarSettings {
  /** Where Jarvis adds events (null: the first writable one). */
  defaultCalendar: CalendarRef | null;
  /** IANA, e.g. 'Europe/Lisbon' (the computer's, unless set). */
  timeZone: string;
  /** The next 7 days go into the voice's context, so Jarvis answers about them directly (default on). */
  shareWithVoice?: boolean;
}

export interface CalendarEvent {
  /** Stable within the account. */
  id: string;
  accountId: string;
  calendarId: string;
  calendarName?: string;
  color?: string;
  title: string;
  /** ISO with offset ('2026-10-22T15:00:00+01:00'); all-day: 'YYYY-MM-DD'. */
  start: string;
  /** Same form; all-day: exclusive end date. */
  end?: string;
  allDay?: boolean;
  location?: string;
  /** ≤ 500 chars */
  description?: string;
  /** Meet / Zoom / Teams link found in the event. */
  meetingUrl?: string;
  recurring?: boolean;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  writable?: boolean;
}

export interface GoogleAvailability { available: boolean; reason?: string }

export interface CalendarOverview {
  accounts: CalendarAccount[];
  settings: CalendarSettings;
  google: GoogleAvailability;
}

export type NewCalendarAccount =
  | { kind: 'ics'; url: string; name?: string }
  | { kind: 'caldav'; provider: CaldavProvider; username: string; password: string; url?: string }
  | { kind: 'file'; filename: string; content: string; name?: string };

export interface CalendarAccountPatch {
  name?: string;
  calendars?: Array<{ id: string; enabled: boolean }>;
  /** Re-import a file account. */
  content?: string;
  filename?: string;
}

export type GoogleSignInStatus =
  | { status: 'pending' }
  | { status: 'connected'; account: CalendarAccount }
  | { status: 'error'; error: string };

export interface NewCalendarEvent {
  title: string;
  /** ISO; local time without offset = settings.timeZone. */
  start: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  calendar?: CalendarRef;
}

export interface CalendarEventRef { accountId: string; calendarId: string; eventId: string }

export type CalendarEventPatch = CalendarEventRef & Partial<Pick<NewCalendarEvent, 'title' | 'start' | 'end' | 'allDay' | 'location' | 'description'>>;

export interface DeviceEvent {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  notes?: string;
  url?: string;
}

export interface DeviceSync {
  deviceId: string;
  deviceName: string;
  platform: 'ios' | 'android';
  calendars: Array<{ id: string; name: string; color?: string; writable?: boolean }>;
  /** At most 2000 events, 7 days back … 60 days ahead. */
  events: DeviceEvent[];
  from: string;
  to: string;
}

export type AgendaRange = 'today' | 'tomorrow' | 'week' | 'next_week';

/** A failed call: `message` is the server's own sentence (ready to show), `status` the HTTP status (0: unreachable). */
export class CalendarApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CalendarApiError';
    this.status = status;
  }
}

/** Where to send calls: read at call time, so a reconnect to another server is picked up. */
export type CalendarConnection = () => { url: string; key: string };

const fallbackMessage = (status: number) =>
  status === 403 ? 'Only this computer’s owner can change its calendars.'
    : status === 404 ? 'This Jarvis Server doesn’t have calendars yet — update Jarvis on your computer.'
      : status === 413 ? 'That file is too big (5 MB at most).'
        : status >= 500 ? 'Jarvis Server couldn’t do that — try again in a moment.'
          : `The server answered ${status}.`;

/** The server's `{ error }` sentence, else a fallback for the status. */
export async function errorMessage(r: Response): Promise<string> {
  const d = await r.json().catch(() => null) as { error?: unknown } | null;
  return (d && typeof d.error === 'string' && d.error.trim()) || fallbackMessage(r.status);
}

export function calendarClient(conn: CalendarConnection, fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { url, key } = conn();
    if (!url) throw new CalendarApiError('Not connected to Jarvis Server.', 0);
    let r: Response;
    try {
      r = await fetchImpl(`${url}/api/calendar${path}`, {
        method,
        headers: { 'x-api-key': key, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new CalendarApiError('Jarvis Server is unreachable — check that it’s running.', 0);
    }
    if (!r.ok) throw new CalendarApiError(await errorMessage(r), r.status);
    return (await r.json().catch(() => ({}))) as T;
  }
  const id = (s: string) => encodeURIComponent(s);
  const query = (q: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  return {
    /** Accounts, settings and whether Google sign-in is offered. */
    overview: async (): Promise<CalendarOverview> => {
      const d = await call<Partial<CalendarOverview>>('GET', '');
      return {
        accounts: Array.isArray(d.accounts) ? d.accounts : [],
        settings: { defaultCalendar: d.settings?.defaultCalendar ?? null, timeZone: d.settings?.timeZone || '', shareWithVoice: d.settings?.shareWithVoice !== false },
        google: { available: !!d.google?.available, ...(d.google?.reason ? { reason: d.google.reason } : {}) },
      };
    },
    addAccount: async (body: NewCalendarAccount) => (await call<{ account: CalendarAccount }>('POST', '/accounts', body)).account,
    updateAccount: async (accountId: string, patch: CalendarAccountPatch) => (await call<{ account: CalendarAccount }>('PATCH', `/accounts/${id(accountId)}`, patch)).account,
    syncAccount: async (accountId: string) => (await call<{ account: CalendarAccount }>('POST', `/accounts/${id(accountId)}/sync`)).account,
    removeAccount: async (accountId: string) => { await call<{ ok: true }>('DELETE', `/accounts/${id(accountId)}`); },
    updateSettings: async (patch: Partial<CalendarSettings>) => (await call<{ settings: CalendarSettings }>('PUT', '/settings', patch)).settings,
    startGoogle: () => call<{ authUrl: string; state: string }>('POST', '/google/start'),
    googleStatus: async (state: string): Promise<GoogleSignInStatus> => {
      const d = await call<Partial<{ status: string; account: CalendarAccount; error: string }>>('GET', `/google/status${query({ state })}`);
      if (d.status === 'connected' && d.account) return { status: 'connected', account: d.account };
      if (d.status === 'error') return { status: 'error', error: d.error || 'Google sign-in didn’t finish.' };
      return { status: 'pending' };
    },
    events: async (opts: { from?: string; to?: string; q?: string } = {}) => {
      const d = await call<{ events?: CalendarEvent[]; timeZone?: string }>('GET', `/events${query(opts)}`);
      return { events: Array.isArray(d.events) ? d.events : [], timeZone: d.timeZone || '' };
    },
    addEvent: async (body: NewCalendarEvent) => (await call<{ event: CalendarEvent }>('POST', '/events', body)).event,
    updateEvent: async (patch: CalendarEventPatch) => (await call<{ event: CalendarEvent }>('PATCH', '/events', patch)).event,
    removeEvent: async (ref: CalendarEventRef) => { await call<{ ok: true }>('DELETE', '/events', ref); },
    deviceSync: async (body: DeviceSync) => (await call<{ account: CalendarAccount }>('POST', '/device/sync', body)).account,
    /** Opens the agenda card on the user's screens; `result` = what to say. */
    show: (body: { range?: AgendaRange; from?: string; to?: string; q?: string; origin?: string } = {}) =>
      call<{ ok: boolean; result?: string }>('POST', '/show', body),
  };
}

export type CalendarClient = ReturnType<typeof calendarClient>;
