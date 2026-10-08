import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { loadConfig } from '../src/config';
import { Repository } from '../src/db';
import { Media } from '../src/media';
import { OpenAiProvider } from '../src/providers/openai';
import { PermanentError, Work } from '../src/domain';

async function main() {
  const sourceId = process.argv[2];
  if (!sourceId) throw new Error('Usage: npm run video:preview -- <runId>');
  const c = loadConfig();
  const pool = new Pool({ connectionString: c.DATABASE_URL });
  const repo = new Repository(pool);
  const run = await repo.detail(sourceId).finally(() => pool.end());
  const news = run.steps.find((s) => s.step === 'rank')?.output?.selected;
  if (!news?.length) throw new Error('Run has no selected news');
  const id = randomUUID(),
    dir = join(c.STORAGE_ROOT, 'quality-preview', id);
  await mkdir(dir, { recursive: true });
  const report: any = {
    id,
    source_run: sourceId,
    source_revision: run.revision,
    costs: [],
    status: 'RUNNING',
    mock: c.MOCK_OPENAI,
  };
  const save = async () => writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  const ledger = {
    reserve: async (w: Work, model: string, usd: number, max: number) => {
      if (max > 0 && report.costs.reduce((n: number, r: any) => n + r.reserved_usd, 0) + usd > max)
        throw new PermanentError('Preview reservation limit reached');
      const row = { id: randomUUID(), operation: w.step, model, reserved_usd: usd };
      report.costs.push(row);
      await save();
      return row.id;
    },
    usage: async (id: string, usage: any) => {
      report.costs.find((r: any) => r.id === id).usage = usage;
      await save();
    },
  } as unknown as Repository;
  const media = new Media(c),
    ai = new OpenAiProvider(c, ledger, media);
  const w = (step: Work['step']): Work => ({ runId: id, revision: 1, step });
  try {
    let script = await ai.script(w('script'), news);
    for (let round = 0; round < 3; round++) {
      const verification = await ai.verify(w('verify'), news, script);
      if (!verification.needs_rewrite && !verification.unsupported_claims.length) {
        report.verification = verification;
        break;
      }
      if (round === 2) throw new Error('Preview facts still need revision');
      script = await ai.script(w('script'), news, script, verification);
    }
    report.script = script;
    await save();
    console.log('Script verified:', script.full_script.split(/\s+/).length, 'tokens');
    report.storyboard = await ai.storyboard(w('storyboard'), script, news);
    await save();
    report.voice = await ai.voice(w('voice'), dir, report.storyboard);
    await save();
    console.log(
      'Voice:',
      report.voice.duration,
      'seconds; alignment:',
      report.voice.alignment_coverage,
    );
    report.visuals = await ai.visuals(w('visuals'), dir, report.storyboard);
    await save();
    report.subtitles = await media.subtitles(dir, report.storyboard, report.voice);
    // Separate render directory avoids overwriting/copying its own input files.
    const renderDir = join(dir, 'render');
    await mkdir(renderDir);
    report.render = await media.render(renderDir, report.visuals, report.voice, report.subtitles);
    report.qc = await media.validate(report.render, report.subtitles, c.MOCK_OPENAI);
    if (!report.qc.hard_pass) throw new Error('Preview technical QC failed');
    report.status = 'COMPLETE';
    console.log('Preview:', report.render.path);
  } catch (e) {
    report.status = 'FAILED';
    report.error = e instanceof Error ? e.message : 'Unknown failure';
    throw e;
  } finally {
    await save();
    console.log('Report:', join(dir, 'report.json'));
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
