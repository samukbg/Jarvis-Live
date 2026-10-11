// Settings → Businesses, behind the routes and the voice tool: add / refresh / remove sources,
// analyse them in the background (one at a time: a headless render or an agent CLI is heavy),
// and show the dashboard card.
//
// When an analysis finishes, the apps hear it twice: `business_sources` (the list, for
// Settings) and — unless the client asked otherwise — the dashboard card as an agent_result,
// tagged with the device that added the source (`origin`, shared/clientOrigin.js) so the
// desktop app leaves a phone's card to the phone.
import { analyse as analyseFacts, scrub } from './analyse.js';
import { dashboardData, dashboardText, spokenOverview } from './card.js';
import { detectLocalFormat, scanSource } from './scan.js';
import { checkHost } from './scanWebsite.js';
import { attachLogos, logoFile } from './logos.js';
import { createBusinessStore, normalizeTarget, publicView, SOURCE_KINDS, validateHeaders } from './store.js';

const KIND_ALIASES = { folder: 'folder', file: 'folder', path: 'folder', website: 'website', link: 'website', url: 'website', api: 'website' };
export const ORIGINS = ['iphone', 'android', 'watch', 'web'];
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

export function createBusinessService({
  dataDir,
  broadcast = () => {},
  log = () => {},
  env = process.env,
  scan = scanSource,
  analyse = analyseFacts,
  lookup,
} = {}) {
  const store = createBusinessStore({ dataDir });
  const queued = new Set();
  let chain = Promise.resolve();

  const sources = () => store.list().map(publicView);
  const announceSources = () => broadcast({ type: 'business_sources', sources: sources() });
  const pending = () => store.list().filter((s) => s.status === 'analysing').length;

  /** The dashboard card as an agent_result, for the device `origin` (undefined: the request's own, if any). */
  function showCard({ focus, origin } = {}) {
    const data = dashboardData(store.list(), { focus });
    const text = dashboardText(data);
    broadcast({ type: 'agent_result', agentId: 'jarvis', agentName: 'Jarvis', result: text, isDelegated: true, ...(origin ? { origin } : {}) });
    return { data, text, spoken: spokenOverview(data, { pending: pending() }) };
  }

  async function run(id, { origin, announce }) {
    const source = store.get(id);
    if (!source) return; // removed while queued
    const started = Date.now();
    try {
      const facts = await scan(source, { lookup });
      const { overview, overviews, analyser } = await analyse(facts, { id, env, log });
      // Each business's own icon from its website, cached here (logos.js).
      await attachLogos([overview, ...(overviews || [])], { dataDir, lookup, log });
      const current = store.get(id);
      if (!current) return;
      store.update(id, {
        // A name taken from the file / host ("index") gives way to the one analysed ("Apps Dashboard").
        ...(current.nameAuto && overview?.name ? { name: overview.name.slice(0, 80) } : {}),
        status: 'ready',
        format: facts.format,
        analysedAt: new Date().toISOString(),
        analyser,
        overview,
        overviews: overviews?.length ? overviews : null,
        error: null,
      });
      log(`[BUSINESS] ${store.get(id)?.name || source.name}: analysed (${facts.format}, ${analyser}, ${overviews?.length || 1} business(es), ${Date.now() - started} ms)`);
      announceSources();
      if (announce) showCard({ focus: id, origin });
    } catch (e) {
      if (!store.get(id)) return;
      // The message may quote the target, never a header (they are not in error texts).
      store.update(id, { status: 'error', error: scrub(e.message).slice(0, 300), analysedAt: new Date().toISOString() });
      log(`[BUSINESS] ${source.name}: analysis failed: ${e.message}`);
      announceSources();
    }
  }

  function enqueue(id, opts = {}) {
    if (queued.has(id)) return;
    queued.add(id);
    const job = chain.then(() => run(id, opts)).finally(() => queued.delete(id));
    chain = job.catch(() => {});
    return job;
  }

  // Analyses cut short by a restart start again (quietly: nobody is waiting for the card).
  for (const s of store.list()) if (s.status === 'analysing') enqueue(s.id, { announce: false });

  return {
    store,
    sources,

    /** Validates and adds a source; its analysis starts in the background. Errors carry `status`. */
    async add({ kind: rawKind, target, name, headers, origin, announce = true, allowPrivate = false }) {
      const kind = KIND_ALIASES[String(rawKind || '').toLowerCase()];
      if (!SOURCE_KINDS.includes(kind)) throw bad("kind must be 'folder' or 'website'");
      let normalized;
      try { normalized = normalizeTarget(kind, target); } catch (e) { throw bad(e.message); }
      let format;
      let cleanHeaders;
      if (kind === 'folder') {
        if (headers && Object.keys(headers).length) throw bad('headers are for links only');
        format = await detectLocalFormat(normalized);
      } else {
        try { cleanHeaders = validateHeaders(headers); } catch (e) { throw bad(e.message); }
        try { await checkHost(new URL(normalized).hostname, { allowPrivate, lookup }); } catch (e) { throw bad(e.message); }
      }
      const source = store.add({ kind, target: normalized, name, format, headers: cleanHeaders, allowPrivate: kind === 'website' && allowPrivate });
      announceSources();
      enqueue(source.id, { origin: ORIGINS.includes(origin) ? origin : undefined, announce: announce !== false });
      return publicView(source);
    },

    refresh(id, { origin, announce = true } = {}) {
      if (!store.get(id)) return null;
      const source = store.update(id, { status: 'analysing', error: null });
      announceSources();
      enqueue(id, { origin: ORIGINS.includes(origin) ? origin : undefined, announce: announce !== false });
      return publicView(source);
    },

    remove(id) {
      const ok = store.remove(id);
      if (ok) announceSources();
      return ok;
    },

    dashboard({ focus } = {}) {
      const data = dashboardData(store.list(), { focus });
      return { card: { type: 'business_dashboard', data }, text: dashboardText(data) };
    },

    /** Opens the card on the apps; `spoken` is what the voice model tells the user. */
    show: showCard,

    /** A business logo cached by an analysis: { file, type } or null. */
    logo: (host) => logoFile(dataDir, host),

    /** Resolves when the queued analyses are done (tests). */
    idle: () => chain,
  };
}
