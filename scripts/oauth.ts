import 'dotenv/config';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main() {
  const client = process.env.GOOGLE_CLIENT_ID,
    secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!client || !secret) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env');
  const redirect = 'http://127.0.0.1:8765/oauth/callback',
    state = randomBytes(32).toString('hex');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: client,
    redirect_uri: redirect,
    response_type: 'code',
    scope:
      'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString();
  console.log('Register this exact redirect URI on your Web OAuth client:', redirect);
  console.log('Open this consent URL in your browser:', url.toString());
  const code = await new Promise<string>((resolveCode, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('OAuth consent timed out'));
    }, 10 * 60_000);
    const server = createServer((req, res) => {
      const u = new URL(req.url || '/', redirect);
      if (u.pathname !== '/oauth/callback') {
        res.writeHead(404).end();
        return;
      }
      if (u.searchParams.get('state') !== state) {
        res.writeHead(403).end('Invalid state');
        return;
      }
      const code = u.searchParams.get('code');
      clearTimeout(timeout);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(code ? 'Consent received. Return to your terminal.' : 'Consent denied.');
      server.close();
      code ? resolveCode(code) : reject(new Error('OAuth consent denied'));
    });
    server.on('error', (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    server.listen(8765, '127.0.0.1');
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client,
      client_secret: secret,
      code,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`OAuth token exchange HTTP ${r.status}`);
  const tokens: any = await r.json();
  if (!tokens.refresh_token)
    throw new Error('No refresh token; revoke existing grant and consent again');
  const dir = resolve('storage');
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, 'youtube-oauth.json');
  await writeFile(
    path,
    JSON.stringify({ refresh_token: tokens.refresh_token, scope: tokens.scope }, null, 2),
    { mode: 0o600 },
  );
  console.log(
    `Refresh token saved locally to ${path}. Copy refresh_token to YOUTUBE_REFRESH_TOKEN in .env. Do not share this file.`,
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'OAuth failed');
  process.exitCode = 1;
});
