import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { isSecretFile, scanFolder } from './scanFolder.js';
import { formatFromContentType, pdfText, sniffFileFormat, summarizeCsv, summarizeJson } from './formats.js';
import { addressClass, checkHost, extractHtml, fetchLimited, pickSubpages, scanUrl } from './scanWebsite.js';
import { detectLocalFormat, scanSource } from './scan.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

function fakeRepo() {
  const dir = tmp('jarvis-biz-repo-');
  const outside = tmp('jarvis-biz-outside-');
  write(path.join(outside, 'private.md'), 'OUTSIDE_MARKER');
  write(path.join(dir, 'package.json'), JSON.stringify({ name: 'acme-app', version: '0.4.1', description: 'Invoices for freelancers' }));
  write(path.join(dir, 'README.md'), '# Acme\n\n[![badge](x.svg)](y)\n\nAcme sends invoices for freelancers and tracks who paid, with reminders.\n');
  write(path.join(dir, 'docs', 'business', 'plan.md'), '# Plan\nPricing: $9/month. Target: 100 paying users.');
  write(path.join(dir, 'src', 'index.js'), '// TODO: retry\nconsole.log(1) // FIXME later\n');
  write(path.join(dir, 'src', 'util.ts'), 'export const x = 1;\n');
  write(path.join(dir, '.env'), 'GEMINI_API_KEY=SUPERSECRET_ENV');
  write(path.join(dir, 'config.js'), 'window.KEY = "SUPERSECRET_CONFIG"');
  write(path.join(dir, 'deploy.pem'), 'SUPERSECRET_PEM');
  write(path.join(dir, 'node_modules', 'dep', 'README.md'), 'NODE_MODULES_MARKER');
  write(path.join(dir, '.hidden', 'notes.md'), 'DOTDIR_MARKER');
  fs.symlinkSync(outside, path.join(dir, 'linked'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.io', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.io' } });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\nnode_modules\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  write(path.join(dir, 'src', 'more.js'), 'export {}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Add invoices export');
  git('tag', 'v0.4.1');
  return dir;
}

test('scanFolder: manifest, README, docs, languages, TODOs, git — and never secrets, deps, dot-folders or symlinks', async () => {
  const dir = fakeRepo();
  const f = await scanFolder(dir);
  assert.equal(f.name, 'acme-app');
  assert.equal(f.manifest.description, 'Invoices for freelancers');
  assert.equal(f.hasCode, true);
  assert.deepEqual(f.languages.map((l) => l.name).sort(), ['JavaScript', 'TypeScript']);
  assert.equal(f.todoCount, 2);
  assert.ok(f.texts.some((t) => t.label === 'README' && /sends invoices/.test(t.text)));
  assert.ok(f.texts.some((t) => t.label === 'docs/business/plan.md' && /\$9\/month/.test(t.text)));
  const all = JSON.stringify(f);
  for (const marker of ['SUPERSECRET', 'NODE_MODULES_MARKER', 'DOTDIR_MARKER', 'OUTSIDE_MARKER']) assert.ok(!all.includes(marker), marker);
  assert.equal(f.git.commits30, 2);
  assert.equal(f.git.contributors90, 1);
  assert.equal(f.git.latestTag, 'v0.4.1');
  assert.equal(f.git.branch, 'main');
  assert.equal(f.git.lastCommit.subject, 'Add invoices export');
  assert.equal(f.git.commitsPerWeek.length, 12);
  assert.equal(f.git.commitsPerWeek.at(-1).value, 2);
  await assert.rejects(scanFolder(path.join(dir, 'nope')), /not found/i);
  await assert.rejects(scanFolder(path.join(dir, 'README.md')), /Not a folder/);
});

test('secret files are recognised', () => {
  for (const n of ['.env', '.env.production', 'id_rsa', 'id_ed25519.pub', 'server.key', 'cert.p12', 'login.keychain-db', 'aws_credentials.json', 'client_secret.json', 'tokens.json', 'config.js', 'service-account.json']) assert.ok(isSecretFile(n), n);
  for (const n of ['README.md', 'plan.md', 'tokenizer.py', 'index.html', 'app.js']) assert.ok(!isSecretFile(n), n);
});

test('JSON summary: paths, array lengths, first items only, secret keys hidden', () => {
  const s = summarizeJson({ app: 'VTO', stats: { users: 1204, mrr: '$310' }, apiKey: 'sk-123', plans: [{ name: 'Pro', price: 9 }, { name: 'Max', price: 19 }, { n: 3 }, { n: 4 }] });
  assert.match(s, /^app: VTO$/m);
  assert.match(s, /^stats\.users: 1204$/m);
  assert.match(s, /^apiKey: \[hidden\]$/m);
  assert.match(s, /^plans: \[4 items\]$/m);
  assert.match(s, /^plans\[1\]\.price: 19$/m);
  assert.ok(!s.includes('plans[3]'));
  assert.ok(!s.includes('sk-123'));
  assert.ok(summarizeJson({ big: 'x'.repeat(100), list: Array.from({ length: 5000 }, (_, i) => ({ i })) }, { cap: 500, arrayItems: 5000 }).length <= 502);
});

test('CSV summary: columns, row count, first rows, delimiter and quotes', () => {
  const csv = 'month;revenue;"note, with comma"\n2026-08;1200;"a ""b"""\n2026-09;1500;ok\n';
  const s = summarizeCsv(csv, { rows: 1 });
  assert.match(s, /Columns \(3\): month \| revenue \| note, with comma/);
  assert.match(s, /Rows: 2/);
  assert.match(s, /2026-08 \| 1200 \| a "b"/);
  assert.ok(!s.includes('2026-09'));
});

/** A one-page PDF with `text`, offsets computed so any reader accepts it. */
function tinyPdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 18 Tf 20 60 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('PDF text extraction', async () => {
  const { text, pages } = await pdfText(tinyPdf('Revenue grew to 4200 EUR'));
  assert.equal(pages, 1);
  assert.match(text, /Revenue grew to 4200 EUR/);
});

test('local files: format by extension and content, secrets and binaries refused', async () => {
  const dir = tmp('jarvis-biz-files-');
  const files = {
    'a.json': '{"users": 3}', 'b.csv': 'x,y\n1,2', 'c.md': '# Hi\n\nSome text here for the summary paragraph.', 'd.txt': 'plain',
    'e.html': '<html><body><h1>Shop</h1></body></html>', 'noext': '{"k":1}',
  };
  for (const [n, c] of Object.entries(files)) write(path.join(dir, n), c);
  fs.writeFileSync(path.join(dir, 'f.pdf'), tinyPdf('Hello'));
  fs.writeFileSync(path.join(dir, 'g.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  write(path.join(dir, '.env.local'), 'X=1');
  const fmt = (n) => detectLocalFormat(path.join(dir, n));
  assert.deepEqual(await Promise.all(['a.json', 'b.csv', 'c.md', 'd.txt', 'e.html', 'f.pdf', 'noext'].map(fmt)), ['json', 'csv', 'markdown', 'text', 'html', 'pdf', 'json']);
  assert.equal(await detectLocalFormat(dir), 'directory');
  await assert.rejects(fmt('g.bin'), /Unsupported file type/);
  await assert.rejects(fmt('.env.local'), /secrets/);
  await assert.rejects(fmt('missing.txt'), /Not found/);
  assert.equal(sniffFileFormat('x.unknown', Buffer.from('%PDF-1.7')), 'pdf');

  const json = await scanSource({ kind: 'folder', target: path.join(dir, 'a.json') });
  assert.equal(json.format, 'json');
  assert.match(json.texts[0].text, /users: 3/);
  // An HTML file is rendered; when no browser can start, its static HTML is read instead.
  const html = await scanSource({ kind: 'folder', target: path.join(dir, 'e.html') }, { render: async () => { throw new Error('no browser'); } });
  assert.equal(html.format, 'html');
  assert.equal(html.renderError, 'no browser');
  assert.deepEqual(html.site.headings, ['Shop']);
  const rendered = await scanSource({ kind: 'folder', target: path.join(dir, 'e.html') }, { render: async (url) => ({ title: 'Apps Dashboard', headings: ['Overview'], text: `Users\n120\nfrom ${url.slice(0, 7)}`, views: [{ label: 'VTO', text: 'MRR\n$40' }], elapsedMs: 5 }) });
  assert.equal(rendered.name, 'Apps Dashboard');
  assert.match(rendered.texts[0].text, /from file:\/\//);
  assert.equal(rendered.views[0].label, 'VTO');
});

const SAMPLE = `<!doctype html><html><head><title>Acme &amp; Co | Invoices</title>
<meta name="description" content="Invoices in one click">
<meta property="og:site_name" content="Acme">
<meta property="og:image" content="/og.png">
<link rel="icon" href="/fav.svg">
<style>.x{color:red}</style><script>var secret = "SCRIPT_MARKER";</script></head>
<body><nav><a href="/pricing">Pricing</a><a href="https://other.com/about">Other</a></nav>
<h1>Get paid faster</h1><p>Plans from $9/mo or 19 € per month.</p><h2>Teams</h2>
<a href="/about#team">About us</a><a href="/blog/post-1">Blog</a><a href="/login">Login</a>
<footer>FOOTER_MARKER</footer></body></html>`;

test('HTML extraction: meta, icon, headings, text without script/nav/footer, same-origin links, prices', () => {
  const p = extractHtml(SAMPLE, 'https://acme.io/');
  assert.equal(p.title, 'Acme & Co | Invoices');
  assert.equal(p.description, 'Invoices in one click');
  assert.equal(p.siteName, 'Acme');
  assert.equal(p.image, 'https://acme.io/og.png');
  assert.equal(p.favicon, 'https://acme.io/fav.svg');
  assert.deepEqual(p.headings, ['Get paid faster', 'Teams']);
  assert.match(p.text, /Plans from \$9\/mo/);
  for (const m of ['SCRIPT_MARKER', 'FOOTER_MARKER', 'color:red']) assert.ok(!p.text.includes(m), m);
  assert.ok(p.prices.includes('$9/mo'));
  assert.ok(p.links.every((l) => l.url.startsWith('https://acme.io/')));
  assert.deepEqual(pickSubpages(p), ['https://acme.io/pricing', 'https://acme.io/about', 'https://acme.io/blog/post-1']);
});

test('SSRF: loopback, LAN, link-local and metadata refused; LAN only with allowPrivate; link-local never', async () => {
  assert.equal(addressClass('8.8.8.8'), 'public');
  assert.equal(addressClass('127.0.0.1'), 'private');
  assert.equal(addressClass('192.168.1.10'), 'private');
  assert.equal(addressClass('169.254.169.254'), 'blocked');
  assert.equal(addressClass('::1'), 'private');
  assert.equal(addressClass('::ffff:10.0.0.1'), 'private');
  assert.equal(addressClass('fe80::1'), 'blocked');
  const lookup = async (host) => [{ address: host === 'evil.example' ? '10.0.0.5' : '93.184.216.34' }];
  await assert.rejects(checkHost('localhost', { lookup }), /not a public/);
  await assert.rejects(checkHost('127.0.0.1', { lookup }), /not a public/);
  await assert.rejects(checkHost('evil.example', { lookup }), /not a public/);
  await assert.rejects(checkHost('169.254.169.254', { lookup, allowPrivate: true }), /not a public/);
  await checkHost('127.0.0.1', { lookup, allowPrivate: true });
  await checkHost('acme.io', { lookup });
  await assert.rejects(scanUrl('http://127.0.0.1:9/x'), /not a public/);
});

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('links: routed by Content-Type (api, web, pdf, csv), SPA rendered, headers only to the own origin', async () => {
  const seen = [];
  const other = await serve((req, res) => { seen.push({ host: 'other', auth: req.headers.authorization }); res.setHeader('content-type', 'application/json'); res.end('{"moved": true}'); });
  const main = await serve((req, res) => {
    seen.push({ host: 'main', path: req.url, auth: req.headers.authorization });
    if (req.url === '/api') { res.setHeader('content-type', 'application/json; charset=utf-8'); return res.end(JSON.stringify({ users: 42, token: 'tok-SECRET' })); }
    if (req.url === '/untyped') return res.end('[1,2,3]');
    if (req.url === '/report') { res.setHeader('content-type', 'application/pdf'); return res.end(tinyPdf('Quarterly report')); }
    if (req.url === '/data.csv') { res.setHeader('content-type', 'text/csv'); return res.end('a,b\n1,2'); }
    if (req.url === '/spa') { res.setHeader('content-type', 'text/html'); return res.end('<html><head><title>App</title></head><body><div id="root"></div></body></html>'); }
    if (req.url === '/away') { res.writeHead(302, { location: `${other.url}/landing` }); return res.end(); }
    if (req.url === '/denied') { res.writeHead(401); return res.end(); }
    res.setHeader('content-type', 'text/html');
    res.end(SAMPLE.replace(/\/pricing/g, '/pricing'));
  });
  try {
    const opts = { allowPrivate: true, headers: { Authorization: 'Bearer HEADER_SECRET' } };
    const api = await scanUrl(`${main.url}/api`, opts);
    assert.equal(api.format, 'api');
    assert.match(api.texts[0].text, /users: 42/);
    assert.ok(!JSON.stringify(api).includes('tok-SECRET'));
    assert.equal((await scanUrl(`${main.url}/untyped`, opts)).format, 'api');
    assert.match((await scanUrl(`${main.url}/report`, opts)).texts[0].text, /Quarterly report/);
    assert.equal((await scanUrl(`${main.url}/data.csv`, opts)).format, 'csv');
    const spa = await scanUrl(`${main.url}/spa`, { ...opts, render: async () => ({ title: 'App', headings: ['Dashboard'], text: 'Rendered content', views: [] }) });
    assert.equal(spa.rendered, true);
    assert.equal(spa.texts[0].text, 'Rendered content');
    const web = await scanUrl(`${main.url}/`, opts);
    assert.equal(web.format, 'web');
    assert.equal(web.name, 'Acme');
    assert.ok(web.site.pages.length >= 2, 'subpages read');
    await assert.rejects(scanUrl(`${main.url}/denied`, opts), /needs access/);

    seen.length = 0;
    const r = await fetchLimited(`${main.url}/away`, opts);
    assert.equal(r.status, 200);
    assert.deepEqual(seen.map((s) => [s.host, s.auth]), [['main', 'Bearer HEADER_SECRET'], ['other', undefined]], 'the header stays on its own origin');
    assert.ok(seen.every((s) => s.host !== 'main' || s.auth), 'own-origin requests (subpages too) carry it');
    assert.equal(formatFromContentType('application/octet-stream', Buffer.from([0, 1, 2])), null);
  } finally {
    main.server.close();
    other.server.close();
  }
});

test('IPv6 spellings of an IPv4 address are judged as that address', () => {
  assert.equal(addressClass('::ffff:7f00:1'), 'private');
  assert.equal(addressClass('::ffff:a9fe:a9fe'), 'blocked');
  assert.equal(addressClass('64:ff9b::a9fe:a9fe'), 'blocked');
  assert.equal(addressClass('2002:c0a8:101::1'), 'private');
  assert.equal(addressClass('::ffff:808:808'), 'public');
  assert.equal(addressClass('2606:4700::1111'), 'public');
});
