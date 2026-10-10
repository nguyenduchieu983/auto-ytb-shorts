import { z } from 'zod';
import { Config, localDate } from './config';
import { Repository } from './db';
import { PermanentError } from './domain';

export const scheduleSchema = z
  .object({
    enabled: z.boolean(),
    timezone: z.literal('Asia/Ho_Chi_Minh'),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    videos_per_day: z.number().int().min(1).max(20),
    auto_publish: z.boolean(),
  })
  .strict();
export type VideoSchedule = z.infer<typeof scheduleSchema>;
export const defaultSchedule: VideoSchedule = {
  enabled: false,
  timezone: 'Asia/Ho_Chi_Minh',
  time: '07:30',
  videos_per_day: 1,
  auto_publish: false,
};
const settled = new Set([
  'WAITING_APPROVAL',
  'NEEDS_REVISION',
  'FAILED',
  'SKIPPED',
  'PUBLISHED',
  'UPLOADED_PRIVATE',
  'UPLOAD_UNCERTAIN',
]);

export function vietnamTime(now: Date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
}
export function nextScheduleAt(settings: VideoSchedule, now: Date): string | null {
  if (!settings.enabled) return null;
  const date = localDate(now, settings.timezone);
  const next = new Date(`${date}T${settings.time}:00+07:00`);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}
export class VideoScheduler {
  constructor(
    private repo: Repository,
    private c: Config,
  ) {}
  private live() {
    return !this.c.MOCK_OPENAI && !this.c.MOCK_YOUTUBE && !this.c.MOCK_TELEGRAM;
  }
  async saved(): Promise<VideoSchedule | null> {
    const row = (await this.repo.pool.query('SELECT settings FROM video_schedule WHERE id=1'))
      .rows[0];
    return row ? scheduleSchema.parse(row.settings) : null;
  }
  async view(now = new Date()) {
    const saved = await this.saved(),
      settings = saved || defaultSchedule;
    const batches = (
      await this.repo.pool.query(
        'SELECT * FROM video_schedule_batches ORDER BY run_date DESC LIMIT 7',
      )
    ).rows;
    const recent = [];
    for (const batch of batches) {
      const runs = (
        await this.repo.pool.query(
          'SELECT r.id,r.status,s.sequence FROM video_schedule_runs s JOIN daily_runs r ON r.id=s.run_id WHERE s.run_date=$1 ORDER BY s.sequence',
          [batch.run_date],
        )
      ).rows;
      recent.push({ date: batch.run_date, settings: batch.settings, runs });
    }
    let nextAt = nextScheduleAt(settings, now);
    if (
      nextAt &&
      batches.some((b) => b.run_date === localDate(now, settings.timezone)) &&
      localDate(new Date(nextAt), settings.timezone) === localDate(now, settings.timezone)
    ) {
      const next = new Date(nextAt);
      next.setUTCDate(next.getUTCDate() + 1);
      nextAt = next.toISOString();
    }
    return {
      settings,
      configured: !!saved,
      next_at: nextAt,
      recent,
      live_ready: this.live(),
      privacy: this.c.YOUTUBE_PRIVACY_STATUS,
      legacy_enabled: !saved && this.c.SCHEDULE_ENABLED,
    };
  }
  async save(input: unknown) {
    const settings = scheduleSchema.parse(input);
    if (settings.enabled && settings.auto_publish && !this.live())
      throw new PermanentError(
        'Tự upload theo lịch yêu cầu cả OpenAI, YouTube và Telegram ở chế độ live',
      );
    await this.repo.pool.query(
      'INSERT INTO video_schedule (id,settings) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET settings=$1,updated_at=now()',
      [settings],
    );
    return this.view();
  }
  async autoPublishAllowed(runId: string): Promise<boolean> {
    const row = (
      await this.repo.pool.query('SELECT auto_publish FROM video_schedule_runs WHERE run_id=$1', [
        runId,
      ])
    ).rows[0];
    if (!row) return this.c.AUTO_PUBLISH;
    const current = await this.saved();
    return !!(row.auto_publish && current?.enabled && current.auto_publish && this.live());
  }
  async publishReady() {
    const current = await this.saved();
    if (!current?.enabled || !current.auto_publish || !this.live()) return;
    // Recover an approval completed just before a worker crash, using the same upload gates.
    const rows = (
      await this.repo.pool.query(
        "SELECT r.id,r.revision,q.output,q.finished_at FROM video_schedule_runs s JOIN daily_runs r ON r.id=s.run_id JOIN pipeline_steps q ON q.run_id=r.id AND q.revision=r.revision AND q.step='qc' WHERE s.auto_publish=true AND r.mock=false AND r.status='WAITING_APPROVAL' AND q.status='SUCCEEDED'",
      )
    ).rows;
    for (const row of rows)
      if (
        row.output?.auto_eligible &&
        row.finished_at &&
        Date.now() - new Date(row.finished_at).getTime() <= 86400000 &&
        (await this.autoPublishAllowed(row.id))
      )
        await this.repo.publish(row.id, row.revision, 'auto');
  }
  async tick(now = new Date()) {
    return this.repo.tx(async (client) => {
      // Serialize settings, batch allocation and outbox creation across all workers.
      const row = (await client.query('SELECT settings FROM video_schedule WHERE id=1 FOR UPDATE'))
        .rows[0];
      if (!row) return;
      const settings = scheduleSchema.parse(row.settings);
      if (!settings.enabled) return;
      const date = localDate(now, settings.timezone);
      if (vietnamTime(now) === settings.time)
        await client.query(
          'INSERT INTO video_schedule_batches (run_date,settings) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [date, settings],
        );
      const batches = (
        await client.query(
          'SELECT * FROM video_schedule_batches WHERE run_date <= $1 AND completed=false ORDER BY run_date',
          [date],
        )
      ).rows;
      for (const batch of batches) {
        const plan = scheduleSchema.parse(batch.settings);
        const runs = (
          await client.query(
            'SELECT r.id,r.status,s.sequence FROM video_schedule_runs s JOIN daily_runs r ON r.id=s.run_id WHERE s.run_date=$1 ORDER BY s.sequence',
            [batch.run_date],
          )
        ).rows;
        if (runs.some((r) => !settled.has(r.status))) return;
        if (runs.length >= plan.videos_per_day) {
          await client.query('UPDATE video_schedule_batches SET completed=true WHERE run_date=$1', [
            batch.run_date,
          ]);
          continue;
        }
        const sequence = runs.length + 1;
        const run = await this.repo.createInTransaction(
          client,
          batch.run_date,
          this.c.MOCK_OPENAI,
          `scheduled:${batch.run_date}:${sequence}`,
        );
        await client.query(
          'INSERT INTO video_schedule_runs (run_id,run_date,sequence,auto_publish) VALUES ($1,$2,$3,$4)',
          [run.id, batch.run_date, sequence, plan.auto_publish],
        );
        await client.query(
          'INSERT INTO pipeline_logs (id,run_id,revision,step,level,message) VALUES ($1,$2,1,$3,$4,$5)',
          [
            `schedule-${run.id}`,
            run.id,
            'discover',
            'info',
            `Scheduled video ${sequence}/${plan.videos_per_day}; start ${plan.time} UTC+7; auto upload ${plan.auto_publish}`,
          ],
        );
        return run;
      }
    });
  }
}
