// Settings → Businesses: the folders, files and links Jarvis keeps a business overview of (the
// computer's owner only — hidden when the server doesn't answer, like the other sections for
// this computer). Adding one analyses it in the background; when it's ready, this client opens
// the Business Dashboard on it.
import React, { useEffect, useState } from 'react';
import { create } from 'zustand';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle, Braces, ChartNoAxesColumn, FileCode, FileText, FileType, Folder, FolderPlus, Globe, KeyRound, Link2, Loader2, Lock,
  Plug, Plus, RotateCw, Table, X, type LucideIcon,
} from 'lucide-react';
import { useStore, API_KEY, BACKEND_HTTP } from '../store';
import { IconButton, Pressable, alpha, palette } from '../ui';
import { Section } from './SettingsSection';
import type { BusinessOverview } from './overlayCards/types';
import { businessCount, displayLocation, normalizeWebsite, sourceTitle, statusLabel, statusTone, timeAgo, validateLocalPath } from '../server/businessFormat';

export type SourceFormat = 'directory' | 'html' | 'json' | 'pdf' | 'text' | 'markdown' | 'csv' | 'web' | 'api';

export interface BusinessSource {
  id: string;
  /** 'file' may appear for a single file; it's treated like 'folder'. */
  kind: 'folder' | 'website' | 'file';
  target: string;
  name: string;
  status: 'analysing' | 'ready' | 'error';
  error?: string;
  addedAt: string;
  analysedAt?: string;
  format?: SourceFormat;
  /** Names of the request headers saved for a private API (values never leave the server). */
  headerNames?: string[];
  /** The source's own summary (the portfolio when it holds several businesses). */
  overview?: BusinessOverview;
  /** One per business found in the source. */
  overviews?: BusinessOverview[];
}

type Desktop = { pickFolder?: (opts?: { kind?: 'file' | 'folder' }) => Promise<string | null>; platform?: string };
const desktop = (): Desktop | null => (typeof window !== 'undefined' ? (window as unknown as { jarvisDesktop?: Desktop }).jarvisDesktop ?? null : null);

const POLL_MS = 2000;
const WATCH_MS = 3 * 60 * 1000;
const MAX_HEADERS = 5;

// ── Shared state: the list, and the sources this client is waiting on ───────
interface BizState {
  /** null = not loaded, or this server doesn't offer it to this client (section hidden). */
  sources: BusinessSource[] | null;
  /** id → when to give up and whether to open the dashboard once it's ready. */
  pending: Record<string, { until: number; open: boolean }>;
}
const useBiz = create<BizState>(() => ({ sources: null, pending: {} }));

const api = (path: string, init?: RequestInit) =>
  fetch(`${BACKEND_HTTP}${path}`, { ...init, headers: { 'x-api-key': API_KEY, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) } });

const errorOf = async (r: Response) => {
  const d = await r.json().catch(() => ({}));
  return (d && typeof d.error === 'string' && d.error) || (r.status === 409 ? 'That one is already in your list.' : `The server answered ${r.status}.`);
};

const upsert = (s: BusinessSource) =>
  useBiz.setState((st) => ({ sources: st.sources ? (st.sources.some((x) => x.id === s.id) ? st.sources.map((x) => (x.id === s.id ? s : x)) : [...st.sources, s]) : [s] }));

/** GET the list. `initial`: a failure hides the section; while polling, a failure keeps the last list. */
async function loadSources(initial: boolean) {
  if (!BACKEND_HTTP) return;
  try {
    const r = await api('/api/business/sources');
    if (!r.ok) { if (initial) useBiz.setState({ sources: null }); return; }
    const d = await r.json();
    useBiz.setState({ sources: Array.isArray(d?.sources) ? d.sources : [] });
  } catch {
    if (initial) useBiz.setState({ sources: null });
  }
}

/** The dashboard card, as an agent result (the store's result sheet renders it). Closes Settings first: it sits on top. */
async function openBusinessDashboard(focus?: string) {
  const r = await api(`/api/business/dashboard${focus ? `?focus=${encodeURIComponent(focus)}` : ''}`);
  if (!r.ok) throw new Error(await errorOf(r));
  const d = await r.json();
  const text: string = typeof d?.text === 'string' && d.text.trim()
    ? d.text
    : d?.card ? `\`\`\`json\n${JSON.stringify({ type: 'business_dashboard', ...d.card })}\n\`\`\`` : '';
  if (!text) return;
  const s = useStore.getState();
  if (s.settingsOpen) s.setSettingsOpen(false);
  useStore.setState({ agentOutcome: { agentId: 'jarvis', agentName: 'Jarvis', result: text } });
}

// One poller for everything: sources this client added (open the card when ready — even after
// Settings closed) and, while the section is on screen, any source still analysing.
let timer: ReturnType<typeof setTimeout> | null = null;
let visible = 0;
function schedule() {
  if (timer) return;
  const st = useBiz.getState();
  const waiting = Object.keys(st.pending).length > 0;
  const analysing = visible > 0 && !!st.sources?.some((s) => s.status === 'analysing');
  if (!waiting && !analysing) return;
  timer = setTimeout(async () => {
    timer = null;
    await loadSources(false);
    settle();
    schedule();
  }, POLL_MS);
}

function settle() {
  const { sources, pending } = useBiz.getState();
  const next = { ...pending };
  let open: string | null = null;
  for (const [id, w] of Object.entries(pending)) {
    const s = sources?.find((x) => x.id === id);
    if (!s || s.status === 'error' || Date.now() > w.until) delete next[id];
    else if (s.status === 'ready') { delete next[id]; if (w.open) open = id; }
  }
  if (Object.keys(next).length !== Object.keys(pending).length) useBiz.setState({ pending: next });
  if (open) openBusinessDashboard(open).catch(() => {});
}

const watch = (id: string, open: boolean) => {
  useBiz.setState((st) => ({ pending: { ...st.pending, [id]: { until: Date.now() + WATCH_MS, open } } }));
  schedule();
};

// ── UI ───────────────────────────────────────────────────────────────────────
const input = 'w-full min-w-0 rounded-[14px] border border-stroke bg-surface-raised px-4 py-2.5 t-body text-text outline-none transition-colors placeholder:text-text-3 focus:border-accent/70';

const Button = ({ onClick, icon: Icon, children, primary = false, disabled = false }: { onClick: () => void; icon?: LucideIcon; children: React.ReactNode; primary?: boolean; disabled?: boolean }) => (
  <Pressable onClick={onClick} disabled={disabled} className="flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 t-subhead disabled:opacity-50"
    style={primary ? { background: palette.accent, color: palette.textInverse } : { background: palette.surfaceRaised, color: palette.textSecondary, border: `1px solid ${palette.stroke}` }}>
    {Icon && <Icon size={15} />}{children}
  </Pressable>
);

const FORMAT: Record<SourceFormat, { icon: LucideIcon; label: string }> = {
  directory: { icon: Folder, label: 'Folder' },
  html: { icon: FileCode, label: 'HTML' },
  json: { icon: Braces, label: 'JSON' },
  pdf: { icon: FileText, label: 'PDF' },
  text: { icon: FileType, label: 'Text' },
  markdown: { icon: FileType, label: 'Markdown' },
  csv: { icon: Table, label: 'CSV' },
  web: { icon: Globe, label: 'Website' },
  api: { icon: Plug, label: 'API' },
};
const formatOf = (s: BusinessSource) => (s.format && FORMAT[s.format]) || (s.kind === 'website' ? FORMAT.web : s.kind === 'file' ? { icon: FileText, label: 'File' } : FORMAT.directory);
const TONE = { success: palette.success, accent: palette.accent, warning: palette.warning, muted: palette.textTertiary };

const SourceRow: React.FC<{ s: BusinessSource; index: number }> = ({ s, index }) => {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const f = formatOf(s);
  const Icon = f.icon;
  const loc = displayLocation(s.kind === 'website' ? 'website' : 'folder', s.target);
  const analysing = s.status === 'analysing';
  const failed = s.status === 'error';
  const count = businessCount(s.overviews?.length ?? 0);
  const ov = s.overview;
  const tone = ov ? TONE[statusTone(ov.status, ov.health)] : palette.textTertiary;
  const color = failed ? palette.listening : palette.accent;

  const refresh = async (retry: boolean) => {
    setBusy(true); setErr(null);
    try {
      // announce: false — this client opens the card itself (the server would broadcast it too).
      const r = await api(`/api/business/sources/${encodeURIComponent(s.id)}/refresh`, { method: 'POST', body: JSON.stringify({ announce: false }) });
      if (!r.ok) throw new Error(await errorOf(r));
      const d = await r.json();
      if (d?.source) upsert(d.source);
      else upsert({ ...s, status: 'analysing', error: undefined });
      watch(s.id, retry);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!confirm(`Remove “${s.name || sourceTitle(s.kind, s.target)}” from your businesses?\n\nJarvis forgets its overview. Nothing in the ${s.kind === 'website' ? 'link' : 'folder or file'} itself changes.`)) return;
    setBusy(true); setErr(null);
    try {
      const r = await api(`/api/business/sources/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error(await errorOf(r));
      useBiz.setState((st) => {
        const pending = { ...st.pending }; delete pending[s.id];
        return { sources: (st.sources || []).filter((x) => x.id !== s.id), pending };
      });
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const open = async () => {
    setErr(null);
    try { await openBusinessDashboard(s.id); } catch (e) { setErr((e as Error).message); }
  };

  const actions = (
    <>
      <IconButton icon={ChartNoAxesColumn} label="Open dashboard" size={32} onClick={open} disabled={s.status !== 'ready'} />
      <IconButton icon={RotateCw} label="Analyse again" size={32} onClick={() => refresh(false)} disabled={busy || analysing} />
      <IconButton icon={X} label="Remove" size={32} onClick={remove} disabled={busy} />
    </>
  );
  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ type: 'spring', damping: 22, stiffness: 220, delay: Math.min(index, 6) * 0.04 }}
      className="rounded-[16px] border px-3 py-3" style={{ background: palette.surfaceRaised, borderColor: failed ? alpha(palette.listening, 70) : palette.stroke }}>
      <div className="flex items-start gap-3">
      <div className="relative grid size-10 shrink-0 place-items-center rounded-[12px]" style={{ background: alpha(color, 30), color }}>
        <Icon size={19} />
        {analysing && <motion.span className="absolute inset-0 rounded-[12px] border-2" style={{ borderColor: alpha(palette.accent, 150) }} animate={{ opacity: [0.2, 1, 0.2] }} transition={{ duration: 1.6, repeat: Infinity }} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="t-body min-w-0 truncate" style={{ color: palette.text }}>{s.name || sourceTitle(s.kind, s.target)}</span>
          {count && <span className="t-caption shrink-0" style={{ color: palette.textTertiary }}>{count}</span>}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 rounded-[6px] px-1.5 py-[1px] text-[10px] font-bold uppercase tracking-[0.08em]" style={{ background: palette.surfaceHigh, color: palette.textTertiary }}>{f.label}</span>
          <span className="min-w-0 truncate font-mono text-[11.5px]" style={{ color: palette.textTertiary }} title={s.target}>{loc}</span>
        </div>
        {(s.headerNames?.length ?? 0) > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {s.headerNames!.map((h) => (
              <span key={h} className="inline-flex items-center gap-1 rounded-full border px-2 py-[1px] text-[11px]" style={{ borderColor: palette.stroke, color: palette.textSecondary }}>
                <Lock size={10} /> {h}
              </span>
            ))}
          </div>
        )}
        <div className="mt-1.5 t-footnote">
          {analysing ? (
            <span className="flex items-center gap-1.5" style={{ color: palette.accent }}>
              <Loader2 size={13} className="animate-spin" /> Analysing…
              <span className="relative h-1 w-16 overflow-hidden rounded-full" style={{ background: alpha(palette.accent, 30) }}>
                <motion.span className="absolute inset-y-0 w-1/2 rounded-full" style={{ background: palette.accent }} initial={{ x: '-100%' }} animate={{ x: '200%' }} transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }} />
              </span>
            </span>
          ) : failed ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1" style={{ color: palette.listening }}>
              <span className="flex items-start gap-1.5"><AlertTriangle size={13} className="mt-[1px] shrink-0" />{s.error || 'Jarvis couldn’t analyse it.'}</span>
              <button type="button" onClick={() => refresh(true)} disabled={busy} className="font-semibold underline-offset-2 hover:underline disabled:opacity-50" style={{ color: palette.text }}>Retry</button>
            </span>
          ) : (
            <span className="flex flex-wrap items-center gap-x-1.5" style={{ color: palette.textTertiary }}>
              {ov?.status && <><span className="inline-block size-1.5 rounded-full" style={{ background: tone }} /><span style={{ color: tone }}>{statusLabel(ov.status)}</span><span>·</span></>}
              <span>{s.analysedAt ? `Analysed ${timeAgo(s.analysedAt)}` : 'Analysed'}</span>
            </span>
          )}
          {err && <span className="mt-1 flex items-start gap-1.5" style={{ color: palette.warning }}><AlertTriangle size={13} className="mt-[1px] shrink-0" />{err}</span>}
        </div>
      </div>
      <div className="hidden shrink-0 items-center gap-1 sm:flex">{actions}</div>
      </div>
      {/* Phones: the actions get their own line so the name and path keep the width. */}
      <div className="mt-2 flex justify-end gap-1 sm:hidden">{actions}</div>
    </motion.div>
  );
};

type Adding = null | 'path' | 'link';

export const BusinessSettings: React.FC<{ open: boolean }> = ({ open }) => {
  const sources = useBiz((s) => s.sources);
  const activeServerUrl = useStore((s) => s.activeServerUrl);
  const [adding, setAdding] = useState<Adding>(null);
  const [value, setValue] = useState('');
  const [headers, setHeaders] = useState<Array<{ name: string; value: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  const d = desktop();
  const mac = d?.platform === 'darwin';

  useEffect(() => { if (open && activeServerUrl) loadSources(true).then(schedule); }, [open, activeServerUrl]);
  // The poller keeps analysing rows fresh while this section is on screen.
  useEffect(() => {
    if (!open) return;
    visible++;
    schedule();
    const t = setInterval(() => tick((x) => x + 1), 30_000); // "Analysed 5 min ago" stays true
    return () => { visible--; clearInterval(t); };
  }, [open]);
  const analysingCount = sources?.filter((s) => s.status === 'analysing').length ?? 0;
  useEffect(() => { if (analysingCount) schedule(); }, [analysingCount]);

  if (!sources) return null;

  const reset = () => { setAdding(null); setValue(''); setHeaders([]); setError(null); };
  const add = async (kind: 'folder' | 'website', target: string, hdrs?: Record<string, string>) => {
    setBusy(true); setError(null);
    try {
      const r = await api('/api/business/sources', { method: 'POST', body: JSON.stringify({ kind, target, announce: false, ...(hdrs && Object.keys(hdrs).length ? { headers: hdrs } : {}) }) });
      if (!r.ok) throw new Error(await errorOf(r));
      const dd = await r.json();
      if (dd?.source?.id) { upsert(dd.source); watch(dd.source.id, true); }
      else await loadSources(false);
      reset();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (kind?: 'file' | 'folder') => {
    if (!d?.pickFolder) return;
    setError(null);
    const p = await d.pickFolder(kind ? { kind } : undefined).catch(() => null);
    if (p) await add('folder', p);
  };
  const addPath = () => {
    if (d?.pickFolder && mac) { setAdding(null); pick(); return; }
    setAdding(adding === 'path' ? null : 'path'); setValue(''); setError(null);
  };
  const submitPath = () => {
    const v = validateLocalPath(value);
    if ('error' in v) setError(v.error); else add('folder', v.path);
  };
  const submitLink = () => {
    const v = normalizeWebsite(value);
    if ('error' in v) { setError(v.error); return; }
    const hdrs: Record<string, string> = {};
    for (const h of headers) {
      const name = h.name.trim();
      if (!name && !h.value.trim()) continue;
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) { setError(`“${name || '(empty)'}” isn’t a valid header name.`); return; }
      hdrs[name] = h.value;
    }
    add('website', v.url, hdrs);
  };
  const onKey = (submit: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); reset(); }
  };

  const busyCount = analysingCount;
  return (
    <div id="settings-businesses" className="scroll-mt-4">
      <Section title="Businesses" aside={<span className="t-footnote" style={{ color: busyCount ? palette.accent : palette.textTertiary }}>{busyCount ? `Analysing ${busyCount}…` : sources.length ? `${sources.length} source${sources.length > 1 ? 's' : ''}` : ''}</span>}>
        <p className="t-footnote" style={{ color: palette.textTertiary }}>
          Jarvis reads a project folder, a file (an HTML dashboard, JSON, PDF, CSV, notes) or a link (your website, an API) and keeps an overview of how your business is doing. Ask “How’s my business?” anytime. Files stay on {d ? 'this computer' : 'the computer running Jarvis'}.
        </p>

        <AnimatePresence initial={false}>
          {sources.length > 0 && (
            <div className="flex flex-col gap-2">
              <AnimatePresence initial={false}>
                {sources.map((s, i) => <SourceRow key={s.id} s={s} index={i} />)}
              </AnimatePresence>
            </div>
          )}
        </AnimatePresence>

        <div className="flex flex-wrap gap-2">
          <Button icon={adding === 'path' ? X : FolderPlus} onClick={addPath} disabled={busy}>{adding === 'path' ? 'Cancel' : 'Add file or folder'}</Button>
          <Button icon={adding === 'link' ? X : Link2} onClick={() => { setAdding(adding === 'link' ? null : 'link'); setValue(''); setHeaders([]); setError(null); }} disabled={busy}>{adding === 'link' ? 'Cancel' : 'Add link'}</Button>
        </div>

        <AnimatePresence initial={false} mode="wait">
          {adding && (
            <motion.div key={adding} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
              <div className="flex flex-col gap-2 pt-0.5">
                {adding === 'path' && d?.pickFolder && (
                  <div className="flex flex-wrap gap-2">
                    <Button icon={Folder} onClick={() => pick('folder')} disabled={busy}>Choose a folder…</Button>
                    <Button icon={FileText} onClick={() => pick('file')} disabled={busy}>Choose a file…</Button>
                  </div>
                )}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    autoFocus
                    type="text"
                    value={value}
                    onChange={(e) => { setValue(e.target.value); setError(null); }}
                    onKeyDown={onKey(adding === 'path' ? submitPath : submitLink)}
                    placeholder={adding === 'path' ? '/Users/you/Projects/my-app  or  …/dashboard/index.html' : 'https://yourcompany.com  ·  an API endpoint  ·  a PDF or JSON link'}
                    spellCheck={false}
                    autoComplete="off"
                    className={`${input} font-mono`}
                    style={error ? { borderColor: alpha(palette.listening, 160) } : undefined}
                  />
                  <Button primary icon={busy ? Loader2 : Plus} onClick={adding === 'path' ? submitPath : submitLink} disabled={busy || !value.trim()}>{busy ? 'Adding…' : 'Add'}</Button>
                </div>
                {adding === 'link' && (
                  <>
                    {headers.map((h, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input type="text" value={h.name} placeholder="Header (e.g. Authorization)" spellCheck={false} autoComplete="off" onKeyDown={onKey(submitLink)}
                          onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${input} sm:max-w-[220px]`} />
                        <input type="password" value={h.value} placeholder="Value" autoComplete="new-password" onKeyDown={onKey(submitLink)}
                          onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} className={input} />
                        <IconButton icon={X} label="Remove header" size={32} onClick={() => setHeaders(headers.filter((_, j) => j !== i))} />
                      </div>
                    ))}
                    {headers.length < MAX_HEADERS && (
                      <button type="button" onClick={() => setHeaders([...headers, { name: headers.length ? '' : 'Authorization', value: '' }])}
                        className="flex w-fit items-center gap-1.5 t-footnote hover:underline" style={{ color: palette.textSecondary }}>
                        <KeyRound size={13} /> {headers.length ? 'Add another header' : 'Add header · for a private API'}
                      </button>
                    )}
                    {headers.length > 0 && <p className="t-footnote" style={{ color: palette.textTertiary }}>Saved on this computer’s Jarvis Server and only sent to this link.</p>}
                  </>
                )}
                {adding === 'path' && !d?.pickFolder && (
                  <p className="t-footnote" style={{ color: palette.textTertiary }}>The full path of a folder or file on the computer running Jarvis Server.</p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {error && (
          <p className="flex items-start gap-1.5 t-footnote" style={{ color: palette.listening }}>
            <AlertTriangle size={14} className="mt-[1px] shrink-0" /><span>{error}</span>
          </p>
        )}
        {!adding && !error && sources.length === 0 && (
          <p className="t-footnote" style={{ color: palette.textSecondary }}>
            Nothing added yet — start with your project’s folder or your website.
          </p>
        )}
      </Section>
    </div>
  );
};
