import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellArg } from './osUtils.js';

// What cmd.exe + the MSVCRT argv parser do to a line Node builds with `shell: true`:
// the line ends at a newline, and outside double quotes spaces separate arguments while
// & | < > start new commands. Enough to check that a prompt stays one inert argument.
function cmdSplit(line) {
  const firstLine = line.split(/\r?\n/)[0];
  const args = [];
  let cur = '';
  let quoted = false;
  let injected = false;
  for (const ch of firstLine) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && '&|<>'.includes(ch)) injected = true;
    if (!quoted && ch === ' ') { if (cur) args.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) args.push(cur);
  return { args, injected, truncated: firstLine !== line };
}

const hostile = 'System instructions: be brief.\n\nUser: say "hi" & del C:\\important | type secrets > out';

test('unchanged off Windows', () => {
  assert.equal(shellArg(hostile, 'darwin'), hostile);
  assert.equal(shellArg(42, 'win32'), 42);
});

test('without it, cmd.exe splits the prompt and runs what follows & or a newline', () => {
  const r = cmdSplit(['agy', '-p', hostile].join(' '));
  assert.equal(r.args[2], 'System');
  assert.ok(r.injected || r.truncated);
});

test('with it, the prompt is exactly one inert argument', () => {
  const r = cmdSplit(['hermes', 'chat', '-q', shellArg(hostile, 'win32'), '-m', shellArg('model-x', 'win32')].join(' '));
  assert.equal(r.injected, false);
  assert.equal(r.truncated, false);
  assert.equal(r.args.length, 6);
  assert.equal(r.args[3], 'System instructions: be brief.  User: say ”hi” & del C:\\important | type secrets > out');
  assert.equal(r.args[5], 'model-x');
});

test('a % in user text cannot expand an environment variable, and only plain names pass as model names', async () => {
  const { safeCliName } = await import('./osUtils.js');
  assert.equal(shellArg('show %API_KEY% now', 'win32'), '"show ％API_KEY％ now"');
  assert.equal(safeCliName('gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(safeCliName('openrouter::nvidia/nemotron-3:free'), 'openrouter::nvidia/nemotron-3:free');
  for (const bad of ['gemini&calc&', 'x|y', 'a b', '%TEMP%', 'x"y', '', 42]) assert.equal(safeCliName(bad), null, String(bad));
});
