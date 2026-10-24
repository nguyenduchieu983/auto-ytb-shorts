import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setup } from './helpers';
import { CodexLogin, validatedCodexAuthUrl } from '../src/codex-login';
import { codexEnvironment, resolveCodexBinary } from '../src/codex-runtime';
import { Pipeline } from '../src/engine';
import { createApp } from '../src/main';
import { sessionCookie } from '../src/auth';

function fakeServer(authUrl = 'https://auth.openai.com/oauth/authorize?state=fixture') {
  const calls: string[] = [];
  let launches = 0,
    child: any;
  const launch: any = (_path: string, args: string[], options: any) => {
    launches++;
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.DATABASE_URL, undefined);
    assert.ok(args.includes('app-server') && args.includes('forced_login_method="chatgpt"'));
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit('close', 0));
      return true;
    };
    child.stdin.on('data', (b: Buffer) => {
      const message = JSON.parse(b.toString());
      calls.push(message.method);
      if (message.id === undefined) return;
      const result =
        message.method === 'account/login/start'
          ? { type: 'chatgpt', loginId: 'fixture', authUrl }
          : message.method === 'account/read'
            ? {
                account: {
                  type: 'chatgpt',
                  email: 'private@example.test',
                  accessToken: 'must-not-leak',
                },
              }
            : {};
      child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
    });
    return child;
  };
  return {
    launch,
    calls,
    count: () => launches,
    child: () => child,
    complete: (success = true) =>
      child.stdout.write(
        JSON.stringify({
          method: 'account/login/completed',
          params: { loginId: 'fixture', success, error: success ? null : 'private error token' },
        }) + '\n',
      ),
  };
}
test('Codex sign-in starts one managed browser flow, reuses link and hides private auth data on completion', async () => {
  const { c, pool } = await setup();
  c.CONTENT_PROVIDER = 'codex';
  const fake = fakeServer();
  const login = new CodexLogin(c, fake.launch, async () => 'fixture-codex');
  try {
    const [a, b] = await Promise.all([login.start(), login.start()]);
    assert.equal(a.status, 'waiting');
    assert.equal(a.auth_url, b.auth_url);
    assert.equal(fake.count(), 1);
    await login.start();
    assert.equal(fake.count(), 1);
    assert.ok(a.expires_at);
    fake.complete();
    assert.equal(login.view().status, 'succeeded');
    assert.equal(login.view().auth_url, undefined);
    assert.equal(fake.child().killed, true);
    assert.deepEqual(fake.calls, ['initialize', 'initialized', 'account/login/start']);
    const check = await login.check();
    assert.equal(check.account_status, 'chatgpt');
    assert.ok(!JSON.stringify(check).includes('private@example'));
    assert.ok(!JSON.stringify(check).includes('accessToken'));
  } finally {
    login.close();
    await pool.end();
  }
});
test('Codex sign-in rejects redirects, handles cancellation and expires without exposing raw errors', async () => {
  for (const url of [
    'http://auth.openai.com/x',
    'https://auth.openai.com.evil.test/x',
    'https://auth.openai.com@evil.test/x',
    'https://chatgpt.com:123/x',
    'javascript:alert(1)',
  ])
    assert.throws(() => validatedCodexAuthUrl(url));
  const { c, pool } = await setup();
  c.CONTENT_PROVIDER = 'codex';
  const fake = fakeServer('https://evil.test/access_token=private');
  const login = new CodexLogin(c, fake.launch, async () => 'fixture', 20);
  try {
    assert.equal((await login.start()).status, 'failed');
    assert.ok(!JSON.stringify(login.view()).includes('private'));
    assert.equal(fake.child().killed, true);
  } finally {
    login.close();
  }
  const fake2 = fakeServer(),
    other = new CodexLogin(c, fake2.launch, async () => 'fixture', 20);
  try {
    await other.start();
    other.cancel();
    assert.equal(other.view().status, 'cancelled');
    assert.equal(fake2.child().killed, true);
    await other.start();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(other.view().status, 'expired');
    assert.equal(other.view().auth_url, undefined);
  } finally {
    other.close();
    await pool.end();
  }
});
test('Codex executable resolver recovers replaced desktop binaries and never forwards API credentials', async () => {
  const root = await mkdtemp(resolve('storage/tests/codex-resolve-'));
  await mkdir(join(root, 'old'));
  await mkdir(join(root, 'new'));
  const old = join(root, 'old', 'codex.exe'),
    next = join(root, 'new', 'codex.exe');
  await writeFile(old, 'fixture');
  await writeFile(next, 'fixture');
  await utimes(old, 1, 1);
  await utimes(next, 2, 2);
  assert.equal(
    await resolveCodexBinary({ CODEX_PATH: join(root, 'removed', 'codex.exe') }, root),
    next,
  );
  assert.equal(await resolveCodexBinary({ CODEX_PATH: old }, root), old);
  assert.equal(await resolveCodexBinary({ CODEX_PATH: 'codex' }, root), 'codex');
  assert.deepEqual(
    codexEnvironment({
      CODEX_HOME: 'profile',
      PATH: 'bin',
      OPENAI_API_KEY: 'secret',
      CODEX_ACCESS_TOKEN: 'secret',
      DATABASE_URL: 'secret',
    }),
    { PATH: 'bin', CODEX_HOME: 'profile' },
  );
});
test('Codex auth endpoints require dashboard auth and same-origin session mutations', async () => {
  const { c, repo, pool } = await setup();
  const app = await createApp(new Pipeline(c, repo));
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  try {
    for (const path of ['/dashboard/api/codex/login', '/dashboard/api/codex/login/start'])
      assert.equal(
        (await fetch(url + path, { method: path.endsWith('start') ? 'POST' : 'GET' })).status,
        401,
      );
    const headers = {
      Cookie: sessionCookie(c, false).split(';')[0],
      'Content-Type': 'application/json',
    };
    assert.equal(
      (
        await fetch(url + '/dashboard/api/codex/login/start', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://other.test' },
          body: '{}',
        })
      ).status,
      403,
    );
    const state = await fetch(url + '/dashboard/api/codex/login', { headers });
    assert.equal(state.status, 200);
    assert.equal(state.headers.get('cache-control'), 'no-store');
    assert.equal((await state.json()).status, 'idle');
    const cancelled = await fetch(url + '/dashboard/api/codex/login/cancel', {
      method: 'POST',
      headers: { ...headers, Origin: url },
      body: '{}',
    }).then((r) => r.json());
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(
      (await fetch(url + '/dashboard').then((r) => r.text())).includes('Đăng nhập lại Codex'),
    );
  } finally {
    await app.close();
    await pool.end();
  }
});
