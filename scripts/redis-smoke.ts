import { Queue, Worker, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
async function main() {
  const c = loadConfig(),
    prefix = `${c.QUEUE_PREFIX}-test-${randomUUID()}`,
    connection = new IORedis(c.REDIS_URL, {
      maxRetriesPerRequest: null,
      connectTimeout: 5000,
      retryStrategy: () => null,
    });
  connection.on('error', () => {});
  await connection.ping();
  const queue = new Queue('smoke', { connection: connection as any, prefix }),
    events = new QueueEvents('smoke', { connection: connection as any, prefix });
  let calls = 0;
  queue.on('error', () => {});
  events.on('error', () => {});
  const worker = new Worker(
    'smoke',
    async () => {
      calls++;
      if (calls === 1) throw new Error('Expected transient failure');
      return { ok: true };
    },
    { connection: connection as any, prefix, concurrency: 1 },
  );
  worker.on('error', () => {});
  try {
    await events.waitUntilReady();
    const job = await queue.add(
      'test',
      {},
      { jobId: 'unique-smoke', attempts: 2, backoff: { type: 'fixed', delay: 50 } },
    );
    assert.deepEqual(await job.waitUntilFinished(events, 15000), { ok: true });
    assert.equal(calls, 2);
    await queue.add('test', {}, { jobId: 'unique-smoke' });
    assert.equal(await queue.getJobCountByTypes('completed'), 1);
    console.log('Redis/BullMQ native smoke passed: retry and duplicate job prevention');
  } finally {
    await worker.close();
    await events.close();
    // Only remove this newly-created test namespace; app/other-project queues are untouched.
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
  }
}
main().catch(() => {
  console.error('Redis/BullMQ native smoke failed; check REDIS_URL and Redis version');
  process.exitCode = 1;
});
