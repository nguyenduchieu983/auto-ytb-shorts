import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Config } from './config';
import { PermanentError } from './domain';

const schema = z.object({
  version: z.literal(1),
  client_id: z.string().min(1),
  refresh_token: z.string().min(1),
  channel_id: z.string().regex(/^UC[\w-]{22}$/),
  channel_title: z.string(),
  updated_at: z.string(),
});
export type YoutubeCredential = z.infer<typeof schema>;
export const youtubeCredentialPath = (c: Config) =>
  join(c.STORAGE_ROOT, 'youtube-credentials.json');
export async function readYoutubeCredential(c: Config): Promise<YoutubeCredential | null> {
  let raw: string;
  try {
    raw = await readFile(youtubeCredentialPath(c), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new PermanentError('Cannot read YouTube credential store');
  }
  try {
    const value = schema.parse(JSON.parse(raw));
    if (
      value.client_id !== c.GOOGLE_CLIENT_ID ||
      (c.YOUTUBE_CHANNEL_ID && value.channel_id !== c.YOUTUBE_CHANNEL_ID)
    )
      throw new Error('Mismatch');
    return value;
  } catch {
    throw new PermanentError(
      'YouTube credential store invalid or channel/client mismatch; reconnect YouTube',
    );
  }
}
export async function atomicPrivateFile(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, path);
  } catch (e) {
    await unlink(temp).catch(() => {});
    throw e;
  }
}
export async function youtubeAccess(c: Config, refreshToken: string, send: typeof fetch = fetch) {
  if (!refreshToken) throw new PermanentError('YouTube needs reauthorization from dashboard');
  const response = await send('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.GOOGLE_CLIENT_ID,
      client_secret: c.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    await response.text();
    throw new PermanentError(
      `Google OAuth refresh HTTP ${response.status}; reauthorize from dashboard`,
    );
  }
  const data: any = await response.json();
  if (typeof data.access_token !== 'string' || !data.access_token)
    throw new PermanentError('Missing Google access token');
  return { value: data.access_token, expires: Date.now() + Number(data.expires_in || 3600) * 1000 };
}
export async function youtubeChannel(access: string, send: typeof fetch = fetch) {
  const r = await send('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: 'Bearer ' + access },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new PermanentError(`Cannot verify YouTube channel (HTTP ${r.status})`);
  const data: any = await r.json();
  if (data.items?.length !== 1 || !/^UC[\w-]{22}$/.test(data.items[0]?.id || ''))
    throw new PermanentError('Select one YouTube channel and grant read/upload permissions');
  return {
    id: data.items[0].id as string,
    title: String(data.items[0].snippet?.title || 'YouTube channel').slice(0, 200),
  };
}
