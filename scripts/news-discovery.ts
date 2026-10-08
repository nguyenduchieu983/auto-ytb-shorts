import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config';
import { Repository } from '../src/db';
import { Media } from '../src/media';
import { OpenAiProvider } from '../src/providers/openai';
import { PermanentError, Work } from '../src/domain';

async function main() {
  const c = loadConfig();
  if (c.MOCK_OPENAI)
    throw new Error('news:discover requires MOCK_OPENAI=false for a live acceptance test');
  const id = randomUUID(),
    dir = join(c.STORAGE_ROOT, 'discovery-live');
  await mkdir(dir, { recursive: true });
  const costs: {
    id: string;
    operation: string;
    model: string;
    reserved_usd: number;
    usage?: any;
  }[] = [];
  const record: any = { id, started_at: new Date().toISOString(), status: 'RUNNING', costs };
  const save = async () => {
    await writeFile(join(dir, id + '.json'), JSON.stringify(record, null, 2));
    await writeFile(join(dir, 'latest.json'), JSON.stringify(record, null, 2));
  };
  // Isolated live discovery audit: real provider calls, persistent usage ledger,
  // no daily-run state/queue changes and no media, Telegram or YouTube actions.
  const ledger = {
    reserve: async (w: Work, model: string, usd: number, max: number) => {
      if (max > 0 && costs.reduce((n, row) => n + row.reserved_usd, 0) + usd > max)
        throw new PermanentError('Run cost reservation limit reached');
      const entry = { id: randomUUID(), operation: w.step, model, reserved_usd: usd };
      costs.push(entry);
      await save();
      return entry.id;
    },
    usage: async (costId: string, usage: any) => {
      costs.find((row) => row.id === costId)!.usage = usage;
      await save();
    },
  } as unknown as Repository;
  const service = new OpenAiProvider(c, ledger, new Media(c)).newsDiscovery();
  try {
    const w: Work = { runId: id, revision: 1, step: 'discover' };
    const output = await service.discover(w, new Date());
    const ranked = await service.rank({ ...w, step: 'rank' }, output.items);
    const selected = service.selectTopNews(ranked);
    record.status = 'COMPLETE';
    record.counts = service.counts;
    record.items = ranked;
    record.selected_news = selected;
    for (const [label, value] of [
      ['RAW SOURCES', service.counts.rawSourcesCount],
      ['EXTRACTED', service.counts.extractedNewsCount],
      ['AFTER DATE FILTER', service.counts.afterDateFilterCount],
      ['AFTER DEDUP', service.counts.afterDedupCount],
      ['AFTER SOURCE FILTER', service.counts.afterSourceFilterCount],
      ['FINAL SELECTED', selected.length],
    ])
      console.log(`${label}: ${value}`);
    console.log(
      JSON.stringify(
        selected.map((n) => ({
          title: n.title,
          source: n.source,
          url: n.url,
          published_at: n.published_at,
          freshness_hours: n.freshness_hours,
        })),
        null,
        2,
      ),
    );
    console.log('Live discovery report:', join(dir, id + '.json'));
  } catch (error) {
    record.status = 'FAILED';
    record.counts = service.counts;
    record.error = error instanceof Error ? error.message : 'Discovery failed';
    throw error;
  } finally {
    record.finished_at = new Date().toISOString();
    await save();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Discovery failed');
  process.exitCode = 1;
});
