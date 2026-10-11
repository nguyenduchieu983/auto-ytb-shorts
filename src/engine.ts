import { Config, localDate } from './config';
import { Repository } from './db';
import { VideoScheduler } from './video-schedule';
import {
  dedupNews,
  durationClass,
  News,
  PermanentError,
  ReviewError,
  SkipError,
  StaleWorkError,
  Step,
  UploadUncertainError,
  Work,
} from './domain';
import { Media } from './media';
import { OpenAiProvider } from './providers/openai';
import { TelegramProvider } from './providers/telegram';
import { YoutubeProvider } from './providers/youtube';
import { Storage } from './storage';

export function safeError(error: unknown, c: Config): string {
  let text = error instanceof Error ? error.message : 'Unknown failure';
  for (const key of [
    'OPENAI_API_KEY',
    'GOOGLE_CLIENT_SECRET',
    'YOUTUBE_REFRESH_TOKEN',
    'TELEGRAM_BOT_TOKEN',
    'ADMIN_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET',
    'DATABASE_URL',
    'REDIS_URL',
  ] as const)
    if (c[key]) text = text.split(c[key]).join('[redacted]');
  return text
    .replace(/(?:postgres(?:ql)?|rediss?):\/\/[^\s"']+/gi, '[connection]')
    .replace(/https:\/\/www\.googleapis\.com\/upload\/[^\s]+/g, '[upload-session]')
    .slice(0, 4000);
}
export class Pipeline {
  readonly storage: Storage;
  readonly media: Media;
  readonly ai: OpenAiProvider;
  readonly telegram: TelegramProvider;
  readonly youtube: YoutubeProvider;
  constructor(
    public c: Config,
    public repo: Repository,
  ) {
    this.storage = new Storage(c.STORAGE_ROOT);
    this.media = new Media(c);
    this.ai = new OpenAiProvider(c, repo, this.media);
    this.telegram = new TelegramProvider(c);
    this.youtube = new YoutubeProvider(c, repo);
  }
  async run(now = new Date(), requestKey?: string) {
    return this.repo.create(localDate(now, this.c.APP_TIMEZONE), this.c.MOCK_OPENAI, requestKey);
  }
  async execute(w: Work): Promise<void> {
    const claim = await this.repo.claim(w);
    if (!claim) return;
    const heartbeat = setInterval(() => {
      this.repo.heartbeat(w, claim.token).catch(() => {});
    }, 30000);
    try {
      const dir = await this.storage.directory(claim.run, w.step, claim.attempt),
        o = claim.outputs;
      let result: any, status: string | undefined;
      switch (w.step) {
        case 'discover': {
          const now = new Date();
          const discovered = this.c.MOCK_OPENAI
            ? { items: await this.ai.discover(w, now, 24) }
            : await this.ai.newsDiscovery().discover(w, now, await this.repo.previousNews(w.runId));
          result = { ...discovered, discovered_at: now.toISOString() };
          break;
        }
        case 'rank': {
          const history = await this.repo.previousNews(w.runId);
          const candidates = dedupNews(o.discover.items, history);
          const novelty = await this.ai.filterRepeatedNews(w, candidates, history);
          await this.storage.json(dir, 'novelty.json', novelty);
          const items = novelty.items;
          const discovery = this.ai.newsDiscovery();
          if (o.discover.diagnostics) discovery.counts = { ...o.discover.diagnostics };
          const scored = this.c.MOCK_OPENAI ? items : await discovery.rank(w, items);
          const requirePublicationDate = await new VideoScheduler(
            this.repo,
            this.c,
          ).autoPublishAllowed(w.runId);
          if (requirePublicationDate)
            await this.repo.log(
              w,
              `Auto-upload selection: ${scored.filter((n) => n.published_at !== null).length}/${scored.length} candidates have a publication date; undated items excluded`,
            );
          result = {
            items: scored,
            selected: discovery.selectTopNews(scored, requirePublicationDate),
            require_publication_date: requirePublicationDate,
            format: 'single-story',
            diagnostics: discovery.counts,
            novelty: novelty.decisions,
          };
          break;
        }
        case 'script':
          result = await this.ai.script(w, o.rank.selected);
          break;
        case 'verify': {
          let script = o.script,
            verification;
          for (let round = 0; round <= 2; round++) {
            verification = await this.ai.verify(w, o.rank.selected, script);
            if (!verification.needs_rewrite && !verification.unsupported_claims.length) {
              result = { script, verification, verified: true, rewrite_rounds: round };
              break;
            }
            if (round < 2) script = await this.ai.script(w, o.rank.selected, script, verification);
          }
          if (!result) {
            await this.storage.json(dir, 'verification-failed.json', { script, verification });
            throw new ReviewError('Unsupported script claims remain after two rewrites');
          }
          break;
        }
        case 'storyboard':
          result = await this.ai.storyboard(w, o.verify.script, o.rank.selected);
          break;
        case 'voice': {
          result = await this.ai.voice(w, dir, o.storyboard);
          if (durationClass(result.duration) === 'fail') {
            await this.storage.json(dir, 'voice-rejected.json', result);
            throw new ReviewError(
              `Voice is ${result.duration.toFixed(1)}s; regenerate script to fit 40-65s envelope`,
            );
          }
          break;
        }
        case 'visuals':
          result = await this.ai.visuals(w, dir, o.storyboard);
          break;
        case 'metadata':
          result = await this.ai.metadata(w, o.rank.selected);
          break;
        case 'subtitles':
          result = await this.media.subtitles(dir, o.storyboard, o.voice);
          break;
        case 'render': {
          result = await this.media.render(dir, o.visuals, o.voice, o.subtitles, (message) =>
            this.repo.log(w, message),
          );
          result.checksum = await this.storage.checksum(result.path);
          break;
        }
        case 'qc': {
          const technical = await this.media.validate(o.render, o.subtitles, claim.run.mock);
          const news = o.rank.selected as News[];
          // Previously ranked revisions keep their original format when regenerated downstream.
          const singleStory = o.rank.format === 'single-story';
          const checks = {
            ...technical.checks,
            verified: o.verify.verified === true,
            news_count: singleStory ? news.length === 1 : news.length >= 1 && news.length <= 3,
            sources: news.every((n) => n.url && n.evidence),
            unique_sources: dedupNews(news).length === news.length,
            visual_coverage:
              o.visuals.images.length >= 4 &&
              o.voice.timings.every((t: any) =>
                o.visuals.images.some((i: any) => i.scene_id === t.scene_id),
              ),
            metadata: news.every((n) => o.metadata.description.includes(n.url)),
            integrity: (await this.storage.checksum(o.render.path)) === o.render.checksum,
          };
          const hard_pass = Object.values(checks).every(Boolean);
          const freshness = news.filter((n) => !n.older_than_24h).length / news.length;
          const score = hard_pass
            ? Math.round(75 + 15 * freshness + (technical.duration_class === 'pass' ? 10 : 0))
            : 0;
          const autoBlockReasons = [
            ...(!hard_pass ? ['Kiểm chứng/QC bắt buộc chưa đạt'] : []),
            ...(score < 85 ? [`QC ${score}/100, cần ít nhất 85`] : []),
            ...(technical.duration_class !== 'pass'
              ? ['Thời lượng ngoài khoảng tự upload 45–60 giây']
              : []),
            ...(claim.run.mock ? ['Video dùng provider mock'] : []),
            ...(news.length !== (singleStory ? 1 : 3) ? ['Số tin không đúng format video'] : []),
            ...news
              .filter((n) => n.published_at === null)
              .map((n) => `Thiếu ngày xuất bản nguồn: ${n.title}`),
          ];
          result = {
            ...technical,
            checks,
            hard_pass,
            score,
            auto_eligible: autoBlockReasons.length === 0,
            auto_block_reasons: autoBlockReasons,
          };
          if (!hard_pass) {
            await this.storage.json(dir, 'qc-failed.json', result);
            throw new ReviewError('Mandatory QC check failed; regenerate the failed stage');
          }
          if (autoBlockReasons.length)
            await this.repo.log(w, `Auto-upload blocked: ${autoBlockReasons.join('; ')}`, 'warn');
          break;
        }
        case 'approval': {
          await this.repo.assertCurrent(w, claim.token);
          const costs = (await this.repo.detail(w.runId)).costs.reduce(
            (sum: number, r: any) => sum + Number(r.reserved_usd),
            0,
          );
          result = await this.telegram.preview(
            claim.run,
            o.render,
            o.metadata,
            o.rank.selected,
            o.qc,
            costs,
          );
          status = 'WAITING_APPROVAL';
          break;
        }
        case 'upload': {
          await this.repo.assertCurrent(w, claim.token);
          if (!o.qc.hard_pass || !o.verify.verified)
            throw new PermanentError('Upload content gates failed');
          if ((await this.storage.checksum(o.render.path)) !== o.render.checksum)
            throw new PermanentError('Approved video checksum changed');
          result = await this.youtube.publish(
            w,
            this.storage.safe(o.render.path),
            o.metadata,
            claim.run.mock,
          );
          status = result.privacy === 'public' ? 'PUBLISHED' : 'UPLOADED_PRIVATE';
          break;
        }
      }
      await this.repo.assertCurrent(w, claim.token);
      const artifact = await this.storage.json(dir, 'result.json', result);
      await this.repo.finish(w, claim.token, result, artifact, status);
      if (
        w.step === 'approval' &&
        o.qc.auto_eligible &&
        (await new VideoScheduler(this.repo, this.c).autoPublishAllowed(w.runId))
      )
        await this.repo.publish(w.runId, w.revision, 'auto');
      if (w.step === 'upload')
        await this.telegram
          .notify(
            `Upload hoàn tất: ${w.runId} revision ${w.revision}\nPrivacy: ${result.privacy}\n${result.url || 'Mock upload'}`,
          )
          .catch(() => {});
    } catch (e) {
      if (e instanceof StaleWorkError) return;
      const message = safeError(e, this.c);
      const terminal =
        e instanceof SkipError
          ? 'SKIPPED'
          : e instanceof ReviewError
            ? 'NEEDS_REVISION'
            : e instanceof UploadUncertainError
              ? 'UPLOAD_UNCERTAIN'
              : e instanceof PermanentError || claim.attempt >= 3
                ? 'FAILED'
                : undefined;
      await this.repo.fail(w, claim.token, message, terminal);
      if (terminal)
        await this.telegram
          .notify(
            `Pipeline ${terminal}: ${w.runId} revision ${w.revision}\nStep: ${w.step}\n${message}`,
          )
          .catch(() => {});
      if (!terminal) throw new Error(message);
    } finally {
      clearInterval(heartbeat);
    }
  }
  async regenerate(
    id: string,
    revision: number,
    target: 'script' | 'voice' | 'visuals' | 'render',
  ) {
    return this.repo.regenerate(id, revision, target);
  }
  async reconcile(id: string, revision: number, videoId: string) {
    return this.repo.tx(async (client) => {
      // Serialize reconciliation with retry/regenerate and commit all upload
      // state together after ownership verification.
      const run = (await client.query('SELECT * FROM daily_runs WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      const upload = (
        await client.query(
          "SELECT status FROM pipeline_steps WHERE run_id=$1 AND revision=$2 AND step='upload'",
          [id, revision],
        )
      ).rows[0];
      const attempt = await this.repo.upload({ runId: id, revision, step: 'upload' });
      if (
        !run ||
        run.revision !== revision ||
        !['UPLOAD_UNCERTAIN', 'FAILED'].includes(run.status) ||
        upload?.status !== 'FAILED' ||
        !attempt ||
        attempt.status === 'REJECTED'
      )
        throw new PermanentError('Run is not awaiting upload reconciliation');
      const result = await this.youtube.reconcile({ runId: id, revision, step: 'upload' }, videoId);
      await client.query(
        "UPDATE upload_attempts SET status='UPLOADED',youtube_video_id=$3,response=$4,updated_at=now() WHERE run_id=$1 AND revision=$2",
        [id, revision, videoId, JSON.stringify({ status: { privacyStatus: result.privacy } })],
      );
      await client.query(
        'UPDATE pipeline_steps SET status=$4,output=$5,lease_token=NULL,finished_at=now() WHERE run_id=$1 AND revision=$2 AND step=$3',
        [id, revision, 'upload', 'SUCCEEDED', JSON.stringify(result)],
      );
      await client.query(
        'UPDATE daily_runs SET status=$2,error_message=NULL,updated_at=now() WHERE id=$1',
        [id, result.privacy === 'public' ? 'PUBLISHED' : 'UPLOADED_PRIVATE'],
      );
      return result;
    });
  }
}
