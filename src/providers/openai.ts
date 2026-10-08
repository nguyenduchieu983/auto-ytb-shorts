import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Config } from '../config';
import { Repository } from '../db';
import {
  canonicalUrl,
  News,
  newsListSchema,
  PermanentError,
  Script,
  scriptSchema,
  storyboardSchema,
  Storyboard,
  metadataSchema,
  Work,
  verificationSchema,
  normalize,
  StaleWorkError,
} from '../domain';
import { Media, VoiceOutput, VisualOutput } from '../media';
import { mockNews, mockScript, mockStoryboard } from '../mock';

const allowed = [
  'openai.com',
  'anthropic.com',
  'google.com',
  'blog.google',
  'deepmind.google',
  'microsoft.com',
  'github.blog',
  'github.com',
  'nvidia.com',
  'amd.com',
  'aws.amazon.com',
  'cloudflare.com',
  'meta.com',
  'reuters.com',
  'apnews.com',
  'techcrunch.com',
  'theverge.com',
];
function removeUriFormats(schema: any): void {
  if (!schema || typeof schema !== 'object') return;
  // OpenAI strict outputs reject JSON Schema's URI format. Zod still validates
  // URLs locally after the response; other supported constraints are preserved.
  if (schema.format === 'uri') delete schema.format;
  for (const value of Object.values(schema)) removeUriFormats(value);
}
export function sourceAllowed(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === '443') &&
      allowed.some((d) => u.hostname === d || u.hostname.endsWith('.' + d))
    );
  } catch {
    return false;
  }
}
export function publishedDate(html: string): string | null {
  const json = html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1];
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  const meta = tags.find((t) =>
    /(?:property|name)\s*=\s*["'](?:article:published_time|datePublished|pubdate)["']/i.test(t),
  );
  const value = json || meta?.match(/content\s*=\s*["']([^"']+)/i)?.[1];
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:?\d{2}))?$/.test(value)) return null;
  // Date-only sources have uncertain intraday freshness: use start of the UTC day, conservatively.
  const date = new Date(value.length === 10 ? value + 'T00:00:00Z' : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
async function sourceSnapshot(
  url: string,
  reject: (reason: string) => void,
): Promise<{ url: string; published_at: string; text: string } | null> {
  try {
    for (let hop = 0; hop < 5; hop++) {
      if (!sourceAllowed(url)) {
        reject('disallowed_url');
        return null;
      }
      const r = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': 'AI-Tech-Daily/0.1 (source-verification)' },
      });
      if (r.status >= 300 && r.status < 400) {
        url = new URL(r.headers.get('location') || '', url).toString();
        continue;
      }
      if (!r.ok) {
        reject(`http_${r.status}`);
        return null;
      }
      if (!r.headers.get('content-type')?.includes('text/html') || !r.body) {
        reject('not_html');
        return null;
      }
      const reader = r.body.getReader();
      const parts: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > 2_000_000) {
          await reader.cancel();
          reject('page_too_large');
          return null;
        }
        parts.push(next.value);
      }
      const html = Buffer.concat(parts).toString('utf8'),
        published_at = publishedDate(html);
      if (!published_at) {
        reject('missing_publication_date');
        return null;
      }
      const text = html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(?:nbsp|amp|quot|lt|gt);/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 24000);
      return { url: canonicalUrl(url), published_at, text };
    }
    reject('too_many_redirects');
  } catch {
    reject('fetch_failed');
    /* A source failing to load is excluded, never substituted with invented evidence. */
  }
  return null;
}
export class OpenAiProvider {
  constructor(
    private c: Config,
    private repo: Repository,
    private media: Media,
  ) {}
  private async prompt(name: string) {
    return readFile(join('prompts', name + '.md'), 'utf8');
  }
  private async request(w: Work, endpoint: string, body: any, reserve: number): Promise<any> {
    const id = await this.repo.reserve(w, body.model, reserve, this.c.MAX_RUN_COST_USD);
    const r = await fetch('https://api.openai.com/v1/' + endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.c.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    if (!r.ok) {
      const raw = await r.text();
      let details: any;
      try {
        details = JSON.parse(raw).error;
      } catch {
        /* Non-JSON upstream errors retain HTTP status. */
      }
      const redact = (value: unknown): string => {
        let text = typeof value === 'string' ? value : '';
        for (const secret of [
          this.c.OPENAI_API_KEY,
          this.c.GOOGLE_CLIENT_SECRET,
          this.c.YOUTUBE_REFRESH_TOKEN,
          this.c.TELEGRAM_BOT_TOKEN,
          this.c.ADMIN_TOKEN,
          this.c.TELEGRAM_WEBHOOK_SECRET,
        ])
          if (secret) text = text.split(secret).join('[redacted]');
        return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 1000);
      };
      const diagnostic = {
        status: r.status,
        endpoint,
        model: body.model,
        request_id: r.headers.get('x-request-id'),
        type: redact(details?.type),
        code: redact(details?.code),
        param: redact(details?.param),
        message: redact(details?.message),
      };
      const dir = join(this.c.STORAGE_ROOT, 'diagnostics', w.runId, `rev-${w.revision}`);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `api-error-${Date.now()}.json`),
        JSON.stringify(diagnostic, null, 2),
      );
      const message =
        `OpenAI ${endpoint} HTTP ${r.status}` +
        (diagnostic.message ? `: ${diagnostic.message}` : '') +
        (diagnostic.param ? ` (param: ${diagnostic.param})` : '');
      if ([400, 401, 403, 404].includes(r.status)) throw new PermanentError(message);
      throw new Error(message);
    }
    if (endpoint === 'audio/speech') return Buffer.from(await r.arrayBuffer());
    const value: any = await r.json();
    await this.repo.usage(id, value.usage);
    if (value.status && value.status !== 'completed') throw new Error('OpenAI response incomplete');
    return value;
  }
  private outputText(r: any): string {
    return (r.output || [])
      .flatMap((o: any) => o.content || [])
      .filter((o: any) => o.type === 'output_text')
      .map((o: any) => o.text)
      .join('\n');
  }
  private async structured<T extends z.ZodTypeAny>(
    w: Work,
    name: string,
    schema: T,
    input: any,
  ): Promise<z.infer<T>> {
    // Keep the conversion boundary non-generic: zod-to-json-schema's recursive overload
    // otherwise expands every inferred output schema during TypeScript compilation.
    const convert = zodToJsonSchema as unknown as (value: z.ZodTypeAny, options: any) => any;
    const jsonSchema = convert(schema, { $refStrategy: 'none' });
    delete jsonSchema.$schema;
    removeUriFormats(jsonSchema);
    const r = await this.request(
      w,
      'responses',
      {
        model: this.c.OPENAI_TEXT_MODEL,
        instructions: await this.prompt(name),
        input: JSON.stringify(input),
        text: {
          format: {
            type: 'json_schema',
            name: name.replace(/-/g, '_'),
            strict: true,
            schema: jsonSchema,
          },
        },
        max_output_tokens: 6000,
      },
      this.c.TEXT_CALL_RESERVE_USD,
    );
    try {
      return schema.parse(JSON.parse(this.outputText(r)));
    } catch {
      throw new Error(`Invalid structured output for ${name}`);
    }
  }
  async discover(w: Work, now: Date, hours: number): Promise<News[]> {
    if (this.c.MOCK_OPENAI) return mockNews(now);
    const r = await this.request(
      w,
      'responses',
      {
        model: this.c.OPENAI_SEARCH_MODEL,
        instructions:
          (await this.prompt('news-search')) +
          '\nUse several short search queries covering AI models, developer tools, and technology launches, varying publishers. Do not use the entire user request as one search query. Open individual articles, not listing pages. Return only findings actually supported by search, and explicitly report if no matching articles are found.',
        input: `What are the hottest AI, developer tools and technology news stories from ${new Date(now.getTime() - hours * 3600000).toISOString().slice(0, 10)} through ${now.toISOString().slice(0, 10)}? Find 5-15 distinct articles with original article URLs and actual publication dates.`,
        tools: [{ type: 'web_search', filters: { allowed_domains: allowed } }],
        tool_choice: 'required',
        include: ['web_search_call.action.sources'],
        max_output_tokens: 6000,
      },
      this.c.SEARCH_CALL_RESERVE_USD,
    );
    const urls = new Set<string>();
    for (const output of r.output || []) {
      for (const src of output.action?.sources || []) if (src.url) urls.add(src.url);
      for (const content of output.content || [])
        for (const cite of content.annotations || [])
          if (cite.type === 'url_citation') urls.add(cite.url);
    }
    const diagnosticDir = join(this.c.STORAGE_ROOT, 'diagnostics', w.runId, `rev-${w.revision}`);
    await mkdir(diagnosticDir, { recursive: true });
    const diagnostic: any = {
      hours,
      now: now.toISOString(),
      output_types: (r.output || []).map((o: any) => o.type),
      search_calls: (r.output || []).filter((o: any) => o.type === 'web_search_call'),
      response_text: this.outputText(r),
      cited_urls: [...urls],
      sources: [],
    };
    const saveDiagnostic = () =>
      writeFile(
        join(diagnosticDir, `discovery-${hours}h.json`),
        JSON.stringify(diagnostic, null, 2),
      );
    if (!(r.output || []).some((o: any) => o.type === 'web_search_call')) {
      await saveDiagnostic();
      throw new PermanentError(
        'OpenAI returned no web_search_call despite required search; inspect discovery diagnostics',
      );
    }
    const snapshots: { url: string; published_at: string; text: string }[] = [];
    for (const url of [...urls].slice(0, 25)) {
      let rejection: string | undefined;
      const s = await sourceSnapshot(url, (reason) => {
        rejection = reason;
      });
      diagnostic.sources.push({
        url,
        fetched: Boolean(s),
        published_at: s?.published_at,
        rejection:
          rejection ||
          (s && Date.parse(s.published_at) > now.getTime()
            ? 'future_date'
            : s && Date.parse(s.published_at) < now.getTime() - hours * 3600000
              ? 'outside_window'
              : undefined),
        in_window: Boolean(
          s &&
          Date.parse(s.published_at) <= now.getTime() &&
          Date.parse(s.published_at) >= now.getTime() - hours * 3600000,
        ),
      });
      if (
        s &&
        Date.parse(s.published_at) <= now.getTime() &&
        Date.parse(s.published_at) >= now.getTime() - hours * 3600000
      )
        snapshots.push(s);
    }
    diagnostic.accepted_sources = snapshots.length;
    await saveDiagnostic();
    if (!snapshots.length) return [];
    const parsed = await this.structured(w, 'news-extract', newsListSchema, {
      now: now.toISOString(),
      sources: snapshots,
    });
    const items = parsed.items.flatMap((n) => {
      const source = snapshots.find((s) => s.url === canonicalUrl(n.url));
      if (!source || !normalize(source.text).includes(normalize(n.evidence))) return [];
      return [
        {
          ...n,
          id: randomUUID(),
          url: source.url,
          canonical_url: source.url,
          published_at: source.published_at,
          older_than_24h: now.getTime() - Date.parse(source.published_at) > 86400000,
          score: 0,
        },
      ];
    });
    diagnostic.extracted_items = parsed.items.length;
    diagnostic.verified_items = items.length;
    await saveDiagnostic();
    return items;
  }
  async rank(w: Work, items: News[]): Promise<News[]> {
    if (this.c.MOCK_OPENAI) return items;
    const scores = await this.structured(
      w,
      'news-rank',
      z.object({
        scores: z.array(
          z.object({
            id: z.string(),
            novelty: z.number().min(0).max(25),
            developer_interest: z.number().min(0).max(25),
            mass_appeal: z.number().min(0).max(20),
            practical_value: z.number().min(0).max(20),
          }),
        ),
      }),
      { items },
    );
    if (
      scores.scores.length !== items.length ||
      new Set(scores.scores.map((s) => s.id)).size !== items.length
    )
      throw new Error('Incomplete ranking');
    return items.map((n) => {
      const s = scores.scores.find((s) => s.id === n.id);
      if (!s) throw new Error('Missing rank');
      return { ...n, score: s.novelty + s.developer_interest + s.mass_appeal + s.practical_value };
    });
  }
  async script(w: Work, news: News[], previous?: Script, issues?: any): Promise<Script> {
    if (this.c.MOCK_OPENAI) return mockScript(news);
    const script = await this.structured(w, 'script', scriptSchema, { news, previous, issues });
    if (
      new Set(script.segments.map((s) => s.news_id)).size !== 3 ||
      !script.segments.every((s) => news.some((n) => n.id === s.news_id))
    )
      throw new Error('Script news IDs mismatch');
    for (const segment of script.segments) {
      const item = news.find((n) => n.id === segment.news_id)!;
      if (item.older_than_24h) {
        const [year, month, day] = item.published_at.slice(0, 10).split('-');
        const date = `${day}/${month}/${year}`;
        if (!segment.narration.includes(date))
          segment.narration = `Theo thông tin công bố ngày ${date}, ${segment.narration}`;
      }
    }
    const full = [
      script.hook,
      ...script.segments.map((s) => s.narration),
      script.takeaway,
      script.cta,
    ]
      .filter(Boolean)
      .join(' ');
    return { ...script, full_script: full };
  }
  async verify(w: Work, news: News[], script: Script) {
    if (this.c.MOCK_OPENAI) return { unsupported_claims: [], needs_rewrite: false };
    return this.structured(w, 'verify-script', verificationSchema, { news, script });
  }
  async storyboard(w: Work, script: Script, news: News[]): Promise<Storyboard> {
    const board = this.c.MOCK_OPENAI
      ? mockStoryboard(script)
      : await this.structured(w, 'storyboard', storyboardSchema, { script, news });
    if (
      new Set(board.scenes.map((s) => s.scene_id)).size !== board.scenes.length ||
      normalize(board.scenes.map((s) => s.narration).join(' ')) !== normalize(script.full_script)
    )
      throw new Error('Storyboard must preserve exact narration in scene order');
    return board;
  }
  async metadata(w: Work, news: News[]) {
    const output = this.c.MOCK_OPENAI
      ? {
          title: 'Demo: Bản tin AI & Tech tự động',
          description: 'Dữ liệu mẫu, không phải tin thật.',
          hashtags: ['#AI', '#Tech', '#Shorts'],
          tags: ['AI', 'Tech'],
        }
      : await this.structured(w, 'metadata', metadataSchema, { news });
    const suffix = `\n\nNguồn:\n${news.map((n) => `${n.title} (ngày nguồn ${n.published_at.slice(0, 10)}): ${n.url}`).join('\n')}\n\nGiọng đọc và hình minh họa được tạo bằng AI.\n${output.hashtags.join(' ')}`;
    return metadataSchema.parse({ ...output, description: output.description + suffix });
  }
  async voice(w: Work, dir: string, board: Storyboard): Promise<VoiceOutput> {
    const words = board.scenes.map((s) => s.narration.split(/\s+/).length),
      total = words.reduce((a, b) => a + b, 0),
      paths: string[] = [];
    for (let i = 0; i < board.scenes.length; i++) {
      const path = join(dir, `voice-${i}.${this.c.MOCK_OPENAI ? 'wav' : 'mp3'}`);
      paths.push(path);
      if (this.c.MOCK_OPENAI) await this.media.mockVoice(path, (55 * words[i]) / total);
      else {
        const audio = await this.request(
          w,
          'audio/speech',
          {
            model: this.c.OPENAI_TTS_MODEL,
            voice: this.c.OPENAI_TTS_VOICE,
            input: board.scenes[i].narration,
            instructions:
              'Đọc tiếng Việt tự nhiên, giọng bản tin công nghệ, rõ ràng, tốc độ vừa phải. Giữ cùng một giọng và phong cách qua từng đoạn.',
            response_format: 'mp3',
          },
          this.c.VOICE_CALL_RESERVE_USD,
        );
        await writeFile(path, audio);
      }
    }
    return this.media.joinVoice(
      dir,
      paths,
      board.scenes.map((s) => s.scene_id),
      this.c.MOCK_OPENAI,
    );
  }
  async visuals(w: Work, dir: string, board: Storyboard): Promise<VisualOutput> {
    const images: VisualOutput['images'] = [];
    for (const scene of board.scenes) {
      let bytes: Buffer | undefined;
      let fallback = false;
      if (!this.c.MOCK_OPENAI && scene.visual_type === 'image') {
        try {
          const r = await this.request(
            w,
            'images/generations',
            {
              model: this.c.OPENAI_IMAGE_MODEL,
              prompt: (await this.prompt('image')) + '\n' + scene.visual_prompt,
              size: '1024x1536',
              quality: 'low',
              n: 1,
            },
            this.c.IMAGE_CALL_RESERVE_USD,
          );
          if (!r.data?.[0]?.b64_json) throw new Error('Missing image');
          bytes = Buffer.from(r.data[0].b64_json, 'base64');
        } catch (e) {
          if (e instanceof StaleWorkError || e instanceof PermanentError) throw e;
          fallback = true;
        }
      }
      const path = join(dir, `image-${scene.scene_id}.png`);
      await this.media.card(
        path,
        scene.overlay_text,
        scene.source_label,
        this.c.MOCK_OPENAI,
        bytes,
      );
      images.push({ scene_id: scene.scene_id, path, fallback });
    }
    return { images };
  }
}
