import 'reflect-metadata';
import {
  Body,
  CanActivate,
  Catch,
  Controller,
  ExceptionFilter,
  ExecutionContext,
  Get,
  HttpException,
  Inject,
  Module,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import { Config, loadConfig, localDate } from './config';
import { migrate, Repository } from './db';
import { PermanentError, STEPS } from './domain';
import { Pipeline, safeError } from './engine';
import { parseTelegramUpdate } from './providers/telegram';

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
class AdminGuard implements CanActivate {
  constructor(@Inject('CONFIG') private c: Config) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (!equal(String(req.headers.authorization || ''), `Bearer ${this.c.ADMIN_TOKEN}`))
      throw new HttpException('Unauthorized', 401);
    return true;
  }
}
@Catch()
class Errors implements ExceptionFilter {
  constructor(private c: Config) {}
  catch(error: any, host: any) {
    const response = host.switchToHttp().getResponse();
    const code =
      error instanceof HttpException
        ? error.getStatus()
        : error instanceof PermanentError || error instanceof ZodError
          ? 400
          : 500;
    response.status(code).json({
      error:
        code === 500
          ? 'Internal error; inspect server logs'
          : error instanceof ZodError
            ? 'Invalid request body'
            : safeError(error, this.c),
    });
    if (code === 500) console.error(safeError(error, this.c));
  }
}
const revisionSchema = z.object({ revision: z.number().int().positive() }).strict();
@Controller('pipeline')
@UseGuards(AdminGuard)
class PipelineController {
  constructor(@Inject('PIPELINE') private p: Pipeline) {}
  @Post('run') run() {
    return this.p.run();
  }
  @Get('today') today() {
    return this.p.repo.today(localDate(new Date(), this.p.c.APP_TIMEZONE));
  }
  @Get(':id') detail(@Param('id') id: string) {
    return this.p.repo.detail(id);
  }
  @Post(':id/publish') publish(@Param('id') id: string, @Body() body: unknown) {
    return this.p.repo.publish(id, revisionSchema.parse(body).revision, 'api-admin');
  }
  @Post(':id/skip') async skip(@Param('id') id: string, @Body() body: unknown) {
    await this.p.repo.skip(id, revisionSchema.parse(body).revision, 'api-admin');
    return this.p.repo.get(id);
  }
  @Post(':id/regenerate') regenerate(@Param('id') id: string, @Body() body: unknown) {
    const b = revisionSchema
      .extend({ target: z.enum(['script', 'voice', 'visuals', 'render']) })
      .parse(body);
    return this.p.regenerate(id, b.revision, b.target);
  }
  @Post(':id/retry') retry(@Param('id') id: string, @Body() body: unknown) {
    const b = revisionSchema.extend({ step: z.enum(STEPS) }).parse(body);
    return this.p.repo.retry(id, b.revision, b.step);
  }
  @Post(':id/reconcile-upload') reconcile(@Param('id') id: string, @Body() body: unknown) {
    const b = revisionSchema
      .extend({ video_id: z.string().regex(/^[a-zA-Z0-9_-]{11}$/) })
      .parse(body);
    return this.p.reconcile(id, b.revision, b.video_id);
  }
}
@Controller()
class PublicController {
  constructor(@Inject('PIPELINE') private p: Pipeline) {}
  @Get('health') async health() {
    await this.p.repo.pool.query('SELECT 1');
    return { ok: true };
  }
  @Post('telegram/webhook') async webhook(@Req() req: any, @Body() body: any) {
    if (
      this.p.c.MOCK_TELEGRAM ||
      this.p.c.TELEGRAM_UPDATE_MODE !== 'webhook' ||
      !equal(
        String(req.headers['x-telegram-bot-api-secret-token'] || ''),
        this.p.c.TELEGRAM_WEBHOOK_SECRET,
      )
    )
      throw new HttpException('Unauthorized', 401);
    if (!Number.isSafeInteger(body?.update_id)) throw new HttpException('Invalid update', 400);
    try {
      parseTelegramUpdate(body, this.p.c);
    } catch {
      throw new HttpException('Unsupported or unauthorized command', 403);
    }
    await this.p.repo.pool.query(
      'INSERT INTO telegram_updates (update_id,payload) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [body.update_id, JSON.stringify(body)],
    );
    return { ok: true };
  }
}
export async function createApp(pipeline: Pipeline) {
  @Module({
    controllers: [PipelineController, PublicController],
    providers: [
      { provide: 'CONFIG', useValue: pipeline.c },
      { provide: 'PIPELINE', useValue: pipeline },
      AdminGuard,
    ],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.useGlobalFilters(new Errors(pipeline.c));
  await app.init();
  return app;
}
export async function main() {
  const c = loadConfig(),
    pool = new Pool({ connectionString: c.DATABASE_URL, max: 12, connectionTimeoutMillis: 10000 });
  await migrate(pool);
  const app = await createApp(new Pipeline(c, new Repository(pool)));
  await app.listen(c.PORT, c.HOST);
  const shutdown = async () => {
    await app.close();
    await pool.end();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
if (require.main === module)
  main().catch(() => {
    console.error('API startup failed; check configuration and database connection');
    process.exitCode = 1;
  });
