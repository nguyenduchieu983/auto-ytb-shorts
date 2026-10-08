import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import IORedis from 'ioredis';
async function main() {
  if (process.platform !== 'win32')
    throw new Error('This helper uses Windows WSL; Linux can run Redis directly');
  const distro = process.env.REDIS_WSL_DISTRO || 'Ubuntu-22.04',
    port = 6380;
  const wsl = (args: string[]) =>
    execFileSync('wsl.exe', ['-d', distro, '--', ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    }).trim();
  const ip = wsl(['hostname', '-I'])
    .split(/\s+/)
    .find((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v));
  if (!ip) throw new Error('Could not determine WSL IPv4 address');
  const old = process.env.REDIS_URL ? new URL(process.env.REDIS_URL) : null;
  const password =
    old?.port === String(port) && old.password
      ? decodeURIComponent(old.password)
      : randomBytes(32).toString('hex');
  const url = `redis://:${encodeURIComponent(password)}@${ip}:${port}`;
  async function ping() {
    const r = new IORedis(url, {
      lazyConnect: true,
      connectTimeout: 3000,
      retryStrategy: () => null,
      maxRetriesPerRequest: 1,
    });
    r.on('error', () => {});
    try {
      await r.connect();
      return (await r.ping()) === 'PONG';
    } catch {
      return false;
    } finally {
      r.disconnect();
    }
  }
  if (!(await ping())) {
    // Use a separate project instance. Existing WSL Redis at port 6379 is untouched.
    const dir = resolve('storage/redis');
    await mkdir(dir, { recursive: true });
    const linuxDir = wsl(['wslpath', '-u', dir.replace(/\\/g, '/')]);
    const quoted = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    const config =
      [
        `bind 127.0.0.1 ${ip}`,
        `port ${port}`,
        'protected-mode yes',
        `requirepass ${quoted(password)}`,
        'daemonize yes',
        'appendonly yes',
        'maxmemory-policy noeviction',
        `dir ${quoted(linuxDir)}`,
        `pidfile ${quoted(linuxDir + '/redis.pid')}`,
        `logfile ${quoted(linuxDir + '/redis.log')}`,
      ].join('\n') + '\n';
    const path = resolve(dir, 'redis.conf');
    await writeFile(path, config, { mode: 0o600 });
    wsl(['redis-server', wsl(['wslpath', '-u', path.replace(/\\/g, '/')])]);
    if (!(await ping()))
      throw new Error(
        'Project Redis failed to start/connect; inspect storage/redis/redis.log locally',
      );
  }
  const env = await readFile('.env', 'utf8');
  const line = `REDIS_URL=${url}`;
  await writeFile(
    '.env',
    /^REDIS_URL=.*$/m.test(env) ? env.replace(/^REDIS_URL=.*$/m, line) : env + '\n' + line + '\n',
    { mode: 0o600 },
  );
  console.log(
    'Project Redis running in Ubuntu WSL on port 6380; authenticated connection verified. REDIS_URL updated locally (credentials not printed).',
  );
}
main().catch(() => {
  console.error(
    'Redis local setup failed; inspect WSL distro, Redis installation and dedicated port 6380',
  );
  process.exitCode = 1;
});
