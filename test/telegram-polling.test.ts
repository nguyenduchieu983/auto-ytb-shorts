import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramPolling } from '../src/telegram-polling';
import { setup } from './helpers';

test('Polling persists, authorizes, deduplicates and advances offset only after durable insert', async () => {
  const { c, pool } = await setup();
  c.TELEGRAM_ADMIN_CHAT_ID = '1';
  c.TELEGRAM_ADMIN_USER_IDS = '2';
  const realConnect = pool.connect.bind(pool);
  let fail = false;
  const fakePool = {
    connect: async () => {
      const client = await realConnect();
      return {
        release: () => client.release(),
        query: async (sql: string, args?: any[]) => {
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
          if (sql.includes('pg_advisory_unlock')) return { rows: [] };
          if (fail && sql.startsWith('INSERT')) throw new Error('DB unavailable');
          return client.query(sql, args);
        },
      };
    },
  };
  const originalFetch = globalThis.fetch;
  const offsets: number[] = [];
  let updates: any[] = [];
  globalThis.fetch = async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith('deleteWebhook')) {
      assert.equal(body.drop_pending_updates, false);
      return Response.json({ ok: true, result: true });
    }
    offsets.push(body.offset);
    return Response.json({ ok: true, result: updates });
  };
  const message = { chat: { id: 1 }, from: { id: 2 }, text: '/status run-id 8' };
  try {
    const polling = new TelegramPolling(c, fakePool as any);
    updates = [
      { update_id: 10, message },
      { update_id: 11, message: { ...message, from: { id: 3 } } },
    ];
    await polling.pollOnce();
    await polling.pollOnce();
    const rows = (
      await pool.query('SELECT update_id,status FROM telegram_updates ORDER BY update_id')
    ).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, 'PENDING');
    assert.equal(rows[1].status, 'REJECTED');
    assert.deepEqual(offsets, [0, 12]);
    updates = [{ update_id: 12, message }];
    fail = true;
    await assert.rejects(polling.pollOnce(), /DB unavailable/);
    fail = false;
    await polling.pollOnce();
    assert.deepEqual(offsets.slice(-2), [12, 12]);
    const restarted = new TelegramPolling(c, fakePool as any);
    await restarted.pollOnce();
    assert.equal((await pool.query('SELECT * FROM telegram_updates')).rows.length, 3);
    updates = [{ update_id: 13, message: { ...message, text: '/publish' } }];
    await restarted.pollOnce();
    assert.equal(
      (await pool.query('SELECT status FROM telegram_updates WHERE update_id=13')).rows[0].status,
      'PENDING',
    );
  } finally {
    globalThis.fetch = originalFetch;
    await pool.end();
  }
});

test('Polling leaves Telegram untouched when another local receiver holds the lock', async () => {
  const { c, pool } = await setup();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Must not fetch');
  };
  let released = false;
  try {
    await new TelegramPolling(c, {
      connect: async () => ({
        query: async () => ({ rows: [{ acquired: false }] }),
        release: () => {
          released = true;
        },
      }),
    } as any).pollOnce();
    assert.equal(released, true);
  } finally {
    globalThis.fetch = originalFetch;
    await pool.end();
  }
});
