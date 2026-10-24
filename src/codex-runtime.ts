import { access, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Config } from './config';

export function codexEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'USERPROFILE',
    'HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'CODEX_HOME',
    'PATHEXT',
    'COMSPEC',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
  ])
    if (source[key]) env[key] = source[key];
  return env;
}
// The desktop updater replaces versioned bin folders. Resolve again for each new process.
export async function resolveCodexBinary(
  c: Pick<Config, 'CODEX_PATH'>,
  installRoot = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
    : '',
) {
  const configured = c.CODEX_PATH;
  if (!isAbsolute(configured) && !/[\\/]/.test(configured)) return configured;
  try {
    await access(configured);
    return configured;
  } catch {}
  if (installRoot) {
    const candidates: { path: string; modified: number }[] = [];
    for (const entry of await readdir(installRoot, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const path = join(installRoot, entry.name, 'codex.exe');
      try {
        const info = await stat(path);
        if (info.isFile()) candidates.push({ path, modified: info.mtimeMs });
      } catch {}
    }
    candidates.sort((a, b) => b.modified - a.modified);
    if (candidates[0]) return candidates[0].path;
  }
  throw new Error('Codex executable unavailable; check CODEX_PATH or install Codex');
}
