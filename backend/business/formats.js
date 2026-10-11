// Business sources come in many shapes (a JSON export or API answer, a CSV, a PDF report, a
// Markdown note…): each becomes readable text for the analysis. Pure functions over the
// content; reading files and fetching URLs is the callers' job (scanFile.js, scanWebsite.js).
import path from 'node:path';

export const TEXT_CAP = 25_000;
export const PDF_LIMITS = { maxPages: 30, maxChars: 40_000 };

/** Keys whose values are never passed on (an API answer may echo a token back). */
const SECRET_KEY = /pass(word|wd)?|secret|token|api[-_]?key|apikey|authorization|cookie|session|private|credential|signature/i;

/** Formats a source can have (stored on the source as `format`). */
export const FORMATS = ['directory', 'html', 'json', 'pdf', 'text', 'markdown', 'csv', 'web', 'api'];

/** The format of a local file from its extension, else from its first bytes; null = unsupported. */
export function sniffFileFormat(file, head = Buffer.alloc(0)) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' || ext === '.htm' || ext === '.xhtml') return 'html';
  if (ext === '.json' || ext === '.geojson') return 'json';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.csv' || ext === '.tsv') return 'csv';
  if (ext === '.md' || ext === '.markdown' || ext === '.mdx') return 'markdown';
  if (ext === '.txt' || ext === '.text' || ext === '.log' || ext === '.rst') return 'text';
  return sniffContent(head);
}

/** The format of content with no useful name or type: PDF magic, JSON, HTML, plain text, or null (binary). */
export function sniffContent(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''));
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  const start = b.subarray(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart();
  if (!start) return null;
  if (/^[{[]/.test(start)) return 'json';
  if (/^<(!doctype html|html|head|body)\b/i.test(start)) return 'html';
  // Binary: NUL bytes or many control characters.
  const sample = b.subarray(0, 4096);
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return null;
    if (byte < 9 || (byte > 13 && byte < 32)) control++;
  }
  return control / Math.max(1, sample.length) > 0.05 ? null : 'text';
}

/** A URL answer's format from its Content-Type (and the body when the type says little). */
export function formatFromContentType(contentType, body) {
  const ct = String(contentType || '').toLowerCase();
  if (/application\/(.+\+)?json|text\/json/.test(ct)) return 'api';
  if (/text\/html|application\/xhtml/.test(ct)) return 'web';
  if (ct.includes('application/pdf')) return 'pdf';
  if (ct.includes('text/csv') || ct.includes('text/tab-separated')) return 'csv';
  if (ct.includes('text/markdown')) return 'markdown';
  const sniffed = sniffContent(body);
  if (sniffed === 'json') {
    try { JSON.parse(Buffer.from(body).toString('utf8')); return 'api'; } catch { /* not JSON after all */ }
  }
  if (sniffed === 'html') return 'web';
  if (sniffed === 'pdf') return 'pdf';
  if (ct.startsWith('text/') || sniffed === 'text') return 'text';
  return null;
}

const short = (v, n = 160) => {
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/**
 * JSON → "path: value" lines, so a model sees its structure and numbers: arrays show their
 * length and their first items only; secret-looking keys are masked. Capped at `cap` chars.
 */
export function summarizeJson(value, { cap = TEXT_CAP, arrayItems = 3, maxDepth = 8 } = {}) {
  const lines = [];
  let size = 0;
  const push = (line) => {
    if (size > cap) return false;
    lines.push(line);
    size += line.length + 1;
    return true;
  };
  const walk = (v, p, depth) => {
    if (size > cap) return;
    if (v === null || typeof v !== 'object') {
      push(`${p || '(value)'}: ${typeof v === 'string' ? short(v) : String(v)}`);
      return;
    }
    if (depth >= maxDepth) { push(`${p}: {…}`); return; }
    if (Array.isArray(v)) {
      push(`${p || '(root)'}: [${v.length} item${v.length === 1 ? '' : 's'}]`);
      v.slice(0, arrayItems).forEach((item, i) => walk(item, `${p}[${i}]`, depth + 1));
      return;
    }
    const keys = Object.keys(v);
    if (!keys.length) { push(`${p || '(root)'}: {}`); return; }
    for (const k of keys) {
      const child = p ? `${p}.${k}` : k;
      if (SECRET_KEY.test(k) && (v[k] === null || typeof v[k] !== 'object')) push(`${child}: [hidden]`);
      else walk(v[k], child, depth + 1);
    }
  };
  walk(value, '', 0);
  const text = lines.join('\n');
  return text.length > cap ? `${text.slice(0, cap)}\n…` : text;
}

/** Readable text of an HTML document (a doc saved as HTML): no scripts, styles or tags. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** One CSV line → fields (quotes, doubled quotes, the given delimiter). */
function csvFields(line, delim) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/** CSV → its columns, row count and first rows (pipe-separated), capped. */
export function summarizeCsv(text, { rows = 50, cap = TEXT_CAP } = {}) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return '';
  const first = lines[0];
  const delim = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const header = csvFields(first, delim);
  const masked = header.map((h) => SECRET_KEY.test(h));
  const row = (l) => csvFields(l, delim).map((f, i) => (masked[i] ? '[hidden]' : short(f, 60))).join(' | ');
  const out = [`Columns (${header.length}): ${header.join(' | ')}`, `Rows: ${lines.length - 1}`, ''];
  for (const l of lines.slice(1, rows + 1)) out.push(row(l));
  const s = out.join('\n');
  return s.length > cap ? `${s.slice(0, cap)}\n…` : s;
}

/** Text of a PDF (first pages only), with unpdf (pure JS, bundled with the desktop app). */
export async function pdfText(data, { limits = PDF_LIMITS } = {}) {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    const pages = Math.min(pdf.numPages, limits.maxPages);
    let text = '';
    for (let i = 1; i <= pages && text.length < limits.maxChars; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += `${content.items.map((it) => it.str || '').join(' ').replace(/\s+/g, ' ').trim()}\n\n`;
    }
    return { text: text.trim().slice(0, limits.maxChars), pages: pdf.numPages };
  } finally {
    await pdf.destroy?.();
  }
}
