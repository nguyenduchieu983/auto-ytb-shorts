import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { readFile, open, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import IORedis from 'ioredis';
import { z } from 'zod';
import { AdminGuard, equal, hasSession, sameOrigin, sessionCookie } from './auth';
import { Pipeline, safeError } from './engine';
import { STEPS } from './domain';

const statuses = [
  'PENDING',
  'RUNNING',
  'WAITING_APPROVAL',
  'NEEDS_REVISION',
  'UPLOADING',
  'UPLOADED_PRIVATE',
  'PUBLISHED',
  'UPLOAD_UNCERTAIN',
  'FAILED',
  'SKIPPED',
] as const;
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  status: z.enum(statuses).optional(),
  search: z.string().max(100).default(''),
});
function clean(value: any, p: Pipeline): any {
  if (typeof value === 'string') return safeError(new Error(value), p.c);
  if (Array.isArray(value)) return value.map((v) => clean(v, p));
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !/session_uri|refresh_token|access_token|api_key|secret/i.test(k))
        .map(([k, v]) => [k, clean(v, p)]),
    );
  return value;
}
@Controller('dashboard')
export class DashboardPublicController {
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(@Inject('PIPELINE') private p: Pipeline) {}
  @Get() async index(@Res() res: any) {
    res.set('Cache-Control', 'no-store');
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    res.type('html').send(await readFile(resolve('dashboard/index.html'), 'utf8'));
  }
  @Get('app.js') async script(@Res() res: any) {
    res.type('js').send(await readFile(resolve('dashboard/app.js'), 'utf8'));
  }
  @Get('style.css') async style(@Res() res: any) {
    res.type('css').send(await readFile(resolve('dashboard/style.css'), 'utf8'));
  }
  @Get('session') session(@Req() req: any, @Res() res: any) {
    res.set('Cache-Control', 'no-store').json({ authenticated: hasSession(req, this.p.c) });
  }
  @Post('login') login(@Req() req: any, @Body() body: unknown, @Res() res: any) {
    if (!sameOrigin(req)) throw new HttpException('Invalid request origin', 403);
    for (const [key, entry] of this.attempts)
      if (entry.until <= Date.now()) this.attempts.delete(key);
    const key = req.ip || 'local';
    const attempt = this.attempts.get(key) || { count: 0, until: Date.now() + 60000 };
    if (attempt.count >= 10) throw new HttpException('Too many attempts; wait one minute', 429);
    const { token } = z
      .object({ token: z.string().max(256) })
      .strict()
      .parse(body);
    if (!equal(token, this.p.c.ADMIN_TOKEN)) {
      attempt.count++;
      this.attempts.set(key, attempt);
      throw new HttpException('Invalid admin token', 401);
    }
    this.attempts.delete(key);
    res
      .set('Set-Cookie', sessionCookie(this.p.c, req.secure))
      .set('Cache-Control', 'no-store')
      .json({ ok: true });
  }
  @Post('logout') @UseGuards(AdminGuard) logout(@Req() req: any, @Res() res: any) {
    res.set('Set-Cookie', sessionCookie(this.p.c, req.secure, true)).json({ ok: true });
  }
}
@Controller('dashboard/api')
@UseGuards(AdminGuard)
export class DashboardController {
  constructor(@Inject('PIPELINE') private p: Pipeline) {}
  @Get('runs') async runs(@Query() query: unknown) {
    const { page, status, search } = pageQuery.parse(query);
    const params: any[] = [];
    const filters: string[] = [];
    if (status) {
      params.push(status);
      filters.push(`status=$${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      filters.push(`(id ILIKE $${params.length} OR run_date ILIKE $${params.length})`);
    }
    const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
    const total = Number(
      (await this.p.repo.pool.query('SELECT count(*) AS count FROM daily_runs' + where, params))
        .rows[0].count,
    );
    const rows = (
      await this.p.repo.pool.query(
        'SELECT * FROM daily_runs' +
          where +
          ` ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET $${params.length + 1}`,
        [...params, (page - 1) * 20],
      )
    ).rows;
    const items = await Promise.all(
      rows.map(async (r) => {
        const steps = await this.p.repo.steps(r.id, r.revision);
        return {
          ...r,
          title: steps.find((s) => s.step === 'metadata')?.output?.title || 'Bản tin AI & Tech',
          completed: steps.filter((s) => s.status === 'SUCCEEDED').length,
          current_steps: steps
            .filter((s) => s.status === 'RUNNING' || s.status === 'FAILED')
            .map((s) => s.step),
          selected: steps.find((s) => s.step === 'rank')?.output?.selected?.length || 0,
        };
      }),
    );
    const summary = (
      await this.p.repo.pool.query(
        'SELECT status,count(*) AS count FROM daily_runs GROUP BY status',
      )
    ).rows;
    return clean({ items, total, page, pages: Math.ceil(total / 20), summary }, this.p);
  }
  @Post('runs') async create(@Body() body: unknown) {
    const { request_key } = z.object({ request_key: z.string().uuid() }).strict().parse(body);
    return this.p.run(new Date(), 'dashboard:' + request_key);
  }
  @Get('runs/:id') async detail(@Param('id') id: string, @Query('revision') raw?: string) {
    const detail = await this.p.repo.detail(id);
    const revision = raw ? z.coerce.number().int().positive().parse(raw) : detail.revision;
    const revisions = (
      await this.p.repo.pool.query(
        'SELECT DISTINCT revision FROM pipeline_steps WHERE run_id=$1 ORDER BY revision DESC',
        [id],
      )
    ).rows.map((r) => r.revision);
    if (!revisions.includes(revision)) throw new HttpException('Revision not found', 404);
    const logs = (
      await this.p.repo.pool.query(
        'SELECT id,revision,step,level,message,created_at FROM pipeline_logs WHERE run_id=$1 AND revision=$2 ORDER BY created_at DESC,id DESC LIMIT 200',
        [id, revision],
      )
    ).rows;
    return clean(
      {
        ...detail,
        steps: await this.p.repo.steps(id, revision),
        logs,
        revisions,
        viewed_revision: revision,
        step_order: STEPS,
      },
      this.p,
    );
  }
  @Get('runtime') async runtime() {
    const workers = (
      await this.p.repo.pool.query('SELECT * FROM runtime_heartbeats ORDER BY updated_at DESC')
    ).rows;
    let redisOk = false;
    const redis = new IORedis(this.p.c.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 1500,
      commandTimeout: 1500,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    redis.on('error', () => {});
    try {
      await redis.connect();
      redisOk = (await redis.ping()) === 'PONG';
    } catch {
    } finally {
      redis.disconnect();
    }
    const inbox = (
      await this.p.repo.pool.query(
        'SELECT status,count(*) AS count FROM telegram_updates GROUP BY status',
      )
    ).rows;
    return {
      api: true,
      database: true,
      redis: redisOk,
      worker: workers.some((w) => Date.now() - new Date(w.updated_at).getTime() < 45000),
      workers,
      inbox,
      modes: {
        openai: this.p.c.MOCK_OPENAI ? 'mock' : 'live',
        telegram: this.p.c.MOCK_TELEGRAM ? 'mock' : 'live',
        youtube: this.p.c.MOCK_YOUTUBE ? 'mock' : 'live',
      },
      schedule: this.p.c.SCHEDULE_ENABLED,
      auto_publish: this.p.c.AUTO_PUBLISH,
      privacy: this.p.c.YOUTUBE_PRIVACY_STATUS,
      timezone: this.p.c.APP_TIMEZONE,
      telegram_mode: this.p.c.TELEGRAM_UPDATE_MODE,
      max_cost: this.p.c.MAX_RUN_COST_USD,
    };
  }
  @Get('runtime/logs') async runtimeLogs() {
    const result: Record<string, string> = {};
    for (const name of ['api.stdout', 'api.stderr', 'worker.stdout', 'worker.stderr']) {
      let file;
      try {
        file = await open(resolve(this.p.c.STORAGE_ROOT, 'runtime', name + '.log'), 'r');
        const size = (await file.stat()).size;
        const buffer = Buffer.alloc(Math.min(size, 16000));
        await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        result[name] = clean(buffer.toString('utf8').slice(-4000), this.p);
      } catch {
        result[name] = 'Log file unavailable; use pipeline logs for persisted events.';
      } finally {
        await file?.close();
      }
    }
    return result;
  }
  @Get('runs/:id/assets/:revision/:step') async asset(
    @Param('id') id: string,
    @Param('revision') raw: string,
    @Param('step') step: string,
    @Query('kind') kind: string,
    @Query('scene') scene: string,
    @Res() res: any,
  ) {
    await this.p.repo.get(id);
    const revision = z.coerce.number().int().positive().parse(raw);
    const output = (await this.p.repo.steps(id, revision)).find(
      (s) => s.step === step && s.status === 'SUCCEEDED',
    )?.output;
    let path: string | undefined;
    if (step === 'render' && kind === 'video') path = output?.path;
    if (step === 'render' && kind === 'thumbnail') path = output?.thumbnail;
    if (step === 'voice' && kind === 'audio') path = output?.path;
    if (step === 'visuals' && kind === 'image')
      path = output?.images?.find((i: any) => i.scene_id === Number(scene))?.path;
    if (step === 'subtitles' && kind === 'subtitle') path = output?.path;
    if (!path) throw new HttpException('Asset not available', 404);
    let full: string;
    try {
      full = await realpath(this.p.storage.safe(path));
      const root = await realpath(this.p.c.STORAGE_ROOT);
      const rel = relative(root, full);
      if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel))
        throw new Error('Outside storage');
    } catch {
      throw new HttpException('Asset unavailable', 404);
    }
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.sendFile(full);
  }
}
