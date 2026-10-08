import { Pool } from 'pg';
import IORedis from 'ioredis';
import { loadConfig } from '../src/config';
import { Media, processFile } from '../src/media';
async function main() {
  const c = loadConfig(),
    pool = new Pool({ connectionString: c.DATABASE_URL, connectionTimeoutMillis: 5000 }),
    redis = new IORedis(c.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 5000,
      retryStrategy: () => null,
      maxRetriesPerRequest: 1,
    });
  redis.on('error', () => {});
  const media = new Media(c);
  const checks = await Promise.allSettled([
    pool.query('SELECT 1'),
    redis.connect().then(() => redis.ping()),
    processFile(media.ffmpeg, ['-version'], undefined, 10000),
    processFile(media.ffprobe, ['-version'], undefined, 10000),
  ]);
  const names = ['postgresql', 'redis', 'ffmpeg', 'ffprobe'];
  const result = Object.fromEntries(
    checks.map((r, i) => [
      names[i],
      {
        ok: r.status === 'fulfilled',
        message:
          r.status === 'fulfilled' ? 'available' : 'unavailable; check service/path/configuration',
      },
    ]),
  );
  console.log(
    JSON.stringify(
      {
        checks: result,
        modes: {
          openai: c.MOCK_OPENAI ? 'mock' : 'live',
          youtube: c.MOCK_YOUTUBE ? 'mock' : 'live',
          telegram: c.MOCK_TELEGRAM ? 'mock' : 'live',
        },
        schedule_enabled: c.SCHEDULE_ENABLED,
        auto_publish: c.AUTO_PUBLISH,
      },
      null,
      2,
    ),
  );
  redis.disconnect();
  await pool.end();
  if (checks.some((r) => r.status === 'rejected')) process.exitCode = 1;
}
main().catch(() => {
  console.error('Invalid configuration; inspect .env without sharing secrets');
  process.exitCode = 1;
});
