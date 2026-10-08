import { Pool, PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  DEPENDENCIES,
  descendants,
  jobId,
  News,
  PermanentError,
  Run,
  Step,
  StepRow,
  STEPS,
  StaleWorkError,
  Work,
} from './domain';

export async function migrate(pool: Pool, memory = false): Promise<void> {
  const client = await pool.connect();
  try {
    if (!memory) await client.query('SELECT pg_advisory_lock(74619320)');
    await client.query(await readFile(resolve('migrations/001_initial.sql'), 'utf8'));
    await client.query(await readFile(resolve('migrations/002_manual_runs.sql'), 'utf8'));
  } finally {
    if (!memory) await client.query('SELECT pg_advisory_unlock(74619320)');
    client.release();
  }
}
const STOPPED = new Set([
  'FAILED',
  'SKIPPED',
  'NEEDS_REVISION',
  'UPLOAD_UNCERTAIN',
  'UPLOADED_PRIVATE',
  'PUBLISHED',
]);
export class Repository {
  constructor(public readonly pool: Pool) {}
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const v = await fn(c);
      await c.query('COMMIT');
      return v;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async get(id: string): Promise<Run> {
    const r = await this.pool.query('SELECT * FROM daily_runs WHERE id=$1', [id]);
    if (!r.rows[0]) throw new PermanentError('Run not found');
    return r.rows[0];
  }
  async today(date: string): Promise<Run | null> {
    return (
      (
        await this.pool.query(
          'SELECT * FROM daily_runs WHERE run_date=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
          [date],
        )
      ).rows[0] || null
    );
  }
  async steps(id: string, revision: number): Promise<StepRow[]> {
    return (
      await this.pool.query('SELECT * FROM pipeline_steps WHERE run_id=$1 AND revision=$2', [
        id,
        revision,
      ])
    ).rows;
  }
  async detail(id: string) {
    const run = await this.get(id);
    return {
      ...run,
      steps: await this.steps(id, run.revision),
      costs: (
        await this.pool.query(
          'SELECT operation,model,reserved_usd,input_tokens,output_tokens FROM api_costs WHERE run_id=$1',
          [id],
        )
      ).rows,
      logs: (
        await this.pool.query(
          'SELECT revision,step,level,message,created_at FROM pipeline_logs WHERE run_id=$1 ORDER BY created_at DESC LIMIT 50',
          [id],
        )
      ).rows,
      uploads: (
        await this.pool.query(
          'SELECT revision,status,youtube_video_id FROM upload_attempts WHERE run_id=$1',
          [id],
        )
      ).rows,
    };
  }
  async create(date: string, mock: boolean, requestKey = `daily:${date}`): Promise<Run> {
    return this.tx(async (c) => {
      const id = randomUUID();
      const inserted = await c.query(
        'INSERT INTO daily_runs (id,run_date,mock,request_key) VALUES ($1,$2,$3,$4) ON CONFLICT (request_key) DO NOTHING RETURNING *',
        [id, date, mock, requestKey],
      );
      if (!inserted.rows.length)
        return (await c.query('SELECT * FROM daily_runs WHERE request_key=$1', [requestKey]))
          .rows[0];
      if (inserted.rows[0].id !== id) return inserted.rows[0];
      for (const step of STEPS)
        await c.query('INSERT INTO pipeline_steps (run_id,revision,step) VALUES ($1,1,$2)', [
          id,
          step,
        ]);
      await this.schedule(c, id, 1);
      return inserted.rows[0];
    });
  }
  private async schedule(c: PoolClient, id: string, revision: number) {
    const rows: StepRow[] = (
      await c.query('SELECT * FROM pipeline_steps WHERE run_id=$1 AND revision=$2', [id, revision])
    ).rows;
    for (const row of rows) {
      if (row.step === 'upload' || row.status !== 'PENDING') continue;
      if (
        !DEPENDENCIES[row.step].every((d) => rows.find((s) => s.step === d)?.status === 'SUCCEEDED')
      )
        continue;
      await c.query(
        "UPDATE pipeline_steps SET status='QUEUED' WHERE run_id=$1 AND revision=$2 AND step=$3",
        [id, revision, row.step],
      );
      const w = { runId: id, revision, step: row.step };
      await c.query(
        'INSERT INTO outbox_events (id,run_id,revision,step) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [jobId(w), id, revision, row.step],
      );
    }
  }
  async outbox(): Promise<(Work & { id: string })[]> {
    const rows = (
      await this.pool.query(
        'SELECT * FROM outbox_events WHERE delivered_at IS NULL ORDER BY created_at LIMIT 100',
      )
    ).rows;
    return rows.map((r) => ({ id: r.id, runId: r.run_id, revision: r.revision, step: r.step }));
  }
  async delivered(id: string) {
    await this.pool.query('UPDATE outbox_events SET delivered_at=now() WHERE id=$1', [id]);
  }
  async claim(w: Work): Promise<{
    run: Run;
    token: string;
    attempt: number;
    outputs: Partial<Record<Step, any>>;
  } | null> {
    return this.tx(async (c) => {
      const run: Run = (await c.query('SELECT * FROM daily_runs WHERE id=$1 FOR UPDATE', [w.runId]))
        .rows[0];
      if (!run || run.revision !== w.revision || STOPPED.has(run.status)) return null;
      const rows: StepRow[] = (
        await c.query('SELECT * FROM pipeline_steps WHERE run_id=$1 AND revision=$2', [
          w.runId,
          w.revision,
        ])
      ).rows;
      const row = rows.find((s) => s.step === w.step);
      if (!row || row.status === 'SUCCEEDED') return null;
      if (
        !DEPENDENCIES[w.step].every((d) => rows.find((s) => s.step === d)?.status === 'SUCCEEDED')
      )
        return null;
      if (w.step === 'upload' && run.status !== 'UPLOADING') return null;
      const active = await c.query(
        "SELECT * FROM pipeline_steps WHERE run_id=$1 AND revision=$2 AND step=$3 AND status='RUNNING' AND lease_until>now()",
        [w.runId, w.revision, w.step],
      );
      if (active.rows.length) throw new Error('Step has an active lease');
      const outputs = Object.fromEntries(
        rows.filter((s) => s.status === 'SUCCEEDED').map((s) => [s.step, s.output]),
      );
      const token = randomUUID();
      await c.query(
        "UPDATE pipeline_steps SET status='RUNNING',attempts=attempts+1,lease_token=$4,lease_until=$5,started_at=now(),input_hash=$6 WHERE run_id=$1 AND revision=$2 AND step=$3",
        [
          w.runId,
          w.revision,
          w.step,
          token,
          new Date(Date.now() + 120_000),
          createHash('sha256').update(JSON.stringify(outputs)).digest('hex'),
        ],
      );
      await c.query(
        'UPDATE daily_runs SET status=$2,error_message=NULL,updated_at=now() WHERE id=$1',
        [w.runId, w.step === 'upload' ? 'UPLOADING' : 'RUNNING'],
      );
      return { run, token, attempt: row.attempts + 1, outputs };
    });
  }
  async heartbeat(w: Work, token: string) {
    await this.pool.query(
      'UPDATE pipeline_steps SET lease_until=$5 WHERE run_id=$1 AND revision=$2 AND step=$3 AND lease_token=$4',
      [w.runId, w.revision, w.step, token, new Date(Date.now() + 120_000)],
    );
  }
  async assertCurrent(w: Work, token: string) {
    const r = await this.pool.query(
      "SELECT s.run_id FROM pipeline_steps s JOIN daily_runs r ON r.id=s.run_id WHERE s.run_id=$1 AND s.revision=$2 AND s.step=$3 AND s.lease_token=$4 AND r.revision=$2 AND s.status='RUNNING' AND r.status IN ('RUNNING','UPLOADING')",
      [w.runId, w.revision, w.step, token],
    );
    if (!r.rows.length) throw new StaleWorkError('Run changed while step was executing');
  }
  async finish(
    w: Work,
    token: string,
    output: any,
    artifact: { path: string; checksum: string },
    status?: string,
  ) {
    return this.tx(async (c) => {
      const run: Run = (await c.query('SELECT * FROM daily_runs WHERE id=$1 FOR UPDATE', [w.runId]))
        .rows[0];
      const row = (
        await c.query('SELECT * FROM pipeline_steps WHERE run_id=$1 AND revision=$2 AND step=$3', [
          w.runId,
          w.revision,
          w.step,
        ])
      ).rows[0];
      if (run.revision !== w.revision || row.lease_token !== token || STOPPED.has(run.status))
        return;
      await c.query(
        "UPDATE pipeline_steps SET status='SUCCEEDED',output=$4,finished_at=now(),lease_until=NULL,error_message=NULL WHERE run_id=$1 AND revision=$2 AND step=$3",
        [w.runId, w.revision, w.step, JSON.stringify(output)],
      );
      await c.query(
        'INSERT INTO artifacts (id,run_id,revision,step,path,checksum) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), w.runId, w.revision, w.step, artifact.path, artifact.checksum],
      );
      await c.query(
        'INSERT INTO pipeline_logs (id,run_id,revision,step,level,message) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), w.runId, w.revision, w.step, 'info', 'Step completed'],
      );
      if (w.step === 'rank') {
        for (const n of output.selected as News[])
          await c.query(
            'INSERT INTO news_items (id,run_id,revision,canonical_url,selected,payload) VALUES ($1,$2,$3,$4,true,$5)',
            [randomUUID(), w.runId, w.revision, n.canonical_url, JSON.stringify(n)],
          );
      }
      if (status)
        await c.query('UPDATE daily_runs SET status=$2,updated_at=now() WHERE id=$1', [
          w.runId,
          status,
        ]);
      else await this.schedule(c, w.runId, w.revision);
    });
  }
  async fail(w: Work, token: string, message: string, terminal?: string) {
    await this.tx(async (c) => {
      await c.query('SELECT id FROM daily_runs WHERE id=$1 FOR UPDATE', [w.runId]);
      const current = (
        await c.query(
          'SELECT s.lease_token,r.revision,r.status FROM pipeline_steps s JOIN daily_runs r ON r.id=s.run_id WHERE s.run_id=$1 AND s.revision=$2 AND s.step=$3',
          [w.runId, w.revision, w.step],
        )
      ).rows[0];
      if (
        !current ||
        current.revision !== w.revision ||
        current.lease_token !== token ||
        STOPPED.has(current.status)
      )
        return;
      await c.query(
        'UPDATE pipeline_steps SET status=$4,error_message=$5,lease_until=NULL WHERE run_id=$1 AND revision=$2 AND step=$3',
        [w.runId, w.revision, w.step, terminal ? 'FAILED' : 'QUEUED', message],
      );
      if (terminal)
        await c.query(
          'UPDATE daily_runs SET status=$2,error_message=$3,updated_at=now() WHERE id=$1',
          [w.runId, terminal, message],
        );
      await c.query(
        'INSERT INTO pipeline_logs (id,run_id,revision,step,level,message) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), w.runId, w.revision, w.step, 'error', message],
      );
    });
  }
  async regenerate(id: string, revision: number, step: Step): Promise<Run> {
    return this.tx(async (c) => {
      const run: Run = (await c.query('SELECT * FROM daily_runs WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!run || run.revision !== revision) throw new PermanentError('Stale revision');
      if (['UPLOADING', 'UPLOAD_UNCERTAIN', 'UPLOADED_PRIVATE', 'PUBLISHED'].includes(run.status))
        throw new PermanentError('Cannot regenerate after upload starts; resolve upload first');
      const uploads = (
        await c.query("SELECT status FROM upload_attempts WHERE run_id=$1 AND status<>'REJECTED'", [
          id,
        ])
      ).rows;
      if (uploads.length)
        throw new PermanentError('An upload attempt exists; reconcile it before regeneration');
      const old: StepRow[] = (
        await c.query('SELECT * FROM pipeline_steps WHERE run_id=$1 AND revision=$2', [
          id,
          revision,
        ])
      ).rows;
      const invalid = descendants(step);
      invalid.add('approval');
      invalid.add('upload');
      const next = revision + 1;
      for (const s of STEPS) {
        const previous = old.find((v) => v.step === s)!;
        const reuse = !invalid.has(s) && previous.status === 'SUCCEEDED';
        await c.query(
          'INSERT INTO pipeline_steps (run_id,revision,step,status,output) VALUES ($1,$2,$3,$4,$5)',
          [
            id,
            next,
            s,
            reuse ? 'SUCCEEDED' : 'PENDING',
            reuse ? JSON.stringify(previous.output) : null,
          ],
        );
      }
      await c.query(
        "UPDATE daily_runs SET revision=$2,status='PENDING',error_message=NULL,updated_at=now() WHERE id=$1",
        [id, next],
      );
      await this.schedule(c, id, next);
      return { ...run, revision: next, status: 'PENDING', error_message: null };
    });
  }
  async publish(id: string, revision: number, actor: string) {
    return this.tx(async (c) => {
      const run: Run = (await c.query('SELECT * FROM daily_runs WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!run || run.revision !== revision) throw new PermanentError('Stale revision');
      if (['UPLOADING', 'UPLOADED_PRIVATE', 'PUBLISHED'].includes(run.status)) return run;
      if (run.status !== 'WAITING_APPROVAL')
        throw new PermanentError('Run is not awaiting approval');
      const rows: StepRow[] = (
        await c.query('SELECT * FROM pipeline_steps WHERE run_id=$1 AND revision=$2', [
          id,
          revision,
        ])
      ).rows;
      const qc = rows.find((s) => s.step === 'qc');
      if (
        qc?.status !== 'SUCCEEDED' ||
        !qc.output.hard_pass ||
        !rows.find((s) => s.step === 'verify')?.output.verified ||
        rows.find((s) => s.step === 'approval')?.status !== 'SUCCEEDED'
      )
        throw new PermanentError('Verification/QC/preview gate has not passed');
      const qcDate = (
        await c.query(
          "SELECT finished_at FROM pipeline_steps WHERE run_id=$1 AND revision=$2 AND step='qc'",
          [id, revision],
        )
      ).rows[0]?.finished_at;
      if (!qcDate || Date.now() - new Date(qcDate).getTime() > 86400000)
        throw new PermanentError(
          'Approval expired after 24 hours; regenerate script to reverify content',
        );
      if (actor === 'auto' && (!qc.output.auto_eligible || run.mock))
        throw new PermanentError('Auto-publish gate has not passed');
      await c.query(
        'INSERT INTO approvals (id,run_id,revision,actor,decision) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [randomUUID(), id, revision, actor, 'publish'],
      );
      await c.query("UPDATE daily_runs SET status='UPLOADING',updated_at=now() WHERE id=$1", [id]);
      await c.query(
        "UPDATE pipeline_steps SET status='QUEUED' WHERE run_id=$1 AND revision=$2 AND step='upload'",
        [id, revision],
      );
      await c.query(
        'INSERT INTO outbox_events (id,run_id,revision,step) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [jobId({ runId: id, revision, step: 'upload' }), id, revision, 'upload'],
      );
      return { ...run, status: 'UPLOADING' };
    });
  }
  async skip(id: string, revision: number, actor: string) {
    await this.tx(async (c) => {
      const run: Run = (await c.query('SELECT * FROM daily_runs WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!run || run.revision !== revision) throw new PermanentError('Stale revision');
      if (['UPLOADING', 'UPLOAD_UNCERTAIN', 'UPLOADED_PRIVATE', 'PUBLISHED'].includes(run.status))
        throw new PermanentError('Upload has already started');
      await c.query("UPDATE daily_runs SET status='SKIPPED',updated_at=now() WHERE id=$1", [id]);
      await c.query(
        'INSERT INTO approvals (id,run_id,revision,actor,decision) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [randomUUID(), id, revision, actor, 'skip'],
      );
    });
  }
  async previousNews(id: string): Promise<News[]> {
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const rows = await this.pool.query(
      "SELECT s.output FROM daily_runs r JOIN pipeline_steps s ON s.run_id=r.id AND s.revision=r.revision AND s.step='rank' WHERE r.id<>$1 AND r.mock=false AND r.run_date >= $2 AND r.status IN ('WAITING_APPROVAL','UPLOADING','UPLOAD_UNCERTAIN','UPLOADED_PRIVATE','PUBLISHED') AND s.status='SUCCEEDED' ORDER BY r.run_date DESC LIMIT 100",
      [id, cutoff],
    );
    return rows.rows.flatMap((r) => r.output?.selected || []);
  }

  async retry(id: string, revision: number, step: Step): Promise<Run> {
    return this.tx(async (c) => {
      const run: Run = (await c.query('SELECT * FROM daily_runs WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!run || run.revision !== revision) throw new PermanentError('Stale revision');
      if (run.status !== 'FAILED')
        throw new PermanentError(
          'Only FAILED runs can retry; revision/content failures need regenerate',
        );
      const row = (
        await c.query('SELECT * FROM pipeline_steps WHERE run_id=$1 AND revision=$2 AND step=$3', [
          id,
          revision,
          step,
        ])
      ).rows[0];
      if (!row || row.status !== 'FAILED') throw new PermanentError('Requested step is not failed');
      await c.query(
        "UPDATE pipeline_steps SET status='QUEUED',attempts=0,lease_token=NULL,lease_until=NULL,error_message=NULL WHERE run_id=$1 AND revision=$2 AND step=$3",
        [id, revision, step],
      );
      await c.query(
        "UPDATE outbox_events SET delivered_at=NULL WHERE run_id=$1 AND revision=$2 AND step IN (SELECT step FROM pipeline_steps WHERE run_id=$1 AND revision=$2 AND status='QUEUED')",
        [id, revision],
      );
      const status = step === 'upload' ? 'UPLOADING' : 'RUNNING';
      await c.query(
        'UPDATE daily_runs SET status=$2,error_message=NULL,updated_at=now() WHERE id=$1',
        [id, status],
      );
      return { ...run, status };
    });
  }
  async reserve(w: Work, model: string, usd: number, max: number): Promise<string> {
    return this.tx(async (c) => {
      const run = (await c.query('SELECT * FROM daily_runs WHERE id=$1 FOR UPDATE', [w.runId]))
        .rows[0];
      if (run.revision !== w.revision || STOPPED.has(run.status))
        throw new StaleWorkError('Run changed before API call');
      const sum = Number(
        (
          await c.query(
            'SELECT COALESCE(SUM(reserved_usd),0) AS total FROM api_costs WHERE run_id=$1',
            [w.runId],
          )
        ).rows[0].total,
      );
      if (max > 0 && sum + usd > max)
        throw new PermanentError('Run cost reservation limit reached');
      const id = randomUUID();
      await c.query(
        'INSERT INTO api_costs (id,run_id,revision,operation,model,reserved_usd) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, w.runId, w.revision, w.step, model, usd],
      );
      return id;
    });
  }
  async usage(id: string, usage: any) {
    await this.pool.query(
      'UPDATE api_costs SET input_tokens=$2,output_tokens=$3,provider_usage=$4 WHERE id=$1',
      [id, usage?.input_tokens ?? null, usage?.output_tokens ?? null, JSON.stringify(usage ?? {})],
    );
  }
  async upload(w: Work): Promise<any> {
    return (
      await this.pool.query('SELECT * FROM upload_attempts WHERE run_id=$1 AND revision=$2', [
        w.runId,
        w.revision,
      ])
    ).rows[0];
  }
  async saveUpload(
    w: Work,
    status: string,
    session: string | null,
    videoId: string | null = null,
    response: any = null,
  ) {
    await this.pool.query(
      'INSERT INTO upload_attempts (run_id,revision,status,session_uri,youtube_video_id,response) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (run_id,revision) DO UPDATE SET status=EXCLUDED.status,session_uri=EXCLUDED.session_uri,youtube_video_id=EXCLUDED.youtube_video_id,response=EXCLUDED.response,updated_at=now()',
      [w.runId, w.revision, status, session, videoId, JSON.stringify(response)],
    );
  }
  async recoverLeases() {
    await this.tx(async (c) => {
      const rows = (
        await c.query(
          "SELECT s.* FROM pipeline_steps s JOIN daily_runs r ON r.id=s.run_id WHERE s.revision=r.revision AND s.status='RUNNING' AND s.lease_until<now() AND r.status IN ('RUNNING','UPLOADING') FOR UPDATE OF s SKIP LOCKED",
        )
      ).rows;
      for (const r of rows) {
        await c.query(
          "UPDATE pipeline_steps SET status='QUEUED',lease_token=NULL WHERE run_id=$1 AND revision=$2 AND step=$3",
          [r.run_id, r.revision, r.step],
        );
        await c.query(
          'UPDATE outbox_events SET delivered_at=NULL WHERE run_id=$1 AND revision=$2 AND step=$3',
          [r.run_id, r.revision, r.step],
        );
      }
    });
  }
}
