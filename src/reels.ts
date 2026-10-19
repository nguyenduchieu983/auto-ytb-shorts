import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Config, localDate } from './config';
import { Repository } from './db';
import { PermanentError, normalize, similarity } from './domain';
import { safeError } from './engine';
import { CodexContent } from './providers/codex';
import { philosophySpecSchema, renderPhilosophy } from './philosophy-render';
import { vietnamTime } from './video-schedule';

export const reelsSettingsSchema = z
  .object({
    enabled: z.boolean(),
    timezone: z.literal('Asia/Ho_Chi_Minh'),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    videos_per_day: z.number().int().min(1).max(10),
  })
  .strict();
export const defaultReelsSettings = {
  enabled: false,
  timezone: 'Asia/Ho_Chi_Minh' as const,
  time: '19:00',
  videos_per_day: 2,
};
export const reelContentSchema = philosophySpecSchema.extend({
  scenes: z
    .array(philosophySpecSchema.shape.scenes.element.extend({ label: z.string().max(22) }))
    .length(6),
  topic_key: z.string().min(5).max(100),
  caption: z.string().min(10).max(300),
  description: z.string().min(30).max(2000),
  hashtags: z
    .array(
      z
        .string()
        .regex(/^#[\p{L}\p{N}_]+$/u)
        .max(40),
    )
    .min(3)
    .max(8),
});
export type ReelContent = z.infer<typeof reelContentSchema>;
const sourceUrl = 'https://classics.mit.edu/Epictetus/epicench.html';
// Editorial summaries of public-domain ideas, not direct quotations or promises.
const themes = [
  { section: 1, idea: 'Dồn sức cho hành động của mình thay vì cố kiểm soát người khác.' },
  { section: 5, idea: 'Xem xét cách mình diễn giải một sự việc trước khi vội phán xét.' },
  { section: 8, idea: 'Chấp nhận điều đã xảy ra để chọn bước hành động tiếp theo.' },
  { section: 10, idea: 'Trước khó khăn, tìm năng lực mình có thể rèn luyện để ứng phó.' },
  { section: 12, idea: 'Tập bình tĩnh từ những mất mát và bất tiện nhỏ hằng ngày.' },
  {
    section: 13,
    idea: 'Kiên trì học hỏi, chấp nhận có lúc mình trông vụng về trong mắt người khác.',
  },
  { section: 15, idea: 'Biết vừa đủ, kiên nhẫn với điều chưa tới thay vì nôn nóng giành lấy.' },
  {
    section: 16,
    idea: 'Đối xử cảm thông với người đang buồn; không buộc họ phải suy nghĩ giống mình.',
  },
  { section: 20, idea: 'Tạm dừng trước lời khiêu khích để tránh phản ứng bốc đồng.' },
  { section: 23, idea: 'Giữ giá trị mình tin thay vì chỉ sống để được người khác khen.' },
];
export function postingText(content: ReelContent) {
  return `${content.caption}\n\n${content.description}\n\n${content.hashtags.join(' ')}`;
}
export function rejectRepeatedReel(content: ReelContent, recent: any[]) {
  const script = content.scenes.map((s) => s.narration).join(' ');
  if (
    recent.some(
      (c) =>
        normalize(c.topic_key || '') === normalize(content.topic_key) ||
        normalize((c.title || []).join(' ')) === normalize(content.title.join(' ')) ||
        similarity(script, (c.scenes || []).map((s: any) => s.narration).join(' ')) > 0.85,
    )
  )
    throw new Error('Chủ đề/tiêu đề hoặc lời đọc quá giống video gần đây; cần viết hướng khác');
  const count = script.split(/\s+/).length;
  if (count < 115 || count > 155)
    throw new Error(`Lời đọc ${count} tiếng, yêu cầu 115–155 để giữ giọng chậm`);
}
export class ReelsService {
  constructor(
    private repo: Repository,
    private c: Config,
    private render = renderPhilosophy,
  ) {}
  private ready() {
    return (
      !this.c.MOCK_OPENAI &&
      this.c.CONTENT_PROVIDER === 'codex' &&
      !this.c.PAID_API_ENABLED &&
      this.c.LOCAL_VOICE_PROVIDER === 'edge'
    );
  }
  async settings() {
    const row = (await this.repo.pool.query('SELECT settings FROM reels_settings WHERE id=1'))
      .rows[0];
    return row ? reelsSettingsSchema.parse(row.settings) : defaultReelsSettings;
  }
  async save(input: unknown) {
    const settings = reelsSettingsSchema.parse(input);
    if (settings.enabled && !this.ready())
      throw new PermanentError('Reels cần Codex live, Edge TTS và PAID_API_ENABLED=false');
    await this.repo.pool.query(
      'INSERT INTO reels_settings (id,settings) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET settings=$1,updated_at=now()',
      [settings],
    );
    return settings;
  }
  async view(page = 1) {
    const settings = await this.settings();
    const rows = (
      await this.repo.pool.query(
        'SELECT j.*,b.run_date,b.origin FROM reels_jobs j JOIN reels_batches b ON b.id=j.batch_id ORDER BY j.created_at DESC,j.sequence DESC LIMIT 10 OFFSET $1',
        [(page - 1) * 10],
      )
    ).rows;
    const total = Number(
      (await this.repo.pool.query('SELECT count(*) AS count FROM reels_jobs')).rows[0].count,
    );
    const now = new Date(),
      today = localDate(now, settings.timezone);
    const exists = (
      await this.repo.pool.query('SELECT id FROM reels_batches WHERE id=$1', ['scheduled:' + today])
    ).rowCount;
    let next = settings.enabled ? new Date(`${today}T${settings.time}:00+07:00`) : null;
    if (next && exists) next.setUTCDate(next.getUTCDate() + 1);
    if (next && next.getTime() < now.getTime()) next = now; // Today's missed start catches up while awake.
    return {
      settings,
      items: rows,
      total,
      page,
      pages: Math.ceil(total / 10),
      ready: this.ready(),
      next_at: next?.toISOString() || null,
    };
  }
  async detail(id: string) {
    z.string().uuid().parse(id);
    const row = (await this.repo.pool.query('SELECT * FROM reels_jobs WHERE id=$1', [id])).rows[0];
    if (!row) throw new PermanentError('Không tìm thấy video Reels');
    const logs = (
      await this.repo.pool.query(
        'SELECT message,created_at FROM reels_logs WHERE job_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200',
        [id],
      )
    ).rows;
    return { ...row, logs, posting_text: row.content ? postingText(row.content) : '' };
  }
  async batch(id: string, origin: 'scheduled' | 'manual', now: Date, input: unknown) {
    const settings = reelsSettingsSchema.parse(input);
    return this.repo.tx(async (client) => {
      const inserted = await client.query(
        'INSERT INTO reels_batches (id,run_date,origin,settings) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',
        [id, localDate(now, settings.timezone), origin, settings],
      );
      if (inserted.rowCount)
        for (let n = 1; n <= settings.videos_per_day; n++)
          await client.query('INSERT INTO reels_jobs (id,batch_id,sequence) VALUES ($1,$2,$3)', [
            randomUUID(),
            id,
            n,
          ]);
      return (
        await client.query('SELECT * FROM reels_jobs WHERE batch_id=$1 ORDER BY sequence', [id])
      ).rows;
    });
  }
  async tick(now = new Date()) {
    const settings = await this.settings();
    if (!settings.enabled || vietnamTime(now) < settings.time) return [];
    return this.batch('scheduled:' + localDate(now, settings.timezone), 'scheduled', now, settings);
  }
  async manual(key: string) {
    z.string().uuid().parse(key);
    if (!this.ready())
      throw new PermanentError('Reels cần Codex live và Edge, không dùng API trả phí');
    return this.batch('manual:' + key, 'manual', new Date(), await this.settings());
  }
  async retry(id: string) {
    z.string().uuid().parse(id);
    const result = await this.repo.pool.query(
      "UPDATE reels_jobs SET status='PENDING',error_message=NULL,updated_at=now() WHERE id=$1 AND status='FAILED' RETURNING id",
      [id],
    );
    if (!result.rowCount) throw new PermanentError('Chỉ retry video Reels đang lỗi');
    await this.log(id, 'Đã yêu cầu retry; giữ kịch bản đã lưu, dựng lại audio/video nếu cần.');
    return { ok: true };
  }
  async log(id: string, message: string) {
    await this.repo.pool.query('INSERT INTO reels_logs (id,job_id,message) VALUES ($1,$2,$3)', [
      randomUUID(),
      id,
      message,
    ]);
  }
  private async content(job: any): Promise<ReelContent> {
    if (job.content) return reelContentSchema.parse(job.content);
    const recent = (
      await this.repo.pool.query(
        'SELECT content FROM reels_jobs WHERE content IS NOT NULL ORDER BY created_at DESC LIMIT 60',
      )
    ).rows.map((r) => r.content);
    const ledger = {
      log: async (_w: unknown, message: string) => this.log(job.id, message),
      reserve: async () => randomUUID(),
      usage: async (_id: string, usage: unknown) => {
        await this.repo.pool.query('UPDATE reels_jobs SET usage=$2 WHERE id=$1', [job.id, usage]);
      },
    } as unknown as Repository;
    const codex = new CodexContent(this.c, ledger);
    const convert = zodToJsonSchema as unknown as (s: z.ZodTypeAny, o: any) => any;
    const schema = convert(reelContentSchema, { $refStrategy: 'none' });
    delete schema.$schema;
    // Match existing Codex provider: local validators enforce URL syntax.
    delete schema.properties.source.format;
    let issue = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = await codex.generate(
        { runId: job.id, revision: 1, step: 'script' },
        'philosophy-reel',
        schema,
        'Write an ORIGINAL Vietnamese philosophy/life-lesson Reel, not tech news. Use supplied source ideas, never invent quotes or attribute your metaphor as an ancient quote. Pick a specific everyday dilemma NOT repeated in recent videos; topic_key is a concise distinct concept/scenario. 6 scenes, total narration 125–145 Vietnamese whitespace syllables (hard bound 115–155), around 45–55s with slow voice. Gentle grounded tone, concrete hook, useful action and memorable closing; no miracle promises, victim-blaming, medical claims or requests for engagement. Title two short lines <=22 chars each. For each scene choose one suitable art preset and a SHORT Vietnamese label <=22 chars when helpful (use an empty string otherwise); journal is reflection/notebook, steps progress, rain umbrella, peace calm, noise criticism, burden worries. Avoid choosing artwork whose objects contradict the narration. Keep main title unchanged across scenes. caption one hook/question, description meaningful Facebook posting copy, hashtags 4–6 relevant Vietnamese hashtags. source must exactly equal supplied URL. source_note transparently states adapted idea and section, original examples; not a quotation. Respond only JSON.',
        {
          source: sourceUrl,
          themes,
          recent: recent.map((c) => ({ title: c.title, topic_key: c.topic_key, scenes: c.scenes })),
          correction: issue,
        },
      );
      try {
        const content = reelContentSchema.parse(raw);
        if (content.source !== sourceUrl) throw new Error('Nguồn không nằm trong tập đã kiểm tra');
        rejectRepeatedReel(content, recent);
        await this.repo.pool.query(
          'UPDATE reels_jobs SET content=$2,updated_at=now() WHERE id=$1',
          [job.id, content],
        );
        return content;
      } catch (e) {
        issue = String(e);
        await this.log(job.id, 'Chỉnh lại nội dung: ' + issue.slice(0, 500));
      }
    }
    throw new PermanentError(
      'Không tạo được kịch bản đạt giới hạn/chống trùng sau 3 lượt: ' + issue.slice(0, 300),
    );
  }
  async processNext() {
    const client = await this.repo.pool.connect();
    let locked = false;
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock(74619325) AS acquired')).rows[0]
        .acquired;
      if (!locked) return;
      // Holding this session lock for the entire job prevents duplicate renders across workers.
      // If a process dies, PostgreSQL releases the lock; the next worker resumes its saved job.
      await client.query(
        "UPDATE reels_jobs SET status='PENDING',updated_at=now() WHERE status='RUNNING'",
      );
      const settings = await this.settings();
      const job = (
        await client.query(
          "SELECT j.* FROM reels_jobs j JOIN reels_batches b ON b.id=j.batch_id WHERE j.status='PENDING' AND (b.origin='manual' OR $1=true) ORDER BY j.created_at,j.sequence LIMIT 1",
          [settings.enabled],
        )
      ).rows[0];
      if (!job) return;
      if (!this.ready()) return; // Defaults never start live work.
      await client.query(
        "UPDATE reels_jobs SET status='RUNNING',attempts=attempts+1,error_message=NULL,updated_at=now() WHERE id=$1",
        [job.id],
      );
      try {
        const content = await this.content(job),
          dir = join(this.c.STORAGE_ROOT, 'reels', job.id);
        await mkdir(dir, { recursive: true });
        await this.log(
          job.id,
          'Kịch bản mới đã lưu; bắt đầu giọng Nam Minh trầm chậm và tranh nét trắng.',
        );
        await client.query("UPDATE reels_jobs SET step='voice',updated_at=now() WHERE id=$1", [
          job.id,
        ]);
        const report = await this.render(this.c, dir, content, async (message) => {
          const step = /Rendering|Joining|MP4/.test(message) ? 'render' : 'voice';
          await this.log(job.id, message);
          await this.repo.pool.query('UPDATE reels_jobs SET step=$2,updated_at=now() WHERE id=$1', [
            job.id,
            step,
          ]);
        });
        const bundle = {
          caption: content.caption,
          description: content.description,
          hashtags: content.hashtags,
          posting_text: postingText(content),
          source: content.source,
          source_note: content.source_note,
        };
        await writeFile(join(dir, 'facebook-post.txt'), postingText(content), 'utf8');
        await writeFile(join(dir, 'facebook-post.json'), JSON.stringify(bundle, null, 2));
        const output = {
          path: report.render.path,
          thumbnail: report.render.thumbnail,
          duration: report.qc.duration,
          qc: report.qc,
          post_text: join(dir, 'facebook-post.txt'),
          post_json: join(dir, 'facebook-post.json'),
          voice: report.voice_settings,
        };
        await client.query(
          "UPDATE reels_jobs SET status='READY',step='complete',output=$2,updated_at=now() WHERE id=$1",
          [job.id, output],
        );
        await this.log(job.id, 'Sẵn sàng tải MP4 + mô tả + hashtag. Chưa đăng Facebook/YouTube.');
      } catch (e) {
        const message = safeError(e, this.c);
        await client.query(
          "UPDATE reels_jobs SET status='FAILED',error_message=$2,updated_at=now() WHERE id=$1",
          [job.id, message],
        );
        await this.log(job.id, message);
      }
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(74619325)').catch(() => {});
      client.release();
    }
  }
}
