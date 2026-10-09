import { newDb } from 'pg-mem';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { migrate, Repository } from '../src/db';
import { Pipeline } from '../src/engine';

async function main() {
  const db = newDb(),
    pg = db.adapters.createPg(),
    pool = new pg.Pool();
  await migrate(pool as any, true);
  const c = loadConfig({
    ...process.env,
    ADMIN_TOKEN: 'demo-only-token-never-use-in-production',
    DATABASE_URL: 'postgres://demo:demo@localhost/demo',
    REDIS_URL: 'redis://localhost:6379',
    MOCK_OPENAI: 'true',
    MOCK_YOUTUBE: 'true',
    MOCK_TELEGRAM: 'true',
    AUTO_PUBLISH: 'false',
    SCHEDULE_ENABLED: 'false',
  });
  const repo = new Repository(pool as any),
    pipeline = new Pipeline(c, repo),
    run = await pipeline.run();
  console.log(`DEMO ${run.id}: fake news, audible test tone, mock Telegram/YouTube`);
  while (true) {
    const events = await repo.outbox();
    if (!events.length) break;
    for (const event of events) {
      await repo.delivered(event.id);
      console.log(`→ ${event.step}`);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await pipeline.execute(event);
          break;
        } catch (e) {
          console.error(String(e));
          if (attempt === 2) throw e;
        }
      }
    }
  }
  const ready = await repo.get(run.id);
  if (ready.status !== 'WAITING_APPROVAL')
    throw new Error(`Demo stopped in ${ready.status}: ${ready.error_message}`);
  await repo.publish(run.id, ready.revision, 'demo-admin');
  for (const event of await repo.outbox()) {
    await repo.delivered(event.id);
    console.log(`→ ${event.step} (MOCK)`);
    await pipeline.execute(event);
  }
  const detail = await repo.detail(run.id),
    render = detail.steps.find((s) => s.step === 'render')?.output,
    qc = detail.steps.find((s) => s.step === 'qc')?.output;
  const rank = detail.steps.find((s) => s.step === 'rank')?.output,
    script = detail.steps.find((s) => s.step === 'script')?.output;
  if (
    rank?.format !== 'single-story' ||
    rank.selected.length !== 1 ||
    script?.segments.length !== 1 ||
    script.segments[0].news_id !== rank.selected[0].id ||
    !qc?.hard_pass
  )
    throw new Error('Single-topic demo failed selection, script or media QC');
  if (detail.status !== 'UPLOADED_PRIVATE')
    throw new Error(`Mock upload did not finish: ${detail.status}`);
  await writeFile(join(c.STORAGE_ROOT, 'demo-latest.json'), JSON.stringify(detail, null, 2));
  console.log(
    JSON.stringify(
      {
        status: detail.status,
        video: render.path,
        thumbnail: render.thumbnail,
        qc,
        report: join(c.STORAGE_ROOT, 'demo-latest.json'),
      },
      null,
      2,
    ),
  );
  await pool.end();
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
