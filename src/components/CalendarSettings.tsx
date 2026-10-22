// Settings → Calendar: the calendars Jarvis reads and adds events to (backend/calendar/API.md).
// The computer's owner only — hidden when the server doesn't answer, like Businesses. Accounts
// live on the computer running Jarvis Server; passwords go straight to it and are never logged
// or kept in this page once sent.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle, CalendarDays, CalendarPlus, Check, ChevronDown, ChevronLeft, ChevronRight, Cloud, ExternalLink, FileText, FileUp, Globe, Link2,
  Loader2, Lock, MessageSquareQuote, Plus, RotateCw, Server, Smartphone, Trash2, Upload, X, type LucideIcon,
} from 'lucide-react';
import { useStore, API_KEY, BACKEND_HTTP } from '../store';
import { IconButton, Pressable, Switch, alpha, palette } from '../ui';
import { Section } from './SettingsSection';
import {
  calendarClient, type CalendarAccount, type CalendarEvent, type CalendarOverview, type CalendarRef, type CaldavProvider, type NewCalendarAccount,
} from '../server/calendar';
import {
  CALDAV_PROVIDERS, caldavBody, calendarsLine, dayHeading, dayKey, deviceTimeZone, effectiveDefault, formatTime, icsFileProblem, isAllDay, looksLikeIcs,
  maskLink, normalizeIcsLink, safeColor, sameRef, syncLine, toMs, validTimeZone, writableTargets, zoneOffsetLabel,
} from '../server/calendarFormat';

const cal = calendarClient(() => ({ url: BACKEND_HTTP, key: API_KEY }));

const POLL_MS = 2000;
const GOOGLE_MAX_MS = 10 * 60 * 1000;
const CAL_FOLD = 4;
const PREVIEW_EVENTS = 5;

// ── Looks ────────────────────────────────────────────────────────────────────
const input = 'w-full min-w-0 rounded-[14px] border border-stroke bg-surface-raised px-4 py-2.5 t-body text-text outline-none transition-colors placeholder:text-text-3 focus:border-accent/70';

const Button = ({ onClick, icon: Icon, children, primary = false, disabled = false, spin = false, type = 'button' }: {
  onClick?: () => void; icon?: LucideIcon; children: React.ReactNode; primary?: boolean; disabled?: boolean; spin?: boolean; type?: 'button' | 'submit';
}) => (
  <Pressable type={type} onClick={onClick} disabled={disabled} className="flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 t-subhead disabled:opacity-50"
    style={primary ? { background: palette.accent, color: palette.textInverse } : { background: palette.surfaceRaised, color: palette.textSecondary, border: `1px solid ${palette.stroke}` }}>
    {Icon && <Icon size={15} className={spin ? 'animate-spin' : undefined} />}{children}
  </Pressable>
);

/** Google's "G", for the Google option and button (its sign-in branding asks for it). */
const GoogleMark = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
    <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
    <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
    <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
    <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
  </svg>
);

type Look = { label: string; color: string; icon: LucideIcon | null };
const lookOf = (a: Pick<CalendarAccount, 'kind' | 'provider'>): Look => {
  switch (a.kind) {
    case 'google': return { label: 'Google', color: '#4285F4', icon: null };
    case 'caldav': return a.provider === 'icloud'
      ? { label: 'iCloud', color: '#38BDF8', icon: Cloud }
      : { label: a.provider && a.provider !== 'other' ? CALDAV_PROVIDERS[a.provider].label : 'CalDAV', color: '#A78BFA', icon: Server };
    case 'ics': return { label: 'Link', color: palette.success, icon: Link2 };
    case 'file': return { label: 'File', color: palette.warning, icon: FileText };
    case 'device': return { label: 'Phone', color: '#F472B6', icon: Smartphone };
    default: return { label: 'Calendar', color: palette.accent, icon: CalendarDays };
  }
};

const Tile = ({ look, size = 40, children }: { look: Look; size?: number; children?: React.ReactNode }) => {
  const Icon = look.icon;
  return (
    <div className="relative grid shrink-0 place-items-center rounded-[12px]" style={{ width: size, height: size, background: look.icon ? alpha(look.color, 30) : palette.surfaceHigh, color: look.color }}>
      {Icon ? <Icon size={Math.round(size * 0.47)} /> : <GoogleMark size={Math.round(size * 0.45)} />}
      {children}
    </div>
  );
};

const ErrorLine = ({ children, tone = palette.listening }: { children: React.ReactNode; tone?: string }) => (
  <p role="alert" className="flex items-start gap-1.5 t-footnote" style={{ color: tone }}>
    <AlertTriangle size={14} className="mt-[1px] shrink-0" /><span>{children}</span>
  </p>
);

const Field = ({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) => (
  <label className="flex min-w-0 flex-col gap-1.5">
    <span className="t-subhead" style={{ color: palette.textSecondary }}>{label}{hint && <span style={{ color: palette.textTertiary }}> · {hint}</span>}</span>
    {children}
  </label>
);

const errText = (e: unknown) => (e instanceof Error && e.message) || 'Something went wrong.';

// ── An account ───────────────────────────────────────────────────────────────
type Fix = { kind: 'google' } | { kind: 'caldav'; account: CalendarAccount } | { kind: 'file'; account: CalendarAccount };

const AccountRow: React.FC<{
  a: CalendarAccount; index: number; fresh: boolean;
  onChange: (a: CalendarAccount) => void; onRemoved: (id: string) => void; onFix: (fix: Fix) => void; onEventsChanged: () => void;
}> = ({ a, index, fresh, onChange, onRemoved, onFix, onEventsChanged }) => {
  const [busy, setBusy] = useState<null | 'sync' | 'remove' | 'import'>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const look = lookOf(a);
  const syncing = a.status === 'syncing';
  const failed = a.status === 'error' || a.status === 'needs_auth';
  const cals = a.calendars || [];
  const shown = showAll ? cals : cals.slice(0, CAL_FOLD);

  const sync = async () => {
    setBusy('sync'); setErr(null);
    try { onChange(await cal.syncAccount(a.id)); onEventsChanged(); } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };
  const remove = async () => {
    const what = a.kind === 'google'
      ? 'Jarvis stops reading these calendars and its access to your Google account is revoked. Your events stay in Google Calendar.'
      : a.kind === 'file' ? 'Jarvis forgets the events it imported from this file.'
        : a.kind === 'device' ? 'Jarvis forgets this phone’s calendars until the Jarvis app on it syncs them again.'
          : 'Jarvis stops reading these calendars. Nothing changes in the calendar itself.';
    if (!confirm(`Remove “${a.name}”?\n\n${what}`)) return;
    setBusy('remove'); setErr(null);
    try { await cal.removeAccount(a.id); onRemoved(a.id); } catch (e) {
      if (e instanceof Error && 'status' in e && (e as { status: number }).status === 404) { onRemoved(a.id); return; }
      setErr(errText(e)); setBusy(null);
    }
  };
  const toggle = async (id: string, enabled: boolean) => {
    setErr(null);
    const before = a;
    const next = { ...a, calendars: cals.map((c) => (c.id === id ? { ...c, enabled } : c)) };
    onChange(next); // optimistic
    try {
      // The whole list: the server can treat it as a patch or as the new state.
      onChange(await cal.updateAccount(a.id, { calendars: next.calendars.map((c) => ({ id: c.id, enabled: c.enabled })) }));
      onEventsChanged();
    } catch (e) { onChange(before); setErr(errText(e)); }
  };
  const reimport = async (file: File | undefined) => {
    if (!file) return;
    const problem = icsFileProblem(file);
    if (problem) { setErr(problem); return; }
    setBusy('import'); setErr(null);
    try {
      const content = await file.text();
      if (!looksLikeIcs(content)) throw new Error('That file isn’t a calendar (.ics).');
      onChange(await cal.updateAccount(a.id, { content, filename: file.name }));
      onEventsChanged();
    } catch (e) { setErr(errText(e)); } finally { setBusy(null); if (fileRef.current) fileRef.current.value = ''; }
  };

  // The way out of an error / lost access, by kind.
  const fixKind: null | 'google' | 'caldav' | 'file' | 'sync' = !failed || a.kind === 'device' ? null
    : a.kind === 'google' && a.status === 'needs_auth' ? 'google'
      : a.kind === 'caldav' && a.status === 'needs_auth' ? 'caldav'
        : a.kind === 'file' ? 'file' : 'sync';
  const FIX_LABEL = { google: 'Sign in again', caldav: 'Reconnect', file: 'Import the file again', sync: 'Try again' } as const;
  const runFix = () => {
    if (fixKind === 'google') onFix({ kind: 'google' });
    else if (fixKind === 'caldav') onFix({ kind: 'caldav', account: a });
    else if (fixKind === 'file') fileRef.current?.click();
    else if (fixKind === 'sync') sync();
  };

  const actions = (
    <>
      {a.kind === 'file' && <IconButton icon={Upload} label="Import a newer copy of the file" size={32} onClick={() => fileRef.current?.click()} disabled={!!busy} />}
      {a.kind !== 'device' && <IconButton icon={RotateCw} label="Sync now" size={32} onClick={sync} disabled={!!busy || syncing} className={busy === 'sync' ? '[&_svg]:animate-spin' : ''} />}
      <IconButton icon={Trash2} label="Remove" size={32} onClick={remove} disabled={!!busy} />
    </>
  );

  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ type: 'spring', damping: 22, stiffness: 220, delay: Math.min(index, 6) * 0.04 }}
      className="rounded-[16px] border px-3 py-3" style={{
        background: palette.surfaceRaised,
        borderColor: failed ? alpha(palette.listening, 70) : fresh ? alpha(palette.accent, 140) : palette.stroke,
        boxShadow: fresh ? `0 0 0 3px ${alpha(palette.accent, 36)}` : undefined,
      }}>
      <input ref={fileRef} type="file" accept=".ics,text/calendar" className="hidden" onChange={(e) => reimport(e.target.files?.[0])} />
      <div className="flex items-start gap-3">
        <Tile look={look}>
          {syncing && <motion.span className="absolute inset-0 rounded-[12px] border-2" style={{ borderColor: alpha(palette.accent, 150) }} animate={{ opacity: [0.2, 1, 0.2] }} transition={{ duration: 1.6, repeat: Infinity }} />}
        </Tile>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="t-body min-w-0 truncate" style={{ color: palette.text }}>{a.name}</span>
            {a.writable ? null : <span className="flex shrink-0 items-center gap-1 t-caption" style={{ color: palette.textTertiary }} title="Jarvis can read these calendars but not add events to them"><Lock size={11} />Read-only</span>}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 rounded-[6px] px-1.5 py-[1px] text-[10px] font-bold uppercase tracking-[0.08em]" style={{ background: palette.surfaceHigh, color: look.color }}>{look.label}</span>
            {a.detail && <span className="min-w-0 truncate t-footnote" style={{ color: palette.textTertiary }} title={a.detail}>{a.detail}</span>}
          </div>
          <div className="mt-1.5 t-footnote">
            {syncing ? (
              <span className="flex items-center gap-1.5" style={{ color: palette.accent }}>
                <Loader2 size={13} className="animate-spin" /> Syncing…
                <span className="relative h-1 w-16 overflow-hidden rounded-full" style={{ background: alpha(palette.accent, 30) }}>
                  <motion.span className="absolute inset-y-0 w-1/2 rounded-full" style={{ background: palette.accent }} initial={{ x: '-100%' }} animate={{ x: '200%' }} transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }} />
                </span>
              </span>
            ) : failed ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1" style={{ color: palette.listening }}>
                <span className="flex items-start gap-1.5"><AlertTriangle size={13} className="mt-[1px] shrink-0" />{a.error || (a.status === 'needs_auth' ? 'Jarvis lost access to this calendar — sign in again.' : 'Jarvis couldn’t sync it.')}</span>
                {fixKind && <button type="button" onClick={runFix} disabled={!!busy} className="font-semibold underline-offset-2 hover:underline disabled:opacity-50" style={{ color: palette.text }}>{FIX_LABEL[fixKind]}</button>}
              </span>
            ) : (
              <span className="flex flex-wrap items-center gap-x-1.5" style={{ color: palette.textTertiary }}>
                <span className="inline-block size-1.5 rounded-full" style={{ background: palette.success }} />
                <span>{syncLine(a)}</span>
                {a.kind === 'device' && <span>· syncs from the Jarvis app on the phone</span>}
              </span>
            )}
            {err && <span className="mt-1 flex items-start gap-1.5" style={{ color: palette.warning }}><AlertTriangle size={13} className="mt-[1px] shrink-0" />{err}</span>}
          </div>
        </div>
        <div className="hidden shrink-0 items-center gap-1 sm:flex">{actions}</div>
      </div>

      {cals.length > 0 && (
        <div className="mt-2.5 rounded-[12px] border p-1 sm:ml-[52px]" style={{ borderColor: palette.stroke, background: alpha('#02060C', 90) }}>
          <div className="flex items-center justify-between px-2.5 pb-0.5 pt-1">
            <span className="t-caption" style={{ color: palette.textTertiary }}>{calendarsLine(a)}</span>
          </div>
          {shown.map((c) => {
            const color = safeColor(c.color, look.color);
            return (
              <button key={c.id} type="button" role="switch" aria-checked={c.enabled} onClick={() => toggle(c.id, !c.enabled)}
                className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left transition-colors hover:bg-[rgba(148,210,255,0.05)]">
                <span className="size-3 shrink-0 rounded-[4px] transition-opacity" style={{ background: color, opacity: c.enabled ? 1 : 0.35, boxShadow: c.enabled ? `0 0 8px ${alpha(color, 110)}` : undefined }} />
                <span className="min-w-0 flex-1 truncate t-subhead" style={{ color: c.enabled ? palette.text : palette.textTertiary }}>{c.name}</span>
                {c.primary && <span className="shrink-0 t-caption" style={{ color: palette.textTertiary }}>Primary</span>}
                {!c.writable && <span title="Read-only for Jarvis"><Lock size={12} className="shrink-0" style={{ color: palette.textTertiary }} /></span>}
                <Switch value={c.enabled} color={color} />
              </button>
            );
          })}
          {cals.length > CAL_FOLD && (
            <button type="button" onClick={() => setShowAll(!showAll)} className="flex w-full items-center gap-1 px-2.5 py-1.5 t-footnote hover:underline" style={{ color: palette.textSecondary }}>
              <ChevronDown size={13} className={showAll ? 'rotate-180' : ''} /> {showAll ? 'Show fewer' : `Show all ${cals.length} calendars`}
            </button>
          )}
        </div>
      )}
      {/* Phones: the actions get their own line so the name and status keep the width. */}
      <div className="mt-2 flex justify-end gap-1 sm:hidden">{actions}</div>
    </motion.div>
  );
};

// ── Adding a calendar ────────────────────────────────────────────────────────
type Step = 'choose' | 'google' | 'icloud' | 'caldav' | 'ics' | 'file';
type Option = { key: Exclude<Step, 'choose'>; title: string; line: string; look: Look };
const OPTIONS: Option[] = [
  { key: 'google', title: 'Google Calendar', line: 'Sign in with Google — Jarvis reads your calendars and can add events.', look: lookOf({ kind: 'google' }) },
  { key: 'icloud', title: 'iCloud', line: 'Your Apple ID with an app-specific password. Read and add events.', look: lookOf({ kind: 'caldav', provider: 'icloud' }) },
  { key: 'caldav', title: 'Other CalDAV', line: 'Fastmail, Nextcloud, Yahoo or any CalDAV server.', look: lookOf({ kind: 'caldav', provider: 'other' }) },
  { key: 'ics', title: 'Subscribe by link', line: 'Any calendar’s ICS / webcal link. Read-only, kept up to date.', look: lookOf({ kind: 'ics' }) },
  { key: 'file', title: 'Import a file', line: 'An .ics file exported from any calendar app. Read-only.', look: lookOf({ kind: 'file' }) },
];
const PROVIDER_CHIPS: Exclude<CaldavProvider, 'icloud'>[] = ['fastmail', 'nextcloud', 'yahoo', 'other'];

const ICS_WHERE: Array<[string, string]> = [
  ['Google', 'Settings → your calendar → “Secret address in iCal format”'],
  ['Outlook', 'Settings → Calendar → Shared calendars → Publish a calendar → ICS'],
  ['iCloud', 'Calendar → share the calendar → Public Calendar → copy the link'],
];

/** Pre-filled when fixing an account (needs_auth). */
interface Prefill { provider?: CaldavProvider; username?: string; replaceId?: string; autoGoogle?: boolean }

const AddFlow: React.FC<{
  open: boolean; step: Step; setStep: (s: Step) => void; prefill: Prefill | null; google: CalendarOverview['google'];
  onAdded: (a: CalendarAccount, replaceId?: string) => void; onClose: () => void;
}> = ({ open, step, setStep, prefill, google, onAdded, onClose }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState(prefill?.username ?? '');
  const [password, setPassword] = useState('');
  const [provider, setProvider] = useState<CaldavProvider>(prefill?.provider && prefill.provider !== 'icloud' ? prefill.provider : 'fastmail');
  const [serverUrl, setServerUrl] = useState('');
  const [link, setLink] = useState('');
  const [linkName, setLinkName] = useState('');
  const [dragging, setDragging] = useState(false);
  const [waiting, setWaiting] = useState<{ authUrl: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const poll = useRef<{ timer: ReturnType<typeof setTimeout> | null; alive: boolean }>({ timer: null, alive: false });

  const stopGoogle = useCallback(() => {
    poll.current.alive = false;
    if (poll.current.timer) clearTimeout(poll.current.timer);
    poll.current.timer = null;
    setWaiting(null);
  }, []);
  // Settings closed, or this flow went away: stop asking (the poll checks `alive` before each call).
  useEffect(() => {
    const p = poll.current;
    const halt = () => { p.alive = false; if (p.timer) clearTimeout(p.timer); p.timer = null; };
    if (!open) halt();
    return halt;
  }, [open]);

  // Each option starts clean (a reconnect keeps its account's username).
  const go = (s: Step) => { stopGoogle(); setStep(s); setError(null); setPassword(''); setUsername(prefill?.username ?? ''); setServerUrl(''); };
  const done = (a: CalendarAccount) => { setPassword(''); onAdded(a, prefill?.replaceId); };

  const submit = async (body: NewCalendarAccount) => {
    setBusy(true); setError(null);
    // The password stays in the field after a refusal (to fix a typo); it's cleared once sent successfully or on Back.
    try { done(await cal.addAccount(body)); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  const startGoogle = async () => {
    stopGoogle();
    setBusy(true); setError(null);
    try {
      const { authUrl, state } = await cal.startGoogle();
      // The desktop app's window-open handler sends it to the system browser.
      window.open(authUrl, '_blank', 'noopener');
      setWaiting({ authUrl });
      const deadline = Date.now() + GOOGLE_MAX_MS;
      poll.current.alive = true;
      const tick = async () => {
        if (!poll.current.alive) return;
        try {
          const r = await cal.googleStatus(state);
          if (!poll.current.alive) return;
          if (r.status === 'connected') { stopGoogle(); done(r.account); return; }
          if (r.status === 'error') { stopGoogle(); setError(r.error); return; }
        } catch (e) {
          // A blip keeps polling; a sign-in the server forgot (404 / 410) doesn't.
          const status = (e as { status?: number }).status ?? 0;
          if (status === 404 || status === 410) { stopGoogle(); setError(errText(e)); return; }
        }
        if (Date.now() > deadline) { stopGoogle(); setError('Google sign-in timed out — try again.'); return; }
        poll.current.timer = setTimeout(tick, POLL_MS);
      };
      poll.current.timer = setTimeout(tick, POLL_MS);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  // "Sign in again" on a Google account starts right away.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (step === 'google' && prefill?.autoGoogle && google.available && !autoStarted.current) { autoStarted.current = true; startGoogle(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, prefill]);

  const submitIcloud = () => {
    const v = caldavBody({ provider: 'icloud', username, password });
    if ('error' in v) setError(v.error); else submit(v.body);
  };
  const submitCaldav = () => {
    const v = caldavBody({ provider, username, password, url: serverUrl });
    if ('error' in v) setError(v.error); else submit(v.body);
  };
  const submitLink = () => {
    const v = normalizeIcsLink(link);
    if ('error' in v) setError(v.error); else submit({ kind: 'ics', url: v.url, ...(linkName.trim() ? { name: linkName.trim() } : {}) });
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    const problem = icsFileProblem(file);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try {
      const content = await file.text();
      if (!looksLikeIcs(content)) throw new Error('That file isn’t a calendar (.ics).');
      done(await cal.addAccount({ kind: 'file', filename: file.name, content }));
    } catch (e) { setError(errText(e)); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const onKey = (run: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); if (!busy) run(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  };

  const option = OPTIONS.find((o) => o.key === step);
  const info = CALDAV_PROVIDERS[provider];
  const linkCheck = link.trim() ? normalizeIcsLink(link) : null;

  return (
    <div className="rounded-[18px] border p-3 sm:p-4" style={{ borderColor: palette.strokeStrong, background: alpha('#02060C', 110) }}>
      <div className="mb-3 flex items-center gap-2">
        {step !== 'choose' && <IconButton icon={ChevronLeft} label="Back" size={30} onClick={() => go('choose')} />}
        {option ? <Tile look={option.look} size={30} /> : <span className="grid size-[30px] place-items-center rounded-[10px]" style={{ background: alpha(palette.accent, 30), color: palette.accent }}><CalendarPlus size={15} /></span>}
        <span className="t-headline min-w-0 flex-1 truncate" style={{ color: palette.text }}>{option ? option.title : 'Add a calendar'}</span>
        <IconButton icon={X} label="Close" size={30} onClick={onClose} />
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={step} initial={{ opacity: 0, x: step === 'choose' ? -12 : 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: step === 'choose' ? 12 : -12 }} transition={{ duration: 0.18 }} className="flex flex-col gap-3">
          {step === 'choose' && (
            <div className="grid gap-2 sm:grid-cols-2">
              {OPTIONS.map((o, i) => {
                const off = o.key === 'google' && !google.available;
                return (
                  <motion.button key={o.key} type="button" disabled={off} onClick={() => go(o.key)}
                    initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }} whileTap={off ? undefined : { scale: 0.98 }}
                    className={`group flex min-w-0 items-start gap-3 rounded-[14px] border p-3 text-left transition-colors ${off ? 'cursor-not-allowed' : 'hover:bg-[rgba(148,210,255,0.05)]'} ${o.key === 'file' ? 'sm:col-span-2' : ''}`}
                    style={{ borderColor: palette.stroke, background: palette.surfaceRaised }}>
                    <span className={off ? 'opacity-50' : ''}><Tile look={o.look} size={36} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1 t-callout" style={{ color: off ? palette.textTertiary : palette.text }}>{o.title}</span>
                      <span className="mt-0.5 block t-footnote" style={{ color: off ? palette.warning : palette.textTertiary }}>{off ? (google.reason || 'Google sign-in isn’t available on this computer.') : o.line}</span>
                    </span>
                    {!off && <ChevronRight size={16} className="mt-2.5 shrink-0 transition-transform group-hover:translate-x-0.5" style={{ color: palette.textTertiary }} />}
                  </motion.button>
                );
              })}
            </div>
          )}

          {step === 'google' && (
            waiting ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3 rounded-[14px] px-3 py-3" style={{ background: palette.surfaceRaised }}>
                  <span className="relative grid size-9 shrink-0 place-items-center">
                    <motion.span className="absolute inset-0 rounded-full border-2" style={{ borderColor: alpha('#4285F4', 160), borderTopColor: 'transparent' }} animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} />
                    <GoogleMark size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="t-callout" style={{ color: palette.text }}>Waiting for Google…</div>
                    <div className="t-footnote" style={{ color: palette.textTertiary }}>Finish signing in in your browser, then come back here.</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button icon={ExternalLink} onClick={() => window.open(waiting.authUrl, '_blank', 'noopener')}>Open Google again</Button>
                  <Button onClick={stopGoogle}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="t-footnote" style={{ color: palette.textSecondary }}>
                  Google opens in your browser. Pick your account and allow access to your calendars — Google sends the sign-in straight back to this computer, where the tokens and your events stay.
                </p>
                <Pressable onClick={startGoogle} disabled={busy || !google.available}
                  className="flex h-10 w-fit items-center gap-2.5 rounded-full border px-5 t-callout disabled:opacity-50"
                  style={{ background: '#FFFFFF', color: '#1F1F1F', borderColor: '#DADCE0' }}>
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <GoogleMark size={17} />} Continue with Google
                </Pressable>
              </div>
            )
          )}

          {step === 'icloud' && (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Apple ID">
                  <input autoFocus type="email" value={username} onChange={(e) => { setUsername(e.target.value); setError(null); }} onKeyDown={onKey(submitIcloud)}
                    placeholder="you@icloud.com" autoComplete="username" spellCheck={false} className={input} />
                </Field>
                <Field label="App-specific password">
                  <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} onKeyDown={onKey(submitIcloud)}
                    placeholder="xxxx-xxxx-xxxx-xxxx" autoComplete="off" spellCheck={false} className={`${input} font-mono`} />
                </Field>
              </div>
              <div className="rounded-[14px] border px-3 py-2.5" style={{ borderColor: palette.stroke, background: palette.surfaceRaised }}>
                <div className="mb-1 t-subhead" style={{ color: palette.textSecondary }}>Get an app-specific password</div>
                <ol className="list-decimal space-y-0.5 pl-5 t-footnote" style={{ color: palette.textTertiary }}>
                  <li>Open <a href={CALDAV_PROVIDERS.icloud.helpUrl} target="_blank" rel="noopener noreferrer" className="font-semibold underline-offset-2 hover:underline" style={{ color: palette.accent }}>appleid.apple.com</a> and sign in.</li>
                  <li>Sign-In and Security → App-Specific Passwords → <b style={{ color: palette.textSecondary }}>+</b>.</li>
                  <li>Name it “Jarvis” and paste the password here. Your Apple ID password won’t work.</li>
                </ol>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button primary icon={busy ? Loader2 : Check} spin={busy} onClick={submitIcloud} disabled={busy || !username.trim() || !password}>{busy ? 'Connecting…' : 'Connect iCloud'}</Button>
                <span className="t-footnote" style={{ color: palette.textTertiary }}>Saved only on the computer running Jarvis.</span>
              </div>
            </>
          )}

          {step === 'caldav' && (
            <>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Provider">
                {PROVIDER_CHIPS.map((p) => {
                  const on = provider === p;
                  return (
                    <button key={p} type="button" role="radio" aria-checked={on} onClick={() => { setProvider(p); setError(null); }}
                      className="flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 t-subhead transition-colors"
                      style={on ? { background: alpha(palette.accent, 40), borderColor: alpha(palette.accent, 140), color: palette.accent } : { background: palette.surfaceRaised, borderColor: palette.stroke, color: palette.textSecondary }}>
                      {CALDAV_PROVIDERS[p].label}
                    </button>
                  );
                })}
              </div>
              {info.needsUrl && (
                <Field label="Server address" hint={provider === 'nextcloud' ? 'ends in /remote.php/dav' : 'CalDAV'}>
                  <input type="url" value={serverUrl} onChange={(e) => { setServerUrl(e.target.value); setError(null); }} onKeyDown={onKey(submitCaldav)}
                    placeholder={info.urlPlaceholder} autoComplete="off" spellCheck={false} className={`${input} font-mono`} />
                </Field>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label={info.usernameLabel}>
                  <input autoFocus={!info.needsUrl} type="text" value={username} onChange={(e) => { setUsername(e.target.value); setError(null); }} onKeyDown={onKey(submitCaldav)}
                    placeholder={info.usernamePlaceholder} autoComplete="username" spellCheck={false} className={input} />
                </Field>
                <Field label={info.passwordLabel}>
                  <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} onKeyDown={onKey(submitCaldav)}
                    placeholder="••••••••" autoComplete="off" spellCheck={false} className={input} />
                </Field>
              </div>
              <p className="flex items-start gap-1.5 t-footnote" style={{ color: palette.textTertiary }}>
                <Lock size={12} className="mt-[2px] shrink-0" />
                <span>{info.passwordHint}{info.helpUrl && <> <a href={info.helpUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-semibold underline-offset-2 hover:underline" style={{ color: palette.accent }}>Open <ExternalLink size={11} /></a></>}</span>
              </p>
              <div>
                <Button primary icon={busy ? Loader2 : Check} spin={busy} onClick={submitCaldav} disabled={busy || !username.trim() || !password || (info.needsUrl && !serverUrl.trim())}>{busy ? 'Connecting…' : `Connect ${info.label === 'Other' ? 'calendar' : info.label}`}</Button>
              </div>
            </>
          )}

          {step === 'ics' && (
            <>
              <Field label="Calendar link">
                <input autoFocus type="url" value={link} onChange={(e) => { setLink(e.target.value); setError(null); }} onKeyDown={onKey(submitLink)}
                  placeholder="https://…/basic.ics  or  webcal://…" autoComplete="off" spellCheck={false} className={`${input} font-mono`}
                  style={error ? { borderColor: alpha(palette.listening, 160) } : undefined} />
              </Field>
              {linkCheck && 'url' in linkCheck && (
                <span className="-mt-1.5 flex items-center gap-1.5 t-footnote" style={{ color: palette.success }}><Check size={12} />{maskLink(linkCheck.url)} · read-only</span>
              )}
              <Field label="Name" hint="optional">
                <input type="text" value={linkName} onChange={(e) => setLinkName(e.target.value)} onKeyDown={onKey(submitLink)} placeholder="Holidays, Team rota…" autoComplete="off" className={input} />
              </Field>
              <div className="rounded-[14px] border px-3 py-2.5" style={{ borderColor: palette.stroke, background: palette.surfaceRaised }}>
                <div className="mb-1 t-subhead" style={{ color: palette.textSecondary }}>Where to find the link</div>
                <dl className="grid gap-x-3 gap-y-1 t-footnote sm:grid-cols-[auto_1fr]">
                  {ICS_WHERE.map(([who, where]) => (
                    <React.Fragment key={who}>
                      <dt className="font-semibold" style={{ color: palette.textSecondary }}>{who}</dt>
                      <dd className="mb-1 sm:mb-0" style={{ color: palette.textTertiary }}>{where}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </div>
              <div>
                <Button primary icon={busy ? Loader2 : Link2} spin={busy} onClick={submitLink} disabled={busy || !link.trim()}>{busy ? 'Subscribing…' : 'Subscribe'}</Button>
              </div>
            </>
          )}

          {step === 'file' && (
            <>
              <input ref={fileRef} type="file" accept=".ics,text/calendar" className="hidden" onChange={(e) => importFile(e.target.files?.[0])} />
              <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); importFile(e.dataTransfer.files?.[0]); }}
                className="flex flex-col items-center gap-2 rounded-[16px] border-2 border-dashed px-4 py-7 text-center transition-colors"
                style={{ borderColor: dragging ? palette.accent : palette.strokeStrong, background: dragging ? alpha(palette.accent, 18) : palette.surfaceRaised }}>
                <span className="grid size-11 place-items-center rounded-full" style={{ background: alpha(palette.warning, 30), color: palette.warning }}>
                  {busy ? <Loader2 size={20} className="animate-spin" /> : <FileUp size={20} />}
                </span>
                <span className="t-callout" style={{ color: palette.text }}>{busy ? 'Importing…' : dragging ? 'Drop it here' : 'Drop an .ics file here, or choose one'}</span>
                <span className="t-footnote" style={{ color: palette.textTertiary }}>Up to 5 MB · exported from Google, Outlook, Apple Calendar…</span>
              </button>
            </>
          )}

          {error && <ErrorLine>{error}</ErrorLine>}
        </motion.div>
      </AnimatePresence>
    </div>
  );
};

// ── Coming up ────────────────────────────────────────────────────────────────
const UpcomingRow: React.FC<{ e: CalendarEvent; tz: string; index: number }> = ({ e, tz, index }) => {
  const s = toMs(e.start, tz);
  const key = Number.isFinite(s) ? (isAllDay(e) && e.start.length === 10 ? e.start : dayKey(s, tz)) : '';
  const day = key ? dayHeading(key, tz).label : '';
  const color = safeColor(e.color, palette.accent);
  return (
    <motion.li initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.04 }} className="flex min-w-0 items-center gap-3 py-1.5">
      <span className="h-8 w-[3px] shrink-0 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${alpha(color, 90)}` }} />
      <div className="w-[92px] shrink-0">
        <div className="t-caption" style={{ color: day === 'Today' ? palette.accent : palette.textTertiary }}>{day}</div>
        <div className="t-subhead tabular-nums" style={{ color: palette.textSecondary }}>{isAllDay(e) ? 'All day' : formatTime(s, tz)}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate t-callout" style={{ color: palette.text }}>{e.title}</div>
        {(e.calendarName || e.location) && <div className="truncate t-footnote" style={{ color: palette.textTertiary }}>{[e.calendarName, e.location].filter(Boolean).join(' · ')}</div>}
      </div>
    </motion.li>
  );
};

// ── The section ──────────────────────────────────────────────────────────────
const EXAMPLES = ['What’s on my calendar tomorrow?', 'Add lunch with Ana on Friday at 1 pm', 'Move my 3 pm to 4'];

export const CalendarSettings: React.FC<{ open: boolean }> = ({ open }) => {
  const activeServerUrl = useStore((s) => s.activeServerUrl);
  /** null = not loaded, or this server doesn't offer calendars to this client (section hidden). */
  const [data, setData] = useState<CalendarOverview | null>(null);
  const [events, setEvents] = useState<{ list: CalendarEvent[]; timeZone: string } | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [step, setStep] = useState<Step>('choose');
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [, tick] = useState(0);

  /** While polling, a failure keeps the last list. */
  const refresh = useCallback(async () => {
    if (!BACKEND_HTTP) return;
    try { setData(await cal.overview()); } catch { /* keep what's shown */ }
  }, []);
  const loadEvents = useCallback(async () => {
    if (!BACKEND_HTTP) return;
    try {
      const r = await cal.events();
      setEvents({ list: r.events.filter((e) => e.status !== 'cancelled'), timeZone: r.timeZone });
      setEventsError(null);
    } catch (e) { setEventsError(errText(e)); }
  }, []);

  useEffect(() => {
    if (!open || !activeServerUrl || !BACKEND_HTTP) return;
    let alive = true;
    // A failure hides the section (not this computer's owner, or a server without calendars).
    cal.overview().then(
      (d) => { if (alive) { setData(d); loadEvents(); } },
      () => { if (alive) setData(null); },
    );
    return () => { alive = false; };
  }, [open, activeServerUrl, loadEvents]);

  // While an account syncs, refresh every 2 s; when it's done, the preview too.
  const syncingIds = data?.accounts.filter((a) => a.status === 'syncing').map((a) => a.id).join(',') ?? '';
  const wasSyncing = useRef('');
  useEffect(() => {
    if (!open) return;
    if (!syncingIds) {
      if (wasSyncing.current) { wasSyncing.current = ''; loadEvents(); }
      return;
    }
    wasSyncing.current = syncingIds;
    const t = setTimeout(refresh, POLL_MS);
    return () => clearTimeout(t);
  }, [open, syncingIds, data, refresh, loadEvents]);
  // "Synced 2 min ago" stays true.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, [open]);
  useEffect(() => { if (!fresh) return; const t = setTimeout(() => setFresh(null), 4000); return () => clearTimeout(t); }, [fresh]);

  const accounts = useMemo(() => data?.accounts ?? [], [data]);
  const targets = useMemo(() => writableTargets(accounts), [accounts]);
  if (!data) return null;

  const upsert = (a: CalendarAccount) => setData((d) => d && ({ ...d, accounts: d.accounts.some((x) => x.id === a.id) ? d.accounts.map((x) => (x.id === a.id ? a : x)) : [...d.accounts, a] }));
  const removed = (id: string) => { setData((d) => d && ({ ...d, accounts: d.accounts.filter((x) => x.id !== id) })); loadEvents(); };

  const startAdd = (s: Step = 'choose', p: Prefill | null = null) => { setPrefill(p); setStep(s); setAdding(true); };
  const closeAdd = () => { setAdding(false); setPrefill(null); setStep('choose'); };
  const added = async (a: CalendarAccount, replaceId?: string) => {
    upsert(a);
    setFresh(a.id);
    closeAdd();
    // A reconnected CalDAV account replaces the one that lost access.
    if (replaceId && replaceId !== a.id) {
      try { await cal.removeAccount(replaceId); setData((d) => d && ({ ...d, accounts: d.accounts.filter((x) => x.id !== replaceId) })); } catch { /* the old row stays; the user can remove it */ }
    }
    refresh().then(loadEvents);
  };
  const fix = (f: Fix) => {
    if (f.kind === 'google') startAdd('google', { autoGoogle: true });
    else if (f.kind === 'caldav') startAdd(f.account.provider === 'icloud' ? 'icloud' : 'caldav', { provider: f.account.provider, username: f.account.name.includes('@') ? f.account.name : '', replaceId: f.account.id });
  };

  const saveSettings = async (patch: { defaultCalendar?: CalendarRef | null; timeZone?: string; shareWithVoice?: boolean }) => {
    setSettingsBusy(true); setSettingsError(null);
    const before = data.settings;
    setData((d) => d && ({ ...d, settings: { ...d.settings, ...patch } }));
    try {
      const settings = await cal.updateSettings(patch);
      setData((d) => d && ({ ...d, settings: { defaultCalendar: settings.defaultCalendar ?? null, timeZone: settings.timeZone || d.settings.timeZone, shareWithVoice: settings.shareWithVoice !== false } }));
      if (patch.timeZone) loadEvents();
    } catch (e) {
      setData((d) => d && ({ ...d, settings: before }));
      setSettingsError(errText(e));
    } finally { setSettingsBusy(false); }
  };

  const syncing = accounts.filter((a) => a.status === 'syncing').length;
  const broken = accounts.filter((a) => a.status === 'error' || a.status === 'needs_auth').length;
  const tz = validTimeZone(data.settings.timeZone) ?? deviceTimeZone();
  const deviceTz = deviceTimeZone();
  const current = effectiveDefault(accounts, data.settings);
  const dupNames = new Set(targets.map((t) => t.name).filter((n, i, all) => all.indexOf(n) !== i));
  const upcoming = (events?.list ?? []).slice(0, PREVIEW_EVENTS);
  const eventsTz = validTimeZone(events?.timeZone) ?? tz;

  return (
    <div id="settings-calendar" className="scroll-mt-4">
      <Section title="Calendar" aside={
        <span className="t-footnote" style={{ color: syncing ? palette.accent : broken ? palette.listening : palette.textTertiary }}>
          {syncing ? `Syncing ${syncing}…` : broken ? `${broken} need${broken === 1 ? 's' : ''} attention` : accounts.length ? `${accounts.length} account${accounts.length > 1 ? 's' : ''}` : ''}
        </span>
      }>
        {accounts.length > 0 && (
          <p className="t-footnote" style={{ color: palette.textTertiary }}>
            Jarvis reads the calendars switched on below and adds events where you tell it. Everything stays on the computer running Jarvis.
          </p>
        )}

        {accounts.length === 0 && !adding && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="relative overflow-hidden rounded-[18px] border p-4" style={{ borderColor: palette.stroke, background: `linear-gradient(150deg, ${alpha(palette.accent, 22)} 0%, ${palette.surfaceRaised} 60%)` }}>
            <div className="flex items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-[14px]" style={{ background: alpha(palette.accent, 36), color: palette.accent, boxShadow: `0 0 24px ${alpha(palette.accent, 50)}` }}><CalendarDays size={21} /></span>
              <div className="min-w-0 flex-1">
                <div className="t-headline" style={{ color: palette.text }}>Connect a calendar and just ask</div>
                <p className="mt-0.5 t-footnote" style={{ color: palette.textSecondary }}>Google, iCloud, Fastmail, any CalDAV server, a subscribed link or an .ics file. Jarvis answers from it and adds events for you.</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {EXAMPLES.map((x) => (
                <span key={x} className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 t-footnote" style={{ borderColor: palette.stroke, background: alpha('#02060C', 120), color: palette.textSecondary }}>
                  <MessageSquareQuote size={12} style={{ color: palette.accent }} />“{x}”
                </span>
              ))}
            </div>
          </motion.div>
        )}

        {accounts.length > 0 && (
          <div className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {accounts.map((a, i) => (
                <AccountRow key={a.id} a={a} index={i} fresh={fresh === a.id} onChange={upsert} onRemoved={removed} onFix={fix} onEventsChanged={loadEvents} />
              ))}
            </AnimatePresence>
          </div>
        )}

        <AnimatePresence initial={false} mode="wait">
          {adding ? (
            <motion.div key="flow" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
              <AddFlow key={prefill?.replaceId ?? (prefill?.autoGoogle ? 'google' : 'new')} open={open} step={step} setStep={setStep} prefill={prefill} google={data.google} onAdded={added} onClose={closeAdd} />
            </motion.div>
          ) : (
            <motion.div key="btn" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-wrap gap-2">
              <Button primary={accounts.length === 0} icon={Plus} onClick={() => startAdd()}>Add a calendar</Button>
            </motion.div>
          )}
        </AnimatePresence>

        {accounts.length > 0 && (
          <>
            <div className="h-px" style={{ background: palette.stroke }} />
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="t-subhead" style={{ color: palette.textSecondary }}>Add events to</span>
                {settingsBusy && <Loader2 size={13} className="animate-spin" style={{ color: palette.accent }} />}
              </div>
              {targets.length ? (
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Add events to">
                  {targets.map((t) => {
                    const on = sameRef(current?.ref, t.ref);
                    const color = safeColor(t.color, palette.accent);
                    return (
                      <button key={`${t.ref.accountId}/${t.ref.calendarId}`} type="button" role="radio" aria-checked={on} title={`${t.name} · ${t.account}`}
                        onClick={() => { if (!on) saveSettings({ defaultCalendar: t.ref }); }}
                        className="flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 t-subhead transition-colors"
                        style={on ? { background: alpha(color, 40), borderColor: alpha(color, 150), color: palette.text } : { background: palette.surfaceRaised, borderColor: palette.stroke, color: palette.textSecondary }}>
                        <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
                        <span className="truncate">{t.name}{dupNames.has(t.name) ? <span style={{ color: palette.textTertiary }}> · {t.account}</span> : null}</span>
                        {on && <Check size={13} className="shrink-0" style={{ color }} />}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="t-footnote" style={{ color: palette.textTertiary }}>Links and imported files are read-only. Connect Google, iCloud or a CalDAV calendar to let Jarvis add events.</p>
              )}
              {!data.settings.defaultCalendar && current && <p className="t-footnote" style={{ color: palette.textTertiary }}>Until you pick one, new events go to “{current.name}”.</p>}

              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="flex min-w-0 items-center gap-1.5 t-footnote" style={{ color: palette.textSecondary }}>
                  <Globe size={13} style={{ color: palette.textTertiary }} />
                  Time zone <b className="font-semibold" style={{ color: palette.text }}>{tz.replace(/_/g, ' ')}</b>
                  <span style={{ color: palette.textTertiary }}>{zoneOffsetLabel(tz)}</span>
                </span>
                {tz !== deviceTz ? (
                  <button type="button" onClick={() => saveSettings({ timeZone: deviceTz })} disabled={settingsBusy}
                    className="t-footnote font-semibold underline-offset-2 hover:underline disabled:opacity-50" style={{ color: palette.accent }}>
                    Use this device’s time zone ({deviceTz.replace(/_/g, ' ')})
                  </button>
                ) : (
                  <span className="flex items-center gap-1 t-footnote" style={{ color: palette.textTertiary }}><Check size={12} /> Same as this device</span>
                )}
              </div>
              <button type="button" role="switch" aria-checked={data.settings.shareWithVoice !== false} disabled={settingsBusy}
                onClick={() => saveSettings({ shareWithVoice: data.settings.shareWithVoice === false })}
                className="mt-2 flex w-full items-center gap-3 rounded-[14px] border px-3.5 py-3 text-left transition-colors disabled:opacity-60"
                style={{ background: palette.surfaceRaised, borderColor: palette.stroke }}>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="t-callout font-semibold" style={{ color: palette.text }}>Jarvis knows your week</span>
                  <span className="t-footnote" style={{ color: palette.textTertiary }}>
                    Your next 7 days go into each voice conversation, so “Am I free tonight?” or “When do I see Ana?” are answered at once. Off: Jarvis looks your calendar up only when you ask about it.
                  </span>
                </span>
                <Switch value={data.settings.shareWithVoice !== false} />
              </button>
              {settingsError && <ErrorLine>{settingsError}</ErrorLine>}
            </div>

            <div className="h-px" style={{ background: palette.stroke }} />
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="t-subhead" style={{ color: palette.textSecondary }}>Coming up</span>
                <button type="button" onClick={loadEvents} className="flex items-center gap-1 t-footnote hover:underline" style={{ color: palette.textTertiary }}><RotateCw size={11} /> Refresh</button>
              </div>
              {eventsError ? (
                <ErrorLine tone={palette.warning}>{eventsError}</ErrorLine>
              ) : !events ? (
                <span className="flex items-center gap-1.5 py-1 t-footnote" style={{ color: palette.textTertiary }}><Loader2 size={12} className="animate-spin" /> Loading…</span>
              ) : upcoming.length ? (
                <ul className="flex flex-col divide-y divide-[rgba(148,210,255,0.08)]">
                  {upcoming.map((e, i) => <UpcomingRow key={`${e.accountId}/${e.calendarId}/${e.id}`} e={e} tz={eventsTz} index={i} />)}
                </ul>
              ) : (
                <p className="py-1 t-footnote" style={{ color: palette.textTertiary }}>{syncing ? 'Your events appear here once the sync finishes.' : 'Nothing in the next 7 days.'}</p>
              )}
            </div>
          </>
        )}
      </Section>
    </div>
  );
};
