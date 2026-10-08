import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup } from './helpers';
import { Pipeline } from '../src/engine';
import { createApp } from '../src/main';
import { sessionCookie } from '../src/auth';

test('Dashboard sessions protect data, reject cross-origin mutations and support manual independent runs', async () => {
  const { pool, repo, c } = await setup();
  const app = await createApp(new Pipeline(c, repo));
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  try {
    const shell = await fetch(url + '/dashboard');
    assert.equal(shell.status, 200);
    assert.ok((await shell.text()).includes('Shorts Studio'));
    assert.ok(shell.headers.get('content-security-policy')?.includes("script-src 'self'"));
    assert.equal((await fetch(url + '/dashboard/api/runs')).status, 401);
    const post = (path: string, body: any, headers: any = {}) =>
      fetch(url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: url, ...headers },
        body: JSON.stringify(body),
      });
    assert.equal((await post('/dashboard/login', { token: 'wrong' })).status, 401);
    assert.equal(
      (
        await post(
          '/dashboard/login',
          { token: c.ADMIN_TOKEN },
          { Origin: 'https://other.example' },
        )
      ).status,
      403,
    );
    const login = await post('/dashboard/login', { token: c.ADMIN_TOKEN });
    assert.equal(login.status, 201);
    const setCookie = login.headers.get('set-cookie')!;
    assert.ok(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict'));
    assert.ok(!setCookie.includes(c.ADMIN_TOKEN));
    const cookie = setCookie.split(';')[0];
    assert.equal(
      (
        await fetch(url + '/dashboard/session', { headers: { Cookie: cookie } }).then((r) =>
          r.json(),
        )
      ).authenticated,
      true,
    );
    assert.equal(
      (
        await post(
          '/dashboard/api/runs',
          { request_key: randomUUID() },
          { Cookie: cookie, Origin: 'https://other.example' },
        )
      ).status,
      403,
    );
    const key = randomUUID();
    const first = await post('/dashboard/api/runs', { request_key: key }, { Cookie: cookie }).then(
      (r) => r.json(),
    );
    const again = await post('/dashboard/api/runs', { request_key: key }, { Cookie: cookie }).then(
      (r) => r.json(),
    );
    const next = await post(
      '/dashboard/api/runs',
      { request_key: randomUUID() },
      { Cookie: cookie },
    ).then((r) => r.json());
    assert.equal(first.id, again.id);
    assert.notEqual(first.id, next.id);
    const list = await fetch(url + '/dashboard/api/runs?status=PENDING&search=' + first.id, {
      headers: { Cookie: cookie },
    }).then((r) => r.json());
    assert.equal(list.total, 1);
    assert.equal(list.items[0].id, first.id);
    assert.equal(Number(list.summary[0].count), 2);
    const work = { runId: first.id, revision: 1, step: 'discover' as const };
    await repo.claim(work);
    const detail = await fetch(url + '/dashboard/api/runs/' + first.id, {
      headers: { Cookie: cookie },
    }).then((r) => r.json());
    assert.equal(detail.step_order.length, 13);
    assert.equal(detail.logs[0].message, 'Step started (attempt 1)');
    await repo.regenerate(first.id, 1, 'script');
    const history = await fetch(url + '/dashboard/api/runs/' + first.id + '?revision=1', {
      headers: { Cookie: cookie },
    }).then((r) => r.json());
    assert.equal(history.viewed_revision, 1);
    assert.equal(history.revision, 2);
    assert.deepEqual(history.revisions, [2, 1]);
    assert.equal(
      (
        await fetch(url + '/dashboard/api/runs/' + first.id + '?revision=99', {
          headers: { Cookie: cookie },
        })
      ).status,
      404,
    );
    assert.equal(
      (await post('/pipeline/' + first.id + '/publish', { revision: 1 }, { Cookie: cookie }))
        .status,
      400,
    );
    const tampered = cookie.slice(0, -1) + (cookie.endsWith('x') ? 'y' : 'x');
    assert.equal(
      (await fetch(url + '/dashboard/api/runs', { headers: { Cookie: tampered } })).status,
      401,
    );
    const expired = sessionCookie(c, false).split(';')[0];
    // Rotation invalidates existing sessions without changing bearer behavior.
    c.ADMIN_TOKEN = 'rotated-test-admin-token-with-32-characters';
    assert.equal(
      (await fetch(url + '/dashboard/api/runs', { headers: { Cookie: expired } })).status,
      401,
    );
  } finally {
    await app.close();
    await pool.end();
  }
});

test('Dashboard media supports authenticated byte ranges, redacts secrets and refuses outside files', async () => {
  const { pool, repo, c } = await setup();
  const app = await createApp(new Pipeline(c, repo));
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  try {
    const run = await repo.create('2026-10-08', true);
    const headers = { Authorization: `Bearer ${c.ADMIN_TOKEN}` };
    await mkdir(c.STORAGE_ROOT, { recursive: true });
    const path = resolve(c.STORAGE_ROOT, randomUUID() + '.mp4');
    await writeFile(path, Buffer.from('0123456789'));
    await pool.query(
      "UPDATE pipeline_steps SET status='SUCCEEDED',output=$2 WHERE run_id=$1 AND step='render'",
      [run.id, JSON.stringify({ path })],
    );
    await repo.log(
      { runId: run.id, revision: 1, step: 'render' },
      `secret ${c.ADMIN_TOKEN} ${c.DATABASE_URL}`,
    );
    const detail = await fetch(url + '/dashboard/api/runs/' + run.id, { headers }).then((r) =>
      r.json(),
    );
    assert.ok(!JSON.stringify(detail).includes(c.ADMIN_TOKEN));
    assert.ok(!JSON.stringify(detail).includes(c.DATABASE_URL));
    const asset = url + '/dashboard/api/runs/' + run.id + '/assets/1/render?kind=video';
    assert.equal((await fetch(asset)).status, 401);
    const ranged = await fetch(asset, { headers: { ...headers, Range: 'bytes=2-5' } });
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.text(), '2345');
    await pool.query("UPDATE pipeline_steps SET output=$2 WHERE run_id=$1 AND step='render'", [
      run.id,
      JSON.stringify({ path: resolve('.env') }),
    ]);
    assert.equal((await fetch(asset, { headers })).status, 404);
    assert.equal(
      (await fetch(asset.replace('kind=video', 'kind=anything'), { headers })).status,
      404,
    );
  } finally {
    await app.close();
    await pool.end();
  }
});
