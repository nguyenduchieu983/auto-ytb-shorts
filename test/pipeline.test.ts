import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers';
import { Work } from '../src/domain';

async function succeed(repo: any, w: Work, output: any, status?: string) {
  const claim = await repo.claim(w);
  assert.ok(claim);
  await repo.finish(w, claim.token, output, { path: 'fixture', checksum: 'fixture' }, status);
}
async function ready(repo: any, id: string) {
  const outputs: any = {
    discover: { items: [] },
    rank: { selected: [] },
    script: {},
    verify: { verified: true },
    storyboard: {},
    voice: {},
    visuals: {},
    metadata: {},
    subtitles: {},
    render: {},
    qc: { hard_pass: true, auto_eligible: true },
    approval: {},
  };
  for (let guard = 0; guard < 20; guard++) {
    const events = await repo.outbox();
    if (!events.length) break;
    for (const w of events) {
      await repo.delivered(w.id);
      await succeed(
        repo,
        w,
        outputs[w.step],
        w.step === 'approval' ? 'WAITING_APPROVAL' : undefined,
      );
    }
  }
  assert.equal((await repo.get(id)).status, 'WAITING_APPROVAL');
}
test('Duplicate daily triggers return the same run and one outbox event', async () => {
  const { repo, pool } = await setup();
  try {
    const a = await repo.create('2026-10-08', true),
      b = await repo.create('2026-10-08', true);
    assert.equal(a.id, b.id);
    assert.equal((await repo.outbox()).length, 1);
  } finally {
    await pool.end();
  }
});
test('Two asset branches join only after both complete', async () => {
  const { repo, pool } = await setup();
  try {
    const run = await repo.create('2026-10-08', true);
    for (const step of ['discover', 'rank', 'script', 'verify', 'storyboard'] as const)
      await succeed(
        repo,
        { runId: run.id, revision: 1, step },
        step === 'rank' ? { selected: [] } : {},
      );
    await succeed(repo, { runId: run.id, revision: 1, step: 'voice' }, {});
    await succeed(repo, { runId: run.id, revision: 1, step: 'subtitles' }, {});
    assert.equal((await repo.steps(run.id, 1)).find((s) => s.step === 'render')?.status, 'PENDING');
    await succeed(repo, { runId: run.id, revision: 1, step: 'visuals' }, {});
    assert.equal((await repo.steps(run.id, 1)).find((s) => s.step === 'render')?.status, 'QUEUED');
  } finally {
    await pool.end();
  }
});
test('Regenerate invalidates stale approval and late worker output', async () => {
  const { repo, pool } = await setup();
  try {
    const run = await repo.create('2026-10-08', true);
    await ready(repo, run.id);
    const next = await repo.regenerate(run.id, 1, 'voice');
    assert.equal(next.revision, 2);
    await assert.rejects(repo.publish(run.id, 1, 'admin'), /Stale/);
    const steps = await repo.steps(run.id, 2);
    assert.equal(steps.find((s) => s.step === 'visuals')?.status, 'SUCCEEDED');
    assert.equal(steps.find((s) => s.step === 'approval')?.status, 'PENDING');
    assert.equal(await repo.claim({ runId: run.id, revision: 1, step: 'upload' }), null);
  } finally {
    await pool.end();
  }
});
test('Repeated approval creates a single upload job and refuses regeneration during upload', async () => {
  const { repo, pool } = await setup();
  try {
    const run = await repo.create('2026-10-08', true);
    await ready(repo, run.id);
    await repo.publish(run.id, 1, 'admin');
    await repo.publish(run.id, 1, 'admin');
    assert.equal((await repo.outbox()).filter((w) => w.step === 'upload').length, 1);
    await assert.rejects(repo.regenerate(run.id, 1, 'script'), /upload/i);
  } finally {
    await pool.end();
  }
});
test('QC and verification gates cannot be bypassed with admin publish', async () => {
  const { repo, pool } = await setup();
  try {
    const run = await repo.create('2026-10-08', true);
    await ready(repo, run.id);
    await pool.query("UPDATE pipeline_steps SET output=$2 WHERE run_id=$1 AND step='qc'", [
      run.id,
      JSON.stringify({ hard_pass: false }),
    ]);
    await assert.rejects(repo.publish(run.id, 1, 'admin'), /gate/);
  } finally {
    await pool.end();
  }
});
test('Mock run cannot auto-publish even when score is high', async () => {
  const { repo, pool } = await setup();
  try {
    const run = await repo.create('2026-10-08', true);
    await ready(repo, run.id);
    await assert.rejects(repo.publish(run.id, 1, 'auto'), /Auto-publish/);
  } finally {
    await pool.end();
  }
});
test('Cost reservations count retries and cannot exceed configured budget', async () => {
  const { repo, pool } = await setup();
  try {
    const run = await repo.create('2026-10-08', true),
      w = { runId: run.id, revision: 1, step: 'discover' as const };
    await repo.reserve(w, 'model', 0.4, 0.5);
    await assert.rejects(repo.reserve(w, 'model', 0.2, 0.5), /limit/);
  } finally {
    await pool.end();
  }
});
test('Zero cap disables reservation blocking while preserving usage records', async () => {
  const { repo, pool } = await setup();
  try {
    const run = await repo.create('2026-10-08', true);
    const w = { runId: run.id, revision: 1, step: 'discover' as const };
    await repo.reserve(w, 'model', 6, 0);
    await repo.reserve(w, 'model', 6, 0);
    assert.equal((await repo.detail(run.id)).costs.length, 2);
    await repo.skip(run.id, 1, 'admin');
    await assert.rejects(repo.reserve(w, 'model', 6, 0), /Run changed/);
  } finally {
    await pool.end();
  }
});
test('Skip cancels work and late completion cannot change state', async () => {
  const { repo, pool } = await setup();
  try {
    const run = await repo.create('2026-10-08', true),
      w = { runId: run.id, revision: 1, step: 'discover' as const },
      claim = await repo.claim(w);
    assert.ok(claim);
    await repo.skip(run.id, 1, 'admin');
    await repo.finish(w, claim.token, {}, { path: 'late', checksum: 'late' });
    assert.equal((await repo.get(run.id)).status, 'SKIPPED');
    assert.equal((await repo.steps(run.id, 1)).find((s) => s.step === 'discover')?.output, null);
  } finally {
    await pool.end();
  }
});
test('Manual retry resumes only the failed step without a new revision', async () => {
  const { repo, pool } = await setup();
  try {
    const run = await repo.create('2026-10-08', true);
    const w = { runId: run.id, revision: 1, step: 'discover' as const };
    const event = (await repo.outbox())[0];
    await repo.delivered(event.id);
    const claim = await repo.claim(w);
    assert.ok(claim);
    await repo.fail(w, claim.token, 'Transient dependency failure', 'FAILED');
    await repo.retry(run.id, 1, 'discover');
    const retried = await repo.claim(w);
    assert.ok(retried);
    assert.equal(retried.attempt, 1);
    assert.equal((await repo.get(run.id)).revision, 1);
    assert.equal((await repo.outbox()).length, 1);
  } finally {
    await pool.end();
  }
});
test('Approval older than 24 hours requires content revision', async () => {
  const { repo, pool } = await setup();
  try {
    const run = await repo.create('2026-10-08', true);
    await ready(repo, run.id);
    await pool.query("UPDATE pipeline_steps SET finished_at=$2 WHERE run_id=$1 AND step='qc'", [
      run.id,
      new Date(Date.now() - 25 * 3600000),
    ]);
    await assert.rejects(repo.publish(run.id, 1, 'admin'), /expired/);
  } finally {
    await pool.end();
  }
});
