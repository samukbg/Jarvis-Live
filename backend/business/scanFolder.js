// Facts about a folder on the user's computer (a project repo, a folder of business docs) or
// a single file in it, for the business overview. Facts only — the analysis comes later
// (analyse.js) — and bounded: a home folder must not take minutes or megabytes.
//
// Never read: secrets (.env*, keys, certificates, keychains, anything named secret/credential/
// token/password), dependencies and build output, dot-folders, and symlinks (a link could point
// out of the folder, anywhere on the disk). Commands run with execFile and argument arrays,
// never a shell string: the backend also runs on Windows, where a shell splits and injects.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { htmlToText } from './formats.js';
import { expandHome } from './store.js';

export const LIMITS = {
  maxFiles: 5000, // entries looked at
  maxText: 40_000, // characters of README / docs / changelog excerpts in total
  todoBytes: 6_000_000, // source bytes read to count TODO/FIXME
  todoFileBytes: 256_000, // bigger source files are not read for TODOs
  readmeChars: 8_000,
  docChars: 3_000,
  changelogChars: 2_500,
};

const SKIP_DIRS = new Set([
  'node_modules', 'bower_components', 'vendor', 'pods', 'build', 'dist', 'out', 'target', 'coverage',
  '__pycache__', 'venv', 'env', 'site-packages', 'deriveddata', 'tmp', 'temp', 'logs', 'jspm_packages',
]);

/** Files never opened, whatever the reason to look at them. */
export function isSecretFile(name) {
  const n = String(name || '').toLowerCase();
  return (
    n.startsWith('.env') || n.startsWith('.') // dotfiles: .env, .npmrc, .netrc, .pgpass…
    || /\.(pem|key|p12|pfx|p8|jks|keystore|keychain|keychain-db|mobileprovision|provisionprofile|kdbx|gpg|asc|ovpn)$/.test(n)
    || /^id_(rsa|dsa|ecdsa|ed25519)/.test(n)
    || /secret|credential|password|passwd|private[-_]?key|service[-_]?account/.test(n)
    || /(^|[._-])(tokens?|apikeys?|api[-_]keys?)([._-]|$)/.test(n)
    || /^config\.(js|mjs|cjs|ts|json)$/.test(n) // app configs carry API keys (e.g. a dashboard's admin key)
  );
}

const LANGUAGES = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust',
  '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin', '.swift': 'Swift', '.m': 'Objective-C', '.mm': 'Objective-C',
  '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.hpp': 'C++', '.cs': 'C#', '.php': 'PHP',
  '.dart': 'Dart', '.scala': 'Scala', '.ex': 'Elixir', '.exs': 'Elixir', '.lua': 'Lua', '.sh': 'Shell',
  '.vue': 'Vue', '.svelte': 'Svelte', '.html': 'HTML', '.css': 'CSS', '.scss': 'CSS', '.sql': 'SQL',
};
const CODE_LANGUAGES = new Set(Object.values(LANGUAGES).filter((l) => !['HTML', 'CSS', 'SQL', 'Shell'].includes(l)));
const DOC_EXT = /\.(md|markdown|mdx|txt|rst)$/i;

function run(cmd, args, timeout = 10_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

/** Markdown → readable text: no badges, images, HTML tags or link targets. */
export function plainText(md) {
  return String(md || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The first real paragraph of a README (not the title, badges or a table of contents). */
export function firstParagraph(text) {
  for (const block of String(text || '').split(/\n\s*\n/)) {
    const b = block.trim();
    if (!b || /^#/.test(b) || /^[-*|>]/.test(b) || b.length < 30) continue;
    return b.replace(/\s+/g, ' ');
  }
  return '';
}

async function readText(file, maxChars) {
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(maxChars * 2);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8').slice(0, maxChars);
  } finally {
    await handle.close();
  }
}

async function manifestOf(dir, names) {
  const has = (n) => names.includes(n);
  try {
    if (has('package.json')) {
      const p = JSON.parse(await readText(path.join(dir, 'package.json'), 200_000));
      return { type: 'npm', name: p.name, version: p.version, description: p.description };
    }
    if (has('pyproject.toml')) {
      const t = await readText(path.join(dir, 'pyproject.toml'), 50_000);
      const pick = (k) => t.match(new RegExp(`^${k}\\s*=\\s*["']([^"'\\n]+)["']`, 'm'))?.[1];
      return { type: 'python', name: pick('name'), version: pick('version'), description: pick('description') };
    }
    if (has('Cargo.toml')) {
      const t = await readText(path.join(dir, 'Cargo.toml'), 50_000);
      const pick = (k) => t.match(new RegExp(`^${k}\\s*=\\s*"([^"\\n]+)"`, 'm'))?.[1];
      return { type: 'cargo', name: pick('name'), version: pick('version'), description: pick('description') };
    }
  } catch {
    // An unreadable manifest just means no manifest facts.
  }
  return null;
}

/** git facts for `dir` (only its own history when it is a subfolder of a repo); null without git. */
export async function gitFacts(dir, { now = Date.now() } = {}) {
  const git = (...args) => run('git', ['-C', dir, ...args]);
  if ((await git('rev-parse', '--is-inside-work-tree'))?.trim() !== 'true') return null;
  const [times, authors, last, tag, branch] = await Promise.all([
    git('log', '--since=12.weeks', '--format=%ct', '--', '.'),
    git('log', '--since=90.days', '--format=%aE', '--', '.'),
    git('log', '-1', '--format=%ct%x1f%s', '--', '.'),
    git('describe', '--tags', '--abbrev=0'),
    git('rev-parse', '--abbrev-ref', 'HEAD'),
  ]);
  const stamps = String(times || '').split(/\s+/).filter(Boolean).map((s) => Number(s) * 1000);
  const WEEK = 7 * 86_400_000;
  const DAY = 86_400_000;
  // Oldest week first: the activity sparkline reads left to right.
  const commitsPerWeek = Array.from({ length: 12 }, (_, i) => {
    const end = now - (11 - i) * WEEK;
    return { t: end - WEEK, value: stamps.filter((s) => s > end - WEEK && s <= end).length };
  });
  const [lastTs, subject] = String(last || '').trim().split('\x1f');
  return {
    commitsPerWeek,
    commits30: stamps.filter((s) => s > now - 30 * DAY).length,
    commitsPrev30: stamps.filter((s) => s <= now - 30 * DAY && s > now - 60 * DAY).length,
    contributors90: new Set(String(authors || '').split(/\s+/).filter(Boolean).map((a) => a.toLowerCase())).size,
    lastCommit: lastTs ? { date: new Date(Number(lastTs) * 1000).toISOString(), subject: (subject || '').slice(0, 120) } : null,
    latestTag: tag?.trim() || null,
    branch: branch?.trim() || null,
  };
}

/**
 * Walks `dir` breadth first (shallow files first: README, docs/), skipping what must not or
 * need not be read. Returns the files it saw (relative paths, sizes).
 */
async function walk(dir, maxFiles) {
  const files = [];
  const queue = [''];
  let seen = 0;
  while (queue.length && seen < maxFiles) {
    const rel = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (++seen > maxFiles) break;
      if (e.isSymbolicLink()) continue; // could lead out of the folder
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
        queue.push(childRel);
      } else if (e.isFile() && !isSecretFile(e.name)) {
        files.push(childRel);
      }
    }
  }
  return { files, truncated: seen > maxFiles };
}

/** Facts about a folder. Throws when it is not an existing directory. */
export async function scanFolder(input, { limits = LIMITS, now = Date.now() } = {}) {
  const dir = path.resolve(expandHome(input));
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat) throw new Error(`Folder not found: ${dir}`);
  if (!stat.isDirectory()) throw new Error(`Not a folder: ${dir}`);

  const { files, truncated } = await walk(dir, limits.maxFiles);
  const top = files.filter((f) => !f.includes(path.sep));
  const manifest = await manifestOf(dir, top);

  // Languages by file extension.
  const langCount = new Map();
  for (const f of files) {
    const lang = LANGUAGES[path.extname(f).toLowerCase()];
    if (lang) langCount.set(lang, (langCount.get(lang) || 0) + 1);
  }
  const languages = [...langCount].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => ({ name, files: n }));
  const hasCode = [...langCount.keys()].some((l) => CODE_LANGUAGES.has(l));

  // Text: README, then CHANGELOG head, then docs (docs/ first, shallow first), within budget.
  const texts = [];
  let budget = limits.maxText;
  const take = async (rel, label, max) => {
    if (budget <= 200) return;
    try {
      const html = /\.html?$/i.test(rel);
      // HTML docs carry markup and inline CSS: read more of them to get as much text.
      const raw = await readText(path.join(dir, rel), Math.min(max, budget) * (html ? 12 : 2));
      const text = (html ? htmlToText(raw) : plainText(raw)).slice(0, Math.min(max, budget));
      if (text) { texts.push({ label, text }); budget -= text.length; }
    } catch {
      // unreadable: skip
    }
  };
  const readme = top.find((f) => /^readme(\.(md|markdown|txt|rst))?$/i.test(f));
  if (readme) await take(readme, 'README', limits.readmeChars);
  const changelog = top.find((f) => /^(changelog|changes|history)(\.(md|markdown|txt))?$/i.test(f));
  if (changelog) await take(changelog, 'CHANGELOG (latest entries)', limits.changelogChars);
  const depth = (f) => f.split(path.sep).length;
  const docs = files
    // Markdown anywhere (shallow); plain text and HTML only under docs/ (elsewhere: pid files,
    // dumps, the app's own pages).
    .filter((f) => (DOC_EXT.test(f) || /^docs[\\/].*\.html?$/i.test(f)) && f !== readme && f !== changelog && depth(f) <= 4)
    .filter((f) => !/\.(txt|html?)$/i.test(f) || /^docs[\\/]/i.test(f))
    .filter((f) => !/(^|[\\/])(license|licence|code_of_conduct|contributing|security|patents|third[-_]party|notice)/i.test(f))
    .sort((a, b) => {
      const da = /^docs[\\/]/i.test(a) ? 0 : 1;
      const db = /^docs[\\/]/i.test(b) ? 0 : 1;
      return da - db || depth(a) - depth(b) || a.localeCompare(b);
    });
  for (const f of docs.slice(0, 40)) await take(f, f.split(path.sep).join('/'), limits.docChars);

  // TODO / FIXME markers in source files (bounded by bytes read).
  let todoCount = 0;
  let todoBytes = 0;
  for (const f of files) {
    if (!LANGUAGES[path.extname(f).toLowerCase()] || todoBytes > limits.todoBytes) continue;
    try {
      const full = path.join(dir, f);
      const { size } = await fs.stat(full);
      if (size > limits.todoFileBytes) continue;
      todoBytes += size;
      todoCount += ((await fs.readFile(full, 'utf8')).match(/\b(TODO|FIXME)\b/g) || []).length;
    } catch {
      // skip
    }
  }

  return {
    source: 'folder',
    location: dir,
    name: manifest?.name || path.basename(dir),
    hasCode,
    manifest,
    languages,
    fileCount: files.length,
    filesTruncated: truncated,
    todoCount,
    texts,
    git: await gitFacts(dir, { now }),
  };
}

/** Facts from one text document (.md / .txt). The secret blocklist applies to files too. */
export async function scanTextFile(file, { limits = LIMITS } = {}) {
  if (isSecretFile(path.basename(file))) throw new Error('This file looks like it holds secrets; Jarvis does not read it');
  const text = plainText(await readText(file, limits.maxText * 2)).slice(0, limits.maxText);
  return {
    source: 'file',
    location: file,
    name: path.basename(file).replace(/\.[^.]+$/, ''),
    hasCode: false,
    texts: text ? [{ label: path.basename(file), text }] : [],
  };
}
