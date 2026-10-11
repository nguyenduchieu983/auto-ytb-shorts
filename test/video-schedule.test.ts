import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers';
import { Pipeline } from '../src/engine';
import { mockNews } from '../src/mock';
import {
  VideoScheduler,
  defaultSchedule,
  nextScheduleAt,
  vietnamTime,
} from '../src/video-schedule';

const due = new Date('2026-10-09T17:05:10Z'); // 00:05 on October 10, UTC+7
const plan = { ...defaultSchedule, enabled: true, time: '00:05', videos_per_day: 3 };
test('Scheduled auto-upload rank chooses a dated alternative instead of the highest-scoring undated story', async () => {
  const { repo, pool, c } = await setup();
  c.MOCK_OPENAI = c.MOCK_YOUTUBE = c.MOCK_TELEGRAM = false;
  const scheduler = new VideoScheduler(repo, c);
  const pipeline = new Pipeline(c, repo);
  const items = mockNews(new Date()).slice(0, 2);
  items[0].published_at = null;
  items[0].date_parse_failed = true;
  pipeline.ai.filterRepeatedNews = async () => ({ items, decisions: [] });
  pipeline.ai.rank = async () => items;
  try {
    await scheduler.save({ ...plan, auto_publish: true });
    const run = await scheduler.tick(due);
    assert.ok(run);
    const discover = { runId: run.id, revision: 1, step: 'discover' as const };
    const claim = await repo.claim(discover);
    assert.ok(claim);
    await repo.finish(discover, claim.token, { items }, { path: 'fixture', checksum: 'fixture' });
    await pipeline.execute({ runId: run.id, revision: 1, step: 'rank' });
    const rank = (await repo.steps(run.id, 1)).find((s) => s.step === 'rank')!;
    assert.equal(rank.status, 'SUCCEEDED');
    assert.equal(rank.output.require_publication_date, true);
    assert.equal(rank.output.selected[0].id, items[1].id);
  } finally {
    await pool.end();
  }
});
test('Schedule uses UTC+7 at date rollover and calculates the next daily start', () => {
  assert.equal(vietnamTime(due), '00:05');
  assert.equal(nextScheduleAt(plan, new Date('2026-10-09T17:04:00Z')), '2026-10-09T17:05:00.000Z');
  assert.equal(nextScheduleAt(plan, due), '2026-10-10T17:05:00.000Z');
  assert.equal(nextScheduleAt(defaultSchedule, due), null);
});
test('Schedule validates time, count, timezone and live upload requirements', async () => {
  const { repo, pool, c } = await setup();
  const scheduler = new VideoScheduler(repo, c);
  try {
    assert.equal((await scheduler.view()).settings.enabled, false);
    for (const value of [
      { time: '24:00' },
      { videos_per_day: 0 },
      { videos_per_day: 21 },
      { videos_per_day: 1.5 },
      { timezone: 'UTC' },
    ])
      await assert.rejects(scheduler.save({ ...plan, ...value }));
    await assert.rejects(scheduler.save({ ...plan, auto_publish: true }), /live/);
    assert.equal(await scheduler.saved(), null);
  } finally {
    await pool.end();
  }
});
test('One daily batch creates sequential videos, survives restart and never exceeds its snapshot count', async () => {
  const { repo, pool, c } = await setup();
  let scheduler = new VideoScheduler(repo, c);
  try {
    await scheduler.save(plan);
    assert.equal(await scheduler.tick(new Date('2026-10-09T17:04:59Z')), undefined);
    const first = await scheduler.tick(due);
    assert.ok(first);
    assert.equal(first.run_date, '2026-10-10');
    assert.equal(await scheduler.tick(due), undefined);
    await repo.pool.query("UPDATE daily_runs SET status='WAITING_APPROVAL' WHERE id=$1", [
      first.id,
    ]);
    scheduler = new VideoScheduler(repo, c);
    await scheduler.save({ ...plan, videos_per_day: 10 });
    const second = await scheduler.tick(new Date('2026-10-09T17:06:00Z'));
    assert.ok(second && second.id !== first.id);
    await scheduler.save({ ...plan, enabled: false });
    await repo.pool.query("UPDATE daily_runs SET status='FAILED' WHERE id=$1", [second.id]);
    assert.equal(await scheduler.tick(due), undefined);
    await scheduler.save(plan);
    const third = await scheduler.tick(due);
    assert.ok(third);
    await repo.pool.query("UPDATE daily_runs SET status='PUBLISHED' WHERE id=$1", [third.id]);
    assert.equal(await scheduler.tick(due), undefined);
    const view = await scheduler.view(due);
    assert.equal(view.recent[0].runs.length, 3);
    assert.equal(view.recent[0].settings.videos_per_day, 3);
    assert.equal((await repo.outbox()).length, 3);
  } finally {
    await pool.end();
  }
});
test('Missed start times are not backfilled and changing the time cannot create a second same-day batch', async () => {
  const { repo, pool, c } = await setup();
  const scheduler = new VideoScheduler(repo, c);
  try {
    await scheduler.save({ ...plan, videos_per_day: 1 });
    assert.equal(await scheduler.tick(new Date('2026-10-09T17:06:00Z')), undefined);
    const run = await scheduler.tick(due);
    assert.ok(run);
    await repo.pool.query("UPDATE daily_runs SET status='SKIPPED' WHERE id=$1", [run.id]);
    await scheduler.save({ ...plan, time: '00:06', videos_per_day: 5 });
    assert.equal(await scheduler.tick(new Date('2026-10-09T17:06:00Z')), undefined);
    assert.equal((await scheduler.view()).recent.length, 1);
  } finally {
    await pool.end();
  }
});
test('Scheduled auto upload is isolated from manual runs and disabled immediately for in-flight runs', async () => {
  const { repo, pool, c } = await setup();
  c.MOCK_OPENAI = c.MOCK_YOUTUBE = c.MOCK_TELEGRAM = false;
  const scheduler = new VideoScheduler(repo, c);
  try {
    const manual = await repo.create('2026-10-10', false, 'manual-test');
    await scheduler.save({ ...plan, auto_publish: true });
    const run = await scheduler.tick(due);
    assert.ok(run);
    assert.equal(await scheduler.autoPublishAllowed(manual.id), false);
    assert.equal(await scheduler.autoPublishAllowed(run.id), true);
    await scheduler.save({ ...plan, auto_publish: false });
    assert.equal(await scheduler.autoPublishAllowed(run.id), false);
    await scheduler.save({ ...plan, auto_publish: true, enabled: false });
    assert.equal(await scheduler.autoPublishAllowed(run.id), false);
    c.AUTO_PUBLISH = true;
    assert.equal(await scheduler.autoPublishAllowed(run.id), false);
    assert.equal(await scheduler.autoPublishAllowed(manual.id), true);
  } finally {
    await pool.end();
  }
});

test('Recovery auto uploads a scheduled eligible revision exactly once and leaves failed QC for review', async () => {
  const { repo, pool, c } = await setup();
  c.MOCK_OPENAI = c.MOCK_YOUTUBE = c.MOCK_TELEGRAM = false;
  const scheduler = new VideoScheduler(repo, c);
  try {
    await scheduler.save({ ...plan, auto_publish: true });
    for (const eligible of [true, false]) {
      const run = await scheduler.tick(due);
      assert.ok(run);
      for (let guard = 0; guard < 15; guard++) {
        const events = (await repo.outbox()).filter((w) => w.runId === run.id);
        if (!events.length) break;
        for (const w of events) {
          await repo.delivered(w.id);
          const claim = await repo.claim(w);
          assert.ok(claim);
          const output =
            w.step === 'qc'
              ? { hard_pass: eligible, auto_eligible: eligible }
              : w.step === 'verify'
                ? { verified: true }
                : w.step === 'rank'
                  ? { selected: [] }
                  : {};
          await repo.finish(
            w,
            claim.token,
            output,
            { path: 'fixture', checksum: 'fixture' },
            w.step === 'approval' ? 'WAITING_APPROVAL' : undefined,
          );
        }
      }
      await scheduler.publishReady();
      await scheduler.publishReady();
      assert.equal((await repo.get(run.id)).status, eligible ? 'UPLOADING' : 'WAITING_APPROVAL');
      assert.equal(
        (await repo.outbox()).filter((w) => w.runId === run.id && w.step === 'upload').length,
        eligible ? 1 : 0,
      );
      if (eligible)
        await pool.query("UPDATE daily_runs SET status='PUBLISHED' WHERE id=$1", [run.id]);
    }
  } finally {
    await pool.end();
  }
});
