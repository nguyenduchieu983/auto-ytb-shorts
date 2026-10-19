import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { setup } from './helpers';
import {
  ReelsService,
  defaultReelsSettings,
  postingText,
  rejectRepeatedReel,
  reelContentSchema,
} from '../src/reels';
import { Pipeline } from '../src/engine';
import { createApp } from '../src/main';
import { sessionCookie } from '../src/auth';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { philosophySpecSchema } from '../src/philosophy-render';

const due = new Date('2026-10-21T12:05:00Z'); // 19:05 UTC+7
const plan = { ...defaultReelsSettings, enabled: true };
async function fixture() {
  const spec = JSON.parse(await readFile('examples/philosophy-control.json', 'utf8'));
  return reelContentSchema.parse({
    ...spec,
    scenes: spec.scenes.map((s: any) => ({ ...s, label: '' })),
    topic_key: 'buong-kiem-soat',
    caption: 'Đâu là điều bạn có thể làm hôm nay?',
    description:
      'Dành sức cho hành động của mình. Một lời nhắc nhỏ để mỗi ngày sống nhẹ nhàng hơn.',
    hashtags: ['#TrietLy', '#SongCham', '#BinhYen'],
  });
}
function live(c: any) {
  c.MOCK_OPENAI = false;
  c.CONTENT_PROVIDER = 'codex';
  c.PAID_API_ENABLED = false;
  c.LOCAL_VOICE_PROVIDER = 'edge';
}
test('Reels defaults off; validates schedule and snapshots one daily batch with late same-day catchup', async () => {
  const { pool, repo, c } = await setup();
  const service = new ReelsService(repo, c);
  try {
    assert.equal((await service.settings()).enabled, false);
    assert.deepEqual(await service.tick(due), []);
    await assert.rejects(service.save(plan), /Codex/);
    live(c);
    await assert.rejects(service.save({ ...plan, time: '25:00' }));
    await assert.rejects(service.save({ ...plan, videos_per_day: 11 }));
    await assert.rejects(service.save({ ...plan, auto_publish: true }));
    await service.save(plan);
    assert.deepEqual(await service.tick(new Date('2026-10-21T11:59:59Z')), []);
    const first = await service.tick(due);
    assert.equal(first.length, 2);
    const second = await service.tick(due);
    assert.deepEqual(
      second.map((j) => j.id),
      first.map((j) => j.id),
    );
    await service.save({ ...plan, time: '08:00', videos_per_day: 3 });
    assert.equal((await service.tick(due)).length, 2);
    assert.equal((await service.tick(new Date('2026-10-23T02:00:00Z'))).length, 3);
    const dates = (
      await pool.query('SELECT run_date FROM reels_batches ORDER BY run_date')
    ).rows.map((r: any) => r.run_date);
    assert.deepEqual(dates, ['2026-10-21', '2026-10-23']); // No batch for missed October 22.
    const key = randomUUID();
    assert.equal((await service.manual(key)).length, 3);
    assert.equal((await service.manual(key)).length, 3);
    await service.save({ ...plan, enabled: false });
    assert.deepEqual(await service.tick(due), []);
  } finally {
    await pool.end();
  }
});
test('Posting bundle includes caption, description and hashtags; repeated text/title and short script rejected', async () => {
  const c = await fixture();
  assert.ok(postingText(c).includes('#TrietLy'));
  assert.ok(postingText(c).includes(c.description));
  rejectRepeatedReel(c, []);
  assert.throws(() => rejectRepeatedReel(c, [c]), /giống/);
  assert.throws(() => rejectRepeatedReel({ ...c, scenes: c.scenes.slice(0, 1) }, []), /115/);
});
test('Codex output contract requires every scene field, including label, while local preview can omit labels', () => {
  const convert = zodToJsonSchema as unknown as (schema: unknown, options: unknown) => any;
  const schema = convert(reelContentSchema, { $refStrategy: 'none' });
  const scene = schema.properties.scenes.items;
  assert.deepEqual(new Set(scene.required), new Set(Object.keys(scene.properties)));
  assert.ok(scene.required.includes('label'));
  assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));
  const sceneInput = { art: 'peace', narration: 'Một lời nhắc để sống bình yên.' };
  assert.equal(philosophySpecSchema.shape.scenes.element.safeParse(sceneInput).success, true);
  assert.equal(reelContentSchema.shape.scenes.element.safeParse(sceneInput).success, false);
});
test('Reels worker persists failures, pauses scheduled pending jobs while disabled, retries saved content and advances next job', async () => {
  const { pool, repo, c } = await setup();
  live(c);
  // pg-mem lacks session advisory locks. This stub tests state transitions, not cross-worker locking.
  const connect = pool.connect.bind(pool);
  (repo.pool as any).connect = async () => {
    const client = await connect();
    return {
      query: (sql: string, args: any[]) =>
        /pg_try_advisory_lock/.test(sql)
          ? Promise.resolve({ rows: [{ acquired: true }] })
          : /pg_advisory_unlock/.test(sql)
            ? Promise.resolve({ rows: [] })
            : client.query(sql, args),
      release: () => client.release(),
    };
  };
  let calls = 0,
    fail = true;
  const service = new ReelsService(repo, c, async (_c, dir, _spec, log) => {
    calls++;
    await log('Rendering scene 1/6');
    if (fail) throw new Error('Edge unavailable test');
    return {
      render: { path: join(dir, 'render/final.mp4'), thumbnail: join(dir, 'render/thumbnail.png') },
      qc: { hard_pass: true, duration: 50 },
      voice_settings: { rate: '-15%', pitch: '-15Hz' },
    };
  });
  try {
    await service.save(plan);
    const jobs = await service.tick(due),
      content = await fixture();
    for (const job of jobs)
      await pool.query('UPDATE reels_jobs SET content=$2 WHERE id=$1', [job.id, content]);
    await service.processNext();
    assert.equal((await service.detail(jobs[0].id)).status, 'FAILED');
    await service.save({ ...plan, enabled: false });
    await service.processNext();
    assert.equal(calls, 1);
    await service.retry(jobs[0].id);
    await service.save(plan);
    fail = false;
    await service.processNext();
    const ready = await service.detail(jobs[0].id);
    assert.equal(ready.status, 'READY');
    assert.equal(ready.attempts, 2);
    assert.ok(ready.posting_text.includes('#TrietLy'));
    await assert.rejects(service.retry(jobs[0].id), /Chỉ retry/);
    await service.processNext();
    assert.equal((await service.detail(jobs[1].id)).status, 'READY');
  } finally {
    await pool.end();
  }
});
test('Reels endpoints protect settings/assets, reject traversal and permit ranged MP4 plus posting download', async () => {
  const { pool, repo, c } = await setup();
  live(c);
  const app = await createApp(new Pipeline(c, repo));
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl(),
    headers = {
      Cookie: sessionCookie(c, false).split(';')[0],
      'Content-Type': 'application/json',
      Origin: url,
    };
  try {
    assert.equal((await fetch(url + '/dashboard/api/reels')).status, 401);
    assert.equal(
      (
        await fetch(url + '/dashboard/api/reels/settings', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://other.example' },
          body: JSON.stringify(plan),
        })
      ).status,
      403,
    );
    const service = new ReelsService(repo, c);
    await service.save(plan);
    const [job] = await service.tick(due);
    const dir = resolve(c.STORAGE_ROOT, 'reel-test-' + job.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'final.mp4'), Buffer.alloc(5000, 1));
    await writeFile(join(dir, 'post.txt'), 'Caption #TrietLy');
    await pool.query("UPDATE reels_jobs SET status='READY',content=$2,output=$3 WHERE id=$1", [
      job.id,
      await fixture(),
      { path: join(dir, 'final.mp4'), post_text: join(dir, 'post.txt') },
    ]);
    const asset = url + '/dashboard/api/reels/' + job.id + '/assets/';
    assert.equal((await fetch(asset + 'video')).status, 401);
    const range = await fetch(asset + 'video', { headers: { ...headers, Range: 'bytes=0-99' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 100);
    const text = await fetch(asset + 'post?download=1', { headers });
    assert.equal(text.status, 200);
    assert.ok(text.headers.get('content-disposition')?.includes('attachment'));
    assert.ok((await text.text()).includes('#TrietLy'));
    await pool.query('UPDATE reels_jobs SET output=$2 WHERE id=$1', [
      job.id,
      { path: resolve('.env') },
    ]);
    assert.equal((await fetch(asset + 'video', { headers })).status, 404);
    assert.equal((await fetch(asset + 'constructor', { headers })).status, 404);
    await pool.query("UPDATE reels_jobs SET status='FAILED' WHERE id=$1", [job.id]);
    assert.equal((await fetch(asset + 'post', { headers })).status, 404);
  } finally {
    await app.close();
    await pool.end();
  }
});
