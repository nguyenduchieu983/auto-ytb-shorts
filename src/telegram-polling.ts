import { Pool } from 'pg';
import { Config } from './config';
import { parseTelegramUpdate } from './providers/telegram';

export class TelegramPolling {
  private offset = 0;
  private initialized = false;
  private stopped = false;
  private abort = new AbortController();
  private task?: Promise<void>;
  constructor(
    private c: Config,
    private pool: Pool,
  ) {}
  private async call(method: string, body: unknown): Promise<any> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.c.TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(35000)]),
      },
    );
    if (!response.ok) throw new Error(`Telegram polling ${method} HTTP ${response.status}`);
    const data = (await response.json()) as any;
    if (!data.ok) throw new Error(`Telegram polling ${method} rejected`);
    return data.result;
  }
  async pollOnce(): Promise<void> {
    const client = await this.pool.connect();
    let acquired = false;
    try {
      acquired = (await client.query('SELECT pg_try_advisory_lock(74619322) AS acquired')).rows[0]
        .acquired;
      if (!acquired) return;
      if (!this.initialized) {
        await this.call('deleteWebhook', { drop_pending_updates: false });
        this.initialized = true;
        console.log('Telegram polling ready (local; pending updates preserved)');
      }
      const updates = await this.call('getUpdates', {
        offset: this.offset,
        timeout: 25,
        limit: 100,
        allowed_updates: ['message'],
      });
      if (!Array.isArray(updates)) throw new Error('Invalid Telegram polling response');
      for (const update of updates) {
        if (!Number.isSafeInteger(update?.update_id)) throw new Error('Invalid Telegram update ID');
        let status = 'PENDING',
          error: string | null = null;
        try {
          parseTelegramUpdate(update, this.c);
        } catch (e) {
          // Authorized but incomplete commands go through the inbox so the bot replies with usage.
          if (!(e instanceof Error) || e.message === 'Unauthorized Telegram user/chat') {
            status = 'REJECTED';
            error = 'Unsupported or unauthorized Telegram command';
          }
        }
        await client.query(
          'INSERT INTO telegram_updates (update_id,payload,status,error_message) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [update.update_id, JSON.stringify(update), status, error],
        );
        // Acknowledge only after durable insertion. Redelivery after restart is deduplicated.
        this.offset = Math.max(this.offset, update.update_id + 1);
        console.log(`Telegram update ${update.update_id}: ${status}`);
      }
    } finally {
      if (acquired) await client.query('SELECT pg_advisory_unlock(74619322)').catch(() => {});
      client.release();
    }
  }
  start() {
    if (this.task) return;
    this.task = (async () => {
      while (!this.stopped) {
        try {
          await this.pollOnce();
        } catch {
          if (!this.stopped)
            console.error(
              'Telegram polling failed; retrying in 5 seconds (check network/token or another polling process)',
            );
        }
        if (!this.stopped)
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              this.abort.signal.removeEventListener('abort', done);
              resolve();
            };
            const timer = setTimeout(done, 5000);
            this.abort.signal.addEventListener('abort', done, { once: true });
            if (this.stopped) done();
          });
      }
    })();
  }
  async close() {
    this.stopped = true;
    this.abort.abort();
    await this.task;
  }
}
