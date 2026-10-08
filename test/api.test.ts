import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers';
import { Pipeline } from '../src/engine';
import { createApp } from '../src/main';

test('Native HTTP API authenticates admin, validates revisions and deduplicates triggers', async () => {
  const { repo, pool, c } = await setup();
  const app = await createApp(new Pipeline(c, repo));
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  try {
    const headers = {
      Authorization: `Bearer ${c.ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    };
    assert.equal((await fetch(url + '/health')).status, 200);
    assert.equal((await fetch(url + '/pipeline/today')).status, 401);
    const run: any = await (await fetch(url + '/pipeline/run', { method: 'POST', headers })).json();
    assert.ok(run.id);
    const again: any = await (
      await fetch(url + '/pipeline/run', { method: 'POST', headers })
    ).json();
    assert.equal(again.id, run.id);
    assert.equal(
      (await fetch(url + `/pipeline/${run.id}/publish`, { method: 'POST', headers, body: '{}' }))
        .status,
      400,
    );
    assert.equal(
      (
        await fetch(url + `/pipeline/${run.id}/publish`, {
          method: 'POST',
          headers,
          body: '{"revision":1}',
        })
      ).status,
      400,
    );
    const detail: any = await (await fetch(url + `/pipeline/${run.id}`, { headers })).json();
    assert.equal(detail.steps.length, 13);
    assert.equal(
      (
        await fetch(url + '/telegram/webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );
  } finally {
    await app.close();
    await pool.end();
  }
});
test('Telegram webhook durably deduplicates update IDs and rejects unauthorized users', async () => {
  const { repo, pool, c } = await setup();
  c.MOCK_TELEGRAM = false;
  c.TELEGRAM_UPDATE_MODE = 'webhook';
  c.TELEGRAM_ADMIN_CHAT_ID = '10';
  c.TELEGRAM_ADMIN_USER_IDS = '20';
  c.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret-32-characters-long';
  const app = await createApp(new Pipeline(c, repo));
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  try {
    const headers = {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': c.TELEGRAM_WEBHOOK_SECRET,
    };
    const update = {
      update_id: 100,
      message: { chat: { id: 10 }, from: { id: 20 }, text: '/status abc 1' },
    };
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await fetch(url + '/telegram/webhook', {
            method: 'POST',
            headers,
            body: JSON.stringify(update),
          })
        ).status,
        201,
      );
    assert.equal((await pool.query('SELECT * FROM telegram_updates')).rows.length, 1);
    update.message.from.id = 21;
    assert.equal(
      (
        await fetch(url + '/telegram/webhook', {
          method: 'POST',
          headers,
          body: JSON.stringify(update),
        })
      ).status,
      403,
    );
  } finally {
    await app.close();
    await pool.end();
  }
});
