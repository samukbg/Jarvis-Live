// One entry point for every source: a local path (a folder, or a file of any supported
// format) or a link. Returns the facts the analysis works from (analyse.js), with the
// detected `format` (formats.js FORMATS).
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pdfText, sniffFileFormat, summarizeCsv, summarizeJson, TEXT_CAP } from './formats.js';
import { renderPage } from './render.js';
import { isSecretFile, plainText, scanFolder } from './scanFolder.js';
import { extractHtml, scanUrl } from './scanWebsite.js';
import { expandHome } from './store.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;

async function head(file, bytes = 4096) {
  const h = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await h.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await h.close();
  }
}

/**
 * The format of a local path ('directory', 'html', 'json', 'pdf', 'csv', 'markdown', 'text'),
 * checked when the source is added. Throws (with `status` 400) when it can't be used.
 */
export async function detectLocalFormat(target) {
  const p = path.resolve(expandHome(target));
  const st = await fs.stat(p).catch(() => null);
  const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (!st) throw fail(`Not found on this computer: ${p}`);
  if (st.isDirectory()) return 'directory';
  if (!st.isFile()) throw fail('Not a file or folder');
  if (isSecretFile(path.basename(p))) throw fail('This file looks like it holds secrets; Jarvis does not read it');
  if (st.size > MAX_FILE_BYTES) throw fail('File too large (over 20 MB)');
  const format = sniffFileFormat(p, await head(p));
  if (!format) throw fail('Unsupported file type');
  return format;
}

/** Facts from one local file of a known format. */
async function scanLocalFile(file, format, { render }) {
  const name = path.basename(file).replace(/\.[^.]+$/, '');
  const facts = { source: 'file', format, location: file, name, hasCode: false, texts: [] };
  if (format === 'html') {
    // A dashboard's index.html is often an empty shell its scripts fill: render it.
    try {
      const r = await render(pathToFileURL(file).toString());
      facts.rendered = true;
      facts.renderMs = r.elapsedMs;
      if (r.title) facts.name = r.title;
      facts.site = { title: r.title, headings: r.headings, logos: r.logos };
      facts.texts.push({ label: 'Page (rendered)', text: r.text });
      facts.views = r.views;
      return facts;
    } catch (e) {
      facts.renderError = e.message.split('\n')[0];
      const page = extractHtml(await fs.readFile(file, 'utf8'), pathToFileURL(file).toString());
      if (page.title) facts.name = page.title;
      facts.site = { title: page.title, description: page.description, headings: page.headings, prices: page.prices, logos: page.logos };
      facts.texts.push({ label: 'Page', text: page.text });
      return facts;
    }
  }
  if (format === 'pdf') {
    const { text, pages } = await pdfText(await fs.readFile(file));
    facts.pages = pages;
    facts.texts.push({ label: `PDF (${pages} pages)`, text });
    return facts;
  }
  const raw = (await fs.readFile(file)).toString('utf8');
  if (format === 'json') {
    let json;
    try { json = JSON.parse(raw); } catch { throw new Error('The file is not valid JSON'); }
    facts.texts.push({ label: path.basename(file), text: summarizeJson(json) });
  } else if (format === 'csv') {
    facts.texts.push({ label: path.basename(file), text: summarizeCsv(raw) });
  } else {
    facts.texts.push({ label: path.basename(file), text: plainText(raw).slice(0, TEXT_CAP) });
  }
  return facts;
}

/**
 * Facts for a stored source ({ kind, target, headers?, allowPrivate? }). `render` is the
 * headless renderer (injectable for tests).
 */
export async function scanSource(source, { render = renderPage, fetchImpl, lookup } = {}) {
  if (source.kind === 'website') {
    return scanUrl(source.target, { headers: source.headers || {}, allowPrivate: !!source.allowPrivate, render, fetchImpl, lookup });
  }
  const format = await detectLocalFormat(source.target);
  const p = path.resolve(expandHome(source.target));
  if (format === 'directory') return { ...(await scanFolder(p)), format };
  return scanLocalFile(p, format, { render });
}
