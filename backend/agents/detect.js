// Which agent CLIs are installed on this Jarvis server, and their models, so the apps show
// only what this server can actually run (GET /api/agents, GET /api/models).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Known agents. `key` is the id the apps and the orchestrator use (the backend routes
 * activeModel 'gemini' to the agy CLI); `driven` = Jarvis can delegate to it.
 */
export const AGENTS = [
  { key: 'gemini', cli: 'agy', name: 'Gemini', vendor: 'Google Antigravity', driven: true },
  { key: 'claude', cli: 'claude', name: 'Claude', vendor: 'Anthropic Claude Code', driven: true },
  { key: 'hermes', cli: 'hermes', name: 'Hermes', vendor: 'Nous Hermes Agent', driven: true },
  { key: 'codex', cli: 'codex', name: 'Codex', vendor: 'OpenAI Codex CLI', driven: true },
  { key: 'openclaw', cli: 'openclaw', name: 'OpenClaw', vendor: 'OpenClaw', driven: false },
  { key: 'gemini-cli', cli: 'gemini', name: 'Gemini CLI', vendor: 'Google Gemini CLI', driven: false },
];

// Claude Code accepts these aliases for the current models of each family.
const CLAUDE_CODE_ALIASES = ['sonnet', 'opus', 'haiku'];
const MAX_MODELS_PER_PROVIDER = 40;

/** `agy models` → ids ("gemini-3.8-flash-high\tGemini 3.8 Flash (High)"). */
export function parseAgyModels(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.split('\t'))
    .filter((cols) => cols.length >= 2 && /^[\w.:/-]+$/.test(cols[0].trim()))
    .map((cols) => cols[0].trim());
}

/** Version string from `<cli> --version` output (first line, trimmed). */
export function parseVersion(stdout) {
  const line = String(stdout || '').split(/\r?\n/).find((l) => l.trim());
  return line ? line.trim().slice(0, 80) : null;
}

/**
 * Hermes: its model picker caches each provider's live /v1/models list; the configured
 * default model comes first. Ids are "provider::model" (the CLI needs both).
 */
export function hermesModelsFromCache(cache, defaults = {}) {
  const out = [];
  if (defaults.model) out.push(defaults.provider ? `${defaults.provider}::${defaults.model}` : defaults.model);
  for (const [provider, entry] of Object.entries(cache || {})) {
    if (provider.includes('#')) continue; // fingerprinted duplicate entries
    const models = Array.isArray(entry?.models) ? entry.models : [];
    for (const m of models.slice(0, MAX_MODELS_PER_PROVIDER)) out.push(`${provider}::${m}`);
  }
  return [...new Set(out)];
}

/** `model:\n  default: X\n  provider: Y` from Hermes's config.yaml (top-level `model` block only). */
export function hermesDefaults(yaml) {
  const m = String(yaml || '').match(/^model:\s*\n((?:[ \t]+.*\n?)*)/m);
  if (!m) return {};
  const pick = (k) => m[1].match(new RegExp(`^[ \\t]+${k}:\\s*['"]?([^'"\\n#]+?)['"]?\\s*$`, 'm'))?.[1]?.trim();
  return { model: pick('default'), provider: pick('provider') };
}

/** `ollama list` → model names. */
export function parseOllamaList(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(/\s+/)[0])
    .filter(Boolean);
}

export function createAgentDetector({ exec, fetchImpl = fetch, env = process.env, home = os.homedir(), ttlMs = 10 * 60_000 } = {}) {
  let cached = null;
  let cachedAt = 0;
  let inflight = null;

  const run = async (cmd, timeout = 15000) => {
    try {
      const { stdout } = await exec(cmd, { timeout, env });
      return stdout;
    } catch {
      return null;
    }
  };

  async function apiModels(url, headers, filter) {
    try {
      const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return [];
      const body = await r.json();
      const list = body.data || body.models || [];
      return list.map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter((id) => id && filter(id));
    } catch {
      return [];
    }
  }

  const modelsFor = {
    gemini: async () => parseAgyModels(await run('agy models', 30000)),
    claude: async () => {
      if (env.ANTHROPIC_API_KEY) {
        const ids = await apiModels('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, (id) => id.startsWith('claude'));
        if (ids.length) return ids;
      }
      return CLAUDE_CODE_ALIASES;
    },
    hermes: async () => {
      const hermesHome = env.HERMES_HOME || path.join(home, '.hermes');
      let cache = {};
      let defaults = {};
      try { cache = JSON.parse(fs.readFileSync(path.join(hermesHome, 'provider_models_cache.json'), 'utf8')); } catch {}
      try { defaults = hermesDefaults(fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8')); } catch {}
      const ollama = parseOllamaList(await run('ollama list', 8000)).map((m) => `ollama::${m}`);
      return [...new Set([...hermesModelsFromCache(cache, defaults), ...ollama])];
    },
    codex: async () => (env.OPENAI_API_KEY
      ? apiModels('https://api.openai.com/v1/models', { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, (id) => /^(gpt-|o\d|codex)/.test(id) && !/(audio|realtime|tts|transcribe|image|search|embedding)/.test(id))
      : []),
    'gemini-cli': async () => (env.GEMINI_API_KEY
      ? apiModels(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${env.GEMINI_API_KEY}`, {}, (id) => id.startsWith('gemini') && !/(embedding|tts|live|native-audio|image|transcribe)/.test(id))
      : []),
    openclaw: async () => [],
  };

  async function detect() {
    const results = await Promise.all(
      AGENTS.map(async (agent) => {
        const version = parseVersion(await run(`${agent.cli} --version`, 10000));
        if (!version) return null;
        const models = await modelsFor[agent.key]().catch(() => []);
        return { id: agent.key, cli: agent.cli, name: agent.name, vendor: agent.vendor, version, driven: agent.driven, models };
      }),
    );
    return { detectedAt: new Date().toISOString(), agents: results.filter(Boolean) };
  }

  return async function detectAgents({ refresh = false } = {}) {
    if (!refresh && cached && Date.now() - cachedAt < ttlMs) return cached;
    inflight ??= detect().finally(() => { inflight = null; });
    cached = await inflight;
    cachedAt = Date.now();
    return cached;
  };
}
