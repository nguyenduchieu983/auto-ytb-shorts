import 'dotenv/config';
import { z } from 'zod';
import { resolve } from 'node:path';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  ADMIN_TOKEN: z.string().min(32),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url(),
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('ai-tech-shorts'),
  APP_TIMEZONE: z.string().default('Asia/Ho_Chi_Minh'),
  DAILY_JOB_CRON: z.string().default('0 30 7 * * *'),
  SCHEDULE_ENABLED: bool.default('false'),
  AUTO_PUBLISH: bool.default('false'),
  STORAGE_ROOT: z.string().default('./storage'),
  MOCK_OPENAI: bool.default('true'),
  MOCK_YOUTUBE: bool.default('true'),
  MOCK_TELEGRAM: bool.default('true'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_TEXT_MODEL: z.string().default('gpt-4.1-mini'),
  OPENAI_SEARCH_MODEL: z.string().default('gpt-4.1'),
  OPENAI_IMAGE_MODEL: z.string().default('gpt-image-1'),
  OPENAI_TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  OPENAI_IMAGE_QUALITY: z.enum(['low', 'medium', 'high']).default('medium'),
  TRANSCRIPTION_CALL_RESERVE_USD: z.coerce.number().positive().default(0.02),
  OPENAI_TTS_VOICE: z.string().default('coral'),
  MAX_RUN_COST_USD: z.coerce.number().nonnegative().default(5),
  TEXT_CALL_RESERVE_USD: z.coerce.number().positive().default(0.1),
  SEARCH_CALL_RESERVE_USD: z.coerce.number().positive().default(0.5),
  IMAGE_CALL_RESERVE_USD: z.coerce.number().positive().default(0.25),
  VOICE_CALL_RESERVE_USD: z.coerce.number().positive().default(0.25),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  YOUTUBE_REFRESH_TOKEN: z.string().default(''),
  YOUTUBE_PRIVACY_STATUS: z.enum(['private', 'unlisted', 'public']).default('private'),
  TELEGRAM_UPDATE_MODE: z.enum(['polling', 'webhook']).default('polling'),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_ADMIN_CHAT_ID: z.string().default(''),
  TELEGRAM_ADMIN_USER_IDS: z.string().default(''),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
  FFMPEG_PATH: z.string().default(''),
  FFPROBE_PATH: z.string().default(''),
  CHANNEL_NAME: z.string().default('AI Tech Daily'),
  BACKGROUND_MUSIC_PATH: z.string().default(''),
  RENDER_CONCURRENCY: z.coerce.number().int().positive().default(1),
  ASSET_CONCURRENCY: z.coerce.number().int().positive().default(2),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = schema.parse(env);
  new Intl.DateTimeFormat('en-CA', { timeZone: c.APP_TIMEZONE });
  c.STORAGE_ROOT = resolve(c.STORAGE_ROOT);
  if (!c.MOCK_OPENAI && !c.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
  if (
    !c.MOCK_YOUTUBE &&
    (!c.GOOGLE_CLIENT_ID || !c.GOOGLE_CLIENT_SECRET || !c.YOUTUBE_REFRESH_TOKEN)
  )
    throw new Error('YouTube OAuth credentials are required');
  if (!c.MOCK_YOUTUBE && c.MOCK_OPENAI)
    throw new Error('Real YouTube upload cannot use mock content');
  if (
    !c.MOCK_TELEGRAM &&
    (!c.TELEGRAM_BOT_TOKEN ||
      !c.TELEGRAM_ADMIN_CHAT_ID ||
      !c.TELEGRAM_ADMIN_USER_IDS ||
      (c.TELEGRAM_UPDATE_MODE === 'webhook' && c.TELEGRAM_WEBHOOK_SECRET.length < 32))
  )
    throw new Error(
      'Telegram token/chat/users are required; webhook mode also needs a secret of 32+ chars',
    );
  if (c.AUTO_PUBLISH && (c.MOCK_OPENAI || c.MOCK_YOUTUBE || c.MOCK_TELEGRAM))
    throw new Error('AUTO_PUBLISH requires all live providers');
  return c;
}
export function localDate(now: Date, tz: string): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (k: string) => p.find((v) => v.type === k)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
