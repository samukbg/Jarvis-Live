// The WSL distro that runs the AVTR-1 renderer on this machine. JARVIS_WSL_DISTRO wins
// (boot.bat sets it); otherwise the first common distro name that has /root/avtr-1. Mirrors live_avatar/src/avaturn_live_streamer/wsl_distro.py.
import fs from 'node:fs';
import path from 'node:path';

export const CANDIDATES = ['Ubuntu', 'Ubuntu-24.04', 'Ubuntu-22.04', 'Debian'];

let cached = null;

export function wslDistro({ env = process.env, exists = fs.existsSync } = {}) {
  if (cached && env === process.env) return cached;
  let name = String(env.JARVIS_WSL_DISTRO || '').trim();
  if (!name) {
    name = CANDIDATES.find((d) => wslRoots(d).some((root) => {
      try { return exists(path.win32.join(root, 'root', 'avtr-1')); } catch { return false; }
    })) || CANDIDATES[0];
  }
  if (env === process.env) cached = name;
  return name;
}

/** UNC roots of a distro's filesystem, as seen from Windows. */
export function wslRoots(name = wslDistro()) {
  return [`\\\\wsl.localhost\\${name}`, `\\\\wsl$\\${name}`];
}
