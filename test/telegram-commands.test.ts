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
test('Manual generation uses daily idempotency; repeated command cannot create another video', async () => {
  const { repo, c, pool } = await setup();
  const pipeline = new Pipeline(c, repo);
  try {
    const cmd = { action: 'gen-new-video', actor: 'telegram:20' } as const;
    const first = await handleTelegramCommand(pipeline, cmd),
      second = await handleTelegramCommand(pipeline, cmd);
    assert.equal(first, second);
    assert.equal((await pool.query('SELECT * FROM daily_runs')).rows.length, 1);
    assert.equal((await repo.outbox()).length, 1);
    const run = (await pool.query('SELECT * FROM daily_runs')).rows[0];
    await pool.query("UPDATE daily_runs SET status='WAITING_APPROVAL' WHERE id=$1", [run.id]);
    const existing = await handleTelegramCommand(pipeline, cmd);
    assert.match(existing, /Không tạo thêm/);
    assert.ok(existing.includes(`/publish ${run.id} 1`));
    await pool.query("UPDATE daily_runs SET status='FAILED' WHERE id=$1", [run.id]);
    // This fixture database is pg-mem, not the local production database.
    await repo.saveUpload(
      { runId: run.id, revision: 1, step: 'upload' },
      'UPLOADING',
      'test-session',
    );
    const failed = await handleTelegramCommand(pipeline, cmd);
    assert.match(failed, /phiên upload/);
    assert.ok(!failed.includes('/regenerate'));
  } finally {
    await pool.end();
  }
});
