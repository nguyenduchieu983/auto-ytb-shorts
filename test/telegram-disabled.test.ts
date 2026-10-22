import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers';
import { loadConfig } from '../src/config';
import { TelegramProvider, parseTelegramUpdate } from '../src/providers/telegram';
import { TelegramPolling } from '../src/telegram-polling';
import { handleTelegramCommand } from '../src/telegram-commands';
import { QueueRuntime } from '../src/queues';
import { Pipeline } from '../src/engine';
import { createApp } from '../src/main';
import { VideoScheduler, defaultSchedule } from '../src/video-schedule';

test('Disabled Telegram performs no fetch, file reads, polling or inbox/command side effects', async (t) => {
  const { c, pool } = await setup();
  c.TELEGRAM_ENABLED = false;
  c.MOCK_TELEGRAM = false;
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected network call');
  });
  try {
    const provider = new TelegramProvider(c);
    await provider.notify('must not send');
    const preview = await provider.preview({} as any, { path: 'missing-video.mp4' }, {}, [], {}, 0);
    assert.deepEqual(preview, {
      disabled: true,
      channel: 'dashboard',
      preview_path: 'missing-video.mp4',
    });
    await assert.rejects(provider.call('sendMessage', {}), /disabled/);
    assert.throws(() => parseTelegramUpdate({}, c), /disabled/);
    await assert.rejects(
      handleTelegramCommand({ c } as any, {
        action: 'gen-new-video',
        actor: 'telegram:1',
        requestKey: 'telegram:1',
      }),
      /disabled/,
    );
    const polling = new TelegramPolling(c, {} as any);
    await polling.pollOnce();
    polling.start();
    await polling.close();
    await (QueueRuntime.prototype as any).telegramInbox.call({ pipeline: { c } });
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    await pool.end();
  }
});
test('Web-only mode skips Telegram credentials and keeps live YouTube scheduler eligible', async () => {
  const c = loadConfig({
    ADMIN_TOKEN: 'test-token-more-than-32-characters-long',
    DATABASE_URL: 'postgres://fixture',
    REDIS_URL: 'redis://localhost:6379',
    TELEGRAM_ENABLED: 'false',
    MOCK_TELEGRAM: 'true',
    AUTO_PUBLISH: 'true',
    MOCK_OPENAI: 'false',
    CONTENT_PROVIDER: 'codex',
    PAID_API_ENABLED: 'false',
    MOCK_YOUTUBE: 'false',
    GOOGLE_CLIENT_ID: 'fixture',
    GOOGLE_CLIENT_SECRET: 'fixture',
    YOUTUBE_REFRESH_TOKEN: 'fixture',
  });
  assert.equal(c.AUTO_PUBLISH, true);
  assert.equal(c.TELEGRAM_ENABLED, false);
  const { repo, pool } = await setup();
  try {
    await new VideoScheduler(repo, c).save({
      ...defaultSchedule,
      enabled: true,
      auto_publish: true,
    });
  } finally {
    await pool.end();
  }
});
test('Disabled Telegram webhook rejects even a valid secret; dashboard remains usable', async () => {
  const { repo, pool, c } = await setup();
  c.TELEGRAM_ENABLED = false;
  c.MOCK_TELEGRAM = false;
  c.TELEGRAM_UPDATE_MODE = 'webhook';
  c.TELEGRAM_WEBHOOK_SECRET = 'fixture-webhook-secret-32-characters';
  const app = await createApp(new Pipeline(c, repo));
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  try {
    const response = await fetch(url + '/telegram/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': c.TELEGRAM_WEBHOOK_SECRET,
      },
      body: JSON.stringify({ update_id: 123 }),
    });
    assert.equal(response.status, 401);
    assert.equal(
      Number((await pool.query('SELECT count(*) AS count FROM telegram_updates')).rows[0].count),
      0,
    );
    assert.equal((await fetch(url + '/dashboard')).status, 200);
    const runtime = await fetch(url + '/dashboard/api/runtime', {
      headers: { Authorization: 'Bearer ' + c.ADMIN_TOKEN },
    }).then((r) => r.json());
    assert.equal(runtime.modes.telegram, 'disabled');
    assert.equal(runtime.telegram_mode, 'disabled');
  } finally {
    await app.close();
    await pool.end();
  }
});
