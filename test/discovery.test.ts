import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers';
import {
  NewsDiscoveryService,
  DiscoveryAI,
  responseSources,
  responseText,
} from '../src/news/discovery';
import {
  parsePublishedDate,
  publishedDate,
  parseFeed,
  sourceAllowed,
  snapshot,
  publicAddress,
  fallbackFeeds,
} from '../src/news/sources';
import { mockNews } from '../src/mock';

const now = new Date('2026-10-08T08:00:00Z');
const w = { runId: 'discovery-test', revision: 1, step: 'discover' as const };
const article =
  '<h1>AI coding tool announcement</h1><article><p>A coding agent now supports local tools and private repositories.</p><p>Teams can use the tools to automate their development work.</p></article>';
const extracted = (url: string, i = 0) => ({
  title: `AI coding tool announcement ${i}`,
  source: 'Test publisher',
  url,
  published_at: null,
  summary: 'Một công cụ lập trình hỗ trợ nhóm phát triển.',
  why_it_matters: 'Công cụ cho lập trình viên.',
  category: 'developer-tools',
  company: `company-${i}`,
  kind: 'news' as const,
  confidence: 0.9,
});
const searchResponse = (urls: string[]) => ({
  id: 'response-test',
  output: [
    {
      type: 'web_search_call',
      status: 'completed',
      action: { sources: urls.map((url) => ({ url })) },
    },
    { type: 'message', content: [{ type: 'output_text', text: 'Live news answer.' }] },
  ],
});
test('Raw sources include all tool sources and citations, not only the first output', () => {
  const response = searchResponse(['https://example.com/a']);
  (response.output as any[]).push({
    type: 'message',
    content: [
      {
        type: 'output_text',
        text: 'Second answer.',
        annotations: [{ type: 'url_citation', url: 'https://example.com/b' }],
      },
    ],
  });
  assert.equal(responseSources(response).length, 2);
  assert.match(responseText(response), /Live news answer.*\nSecond answer/);
});
test('Publication parser supports ISO, date-only, textual, missing timezone and unknown dates', () => {
  for (const input of [
    '2026-10-07T18:45:28Z',
    '2026-10-07T18:45:28',
    'October 7, 2026 18:45:28 UTC',
  ])
    assert.equal(parsePublishedDate(input), '2026-10-07T18:45:28.000Z');
  assert.equal(parsePublishedDate('2026-10-07'), '2026-10-07T00:00:00.000Z');
  assert.equal(parsePublishedDate('October 7, 2026'), '2026-10-07T00:00:00.000Z');
  assert.equal(parsePublishedDate('unknown'), null);
  assert.equal(parsePublishedDate('2026-02-30'), null);
  assert.equal(
    publishedDate(
      '<script type="application/ld+json">{"@graph":[{"dateModified":"2026-10-08"},{"datePublished":"October 7, 2026"}]}</script>',
    ),
    '2026-10-07T00:00:00.000Z',
  );
  assert.equal(
    publishedDate('<time datetime="2026-10-07T10:00:00">Published</time>'),
    '2026-10-07T10:00:00.000Z',
  );
  assert.equal(publishedDate('<meta property="article:modified_time" content="2026-10-08">'), null);
});
test('Source preference does not block an unrelated valid publisher; internal addresses stay blocked', () => {
  assert.ok(sourceAllowed('https://independentpublisher.org/article'));
  assert.ok(!sourceAllowed('https://localhost/article'));
  assert.ok(!sourceAllowed('https://127.0.0.1/article'));
  assert.ok(!sourceAllowed('https://user:secret@example.com/article'));
  assert.ok(!publicAddress('10.0.0.1'));
  assert.ok(!publicAddress('169.254.169.254'));
  assert.ok(!publicAddress('::ffff:127.0.0.1'));
  assert.ok(publicAddress('8.8.8.8'));
});
test('HTML parser decodes entities and retains readable articles with unknown dates', () => {
  const source = snapshot(
    {
      url: 'https://example.com/article',
      body: article.replace('local tools', 'local tools &amp; APIs'),
      contentType: 'text/html',
    },
    'https://example.com/article?utm_source=x',
  );
  assert.ok(source.text.includes('local tools & APIs'));
  assert.equal(source.published_at, null);
  assert.equal(source.aliases[0], 'https://example.com/article');
  assert.throws(
    () =>
      snapshot(
        {
          url: 'https://example.com/ai-release-tracker/2026/10',
          body: article,
          contentType: 'text/html',
        },
        'https://example.com/ai-release-tracker/2026/10',
      ),
    /listing_page/,
  );
  assert.throws(
    () =>
      snapshot(
        { url: 'https://example.com/archives/2026/10', body: article, contentType: 'text/html' },
        'https://example.com/archives/2026/10',
      ),
    /listing_page/,
  );
});
test('RSS and Atom keep published date, never substitute updated date', () => {
  assert.equal(
    parseFeed(
      '<rss><channel><item><title>AI code examples</title><link>https://example.com/code</link><description><![CDATA[Example: <!DOCTYPE html>]]></description></item></channel></rss>',
      'https://example.com/feed',
      'Example',
    ).length,
    1,
  );
  assert.throws(
    () =>
      parseFeed('<!DOCTYPE rss [<!ENTITY x "bad">]><rss/>', 'https://example.com/feed', 'Example'),
    /unsupported_feed_entities/,
  );
  assert.equal(
    parseFeed(
      '<rss><channel><item><title>AI news</title><link>https://example.com/a</link><pubDate>Wed, 07 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>',
      'https://example.com/feed',
      'Example',
    )[0].published_at,
    '2026-10-07T10:00:00.000Z',
  );
  const rows = parseFeed(
    '<feed><entry><title>Tool</title><link rel="self" href="/api"/><link rel="alternate" href="/tool"/><updated>2026-10-07</updated></entry></feed>',
    'https://example.com/feed',
    'Example',
  );
  assert.equal(rows[0].url, 'https://example.com/tool');
  assert.equal(rows[0].published_at, null);
});
test('NVIDIA root-cause regression: an ellipsis in model evidence cannot discard a valid article', async () => {
  const { c, pool } = await setup();
  const url = 'https://blogs.nvidia.com/blog/local-ai-announcement';
  const ai: DiscoveryAI = {
    search: async () => searchResponse([url]),
    rank: async (_w, items) => items,
    extract: async () => ({
      items: [
        {
          ...extracted(url),
          evidence: 'A coding agent ... automate their development work.',
        } as any,
      ],
    }),
  };
  try {
    const service = new NewsDiscoveryService(c, ai, async (link) => ({
      url: link,
      body: '<meta property="article:published_time" content="2026-10-07T18:45:28Z">' + article,
      contentType: 'text/html',
    }));
    const items = await service.searchWithOpenAI(w, now, 48);
    assert.equal(items.length, 1);
    assert.ok(items[0].evidence.includes('supports local tools'));
    assert.ok(!items[0].evidence.includes('...'));
    assert.equal(service.validateNews(items, now, 48).length, 1);
  } finally {
    await pool.end();
  }
});
test('Unknown dates survive validation without pretending to be fresh', async () => {
  const { c, pool } = await setup();
  const url = 'https://independentpublisher.org/story';
  const ai: DiscoveryAI = {
    search: async () => searchResponse([url]),
    rank: async (_w, items) => items,
    extract: async () => ({ items: [extracted(url)] }),
  };
  try {
    const service = new NewsDiscoveryService(c, ai, async (link) => ({
      url: link,
      body: article,
      contentType: 'text/html',
    }));
    const items = service.validateNews(await service.searchWithOpenAI(w, now, 24), now, 24);
    assert.equal(items.length, 1);
    assert.equal(items[0].published_at, null);
    assert.equal(items[0].date_parse_failed, true);
    assert.equal(items[0].freshness_hours, null);
    assert.equal(items[0].older_than_24h, true);
  } finally {
    await pool.end();
  }
});
test('Zero web sources and zero extracted news have distinct explicit errors', async () => {
  const { c, pool } = await setup();
  const ai: DiscoveryAI = {
    search: async () => searchResponse([]),
    rank: async (_w, items) => items,
    extract: async () => ({ items: [] }),
  };
  try {
    await assert.rejects(
      new NewsDiscoveryService(c, ai).searchWithOpenAI(w, now, 24),
      /WEB_SEARCH_RETURNED_ZERO_SOURCES/,
    );
    ai.search = async () => searchResponse(['https://example.com/article']);
    await assert.rejects(
      new NewsDiscoveryService(c, ai, async (url) => ({
        url,
        body: article,
        contentType: 'text/html',
      })).searchWithOpenAI(w, now, 24),
      /NEWS_EXTRACTION_FAILED/,
    );
  } finally {
    await pool.end();
  }
});
test('Expansion reconsiders early candidates at 48/72h and survives broken RSS feeds', async () => {
  const { c, pool } = await setup();
  try {
    const service = new NewsDiscoveryService(c, {} as DiscoveryAI);
    const calls: number[] = [];
    const items = mockNews(now)
      .slice(0, 3)
      .map((n) => ({ ...n, published_at: '2026-10-05T12:00:00Z' }));
    service.searchWithOpenAI = async (_w, _now, hours) => {
      calls.push(hours);
      return hours === 24 ? items : [];
    };
    service.searchWithFallbackFeeds = async () => [];
    const output = await service.discover(w, now);
    assert.deepEqual(calls, [24, 48, 72]);
    assert.equal(output.items.length, 3);
    assert.equal(service.selectTopNews(output.items).length, 1);
  } finally {
    await pool.end();
  }
});
test('RSS fallback merges with web news; one broken feed does not abort others', async () => {
  const { c, pool } = await setup();
  const ai: DiscoveryAI = {
    search: async () => searchResponse([]),
    rank: async (_w, items) => items,
    extract: async (_w, input: any) => ({
      items: input.sources.map((s: any, i: number) => extracted(s.url, i)),
    }),
  };
  try {
    const service = new NewsDiscoveryService(c, ai, async (url) => {
      if (url.includes('anthropic')) throw new Error('http_404');
      if (url.includes('/story')) return { url, body: article, contentType: 'text/html' };
      return {
        url,
        body: `<rss><channel><item><title>New AI coding agent</title><link>${new URL(url).origin}/story</link><pubDate>Wed, 07 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`,
        contentType: 'application/rss+xml',
      };
    });
    const items = await service.searchWithFallbackFeeds(w, now);
    assert.ok(items.length >= 3);
    assert.ok(items.every((n) => n.published_at === '2026-10-07T10:00:00.000Z'));
  } finally {
    await pool.end();
  }
});
test('Selection picks exactly one highest-ranked event with confidence tie-break', async () => {
  const { c, pool } = await setup();
  try {
    const service = new NewsDiscoveryService(c, {} as DiscoveryAI);
    const items = mockNews(now).slice(0, 3);
    items[2].kind = 'tool';
    items[2].score = 100;
    assert.deepEqual(service.selectTopNews(items), [items[2]]);
    items[0].score = 100;
    items[2].confidence = 0.9;
    assert.deepEqual(service.selectTopNews(items), [items[0]]);
    assert.equal(service.selectTopNews(items.slice(0, 2)).length, 1);
    assert.equal(service.selectTopNews(items.slice(0, 1)).length, 1);
    assert.throws(() => service.selectTopNews([]), /NEWS_DISCOVERY_EMPTY/);
  } finally {
    await pool.end();
  }
});

test('RSS page budget still reaches added sources when every feed has five eligible articles', async () => {
  const { c, pool } = await setup();
  const pages: string[] = [];
  const service = new NewsDiscoveryService(
    c,
    {
      search: async () => searchResponse([]),
      rank: async (_w, items) => items,
      extract: async (_w, input: any) => ({
        items: input.sources.map((s: any, i: number) => extracted(s.url, i)),
      }),
    },
    async (url) => {
      if (url.includes('/story-')) {
        pages.push(url);
        return { url, body: article, contentType: 'text/html' };
      }
      const feedIndex = fallbackFeeds.findIndex((f) => f.url === url);
      assert.ok(feedIndex >= 0);
      return {
        url,
        contentType: 'application/rss+xml',
        body: `<rss><channel>${Array.from({ length: 5 }, (_, i) => `<item><title>${url.includes('vnexpress.net') ? 'Công cụ trí tuệ nhân tạo mới' : 'New AI developer agent'} ${i}</title><link>${new URL(url).origin}/feed-${feedIndex}/story-${i}</link><pubDate>Wed, 07 Oct 2026 10:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`,
      };
    },
  );
  try {
    await service.searchWithFallbackFeeds(w, now);
    assert.equal(pages.length, 30);
    for (const source of [
      'The Register',
      'The New Stack',
      'BleepingComputer',
      'AWS Machine Learning',
      'The Decoder',
      'ZDNet',
      'Hugging Face',
      'VnExpress Công nghệ',
    ]) {
      const index = fallbackFeeds.findIndex((f) => f.source === source);
      assert.ok(
        pages.some((url) => url.includes(`/feed-${index}/story-`)),
        `${source} must not be starved by earlier feeds`,
      );
    }
    assert.equal(new Set(pages).size, 30);
  } finally {
    await pool.end();
  }
});
