import { Pool } from 'pg';
import { randomInt } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { migrate, Repository } from '../src/db';
import { Pipeline } from '../src/engine';
import { QueueRuntime } from '../src/queues';

async function main() {
  const c = loadConfig();
  if (!c.MOCK_OPENAI || !c.MOCK_YOUTUBE || !c.MOCK_TELEGRAM || c.SCHEDULE_ENABLED || c.AUTO_PUBLISH)
    throw new Error('Native smoke requires all mock providers and schedule/auto-publish disabled');
  const pool = new Pool({
    connectionString: c.DATABASE_URL,
    max: 16,
    connectionTimeoutMillis: 5000,
  });
  await migrate(pool);
  const repo = new Repository(pool),
    pipeline = new Pipeline(c, repo),
    runtime = new QueueRuntime(pipeline);
  // Real calendar test date far outside today's scheduled run, retained for audit.
  let date: string;
  do {
    date = new Date(Date.UTC(randomInt(3000, 9000), randomInt(0, 12), randomInt(1, 29)))
      .toISOString()
      .slice(0, 10);
  } while (await repo.today(date));
  const runs = await Promise.all(Array.from({ length: 8 }, () => repo.create(date, true)));
  assert.equal(new Set(runs.map((r) => r.id)).size, 1);
  const run = runs[0];
  console.log('Concurrent daily triggers: one run');
  const work = { runId: run.id, revision: 1, step: 'discover' as const },
    claim = await repo.claim(work);
  assert.ok(claim);
  await repo.delivered((await repo.outbox())[0].id);
  await pool.query(
    "UPDATE pipeline_steps SET lease_until=now()-interval '3 minutes' WHERE run_id=$1 AND revision=1 AND step='discover'",
    [run.id],
  );
  const deadline = Date.now() + 10 * 60_000;
  async function wait(status: string, revision: number) {
    let last = '';
    while (Date.now() < deadline) {
      const current = await repo.get(run.id);
      const rows = await repo.steps(run.id, current.revision);
      const text = `revision ${current.revision}: ${current.status} / ${rows
        .filter((s) => s.status === 'RUNNING')
        .map((s) => s.step)
        .join(',')}`;
      if (text !== last) {
        console.log(text);
        last = text;
      }
      if (current.status === status && current.revision === revision) return;
      if (['FAILED', 'NEEDS_REVISION', 'UPLOAD_UNCERTAIN', 'SKIPPED'].includes(current.status))
        throw new Error(`Native smoke stopped: ${current.status} ${current.error_message}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Native smoke timed out');
  }
  try {
    await runtime.start();
    await wait('WAITING_APPROVAL', 1);
    console.log('Expired step lease recovered and full render passed');
    const first = (await repo.steps(run.id, 1)).find((s) => s.step === 'visuals')!.output;
    await pipeline.regenerate(run.id, 1, 'voice');
    await assert.rejects(repo.publish(run.id, 1, 'native-test'), /Stale/);
    await wait('WAITING_APPROVAL', 2);
    assert.deepEqual(
      (await repo.steps(run.id, 2)).find((s) => s.step === 'visuals')!.output,
      first,
    );
    console.log('Regeneration reused visuals and rejected stale approval');
    await Promise.all(Array.from({ length: 8 }, () => repo.publish(run.id, 2, 'native-test')));
    await wait('UPLOADED_PRIVATE', 2);
    const approvals = (
      await pool.query(
        "SELECT * FROM approvals WHERE run_id=$1 AND revision=2 AND decision='publish'",
        [run.id],
      )
    ).rows;
    assert.equal(approvals.length, 1);
    const detail = await repo.detail(run.id);
    await writeFile(join(c.STORAGE_ROOT, 'native-latest.json'), JSON.stringify(detail, null, 2));
    console.log(
      JSON.stringify(
        {
          ok: true,
          run_id: run.id,
          test_date: date,
          revision: 2,
          status: detail.status,
          report: join(c.STORAGE_ROOT, 'native-latest.json'),
          video: detail.steps.find((s) => s.step === 'render')!.output.path,
        },
        null,
        2,
      ),
    );
  } finally {
    await runtime.close();
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'Native smoke failed');
  process.exitCode = 1;
});
