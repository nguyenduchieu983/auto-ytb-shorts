import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Pipeline, safeError } from './engine';
import { localDate } from './config';
import { Work } from './domain';
import { parseTelegramUpdate } from './providers/telegram';

export class QueueRuntime {
  private connection: IORedis;
  private queues: Record<string, Queue>;
  private workers: Worker[] = [];
  private timer?: NodeJS.Timeout;
  private pumping = false;
  private closing = false;
  constructor(private pipeline: Pipeline) {
    this.connection = new IORedis(pipeline.c.REDIS_URL, { maxRetriesPerRequest: null });
    this.queues = Object.fromEntries(
      ['daily', 'content', 'assets', 'render', 'youtube'].map((name) => [
        name,
        new Queue(name, { connection: this.connection as any, prefix: pipeline.c.QUEUE_PREFIX }),
      ]),
    );
  }
  private queue(w: Work) {
    return w.step === 'upload'
      ? 'youtube'
      : w.step === 'render' || w.step === 'qc'
        ? 'render'
        : w.step === 'voice' || w.step === 'visuals'
          ? 'assets'
          : 'content';
  }
  async start() {
    for (const name of ['content', 'assets', 'render', 'youtube']) {
      const worker = new Worker(name, async (job) => this.pipeline.execute(job.data), {
        connection: this.connection as any,
        prefix: this.pipeline.c.QUEUE_PREFIX,
        concurrency:
          name === 'render'
            ? this.pipeline.c.RENDER_CONCURRENCY
            : name === 'assets'
              ? this.pipeline.c.ASSET_CONCURRENCY
              : 2,
        lockDuration: 120000,
      });
      worker.on('error', (e) => console.error(safeError(e, this.pipeline.c)));
      this.workers.push(worker);
    }
    const daily = new Worker(
      'daily',
      async () => {
        await this.pipeline.run();
      },
      { connection: this.connection as any, concurrency: 1, prefix: this.pipeline.c.QUEUE_PREFIX },
    );
    daily.on('error', (e) => console.error(safeError(e, this.pipeline.c)));
    this.workers.push(daily);
    if (this.pipeline.c.SCHEDULE_ENABLED)
      await this.queues.daily.upsertJobScheduler(
        'daily-news-shorts',
        { pattern: this.pipeline.c.DAILY_JOB_CRON, tz: this.pipeline.c.APP_TIMEZONE },
        {
          name: 'daily-pipeline',
          data: {},
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 30000 },
            removeOnComplete: 100,
            removeOnFail: 100,
          },
        },
      );
    else await this.queues.daily.removeJobScheduler('daily-news-shorts');
    await this.pump();
    this.timer = setInterval(() => {
      this.pump().catch((e) => console.error(safeError(e, this.pipeline.c)));
    }, 2000);
  }
  async pump() {
    if (this.pumping || this.closing) return;
    this.pumping = true;
    try {
      await this.pipeline.repo.recoverLeases();
      for (const event of await this.pipeline.repo.outbox()) {
        const q = this.queues[this.queue(event)],
          existing = await q.getJob(event.id);
        if (existing) {
          const state = await existing.getState();
          if (state === 'failed' || state === 'completed') await existing.remove();
        }
        await q.add(event.step, event, {
          jobId: event.id,
          attempts: 6,
          backoff: { type: 'exponential', delay: 30000 },
          removeOnComplete: { age: 86400, count: 2000 },
          removeOnFail: { age: 604800, count: 2000 },
        });
        await this.pipeline.repo.delivered(event.id);
      }
      await this.telegramInbox();
    } finally {
      this.pumping = false;
    }
  }
  private async telegramInbox() {
    // Transaction lock keeps command handling serialized across worker instances.
    const lock = await this.pipeline.repo.pool.connect();
    try {
      const acquired = (await lock.query('SELECT pg_try_advisory_lock(74619321) AS acquired'))
        .rows[0].acquired;
      if (!acquired) return;
      const rows = (
        await lock.query(
          "SELECT * FROM telegram_updates WHERE status='PENDING' ORDER BY update_id LIMIT 20",
        )
      ).rows;
      for (const row of rows) {
        let message = '';
        try {
          const cmd = parseTelegramUpdate(row.payload, this.pipeline.c);
          if (cmd.action === 'publish')
            await this.pipeline.repo.publish(cmd.runId, cmd.revision, cmd.actor);
          if (cmd.action === 'skip')
            await this.pipeline.repo.skip(cmd.runId, cmd.revision, cmd.actor);
          if (cmd.action === 'regenerate')
            await this.pipeline.regenerate(cmd.runId, cmd.revision, cmd.target!);
          const run = await this.pipeline.repo.get(cmd.runId);
          message = `${run.id} revision ${run.revision}: ${run.status}`;
          await lock.query("UPDATE telegram_updates SET status='DONE' WHERE update_id=$1", [
            row.update_id,
          ]);
        } catch (e) {
          message = safeError(e, this.pipeline.c);
          await lock.query(
            "UPDATE telegram_updates SET status='REJECTED',error_message=$2 WHERE update_id=$1",
            [row.update_id, message],
          );
        }
        await this.pipeline.telegram.notify(message).catch(() => {});
      }
    } finally {
      await lock.query('SELECT pg_advisory_unlock(74619321)').catch(() => {});
      lock.release();
    }
  }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    while (this.pumping) await new Promise((resolve) => setTimeout(resolve, 25));
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all(Object.values(this.queues).map((q) => q.close()));
    await this.connection.quit();
  }
}
