import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { loadConfig } from '../src/config';
import { migrate, Repository } from '../src/db';
import { VideoScheduler, defaultSchedule } from '../src/video-schedule';

async function main() {
  const c = loadConfig();
  // Isolated PostgreSQL schema: no production settings, queues or live providers are used.
  const schema = 'schedule_test_' + randomUUID().replace(/-/g, '');
  const admin = new Pool({ connectionString: c.DATABASE_URL });
  const pool = new Pool({
    connectionString: c.DATABASE_URL,
    options: `-c search_path=${schema}`,
    max: 12,
  });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    const repo = new Repository(pool);
    const scheduler = new VideoScheduler(repo, {
      ...c,
      MOCK_OPENAI: true,
      MOCK_YOUTUBE: true,
      MOCK_TELEGRAM: true,
      AUTO_PUBLISH: false,
    });
    await scheduler.save({ ...defaultSchedule, enabled: true, time: '00:05', videos_per_day: 2 });
    const due = new Date('2198-10-09T17:05:10Z');
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => scheduler.tick(due)));
    assert.equal(concurrent.filter(Boolean).length, 1);
    const first = concurrent.find(Boolean)!;
    assert.equal(first.run_date, '2198-10-10');
    assert.equal((await repo.outbox()).length, 1);
    await pool.query("UPDATE daily_runs SET status='WAITING_APPROVAL' WHERE id=$1", [first.id]);
    const next = await Promise.all(Array.from({ length: 8 }, () => scheduler.tick(due)));
    assert.equal(next.filter(Boolean).length, 1);
    const second = next.find(Boolean)!;
    await pool.query("UPDATE daily_runs SET status='FAILED' WHERE id=$1", [second.id]);
    await Promise.all(Array.from({ length: 8 }, () => scheduler.tick(due)));
    assert.equal((await repo.outbox()).length, 2);
    assert.equal((await scheduler.view()).recent[0].runs.length, 2);
    console.log(
      'PostgreSQL schedule smoke passed: 8 concurrent ticks, UTC+7 rollover, sequential batch, exact count and outbox dedup. No live API calls.',
    );
  } finally {
    await pool.end();
    // schema is generated locally above from a UUID, never supplied by callers.
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}
main().catch(() => {
  console.error('Schedule smoke failed; inspect the isolated test locally.');
  process.exitCode = 1;
});
