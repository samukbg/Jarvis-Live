import os from 'os';
import path from 'path';

export function getCrossPlatformEnv() {
  const isWin = process.platform === 'win32';
  const delimiter = path.delimiter;
  
  const home = os.homedir();
  const customPaths = isWin 
    ? [
        path.join(home, 'AppData', 'Roaming', 'npm'),
        path.join(home, '.local', 'bin')
      ]
    : [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        path.join(home, '.local', 'bin'),
        path.join(home, '.npm-global', 'bin')
      ];
      
  const env = { ...process.env };
  
  // Find the exact key for PATH (e.g., 'Path' or 'PATH') to avoid shadowing issues on Windows
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  
  env[pathKey] = [env[pathKey] || '', ...customPaths].filter(Boolean).join(delimiter);
  
  return env;
}

export function getCrossPlatformCommand(cmd, isNpm = true) {
  // We no longer append .cmd because we now use `shell: true` on Windows,
  // which lets cmd.exe automatically resolve .cmd, .bat, or .exe correctly!
  return cmd;
}

export function getSpawnOptions(baseOptions = {}) {
  return {
    ...baseOptions,
    env: baseOptions.env || getCrossPlatformEnv(),
    shell: process.platform === 'win32'
  };
}

export function escapeArg(arg) {
  if (process.platform === 'win32' && typeof arg === 'string' && arg.includes(' ')) {
    return `"${arg}"`;
  }
  return arg;
}

/**
 * A value that is safe to pass as ONE argument through `shell: true` (cmd.exe) on Windows.
 * Node joins shell arguments with plain spaces, so "System instructions: ..." became the
 * argument "System" plus stray words — and a newline or `&` in user text would start a
 * second command. cmd.exe has no escape for a quote inside quotes, so `"` becomes `”`;
 * newlines end a cmd.exe command line, so they become spaces. Elsewhere: unchanged.
 */
export function shellArg(arg, platform = process.platform) {
  if (platform !== 'win32' || typeof arg !== 'string') return arg;
  return `"${arg.replace(/\r?\n/g, ' ').replace(/"/g, '\u201d')}"`;
}

/** Where agent CLIs run: JARVIS_AGENT_CWD, else the user's home folder. */
export function agentWorkdir() {
  return process.env.JARVIS_AGENT_CWD || os.homedir();
}

export function agentSpawnOptions(baseOptions = {}) {
  return getSpawnOptions({ cwd: agentWorkdir(), ...baseOptions });
}
