import { Pool } from 'pg';
import IORedis from 'ioredis';
import { loadConfig } from '../src/config';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Media, processFile } from '../src/media';
import { resolveCodexBinary } from '../src/codex-runtime';
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
  if (!c.MOCK_OPENAI && c.CONTENT_PROVIDER === 'codex') {
    checks.push(
      ...(await Promise.allSettled([
        resolveCodexBinary(c)
          .then((binary) => processFile(binary, ['login', 'status'], undefined, 10000))
          .then((output) => {
            if (!/logged in using chatgpt/i.test(output)) throw new Error('ChatGPT login required');
          }),
        Promise.all([
          access(resolve(c.LOCAL_VOICE_PYTHON)),
          ...(c.LOCAL_VOICE_PROVIDER === 'edge'
            ? [
                processFile(
                  resolve(c.LOCAL_VOICE_PYTHON),
                  ['-c', 'import edge_tts'],
                  undefined,
                  10000,
                ),
              ]
            : [
                access(resolve(c.LOCAL_VOICE_MODEL)),
                access(resolve(c.LOCAL_VOICE_MODEL) + '.json'),
              ]),
        ]),
      ])),
    );
    names.push(
      'codex_chatgpt_login',
      c.LOCAL_VOICE_PROVIDER === 'edge' ? 'edge_nam_minh_dependency' : 'local_piper_voice',
    );
  }
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
          telegram: !c.TELEGRAM_ENABLED ? 'disabled' : c.MOCK_TELEGRAM ? 'mock' : 'live',
        },
        schedule_enabled: c.SCHEDULE_ENABLED,
        content_provider: c.CONTENT_PROVIDER,
        paid_api_enabled: c.PAID_API_ENABLED,
        auto_publish: c.AUTO_PUBLISH,
      },
      null,
      2,
    ),
  );
  redis.disconnect();
  await pool.end();
  if (
    checks.some(
      (r, i) =>
        r.status === 'rejected' &&
        !(process.argv.includes('--allow-codex-login') && names[i] === 'codex_chatgpt_login'),
    )
  )
    process.exitCode = 1;
}
main().catch(() => {
  console.error('Invalid configuration; inspect .env without sharing secrets');
  process.exitCode = 1;
});
