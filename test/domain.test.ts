import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalUrl,
  dedupNews,
  descendants,
  durationClass,
  jobId,
  selectNews,
} from '../src/domain';
import { localDate, loadConfig } from '../src/config';
import { mockNews, mockScript, mockStoryboard } from '../src/mock';
import { assText, buildAss } from '../src/media';
import { parseTelegramUpdate } from '../src/providers/telegram';
import { publishedDate, sourceAllowed } from '../src/providers/openai';

test('Timezone rollover uses Vietnamese calendar date', () => {
  assert.equal(localDate(new Date('2026-10-07T18:30:00Z'), 'Asia/Ho_Chi_Minh'), '2026-10-08');
});
test('Canonical URL strips tracking but preserves meaningful query parameters', () => {
  assert.equal(
    canonicalUrl('https://openai.com/news/?utm_source=x&v=2#part'),
    'https://openai.com/news/?v=2',
  );
});
test('Dedup preserves stronger source and removes previously published stories', () => {
  const items = mockNews(new Date()),
    weak = { ...items[0], url: 'https://theverge.com/story' },
    strong = { ...items[0], url: 'https://openai.com/story' };
  assert.equal(dedupNews([weak, strong])[0].url, strong.url);
  assert.equal(dedupNews([strong], [weak]).length, 0);
});
test('Selection picks one strongest verified topic, including a tool, without filling a roundup', () => {
  const items = mockNews(new Date());
  items.forEach((n) => {
    n.company = 'same';
    n.category = 'same';
  });
  assert.deepEqual(selectNews(items), [items[0]]);
  items[2].kind = 'tool';
  items[2].score = 100;
  assert.deepEqual(selectNews(items), [items[2]]);
  items[2].confidence = 0.7;
  assert.deepEqual(selectNews(items), [items[0]]);
  assert.throws(() => selectNews([]));
});
test('Regeneration invalidates dependent media, QC and upload', () => {
  const d = descendants('voice');
  assert.ok(d.has('subtitles') && d.has('render') && d.has('approval') && d.has('upload'));
  assert.ok(!d.has('visuals') && !d.has('script'));
  assert.ok(!jobId({ runId: 'abc', revision: 2, step: 'voice' }).includes(':'));
});
test('Duration QC treats target, review and invalid durations separately', () => {
  assert.equal(durationClass(55), 'pass');
  assert.equal(durationClass(42), 'review');
  assert.equal(durationClass(66), 'fail');
  assert.equal(durationClass(NaN), 'fail');
});
test('ASS sanitizes override injection and retains Vietnamese with bounded chunks', () => {
  assert.equal(assText('{\\pos(0,0)}xin chào'), 'pos(0,0)xin chào');
  const board = mockStoryboard(mockScript(mockNews(new Date()).slice(0, 3)));
  const timings = board.scenes.map((s, i) => ({
    scene_id: s.scene_id,
    start: i * 8,
    end: (i + 1) * 8,
  }));
  const ass = buildAss(board, { path: 'voice.mp3', duration: 48, mock: true, timings });
  assert.match(ass, /Đây/);
  assert.match(ass, /\\N/);
  assert.match(ass, /330,1/);
});
test('Live upload rejects mock content at startup', () => {
  assert.throws(
    () =>
      loadConfig({
        ADMIN_TOKEN: 'test-token-longer-than-thirty-two-characters',
        DATABASE_URL: 'postgres://x:x@localhost/x',
        REDIS_URL: 'redis://localhost',
        MOCK_YOUTUBE: 'false',
        GOOGLE_CLIENT_ID: 'x',
        GOOGLE_CLIENT_SECRET: 'x',
        YOUTUBE_REFRESH_TOKEN: 'x',
      }),
    /mock content/,
  );
});
test('Telegram requires both admin chat and admin user and exact revision', () => {
  const c = { TELEGRAM_ADMIN_CHAT_ID: '10', TELEGRAM_ADMIN_USER_IDS: '20' } as any;
  const u = { message: { chat: { id: 10 }, from: { id: 20 }, text: '/publish abc 2' } };
  assert.equal(parseTelegramUpdate(u, c).revision, 2);
  assert.throws(() =>
    parseTelegramUpdate({ ...u, message: { ...u.message, from: { id: 21 } } }, c),
  );
  assert.throws(() =>
    parseTelegramUpdate({ ...u, message: { ...u.message, text: '/publish abc' } }, c),
  );
});
test('Source fetch only accepts HTTPS allowlisted domains, not lookalikes', () => {
  assert.ok(sourceAllowed('https://blog.google/article'));
  assert.ok(!sourceAllowed('https://openai.com.attacker.test'));
  assert.ok(!sourceAllowed('http://openai.com'));
  assert.ok(!sourceAllowed('https://127.0.0.1'));
  assert.ok(!sourceAllowed('https://openai.com:8443'));
});
test('Freshness uses published date, never updated date', () => {
  assert.equal(
    publishedDate(
      '<script>{"dateModified":"2026-10-08","datePublished":"2026-10-01T10:00:00Z"}</script>',
    ),
    '2026-10-01T10:00:00.000Z',
  );
  assert.equal(publishedDate('{"dateModified":"2026-10-08"}'), null);
});
