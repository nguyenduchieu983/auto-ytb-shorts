import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'dotenv';
import { setup } from './helpers';
import { YoutubeLogin } from '../src/youtube-login';
import { YoutubeProvider } from '../src/providers/youtube';
import { readYoutubeCredential, youtubeCredentialPath } from '../src/youtube-credentials';
import { Pipeline } from '../src/engine';
import { createApp } from '../src/main';
import { sessionCookie } from '../src/auth';

const channelId = 'UC' + 'a'.repeat(22),
  scope =
    'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';
async function fixture() {
  const { repo, pool, c } = await setup();
  c.STORAGE_ROOT = await mkdtemp(resolve('storage/tests/youtube-login-'));
  c.GOOGLE_CLIENT_ID = 'test-client';
  c.GOOGLE_CLIENT_SECRET = 'test-secret';
  c.YOUTUBE_REFRESH_TOKEN = 'old-refresh';
  const envPath = join(c.STORAGE_ROOT, 'settings.env');
  await writeFile(envPath, 'OTHER=value\nYOUTUBE_REFRESH_TOKEN=old-refresh\n');
  return { repo, pool, c, envPath };
}
function api(options: { channel?: string; refresh?: string; scope?: string } = {}) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const send: any = async (input: any, init: any) => {
    const url = String(input),
      body = new URLSearchParams(init?.body);
    calls.push({ url, body });
    if (url === 'https://oauth2.googleapis.com/token')
      return new Response(
        JSON.stringify(
          body.get('grant_type') === 'authorization_code'
            ? {
                refresh_token: options.refresh ?? 'new-refresh',
                access_token: 'initial-access',
                scope: options.scope ?? scope,
              }
            : { access_token: 'access-for-' + body.get('refresh_token'), expires_in: 3600 },
        ),
        { status: 200 },
      );
    assert.ok(url.startsWith('https://www.googleapis.com/youtube/v3/channels?'));
    return new Response(
      JSON.stringify({
        items: [{ id: options.channel || channelId, snippet: { title: 'Fixture channel' } }],
      }),
      { status: 200 },
    );
  };
  return { send, calls };
}
function callback(auth: string) {
  const u = new URL(auth);
  return (
    u.searchParams.get('redirect_uri') +
    '?state=' +
    u.searchParams.get('state') +
    '&code=fixture-code'
  );
}

test('YouTube OAuth validates state/PKCE and never saves even matching channel before explicit Apply; existing worker hot-reloads new token', async (t) => {
  const { repo, pool, c, envPath } = await fixture();
  c.YOUTUBE_CHANNEL_ID = channelId;
  const network = fetch,
    google = api();
  t.mock.method(globalThis, 'fetch', google.send);
  const workerConfig = { ...c },
    worker: any = new YoutubeProvider(workerConfig, repo);
  const login = new YoutubeLogin(c, google.send, envPath, 0);
  try {
    assert.equal(await worker.token(), 'access-for-old-refresh');
    const [a, b] = await Promise.all([login.start(), login.start()]);
    assert.equal(a.auth_url, b.auth_url);
    const u = new URL(a.auth_url!);
    assert.equal(u.origin, 'https://accounts.google.com');
    assert.equal(u.searchParams.get('access_type'), 'offline');
    const bad = await network(
      u.searchParams.get('redirect_uri') + '?state=wrong&code=fixture-code',
    );
    assert.equal(bad.status, 403);
    assert.equal(google.calls.length, 1); // Only worker's old-token refresh; invalid callback made no Google request.
    const result = await network(callback(a.auth_url!));
    assert.equal(result.status, 200);
    assert.equal(login.view().status, 'confirm');
    assert.equal(login.view().channel?.id, channelId);
    assert.equal(
      await readFile(envPath, 'utf8'),
      'OTHER=value\nYOUTUBE_REFRESH_TOKEN=old-refresh\n',
    );
    assert.equal(await readYoutubeCredential(c), null);
    assert.ok(!JSON.stringify(login.view()).includes('new-refresh'));
    assert.equal(await worker.token(), 'access-for-old-refresh');
    const exchange = google.calls.find((r) => r.body.get('grant_type') === 'authorization_code')!;
    assert.equal(
      createHash('sha256').update(exchange.body.get('code_verifier')!).digest('base64url'),
      u.searchParams.get('code_challenge'),
    );
    const saved = await login.apply();
    assert.equal(saved.status, 'succeeded');
    assert.equal(parse(await readFile(envPath, 'utf8')).YOUTUBE_REFRESH_TOKEN, 'new-refresh');
    assert.equal(parse(await readFile(envPath, 'utf8')).OTHER, 'value');
    assert.equal((await readYoutubeCredential(c))?.refresh_token, 'new-refresh');
    assert.equal(await worker.token(), 'access-for-new-refresh');
    assert.equal(workerConfig.YOUTUBE_REFRESH_TOKEN, 'old-refresh');
    const callsBefore = google.calls.length,
      credentials = (await readYoutubeCredential(c))!;
    await writeFile(
      youtubeCredentialPath(c),
      JSON.stringify({ ...credentials, updated_at: new Date(Date.now() + 1000).toISOString() }),
    );
    assert.equal(await worker.token(), 'access-for-new-refresh');
    assert.equal(google.calls.length, callsBefore + 1);
    assert.ok(google.calls.every((call) => !call.url.includes('/upload/')));
    await assert.rejects(login.apply(), /awaiting confirmation/);
  } finally {
    login.close();
    await pool.end();
  }
});
test('YouTube OAuth rejects wrong channels, missing refresh/scope and denial without overwriting credentials', async () => {
  const { pool, c, envPath } = await fixture();
  c.YOUTUBE_CHANNEL_ID = channelId;
  try {
    for (const options of [
      { channel: 'UC' + 'b'.repeat(22) },
      { refresh: '' },
      { scope: 'https://www.googleapis.com/auth/youtube.readonly' },
    ]) {
      const login = new YoutubeLogin(c, api(options).send, envPath, 0);
      try {
        const auth = (await login.start()).auth_url!;
        assert.equal((await fetch(callback(auth))).status, 400);
        assert.equal(login.view().status, 'failed');
        await assert.rejects(login.apply());
        assert.equal(await readYoutubeCredential(c), null);
      } finally {
        login.close();
      }
    }
    const login = new YoutubeLogin(c, api().send, envPath, 0);
    try {
      const u = new URL((await login.start()).auth_url!);
      assert.equal(
        (
          await fetch(
            u.searchParams.get('redirect_uri') +
              '?state=' +
              u.searchParams.get('state') +
              '&error=access_denied',
          )
        ).status,
        400,
      );
      assert.equal(login.view().status, 'failed');
    } finally {
      login.close();
    }
    assert.equal(parse(await readFile(envPath, 'utf8')).YOUTUBE_REFRESH_TOKEN, 'old-refresh');
  } finally {
    await pool.end();
  }
});
test('Verified YouTube credentials expire or cancel in memory and never silently fall back from a corrupt store', async () => {
  const { pool, c, envPath } = await fixture();
  const login = new YoutubeLogin(c, api().send, envPath, 0, 1000);
  try {
    let auth = (await login.start()).auth_url!;
    await fetch(callback(auth));
    login.cancel();
    assert.equal(login.view().status, 'cancelled');
    assert.equal(await readYoutubeCredential(c), null);
    auth = (await login.start()).auth_url!;
    await fetch(callback(auth));
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(login.view().status, 'expired');
    await assert.rejects(login.apply());
    await writeFile(youtubeCredentialPath(c), 'not-json');
    await assert.rejects(readYoutubeCredential(c), /invalid/);
  } finally {
    login.close();
    await pool.end();
  }
});
test('YouTube auth UI/API require session, CSRF protection and channel confirmation before Apply', async () => {
  const { pool, repo, c } = await fixture(),
    app = await createApp(new Pipeline(c, repo));
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  try {
    assert.equal((await fetch(url + '/dashboard/api/youtube/login')).status, 401);
    assert.equal(
      (await fetch(url + '/dashboard/api/youtube/login/start', { method: 'POST' })).status,
      401,
    );
    const headers = {
      Cookie: sessionCookie(c, false).split(';')[0],
      'Content-Type': 'application/json',
    };
    for (const action of ['start', 'apply', 'cancel'])
      assert.equal(
        (
          await fetch(url + '/dashboard/api/youtube/login/' + action, {
            method: 'POST',
            headers: { ...headers, Origin: 'https://other.example' },
            body: '{}',
          })
        ).status,
        403,
      );
    const status = await fetch(url + '/dashboard/api/youtube/login', { headers });
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.equal((await status.json()).status, 'idle');
    assert.equal(
      (
        await fetch(url + '/dashboard/api/youtube/login/apply', {
          method: 'POST',
          headers: { ...headers, Origin: url },
          body: '{}',
        })
      ).status,
      400,
    );
    const page = await fetch(url + '/dashboard').then((r) => r.text());
    assert.ok(page.includes('Kết nối lại YouTube'));
    assert.ok(page.includes('Dùng kênh này'));
  } finally {
    await app.close();
    await pool.end();
  }
});
test('A cancelled slow callback cannot stop a newer YouTube login or write credentials', async () => {
  const { pool, c, envPath } = await fixture(),
    google = api();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    seen = new Promise<void>((r) => {
      entered = r;
    });
  const send: any = async (input: any, init: any) => {
    if (new URLSearchParams(init?.body).get('grant_type') === 'authorization_code') {
      entered();
      await gate;
    }
    return google.send(input, init);
  };
  const login = new YoutubeLogin(c, send, envPath, 0);
  try {
    const old = (await login.start()).auth_url!,
      oldResponse = fetch(callback(old));
    await seen;
    login.cancel();
    const next = (await login.start()).auth_url!;
    assert.notEqual(old, next);
    release();
    assert.equal((await oldResponse).status, 410);
    assert.equal(login.view().status, 'waiting');
    const u = new URL(next);
    assert.equal(
      (await fetch(u.searchParams.get('redirect_uri') + '?state=wrong&code=x')).status,
      403,
    );
    assert.equal(await readYoutubeCredential(c), null);
    assert.equal(parse(await readFile(envPath, 'utf8')).YOUTUBE_REFRESH_TOKEN, 'old-refresh');
  } finally {
    release();
    login.close();
    await pool.end();
  }
});
