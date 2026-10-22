# Calendar API (Jarvis Server)

Settings → Calendar in the apps (web, desktop, phone) and the voice tools read and change the
user's calendars through these routes. Everything lives on the user's computer (the data dir:
`calendar-accounts.json`, 0600, and an event cache); Jarvis Cloud never sees an event. Google
sign-in is the one thing relayed by Jarvis Cloud (PKCE, it never stores a token).

Auth: like every `/api/*` call — `x-api-key` header (or `?api_key=`). Only the computer's owner
and the owner's apps (Cloud 'app' tokens) may call them; others get 403 `{ error }`.
Errors: 4xx/5xx with `{ error: string }` — a sentence ready to show.

## Shapes

```ts
type CalendarAccountKind = 'google' | 'caldav' | 'ics' | 'file' | 'device';
type CaldavProvider = 'icloud' | 'fastmail' | 'nextcloud' | 'yahoo' | 'other';

interface CalendarInfo {
  id: string;
  name: string;
  color?: string;      // '#RRGGBB'
  enabled: boolean;    // its events count (agenda, voice); toggled in Settings
  writable: boolean;   // Jarvis can add / change events in it
  primary?: boolean;
}

interface CalendarAccount {
  id: string;
  kind: CalendarAccountKind;
  provider?: CaldavProvider;          // caldav only
  name: string;                       // "you@gmail.com", "iCloud", "Holidays in Portugal", "work.ics", "Samuel's iPhone"
  detail?: string;                    // secondary line: "Google Calendar", "caldav.fastmail.com", "Subscribed link · calendar.google.com", "Imported file", "iPhone calendars"
  status: 'syncing' | 'ready' | 'error' | 'needs_auth';
  error?: string;                     // why (status error / needs_auth), ready to show
  lastSync?: string;                  // ISO
  eventCount?: number;                // events cached (7 days back … 90 days ahead)
  writable: boolean;                  // any writable + enabled calendar
  calendars: CalendarInfo[];
  createdAt: string;
}

interface CalendarRef { accountId: string; calendarId: string }

interface CalendarSettings {
  defaultCalendar: CalendarRef | null; // where Jarvis adds events (null: the first writable one)
  timeZone: string;                    // IANA, e.g. 'Europe/Lisbon' (the computer's, unless set)
}

interface CalendarEvent {
  id: string;              // stable within the account
  accountId: string;
  calendarId: string;
  calendarName?: string;
  color?: string;
  title: string;
  start: string;           // ISO with offset ('2026-10-22T15:00:00+01:00'); all-day: 'YYYY-MM-DD'
  end?: string;            // same form; all-day: exclusive end date
  allDay?: boolean;
  location?: string;
  description?: string;    // ≤ 500 chars
  meetingUrl?: string;     // Meet / Zoom / Teams link found in the event
  recurring?: boolean;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  writable?: boolean;
}
```

## Routes

| Method & path | Body / query | Answer |
|---|---|---|
| `GET /api/calendar` | — | `{ accounts: CalendarAccount[], settings: CalendarSettings, google: { available: boolean, reason?: string } }` — `google.available` false when this computer isn't linked to Jarvis Cloud (reason says so) |
| `POST /api/calendar/accounts` | `{ kind: 'ics', url, name? }` (https / webcal link) | 201 `{ account }` |
| | `{ kind: 'caldav', provider, username, password, url? }` (`url` required for nextcloud / other) | 201 `{ account }`; 400 when the sign-in fails ("Apple ID or app-specific password is wrong") |
| | `{ kind: 'file', filename, content, name? }` (the .ics text, ≤ 5 MB) | 201 `{ account }` |
| `PATCH /api/calendar/accounts/:id` | `{ name?, calendars?: [{ id, enabled }], content?, filename? }` (content: re-import a file account) | `{ account }` |
| `POST /api/calendar/accounts/:id/sync` | — | `{ account }` (syncs now) |
| `DELETE /api/calendar/accounts/:id` | — | `{ ok: true }` (Google: the access is revoked too) |
| `PUT /api/calendar/settings` | `{ defaultCalendar?: CalendarRef \| null, timeZone?: string }` | `{ settings }` |
| `POST /api/calendar/google/start` | — | `{ authUrl, state }` — open `authUrl` in the system browser |
| `GET /api/calendar/google/status?state=` | — | `{ status: 'pending' }` \| `{ status: 'connected', account }` \| `{ status: 'error', error }` — poll every 2 s, up to 10 min |
| `GET /api/calendar/events` | `?from=ISO&to=ISO&q=text` (default: now … +7 days) | `{ events: CalendarEvent[], timeZone }` (sorted by start, enabled calendars only) |
| `POST /api/calendar/events` | `{ title, start, end?, allDay?, location?, description?, calendar?: CalendarRef }` (start/end: ISO; local time without offset = settings.timeZone) | 201 `{ event }` |
| `PATCH /api/calendar/events` | `{ accountId, calendarId, eventId, title?, start?, end?, allDay?, location?, description? }` | `{ event }` |
| `DELETE /api/calendar/events` | `{ accountId, calendarId, eventId }` | `{ ok: true }` |
| `POST /api/calendar/device/sync` | `{ deviceId, deviceName, platform: 'ios' \| 'android', calendars: [{ id, name, color?, writable? }], events: DeviceEvent[], from, to }` | `{ account }` — the phone's own calendars (kind 'device', read-only for Jarvis; one account per deviceId) |
| `POST /api/calendar/show` | `{ range?: 'today' \| 'tomorrow' \| 'week' \| 'next_week', from?, to?, q?, origin? }` | `{ ok, result }` — opens the agenda card; `result` = what to say |

`DeviceEvent` = `{ id, calendarId, title, start, end?, allDay?, location?, notes?, url? }` (same date
forms as CalendarEvent; at most 2000 events, 7 days back … 60 days ahead). Send only the events of
calendars that are `enabled` in the account the last sync returned (all of them the first time).

## The agenda card

Voice answers about the calendar open an `agenda` card (an `agent_result` whose text ends with a
fenced JSON block `{ "type": "agenda", "summary": "...", "data": AgendaData }`, read by
detectSpecialContent like `business_dashboard`).

```ts
interface AgendaEvent {
  id: string;
  title: string;
  start: string;           // as CalendarEvent
  end?: string;
  allDay?: boolean;
  location?: string;
  calendar?: string;       // calendar name
  color?: string;
  meetingUrl?: string;
}

interface AgendaData {
  title: string;           // "Today", "Tomorrow", "This week", "Thu 23 Oct", "Search: dentist"
  from: string;            // ISO, the range shown
  to: string;
  timeZone?: string;       // IANA: show times in it
  events: AgendaEvent[];   // sorted by start, ≤ 40
  highlightId?: string;    // the event just added / changed (shown first / accented)
  empty?: boolean;         // no calendar connected: invite to Settings → Calendar
}
```
