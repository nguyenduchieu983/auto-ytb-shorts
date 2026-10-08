import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup } from './helpers';
import { YoutubeProvider } from '../src/providers/youtube';
import { OpenAiProvider } from '../src/providers/openai';
import { metadataSchema, UploadUncertainError } from '../src/domain';

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
    await assert.rejects(provider.publish(w, path, metadata, false), /network loss/);
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
      return json({
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 20 },
        output: [{ type: 'web_search_call', action: { sources: [{ url: item.url }] } }],
      });
    }
    assert.equal(body.text.format.type, 'json_schema');
    return json({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ items: [item] }) }] }],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
  };
  try {
    const items = await new OpenAiProvider(c, repo, {} as any).discover(w, now, 24);
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
