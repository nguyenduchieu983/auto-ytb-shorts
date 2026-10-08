import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers';
import { Pipeline } from '../src/engine';
import { parseTelegramUpdate } from '../src/providers/telegram';
import { handleTelegramCommand } from '../src/telegram-commands';

test('Manual generate command requires admin, accepts no IDs and rejects extra arguments', async () => {
  const { c, pool } = await setup();
  c.TELEGRAM_ADMIN_CHAT_ID = '10';
  c.TELEGRAM_ADMIN_USER_IDS = '20';
  const update = (text: string, user = 20) => ({
    update_id: 100,
    message: { chat: { id: 10 }, from: { id: user }, text },
  });
  try {
    assert.equal(parseTelegramUpdate(update('/gen-new-video'), c).action, 'gen-new-video');
    assert.equal(parseTelegramUpdate(update('/gen_new_video@mybot'), c).action, 'gen-new-video');
    assert.throws(() => parseTelegramUpdate(update('/gen-new-video', 21), c), /Unauthorized/);
    assert.throws(
      () => parseTelegramUpdate(update('/gen-new-video extra'), c),
      /without arguments/,
    );
  } finally {
    await pool.end();
  }
});
test('Each manual update creates a new run even when an earlier same-day run failed upload; redelivery reuses its run', async () => {
  const { repo, c, pool } = await setup();
  const pipeline = new Pipeline(c, repo);
  try {
    const cmd = {
      action: 'gen-new-video',
      actor: 'telegram:20',
      requestKey: 'telegram:101',
    } as const;
    const first = await handleTelegramCommand(pipeline, cmd);
    assert.equal(await handleTelegramCommand(pipeline, cmd), first);
    const old = (await pool.query('SELECT * FROM daily_runs')).rows[0];
    await pool.query("UPDATE daily_runs SET status='FAILED' WHERE id=$1", [old.id]);
    await repo.saveUpload(
      { runId: old.id, revision: 1, step: 'upload' },
      'UPLOADING',
      'existing-session',
    );
    const second = await handleTelegramCommand(pipeline, { ...cmd, requestKey: 'telegram:102' });
    assert.notEqual(second, first);
    assert.equal((await pool.query('SELECT * FROM daily_runs')).rows.length, 2);
    assert.equal((await repo.outbox()).length, 2);
    assert.equal((await repo.get(old.id)).status, 'FAILED');
    assert.equal(
      (await repo.upload({ runId: old.id, revision: 1, step: 'upload' })).session_uri,
      'existing-session',
    );
    assert.equal(
      await handleTelegramCommand(pipeline, { ...cmd, requestKey: 'telegram:102' }),
      second,
    );
  } finally {
    await pool.end();
  }
});
