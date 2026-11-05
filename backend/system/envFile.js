// One KEY=value line in a .env file (the app's data folder): set, replace or remove it, leave
// every other line (and comment) as it is. The file holds keys: owner-only permissions.
import fs from 'node:fs';

export function setEnvValue(file, key, value) {
  const v = String(value ?? '').trim();
  if (/[\r\n]/.test(v) || !/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error('invalid value');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').replace(/\n$/, '').split('\n'); } catch { /* new file */ }
  lines = lines.filter((l) => !new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (v) lines.push(`${key}=${v}`);
  try {
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch {
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
  }
}
