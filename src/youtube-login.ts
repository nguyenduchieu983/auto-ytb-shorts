import { createServer, Server } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Config } from './config';
import { equal } from './auth';
import { PermanentError } from './domain';
import {
  atomicPrivateFile,
  readYoutubeCredential,
  youtubeAccess,
  youtubeChannel,
  youtubeCredentialPath,
  YoutubeCredential,
} from './youtube-credentials';

const scopes = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];
export class YoutubeLogin {
  private server?: Server;
  private deadline?: NodeJS.Timeout;
  private starting?: Promise<any>;
  private applying?: Promise<any>;
  private checking?: Promise<any>;
  private generation = 0;
  private pending?: YoutubeCredential;
  private state: {
    status: string;
    auth_url?: string;
    expires_at?: string;
    channel?: { id: string; title: string };
    message?: string;
  } = { status: 'idle' };
  constructor(
    private c: Config,
    private send: typeof fetch = fetch,
    private envPath = resolve('.env'),
    private port = 8765,
    private ttlMs = 10 * 60 * 1000,
  ) {}
  view() {
    return { ...this.state };
  }
  private stop() {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = undefined;
    const server = this.server;
    this.server = undefined;
    server?.close();
  }
  close() {
    this.generation++;
    this.pending = undefined;
    this.stop();
  }
  cancel() {
    if (this.applying) throw new PermanentError('Đang lưu cấu hình; chờ hoàn tất.');
    this.close();
    this.state = {
      status: 'cancelled',
      message: 'Đã hủy phiên cấp quyền. Token đang dùng được giữ nguyên.',
    };
    return this.view();
  }
  private expire() {
    this.deadline = setTimeout(() => {
      this.close();
      this.state = {
        status: 'expired',
        message: 'Phiên cấp quyền đã hết hạn. Bấm kết nối lại để lấy link mới.',
      };
    }, this.ttlMs);
  }
  async start() {
    if (this.checking) await this.checking;
    if (this.starting) return this.starting;
    if (['waiting', 'verifying', 'confirm', 'applying'].includes(this.state.status))
      return this.view();
    const task = this.begin();
    this.starting = task;
    try {
      return await task;
    } finally {
      if (this.starting === task) this.starting = undefined;
    }
  }
  private async begin() {
    this.close();
    const generation = this.generation;
    if (!this.c.GOOGLE_CLIENT_ID || !this.c.GOOGLE_CLIENT_SECRET)
      throw new PermanentError(
        'Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before connecting YouTube',
      );
    // A broken old store must block uploads, but an explicit reauthorization can repair it.
    const previous = await readYoutubeCredential(this.c).catch(() => null);
    if (generation !== this.generation) return this.view();
    const expected = this.c.YOUTUBE_CHANNEL_ID || previous?.channel_id || '';
    const nonce = randomBytes(32).toString('hex'),
      verifier = randomBytes(32).toString('base64url');
    let handling = false,
      redirect = '';
    this.state = { status: 'starting' };
    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== '/oauth/callback') {
        res.writeHead(404).end();
        return;
      }
      if (generation !== this.generation || !equal(url.searchParams.get('state') || '', nonce)) {
        res.writeHead(403).end('Invalid or expired OAuth state');
        return;
      }
      if (handling) {
        res.writeHead(409).end('Consent is already being processed.');
        return;
      }
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || !code) {
        this.state = {
          status: 'failed',
          message: 'Google chưa cấp quyền. Token cũ không bị thay đổi; có thể bấm kết nối lại.',
        };
        this.stop();
        res.writeHead(400).end('Chưa được cấp quyền. Quay lại dashboard.');
        return;
      }
      handling = true;
      this.state = { status: 'verifying', message: 'Đang kiểm tra quyền upload và kênh YouTube…' };
      void (async () => {
        try {
          const tokenResponse = await this.send('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: this.c.GOOGLE_CLIENT_ID,
              client_secret: this.c.GOOGLE_CLIENT_SECRET,
              grant_type: 'authorization_code',
              code,
              redirect_uri: redirect,
              code_verifier: verifier,
            }),
            signal: AbortSignal.timeout(30000),
          });
          if (!tokenResponse.ok) throw new Error('Exchange failed');
          const tokens: any = await tokenResponse.json();
          if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token)
            throw new Error('No refresh token');
          if (
            !scopes.every((scope) =>
              String(tokens.scope || '')
                .split(' ')
                .includes(scope),
            )
          )
            throw new Error('Missing scopes');
          const access = await youtubeAccess(this.c, tokens.refresh_token, this.send),
            channel = await youtubeChannel(access.value, this.send);
          if (expected && channel.id !== expected) throw new Error('Wrong channel');
          if (generation !== this.generation) {
            res.writeHead(410).end('Phiên đã hủy hoặc hết hạn.');
            return;
          }
          // Keep new credentials in memory only. Even a matching channel requires explicit Apply.
          this.pending = {
            version: 1,
            client_id: this.c.GOOGLE_CLIENT_ID,
            refresh_token: tokens.refresh_token,
            channel_id: channel.id,
            channel_title: channel.title,
            updated_at: new Date().toISOString(),
          };
          this.state = {
            status: 'confirm',
            channel,
            message:
              'Đã xác minh kênh. Bấm “Dùng kênh này” trên dashboard để lưu token. Chưa upload video.',
          };
          res.end('Đã xác minh quyền YouTube. Quay lại dashboard và bấm Dùng kênh này để lưu.');
        } catch {
          if (generation === this.generation) {
            this.pending = undefined;
            this.state = {
              status: 'failed',
              message:
                'Không nhận token: quyền chưa đủ, thiếu refresh token, chọn khác kênh đang dùng hoặc lỗi kết nối. Hãy chọn đúng kênh và cấp đủ quyền rồi thử lại.',
            };
          }
          res.writeHead(400).end('Không hoàn tất cấp quyền. Xem thông báo trên dashboard.');
        } finally {
          if (generation === this.generation) {
            this.stop();
            if (this.state.status === 'confirm') this.expire();
          } else server.close();
        }
      })();
    });
    this.server = server;
    try {
      await new Promise<void>((done, reject) => {
        server.once('error', reject);
        server.listen(this.port, '127.0.0.1', () => done());
      });
    } catch {
      this.stop();
      this.state = {
        status: 'failed',
        message: 'Không mở được callback tại cổng 8765. Đóng phiên npm run oauth cũ rồi bấm lại.',
      };
      return this.view();
    }
    if (generation !== this.generation) {
      server.close();
      return this.view();
    }
    redirect = `http://127.0.0.1:${(server.address() as any).port}/oauth/callback`;
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.c.GOOGLE_CLIENT_ID,
      redirect_uri: redirect,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state: nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    this.state = {
      status: 'waiting',
      auth_url: url.href,
      expires_at: new Date(Date.now() + this.ttlMs).toISOString(),
      message: 'Chọn tài khoản/kênh và cấp quyền trong tab Google vừa mở.',
    };
    this.expire();
    return this.view();
  }
  // Called ONLY by the authenticated POST apply endpoint after the user reviews the channel.
  async apply() {
    if (this.applying) return this.applying;
    if (this.state.status !== 'confirm' || !this.pending)
      throw new PermanentError('No verified YouTube channel is awaiting confirmation');
    const pending = this.pending;
    this.stop();
    this.state = {
      ...this.state,
      status: 'applying',
      message: 'Đang lưu token cho kênh đã xác nhận…',
    };
    const task = (async () => {
      const original = await readFile(this.envPath, 'utf8');
      let env = original;
      for (const [key, value] of Object.entries({
        YOUTUBE_REFRESH_TOKEN: pending.refresh_token,
        YOUTUBE_CHANNEL_ID: pending.channel_id,
      })) {
        const line = key + '=' + JSON.stringify(value),
          pattern = new RegExp('^' + key + '=.*$', 'm');
        env = pattern.test(env)
          ? env.replace(pattern, () => line)
          : env.trimEnd() + '\n' + line + '\n';
      }
      await atomicPrivateFile(this.envPath, env);
      try {
        await atomicPrivateFile(youtubeCredentialPath(this.c), JSON.stringify(pending, null, 2));
      } catch (e) {
        await atomicPrivateFile(this.envPath, original);
        throw e;
      }
      this.c.YOUTUBE_REFRESH_TOKEN = pending.refresh_token;
      this.c.YOUTUBE_CHANNEL_ID = pending.channel_id;
      this.pending = undefined;
      this.state = {
        status: 'succeeded',
        channel: { id: pending.channel_id, title: pending.channel_title },
        message:
          'Đã cập nhật quyền upload YouTube. Worker dùng token mới ngay; có thể retry bước upload của video lỗi.',
      };
      return this.view();
    })();
    this.applying = task;
    try {
      return await task;
    } catch {
      this.state = {
        status: 'confirm',
        channel: { id: pending.channel_id, title: pending.channel_title },
        message:
          'Chưa lưu được cấu hình. Kiểm tra quyền ghi .env/storage rồi bấm Dùng kênh này để thử lại.',
      };
      this.expire();
      return this.view();
    } finally {
      this.applying = undefined;
    }
  }
  async check() {
    if (this.starting) return this.view();
    if (['waiting', 'verifying', 'confirm', 'applying'].includes(this.state.status))
      return this.view();
    if (this.checking) return this.checking;
    const task = this.inspect(this.generation);
    this.checking = task;
    try {
      return await task;
    } finally {
      if (this.checking === task) this.checking = undefined;
    }
  }
  private async inspect(generation: number) {
    try {
      const stored = await readYoutubeCredential(this.c),
        access = await youtubeAccess(
          this.c,
          stored?.refresh_token || this.c.YOUTUBE_REFRESH_TOKEN,
          this.send,
        ),
        channel = await youtubeChannel(access.value, this.send);
      if (this.c.YOUTUBE_CHANNEL_ID && channel.id !== this.c.YOUTUBE_CHANNEL_ID)
        throw new Error('Wrong channel');
      if (generation !== this.generation) return this.view();
      this.state = {
        status: 'idle',
        channel,
        message:
          'Token YouTube còn dùng được; đã xác minh kênh. Không có video nào được upload trong lượt kiểm tra này.',
      };
    } catch {
      if (generation !== this.generation) return this.view();
      this.state = {
        status: 'failed',
        message:
          'Không xác minh được token YouTube. Bấm “Kết nối lại YouTube” để cấp lại quyền hoặc kiểm tra kết nối.',
      };
    }
    return this.view();
  }
}
