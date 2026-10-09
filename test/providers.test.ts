import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { setup } from './helpers';
import { YoutubeProvider, uploadNetworkError } from '../src/providers/youtube';
import { OpenAiProvider } from '../src/providers/openai';
import { metadataSchema, UploadUncertainError } from '../src/domain';
import { mockNews, mockScript } from '../src/mock';

const metadata = metadataSchema.parse({
  title: 'Test',
  description: 'Test source',
  hashtags: ['#AI', '#Tech', '#Shorts'],
  tags: [],
});
async function video() {
  const dir = resolve('storage/tests');
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, randomUUID() + '.mp4');
  await writeFile(path, Buffer.alloc(20));
  return path;
}
const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('Resumable upload retries use the same session after lost completion response', async () => {
  const { repo, pool, c } = await setup();
  c.MOCK_YOUTUBE = false;
  c.GOOGLE_CLIENT_ID = 'test-client';
  c.GOOGLE_CLIENT_SECRET = 'test-secret';
  c.YOUTUBE_REFRESH_TOKEN = 'test-refresh';
  const run = await repo.create('2026-10-08', false),
    w = { runId: run.id, revision: 1, step: 'upload' as const },
    path = await video();
  const savedFetch = globalThis.fetch;
  let inserts = 0,
    statusChecks = 0,
    putCalls = 0;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes('oauth2.googleapis.com'))
      return json({ access_token: 'token', expires_in: 3600 });
    if (init?.method === 'POST') {
      inserts++;
      return new Response(null, {
        status: 200,
        headers: {
          Location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=session',
        },
      });
    }
    if (init?.headers['Content-Range'] === 'bytes */20') {
      statusChecks++;
      return statusChecks === 1
        ? new Response(null, { status: 308 })
        : json({ id: 'abcdefghijk', status: { privacyStatus: 'private' } });
    }
    putCalls++;
    throw new TypeError('simulated network loss after YouTube received file');
  };
  try {
    const provider = new YoutubeProvider(c, repo);
    await assert.rejects(provider.publish(w, path, metadata, false), /chunk transfer failed/);
    const result = await provider.publish(w, path, metadata, false);
    assert.equal(result.video_id, 'abcdefghijk');
    assert.equal(inserts, 1);
    assert.equal(putCalls, 1);
    assert.equal(statusChecks, 2);
    assert.equal((await repo.upload(w)).youtube_video_id, 'abcdefghijk');
  } finally {
    globalThis.fetch = savedFetch;
    await pool.end();
  }
});
test('Unknown upload initiation never automatically creates a second session', async () => {
  const { repo, pool, c } = await setup();
  c.MOCK_YOUTUBE = false;
  c.GOOGLE_CLIENT_ID = 'client';
  c.GOOGLE_CLIENT_SECRET = 'secret';
  c.YOUTUBE_REFRESH_TOKEN = 'refresh';
  const run = await repo.create('2026-10-08', false),
    w = { runId: run.id, revision: 1, step: 'upload' as const },
    path = await video();
  const savedFetch = globalThis.fetch;
  let inserts = 0;
  globalThis.fetch = async (input: any) => {
    if (String(input).includes('oauth2.googleapis.com'))
      return json({ access_token: 'token', expires_in: 3600 });
    inserts++;
    throw new TypeError('lost initiation');
  };
  try {
    const provider = new YoutubeProvider(c, repo);
    await assert.rejects(provider.publish(w, path, metadata, false), UploadUncertainError);
    await assert.rejects(provider.publish(w, path, metadata, false), UploadUncertainError);
    assert.equal(inserts, 1);
  } finally {
    globalThis.fetch = savedFetch;
    await pool.end();
  }
});
test('YouTube honors byte offset returned by resumable status check', async () => {
  const { repo, pool, c } = await setup();
  c.MOCK_YOUTUBE = false;
  c.GOOGLE_CLIENT_ID = 'client';
  c.GOOGLE_CLIENT_SECRET = 'secret';
  c.YOUTUBE_REFRESH_TOKEN = 'refresh';
  const run = await repo.create('2026-10-08', false),
    w = { runId: run.id, revision: 1, step: 'upload' as const },
    path = await video();
  await repo.saveUpload(
    w,
    'UPLOADING',
    'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=session',
  );
  const savedFetch = globalThis.fetch;
  let range = '';
  globalThis.fetch = async (input: any, init?: any) => {
    if (String(input).includes('oauth2.googleapis.com'))
      return json({ access_token: 'token', expires_in: 3600 });
    if (init.headers['Content-Range'] === 'bytes */20')
      return new Response(null, { status: 308, headers: { Range: 'bytes=0-9' } });
    range = init.headers['Content-Range'];
    return json({ id: 'abcdefghijk', status: { privacyStatus: 'private' } });
  };
  try {
    await new YoutubeProvider(c, repo).publish(w, path, metadata, false);
    assert.equal(range, 'bytes 10-19/20');
  } finally {
    globalThis.fetch = savedFetch;
    await pool.end();
  }
});
test('OpenAI discovery only accepts cited source snapshots with real publication metadata', async () => {
  const { repo, pool, c } = await setup();
  c.MOCK_OPENAI = false;
  c.OPENAI_API_KEY = 'test-key';
  const run = await repo.create('2026-10-08', false),
    w = { runId: run.id, revision: 1, step: 'discover' as const },
    now = new Date('2026-10-08T06:00:00Z');
  const savedFetch = globalThis.fetch;
  let requestCount = 0;
  const item = {
    id: 'temporary',
    title: 'A sourced test announcement',
    source: 'OpenAI',
    url: 'https://openai.com/test-announcement',
    canonical_url: 'https://openai.com/test-announcement',
    published_at: '2000-01-01T00:00:00Z',
    event_date: null,
    summary: 'A new test feature is announced for developers.',
    evidence: 'A new test feature is announced for developers.',
    why_it_matters: 'Useful test',
    category: 'coding',
    company: 'OpenAI',
    kind: 'news',
    confidence: 1,
    older_than_24h: false,
    score: 0,
  };
  globalThis.fetch = async (input: any, init?: any) => {
    if (String(input).startsWith('https://openai.com/'))
      return new Response(
        '<script type="application/ld+json">{"datePublished":"2026-10-08T05:00:00Z"}</script><article>A new test feature is announced for developers.</article>',
        { headers: { 'Content-Type': 'text/html' } },
      );
    requestCount++;
    const body = JSON.parse(init.body);
    if (requestCount === 1) {
      assert.equal(body.tools[0].type, 'web_search');
      assert.equal(body.tool_choice, 'required');
      assert.equal(body.tools[0].search_context_size, 'high');
      assert.equal(body.tools[0].external_web_access, true);
      assert.equal(body.tools[0].filters, undefined);
      assert.equal(body.text, undefined);
      assert.deepEqual(body.include, ['web_search_call.action.sources']);
      return json({
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 20 },
        output: [{ type: 'web_search_call', action: { sources: [{ url: item.url }] } }],
      });
    }
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.schema.properties.items.items.properties.url.type, 'string');
    assert.equal(body.text.format.schema.properties.items.items.properties.url.format, undefined);
    return json({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ items: [item] }) }] }],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
  };
  try {
    const items = await new OpenAiProvider(c, repo, {} as any).discover(
      w,
      now,
      24,
      async (url) => ({
        url,
        body: '<script type="application/ld+json">{"datePublished":"2026-10-08T05:00:00Z"}</script><article>A new test feature is announced for developers.</article>',
        contentType: 'text/html',
      }),
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].published_at, '2026-10-08T05:00:00.000Z');
    assert.notEqual(items[0].id, 'temporary');
    assert.equal(requestCount, 2);
    assert.equal((await repo.detail(run.id)).costs.length, 2);
  } finally {
    globalThis.fetch = savedFetch;
    await pool.end();
  }
});

test('Discovery rejects a text answer without an actual web search call', async () => {
  const { repo, pool, c } = await setup();
  c.MOCK_OPENAI = false;
  c.OPENAI_API_KEY = 'test-key';
  const run = await repo.create('2026-10-08', false);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    json({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'No recent news.' }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  try {
    await assert.rejects(
      new OpenAiProvider(c, repo, {} as any).discover(
        { runId: run.id, revision: 1, step: 'discover' },
        new Date('2026-10-08T06:00:00Z'),
        24,
      ),
      /no web_search_call/,
    );
  } finally {
    globalThis.fetch = savedFetch;
    await pool.end();
  }
});

test('Live narration preserves the source date for older news', async () => {
  const { repo, pool, c } = await setup();
  c.MOCK_OPENAI = false;
  const news = mockNews(new Date('2026-10-01T14:00:00Z')).slice(0, 3);
  for (const item of news) {
    item.published_at = '2026-10-01T14:00:00Z';
    item.older_than_24h = true;
  }
  const provider = new OpenAiProvider(c, repo, {} as any);
  (provider as any).structured = async () => ({
    ...mockScript(news),
    hook: 'Tin mới',
    segments: news.map((n) => ({
      news_id: n.id,
      narration: Array(33).fill('tin').join(' '),
      headline: n.title,
      key_takeaway: '',
    })),
    takeaway: '',
    cta: 'Theo dõi',
  });
  try {
    const output = await provider.script({ runId: 'test', revision: 1, step: 'script' }, news);
    for (const segment of output.segments) {
      assert.ok(segment.narration.includes('01/10/2026'));
      assert.ok(output.full_script.includes(segment.narration));
    }
  } finally {
    await pool.end();
  }
});

test('OpenAI errors preserve actionable details without leaking credentials', async () => {
  const { repo, pool, c } = await setup();
  c.MOCK_OPENAI = false;
  c.OPENAI_API_KEY = 'secret-test-key';
  const run = await repo.create('2026-10-08', false);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    json(
      {
        error: {
          type: 'invalid_request_error',
          code: 'unsupported_parameter',
          param: 'tool_choice',
          message: 'Unsupported tool_choice; credential secret-test-key',
        },
      },
      400,
    );
  try {
    await assert.rejects(
      new OpenAiProvider(c, repo, {} as any).discover(
        { runId: run.id, revision: 1, step: 'discover' },
        new Date('2026-10-08T06:00:00Z'),
        24,
      ),
      (error: any) => {
        assert.match(error.message, /HTTP 400.*Unsupported tool_choice/);
        assert.match(error.message, /param: tool_choice/);
        assert.ok(!error.message.includes(c.OPENAI_API_KEY));
        return true;
      },
    );
    const dir = resolve(c.STORAGE_ROOT, 'diagnostics', run.id, 'rev-1');
    const file = (await readdir(dir)).find((name) => name.startsWith('api-error-'))!;
    const diagnostic = await readFile(resolve(dir, file), 'utf8');
    assert.ok(!diagnostic.includes(c.OPENAI_API_KEY));
    assert.equal(JSON.parse(diagnostic).code, 'unsupported_parameter');
  } finally {
    globalThis.fetch = savedFetch;
    await pool.end();
  }
});

test('Strict URI compatibility keeps local URL validation', async () => {
  const { repo, pool, c } = await setup();
  c.MOCK_OPENAI = false;
  c.OPENAI_API_KEY = 'test-key';
  const run = await repo.create('2026-10-08', false);
  const schema = z.object({ sources: z.array(z.object({ url: z.string().url() })) });
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (_input: any, init?: any) => {
    const body = JSON.parse(init.body);
    const urlSchema = body.text.format.schema.properties.sources.items.properties.url;
    assert.equal(urlSchema.type, 'string');
    assert.equal(urlSchema.format, undefined);
    return json({
      status: 'completed',
      usage: {},
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({ sources: [{ url: 'not-a-url' }] }),
            },
          ],
        },
      ],
    });
  };
  try {
    await assert.rejects(
      (new OpenAiProvider(c, repo, {} as any) as any).structured(
        { runId: run.id, revision: 1, step: 'discover' },
        'news-extract',
        schema,
        {},
      ),
      /Invalid structured output/,
    );
  } finally {
    globalThis.fetch = savedFetch;
    await pool.end();
  }
});

test('Script rewrites oversized narration and counts final fields instead of claimed full_script', async () => {
  const { repo, pool, c } = await setup();
  c.MOCK_OPENAI = false;
  const news = mockNews(new Date()).slice(0, 1);
  const provider = new OpenAiProvider(c, repo, {} as any);
  let calls = 0;
  const issues = { unsupported_claims: [{ claim: 'example', reason: 'unsupported' }] };
  (provider as any).structured = async (_w: any, _name: any, _schema: any, input: any) => {
    calls++;
    assert.deepEqual(input.issues, issues);
    assert.equal(input.editorial_brief.format, 'single-story-explainer');
    assert.equal(input.news.length, 1);
    assert.equal(input.news[0].evidence, news[0].evidence);
    if (calls === 2) {
      assert.equal(input.narration_budget.previous_word_count, 387);
      assert.match(input.narration_budget.correction, /REMOVE AT LEAST 257 tokens/);
      assert.equal(input.previous.full_script.split(/\s+/).length, 387);
    }
    return {
      ...mockScript(news),
      hook: 'Tin',
      takeaway: '',
      cta: '',
      full_script: 'short misleading field',
      segments: [
        {
          news_id: news[0].id,
          narration: Array(calls === 1 ? 386 : 139)
            .fill('tin')
            .join(' '),
          headline: '',
          key_takeaway: '',
        },
      ],
    };
  };
  try {
    const result = await provider.script(
      { runId: 'test', revision: 1, step: 'script' },
      news,
      undefined,
      issues,
    );
    assert.equal(calls, 2);
    assert.equal(result.full_script.split(/\s+/).length, 140);
    assert.ok(result.estimated_duration_sec < 60);
  } finally {
    await pool.end();
  }
});

test('Script stops after bounded attempts when narration is too short or too long', async () => {
  const { repo, pool, c } = await setup();
  c.MOCK_OPENAI = false;
  const news = mockNews(new Date()).slice(0, 1);
  const provider = new OpenAiProvider(c, repo, {} as any);
  try {
    for (const words of [10, 387]) {
      let calls = 0;
      (provider as any).structured = async () => {
        calls++;
        return {
          ...mockScript(news),
          hook: 'Tin',
          takeaway: '',
          cta: '',
          segments: [
            {
              news_id: news[0].id,
              narration: Array(words).fill('tin').join(' '),
              headline: '',
              key_takeaway: '',
            },
          ],
        };
      };
      await assert.rejects(
        provider.script({ runId: 'test', revision: 1, step: 'script' }, news),
        /after 3 attempts/,
      );
      assert.equal(calls, 3);
    }
  } finally {
    await pool.end();
  }
});

test('Upload network diagnostics retain safe cause codes without leaking session URLs', () => {
  const error = new TypeError(
    'fetch failed https://www.googleapis.com/upload/youtube?secret=token',
    { cause: { code: 'ECONNRESET', message: 'secret-token' } },
  );
  assert.match(uploadNetworkError('chunk transfer', error).message, /ECONNRESET/);
  assert.ok(!uploadNetworkError('chunk transfer', error).message.includes('secret'));
});

test('YouTube PUT derives correct byte lengths with the application Cheerio/Undici dispatcher', async () => {
  await import('cheerio');
  const { createServer } = await import('node:http');
  const received: { length: string | undefined; bytes: number }[] = [];
  const server = createServer(async (req, res) => {
    let bytes = 0;
    for await (const chunk of req) bytes += chunk.length;
    received.push({ length: req.headers['content-length'], bytes });
    res.writeHead(308);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { repo, pool, c } = await setup();
  const provider = new YoutubeProvider(c, repo) as any;
  provider.token = async () => 'test-token';
  try {
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/upload`;
    await provider.request(url, new Uint8Array(), 'bytes */3');
    await provider.request(url, new Uint8Array([1, 2, 3]), 'bytes 0-2/3');
    assert.deepEqual(received, [{ length: '0', bytes: 0 }, { length: '3', bytes: 3 }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await pool.end();
  }
});
