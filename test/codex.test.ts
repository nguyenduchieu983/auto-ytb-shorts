import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setup } from './helpers';
import { loadConfig } from '../src/config';
import { CodexContent } from '../src/providers/codex';
import { OpenAiProvider } from '../src/providers/openai';
import { Media } from '../src/media';
import { mockNews, mockStoryboard, mockScript } from '../src/mock';
import { NewsDiscoveryService } from '../src/news/discovery';

test('Codex mode requires no Platform key and rejects paid provider when API spending disabled', async () => {
  const { c, pool } = await setup();
  try {
    assert.equal(
      loadConfig({
        ...c,
        MOCK_OPENAI: 'false',
        MOCK_YOUTUBE: 'true',
        MOCK_TELEGRAM: 'true',
        TELEGRAM_ENABLED: 'true',
        AUTO_PUBLISH: 'false',
        SCHEDULE_ENABLED: 'false',
        CONTENT_PROVIDER: 'codex',
        PAID_API_ENABLED: 'false',
        OPENAI_API_KEY: '',
      } as any).CONTENT_PROVIDER,
      'codex',
    );
    assert.throws(
      () =>
        loadConfig({
          ...c,
          MOCK_OPENAI: 'false',
          MOCK_YOUTUBE: 'true',
          MOCK_TELEGRAM: 'true',
          TELEGRAM_ENABLED: 'true',
          AUTO_PUBLISH: 'false',
          SCHEDULE_ENABLED: 'false',
          CONTENT_PROVIDER: 'openai',
          PAID_API_ENABLED: 'false',
          OPENAI_API_KEY: 'test',
        } as any),
      /PAID_API_ENABLED/,
    );
  } finally {
    await pool.end();
  }
});
test('Codex subprocess uses schema/stdin, strips credentials, records zero API USD and validated usage', async () => {
  const { c, repo, pool } = await setup();
  const run = await repo.create('2026-10-18', false, 'codex-stub');
  const claim = await repo.claim({ runId: run.id, revision: 1, step: 'discover' });
  assert.ok(claim);
  let calls = 0;
  const launch: any = (_binary: string, args: string[], options: any) => {
    calls++;
    assert.equal(options.shell, false);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.CODEX_API_KEY, undefined);
    assert.equal(options.env.DATABASE_URL, undefined);
    assert.ok(args.includes('--ignore-user-config') && args.includes('read-only'));
    assert.ok(args.includes('shell_tool') && args.includes('multi_agent'));
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    child.stdin.on('finish', async () => {
      const schema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
      assert.equal(schema.type, 'object');
      await writeFile(args[args.indexOf('-o') + 1], JSON.stringify({ message: 'Xin chào' }));
      child.stdout.write(
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } }) +
          '\n',
      );
      child.emit('close', 0);
    });
    return child;
  };
  try {
    const value = await new CodexContent(c, repo, launch).generate(
      { runId: run.id, revision: 1, step: 'discover' },
      'stub',
      { type: 'object' },
      'Return JSON',
      {},
    );
    assert.equal(value.message, 'Xin chào');
    assert.equal(calls, 1);
    const costs = (await repo.detail(run.id)).costs;
    assert.equal(Number(costs[0].reserved_usd), 0);
    assert.equal(costs[0].input_tokens, 12);
  } finally {
    await pool.end();
  }
});
test('Codex exhaustion stops without a paid API fallback', async () => {
  const { c, repo, pool } = await setup();
  const run = await repo.create('2026-10-18', false, 'codex-quota');
  const launch: any = () => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    child.stdin.on('finish', () => {
      child.stderr.write('usage limit reached');
      child.emit('close', 1);
    });
    return child;
  };
  try {
    await assert.rejects(
      new CodexContent(c, repo, launch).generate(
        { runId: run.id, revision: 1, step: 'discover' },
        'quota',
        { type: 'object' },
        '',
        {},
      ),
      /CODEX_QUOTA_EXHAUSTED/,
    );
  } finally {
    await pool.end();
  }
});
test('Codex discovery reads feeds and never invokes paid web search', async () => {
  const { c, pool } = await setup();
  c.CONTENT_PROVIDER = 'codex';
  c.PAID_API_ENABLED = false;
  let feedCalls = 0;
  const service = new NewsDiscoveryService(c, {} as any);
  service.searchWithOpenAI = async () => {
    throw new Error('Paid search must not run');
  };
  service.searchWithFallbackFeeds = async () => {
    feedCalls++;
    return mockNews(new Date());
  };
  try {
    assert.equal(
      (await service.discover({ runId: 'feed-only', revision: 1, step: 'discover' }, new Date()))
        .items.length,
      5,
    );
    assert.equal(feedCalls, 1);
  } finally {
    await pool.end();
  }
});
test('Paid API boundary refuses calls before reserving cost or sending HTTP; Codex visuals use local cards', async () => {
  const { c, repo, pool } = await setup();
  c.MOCK_OPENAI = false;
  c.CONTENT_PROVIDER = 'codex';
  c.PAID_API_ENABLED = false;
  const provider = new OpenAiProvider(c, repo, new Media(c));
  const savedFetch = globalThis.fetch;
  let http = 0;
  globalThis.fetch = async () => {
    http++;
    throw new Error('No network allowed');
  };
  try {
    await assert.rejects(
      (provider as any).request({ runId: 'x', revision: 1, step: 'voice' }, 'audio/speech', {}, 1),
      /disabled/,
    );
    const board = mockStoryboard(mockScript(mockNews(new Date()).slice(0, 1)));
    board.scenes[0].visual_type = 'image';
    const dir = resolve(c.STORAGE_ROOT, 'codex-local-card-test');
    await mkdir(dir, { recursive: true });
    const images = await provider.visuals({ runId: 'x', revision: 1, step: 'visuals' }, dir, board);
    assert.equal(images.images.length, board.scenes.length);
    assert.equal(http, 0);
  } finally {
    globalThis.fetch = savedFetch;
    await pool.end();
  }
});
