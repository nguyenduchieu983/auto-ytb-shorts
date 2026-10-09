import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignNarration } from '../src/narration';
import { buildAss } from '../src/media';
import { Storyboard } from '../src/domain';
import { setup } from './helpers';
import { OpenAiProvider } from '../src/providers/openai';
import { mockNews } from '../src/mock';
const board = {
  scenes: [
    { scene_id: 1, narration: 'Xin chào Việt Nam.' },
    { scene_id: 2, narration: 'Tin mới hôm nay.' },
  ],
} as Storyboard;
const words = ['Xin', 'chào', 'Việt', 'Nam.', 'Tin', 'mới', 'hôm', 'nay.'].map((word, i) => ({
  word,
  start: i + 0.2,
  end: i + 0.8,
}));
test('Continuous voice alignment follows measured speech with pauses and preserves narration', () => {
  const result = alignNarration(board, words, 9);
  assert.equal(result.alignment_coverage, 1);
  assert.equal(result.timings[0].start, 0);
  assert.equal(result.timings[0].end, 4.2);
  assert.equal(result.timings[1].end, 9);
  assert.equal(result.words.map((w) => w.word).join(' '), 'Xin chào Việt Nam. Tin mới hôm nay.');
  const ass = buildAss(board, { path: '', duration: 9, mock: false, ...result });
  assert.match(ass, /0:00:00.20/);
  assert.match(ass, /\\kf/);
});
test('Alignment rejects unrelated transcription, invalid timestamps and missing whole scenes', () => {
  assert.throws(
    () => alignNarration(board, [{ word: 'unrelated', start: 0, end: 1 }], 9),
    /coverage/,
  );
  assert.throws(
    () => alignNarration(board, [{ word: 'Xin', start: NaN, end: 1 }], 9),
    /timestamps/,
  );
  assert.throws(
    () => alignNarration(board, words.slice(0, 4), 9),
    /scene 2 \(0%\): Tin mới hôm nay/,
  );
});
test('Alignment interpolates a small unmatched numeric span without changing spoken copy', () => {
  const partial = words.filter((_, i) => i !== 2);
  const result = alignNarration(board, partial, 9);
  assert.ok(result.words[2].start > result.words[1].start);
  assert.ok(result.words[2].start < result.words[3].start);
});
test('Event novelty removes cross-publisher repeats but retains a concrete new update', async () => {
  const { c, repo, pool } = await setup();
  c.MOCK_OPENAI = false;
  const news = mockNews(new Date()).slice(0, 3);
  const previous = [{ ...news[0], id: 'old' }];
  const provider = new OpenAiProvider(c, repo, {} as any);
  const runId = (await repo.create('2026-10-09', false)).id;
  (provider as any).structured = async () => ({
    decisions: [
      {
        id: news[0].id,
        decision: 'duplicate',
        matched_id: 'old',
        reason: 'Same launch, different headline',
      },
      {
        id: news[1].id,
        decision: 'update',
        matched_id: 'old',
        reason: 'New version actually released',
      },
      { id: news[2].id, decision: 'new', matched_id: null, reason: 'Different event' },
    ],
  });
  try {
    const result = await provider.filterRepeatedNews(
      { runId, revision: 1, step: 'rank' },
      news,
      previous,
    );
    assert.deepEqual(
      result.items.map((n) => n.id),
      [news[1].id, news[2].id],
    );
    (provider as any).structured = async () => ({ decisions: [] });
    await assert.rejects(
      provider.filterRepeatedNews({ runId, revision: 1, step: 'rank' }, news, previous),
      /incomplete after 3 passes/,
    );
  } finally {
    await pool.end();
  }
});
test('History uses current rank snapshot including carried-forward revision and waiting approval', async () => {
  const { repo, pool } = await setup();
  try {
    const today = new Date().toISOString().slice(0, 10),
      run = await repo.create(today, false);
    const news = mockNews(new Date()).slice(0, 1);
    await pool.query(
      "UPDATE pipeline_steps SET status='SUCCEEDED',output=$2 WHERE run_id=$1 AND step='rank'",
      [run.id, JSON.stringify({ selected: news })],
    );
    await pool.query("UPDATE daily_runs SET status='WAITING_APPROVAL' WHERE id=$1", [run.id]);
    assert.equal((await repo.previousNews('00000000-0000-0000-0000-000000000000')).length, 1);
    assert.equal((await repo.previousNews(run.id)).length, 0);
    await pool.query(
      "INSERT INTO pipeline_steps (run_id,revision,step,status,output) VALUES ($1,2,'rank','SUCCEEDED',$2)",
      [run.id, JSON.stringify({ selected: [{ ...news[0], id: 'current-revision-news' }] })],
    );
    await pool.query('UPDATE daily_runs SET revision=2 WHERE id=$1', [run.id]);
    const carried = await repo.previousNews('00000000-0000-0000-0000-000000000000');
    assert.equal(carried.length, 1);
    assert.equal(carried[0].id, 'current-revision-news');
    await pool.query("UPDATE daily_runs SET status='SKIPPED' WHERE id=$1", [run.id]);
    assert.equal((await repo.previousNews('00000000-0000-0000-0000-000000000000')).length, 0);
  } finally {
    await pool.end();
  }
});

test('Ranking repairs only unresolved IDs, rejects duplicate/unknown IDs and invalid scores, and saves responses', async () => {
  const { c, repo, pool } = await setup();
  c.MOCK_OPENAI = false;
  const news = mockNews(new Date()).slice(0, 3);
  const provider = new OpenAiProvider(c, repo, {} as any);
  const requests: string[][] = [];
  const score = (id: string) => ({
    id,
    novelty: 20,
    developer_interest: 20,
    mass_appeal: 15,
    practical_value: 15,
  });
  (provider as any).request = async (_w: any, _endpoint: string, body: any) => {
    const input = JSON.parse(body.input);
    requests.push(input.expected_ids);
    assert.ok(input.items.every((n: any) => n.evidence === undefined));
    const schema = body.text.format.schema.properties.scores;
    assert.equal(schema.minItems, input.expected_ids.length);
    assert.equal(schema.maxItems, input.expected_ids.length);
    assert.deepEqual(schema.items.properties.id.enum, input.expected_ids);
    const scores =
      requests.length === 1
        ? [score(news[0].id), score(news[1].id), score(news[1].id), score('unknown')]
        : requests.length === 2
          ? [score(news[1].id), { ...score(news[2].id), novelty: 100 }]
          : [score(news[2].id)];
    return { output: [{ content: [{ type: 'output_text', text: JSON.stringify({ scores }) }] }] };
  };
  const runId = (await repo.create('2026-10-09', false)).id;
  try {
    const result = await provider.rank({ runId, revision: 1, step: 'rank' }, news);
    assert.deepEqual(
      result.map((n) => n.id),
      news.map((n) => n.id),
    );
    assert.ok(result.every((n) => n.score === 70));
    assert.deepEqual(requests, [
      news.map((n) => n.id),
      news.slice(1).map((n) => n.id),
      [news[2].id],
    ]);
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(c.STORAGE_ROOT, 'diagnostics', runId, 'rev-1');
    const files = await readdir(dir);
    assert.equal(files.length, 3);
    assert.ok(
      (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).some((text) =>
        text.includes('unknown'),
      ),
    );
  } finally {
    await pool.end();
  }
});

test('Novelty preserves full candidate order across batches and repairs invalid backward references', async () => {
  const { c, repo, pool } = await setup();
  c.MOCK_OPENAI = false;
  const base = mockNews(new Date())[0];
  const news = Array.from({ length: 17 }, (_, i) => ({ ...base, id: `candidate-${i}` }));
  const provider = new OpenAiProvider(c, repo, {} as any);
  const runId = (await repo.create('2026-10-09', false)).id;
  const requests: string[][] = [];
  (provider as any).structured = async (_w: any, _name: string, _schema: any, input: any) => {
    requests.push(input.expected_ids);
    assert.deepEqual(
      input.candidate_order,
      news.map((n) => n.id),
    );
    assert.equal(input.candidate_context.length, 17);
    return {
      decisions: input.candidates.map((n: any) => ({
        id: n.id,
        decision: n.id === 'candidate-8' ? 'duplicate' : 'new',
        matched_id:
          n.id === 'candidate-8' ? (requests.length === 2 ? 'candidate-16' : 'candidate-0') : null,
        reason: 'Fixture event comparison',
      })),
    };
  };
  try {
    const result = await provider.filterRepeatedNews(
      { runId, revision: 1, step: 'rank' },
      news,
      [],
    );
    assert.deepEqual(
      requests.map((ids) => ids.length),
      [8, 8, 1, 1],
    );
    assert.deepEqual(requests[2], ['candidate-8']);
    assert.equal(result.decisions.length, 17);
    assert.equal(result.items.length, 16);
    assert.ok(!result.items.some((n) => n.id === 'candidate-8'));
  } finally {
    await pool.end();
  }
});

test('Ranking stops after three incomplete responses without fabricating scores', async () => {
  const { c, repo, pool } = await setup();
  c.MOCK_OPENAI = false;
  const news = mockNews(new Date()).slice(0, 2);
  const provider = new OpenAiProvider(c, repo, {} as any);
  const runId = (await repo.create('2026-10-09', false)).id;
  let calls = 0;
  (provider as any).structured = async () => {
    calls++;
    return { scores: [] };
  };
  try {
    await assert.rejects(
      provider.rank({ runId, revision: 1, step: 'rank' }, news),
      /incomplete after 3 passes; unresolved IDs/,
    );
    assert.equal(calls, 3);
  } finally {
    await pool.end();
  }
});

test('Storyboard locks every spoken token while the model designs visuals only', async () => {
  const { c, repo, pool } = await setup();
  c.MOCK_OPENAI = false;
  const news = mockNews(new Date()).slice(0, 3);
  const { mockScript } = await import('../src/mock');
  const script = mockScript(news),
    provider = new OpenAiProvider(c, repo, {} as any);
  (provider as any).structured = async (_w: any, _name: any, _schema: any, input: any) => ({
    scenes: [...input.scenes].reverse().map((s: any) => ({
      scene_id: s.scene_id,
      narration: 'Injected changed narration must be ignored',
      visual_type: 'headline-card',
      visual_prompt: 'Editorial',
      overlay_text: 'Tin',
      source_label: 'example.com',
    })),
  });
  try {
    const result = await provider.storyboard(
      { runId: 'x', revision: 1, step: 'storyboard' },
      script,
      news,
    );
    assert.equal(result.scenes.length, 10);
    assert.equal(result.scenes.map((s) => s.narration).join(' '), script.full_script);
    assert.deepEqual(
      result.scenes.map((s) => s.scene_id),
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
  } finally {
    await pool.end();
  }
});

test('Live voice uses one speech call plus multipart timestamp alignment for all scenes', async () => {
  const { c, repo, pool } = await setup();
  c.MOCK_OPENAI = false;
  const provider = new OpenAiProvider(c, repo, {
    probe: async () => ({ format: { duration: 55 } }),
  } as any);
  const { mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const dir = join(c.STORAGE_ROOT, randomUUID());
  await mkdir(dir, { recursive: true });
  const calls: string[] = [];
  (provider as any).request = async (_w: any, endpoint: string, body: any) => {
    calls.push(endpoint);
    if (endpoint === 'audio/speech') {
      assert.equal(body.input, board.scenes.map((s) => s.narration).join(' '));
      return Buffer.from('audio fixture');
    }
    assert.ok(body instanceof FormData);
    assert.equal(body.get('model'), 'whisper-1');
    assert.equal(body.get('timestamp_granularities[]'), 'word');
    return { words: words.map((w) => ({ ...w, start: w.start * 6, end: w.end * 6 })) };
  };
  try {
    const result = await provider.voice({ runId: 'x', revision: 1, step: 'voice' }, dir, board);
    assert.deepEqual(calls, ['audio/speech', 'audio/transcriptions']);
    assert.equal(result.timings.length, 2);
    assert.equal(result.alignment_coverage, 1);
  } finally {
    await pool.end(); /* Test artifacts intentionally remain under ignored storage. */
  }
});

test('Voice retries missing closing speech once and rejects a second incomplete recording', async () => {
  for (const recovered of [true, false]) {
    const { c, pool } = await setup();
    c.MOCK_OPENAI = false;
    const provider = new OpenAiProvider(
      c,
      { log: async () => {} } as any,
      {
        probe: async () => ({ format: { duration: 55 } }),
      } as any,
    );
    const { mkdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { randomUUID } = await import('node:crypto');
    const dir = join(c.STORAGE_ROOT, randomUUID());
    await mkdir(dir, { recursive: true });
    let speechCalls = 0,
      transcriptionCalls = 0;
    (provider as any).request = async (_w: any, endpoint: string, body: any) => {
      if (endpoint === 'audio/speech') {
        speechCalls++;
        assert.equal(body.input, board.scenes.map((s) => s.narration).join(' '));
        assert.match(body.instructions, /final question/);
        return Buffer.from('audio fixture');
      }
      transcriptionCalls++;
      return {
        words: (recovered && speechCalls === 2 ? words : words.slice(0, 4)).map((w) => ({
          ...w,
          start: w.start * 6,
          end: w.end * 6,
        })),
      };
    };
    try {
      const output = provider.voice({ runId: 'x', revision: 1, step: 'voice' }, dir, board);
      if (recovered) assert.equal((await output).alignment_coverage, 1);
      else await assert.rejects(output, /scene 2 \(0%\)/);
      assert.equal(speechCalls, 2);
      assert.equal(transcriptionCalls, 2);
      assert.match(await readFile(join(dir, 'alignment-pass-1.json'), 'utf8'), /scene 2/);
    } finally {
      await pool.end();
    }
  }
});
