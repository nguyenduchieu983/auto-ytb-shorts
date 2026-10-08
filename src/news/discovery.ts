import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Config } from '../config';
import {
  canonicalUrl,
  dedupNews,
  News,
  newsSchema,
  PermanentError,
  SkipError,
  sourceQuality,
  Work,
} from '../domain';
import {
  DocumentLoader,
  fallbackFeeds,
  fetchDocument,
  parseFeed,
  preferredDomains,
  snapshot,
  SourceSnapshot,
  sourceAllowed,
} from './sources';

export const newsExtractionSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().min(5),
        source: z.string(),
        url: z.string(),
        published_at: z.string().nullable(),
        summary: z.string().min(10),
        why_it_matters: z.string(),
        category: z.string(),
        company: z.string(),
        kind: z.enum(['news', 'tool']),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(30),
});
export type ExtractedNews = z.infer<typeof newsExtractionSchema>['items'][number];
export interface DiscoveryAI {
  search(w: Work, input: string): Promise<any>;
  extract(w: Work, input: unknown): Promise<{ items: ExtractedNews[] }>;
  rank(w: Work, items: News[]): Promise<News[]>;
}
export interface DiscoveryCounts {
  rawSourcesCount: number;
  extractedNewsCount: number;
  afterDateFilterCount: number;
  afterDedupCount: number;
  afterSourceFilterCount: number;
  finalSelectedCount: number;
  feedSourcesCount: number;
}
export function responseText(response: any): string {
  return typeof response.output_text === 'string' && response.output_text
    ? response.output_text
    : (response.output || [])
        .flatMap((o: any) => o.content || [])
        .filter((c: any) => c.type === 'output_text')
        .map((c: any) => c.text)
        .join('\n');
}
export function responseSources(response: any): string[] {
  const urls = new Set<string>();
  for (const output of response.output || []) {
    for (const source of output.action?.sources || [])
      if (typeof source.url === 'string') urls.add(source.url);
    for (const content of output.content || [])
      for (const citation of content.annotations || [])
        if (citation.type === 'url_citation' && typeof citation.url === 'string')
          urls.add(citation.url);
  }
  return [...urls];
}
async function mapLimited<T, R>(items: T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        result[index] = await task(items[index]);
      }
    }),
  );
  return result;
}

export class NewsDiscoveryService {
  counts: DiscoveryCounts = {
    rawSourcesCount: 0,
    extractedNewsCount: 0,
    afterDateFilterCount: 0,
    afterDedupCount: 0,
    afterSourceFilterCount: 0,
    finalSelectedCount: 0,
    feedSourcesCount: 0,
  };
  private rawUrls = new Set<string>();
  private pages = new Map<string, Promise<SourceSnapshot | null>>();
  private decisions: any[] = [];
  private errors: string[] = [];
  private directory = '';
  private serial = 0;
  constructor(
    private c: Config,
    private ai: DiscoveryAI,
    private load: DocumentLoader = fetchDocument,
  ) {}
  private async begin(w: Work) {
    if (this.directory) return;
    this.directory = join(
      this.c.STORAGE_ROOT,
      'diagnostics',
      w.runId,
      `rev-${w.revision}`,
      `discovery-${Date.now()}-${randomUUID().slice(0, 8)}`,
    );
    await mkdir(this.directory, { recursive: true });
  }
  private async save(name: string, value: unknown) {
    // Only provider response/source content is persisted, never request headers/config.
    await writeFile(join(this.directory, name + '.json'), JSON.stringify(value, null, 2));
  }
  private async page(url: string, origin: 'web' | 'rss'): Promise<SourceSnapshot | null> {
    if (!sourceAllowed(url)) {
      this.decisions.push({ url, rejected: 'invalid_url' });
      return null;
    }
    const key = canonicalUrl(url);
    if (!this.pages.has(key))
      this.pages.set(
        key,
        (async () => {
          try {
            return snapshot(await this.load(url), url, origin);
          } catch (error) {
            this.decisions.push({
              url,
              rejected: error instanceof Error ? error.message : 'fetch_failed',
            });
            return null;
          }
        })(),
      );
    return this.pages.get(key)!;
  }
  private async extract(
    w: Work,
    rawAnswer: string,
    urls: string[],
    sources: SourceSnapshot[],
    now: Date,
    label: string,
  ): Promise<News[]> {
    if (!sources.length) {
      await this.save(label + '-sources', { urls, sources, decisions: this.decisions });
      throw new PermanentError(
        'NEWS_EXTRACTION_FAILED: no accessible article source; inspect source decisions',
      );
    }
    const result: News[] = [];
    for (let offset = 0; offset < sources.length; offset += 10) {
      const batch = sources.slice(offset, offset + 10);
      const parsed = await this.ai.extract(w, {
        now: now.toISOString(),
        raw_answer: rawAnswer,
        source_list: urls,
        sources: batch,
      });
      this.counts.extractedNewsCount += parsed.items.length;
      await this.save(`${label}-extraction-${offset}`, { sources: batch, extracted: parsed.items });
      for (const item of parsed.items) {
        let source: SourceSnapshot | undefined;
        try {
          source = batch.find((s) => s.aliases.includes(canonicalUrl(item.url)));
        } catch {
          /* Invalid URL. */
        }
        if (!source) {
          this.decisions.push({ url: item.url, rejected: 'extracted_url_not_in_sources' });
          continue;
        }
        // Evidence comes from the fetched article, never a model-generated quotation.
        // Ellipses/paraphrases in an LLM summary no longer discard the entire article.
        const freshness =
          source.published_at === null
            ? null
            : (now.getTime() - Date.parse(source.published_at)) / 3600000;
        const candidate = newsSchema.safeParse({
          ...item,
          id: randomUUID(),
          url: source.url,
          canonical_url: source.url,
          source: source.source,
          published_at: source.published_at,
          date_parse_failed: source.published_at === null,
          freshness_hours: freshness,
          older_than_24h: freshness === null || freshness > 24,
          event_date: null,
          evidence: source.text.slice(0, 16000),
          score: 0,
        });
        if (candidate.success) result.push(candidate.data);
        else
          this.decisions.push({
            url: source.url,
            rejected: 'invalid_extracted_item',
            issues: candidate.error.issues.map((i) => ({ path: i.path, code: i.code })),
          });
      }
    }
    if (!result.length)
      throw new PermanentError('NEWS_EXTRACTION_FAILED: extraction produced no valid items');
    return result;
  }
  async searchWithOpenAI(w: Work, now: Date, hours: number): Promise<News[]> {
    await this.begin(w);
    const label = `web-${hours}h-${++this.serial}`;
    const input = `Search LIVE WEB, not memory: hottest AI and tech news ${new Date(now.getTime() - hours * 3600000).toISOString().slice(0, 10)} through ${now.toISOString().slice(0, 10)}. Prefer the last ${hours} hours. Find at least 10 distinct article candidates if available, using separate short queries for new AI models, AI/coding agents, developer tools, APIs, cybersecurity, robotics, infrastructure, chips and emerging AI startups/services. Include a noteworthy newly announced tool/repo/service. Prefer ${preferredDomains.join(', ')}, but include other valid publishers. Cite original article URLs and actual publication dates; unknown dates must remain unknown.`;
    const response = await this.ai.search(w, input);
    const raw = responseText(response),
      urls = responseSources(response);
    console.log('OPENAI RESPONSE ID:', response.id);
    console.log('OPENAI OUTPUT TEXT:', raw);
    console.dir(response.output, { depth: null });
    await this.save(label + '-response', response);
    if (
      !(response.output || []).some(
        (o: any) => o.type === 'web_search_call' && o.status !== 'failed',
      )
    )
      throw new PermanentError('WEB_SEARCH_NOT_EXECUTED: no web_search_call returned');
    if (!urls.length) throw new PermanentError('WEB_SEARCH_RETURNED_ZERO_SOURCES');
    for (const url of urls) this.rawUrls.add(url);
    this.counts.rawSourcesCount = this.rawUrls.size;
    const snapshots = (await mapLimited(urls.slice(0, 40), (url) => this.page(url, 'web'))).filter(
      (s): s is SourceSnapshot => !!s,
    );
    return this.extract(w, raw, urls, snapshots, now, label);
  }
  async searchWithFallbackFeeds(w: Work, now: Date): Promise<News[]> {
    await this.begin(w);
    const feedLogs: any[] = [];
    const entries = (
      await mapLimited(fallbackFeeds, async (feed) => {
        try {
          const document = await this.load(feed.url);
          const all = parseFeed(document.body, document.url, feed.source);
          const selected = all
            .filter((e) =>
              /\b(ai|llm|model|agent|code|coding|developer|api|cyber|security|robot|chip|gpu|cloud|infrastructure|software|open.source)\b/i.test(
                e.title + ' ' + e.summary,
              ),
            )
            .filter(
              (e) => !e.published_at || now.getTime() - Date.parse(e.published_at) <= 72 * 3600000,
            )
            .slice(0, 5);
          feedLogs.push({ ...feed, parsed: all.length, candidates: selected.length });
          return selected;
        } catch (error) {
          feedLogs.push({ ...feed, error: error instanceof Error ? error.message : 'feed_failed' });
          return [];
        }
      })
    ).flat();
    const unique = [...new Map(entries.map((e) => [e.url, e])).values()].slice(0, 30);
    this.counts.feedSourcesCount = unique.length;
    await this.save('feeds', { feeds: feedLogs, entries: unique });
    const snapshots = (
      await mapLimited(unique, async (e) => {
        const page = await this.page(e.url, 'rss');
        if (!page) return null;
        return {
          ...page,
          published_at: page.published_at || e.published_at,
          title: page.title || e.title,
        };
      })
    ).filter((s): s is SourceSnapshot => !!s);
    if (!snapshots.length) return [];
    return this.extract(
      w,
      'Fallback candidates from official/public RSS and Atom feeds. Extract only relevant AI/tech articles from the supplied readable sources.',
      unique.map((e) => e.url),
      snapshots,
      now,
      'rss',
    );
  }
  mergeSources(...groups: News[][]): News[] {
    return groups.flat();
  }
  validateNews(items: News[], now: Date, hours: number): News[] {
    return items.flatMap((item) => {
      const freshness = item.published_at
        ? (now.getTime() - Date.parse(item.published_at)) / 3600000
        : null;
      if (freshness !== null && (freshness < 0 || freshness > hours)) {
        this.decisions.push({
          url: item.url,
          rejected: freshness < 0 ? 'future_date' : 'outside_window',
          hours,
        });
        return [];
      }
      return [
        {
          ...item,
          freshness_hours: freshness,
          older_than_24h: freshness === null || freshness > 24,
          date_parse_failed: item.published_at === null,
        },
      ];
    });
  }
  deduplicate(items: News[], previous: News[] = []): News[] {
    return dedupNews(items, previous);
  }
  async discover(
    w: Work,
    now: Date,
    previous: News[] = [],
  ): Promise<{ items: News[]; diagnostics: DiscoveryCounts }> {
    await this.begin(w);
    let candidates: News[] = [],
      items: News[] = [];
    for (const hours of [24, 48, 72]) {
      try {
        candidates = this.mergeSources(candidates, await this.searchWithOpenAI(w, now, hours));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'NEWS_DISCOVERY_SEARCH_FAILED';
        this.errors.push(message);
        console.error(message);
        // Authentication/schema errors must remain actionable, not become "no news".
        if (!/^WEB_SEARCH_|^NEWS_EXTRACTION_FAILED/.test(message)) throw error;
      }
      const valid = this.validateNews(candidates, now, hours);
      items = this.deduplicate(valid, previous);
      this.counts.afterDateFilterCount = valid.length;
      this.counts.afterDedupCount = items.length;
      this.counts.afterSourceFilterCount = items.length;
      console.log({ windowHours: hours, ...this.counts });
      if (items.length >= 5) break;
    }
    if (items.length < 5) {
      try {
        candidates = this.mergeSources(candidates, await this.searchWithFallbackFeeds(w, now));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'RSS_EXTRACTION_FAILED';
        this.errors.push(message);
        console.error(message);
        if (!/^NEWS_EXTRACTION_FAILED/.test(message)) throw error;
      }
      const valid = this.validateNews(candidates, now, 72);
      items = this.deduplicate(valid, previous);
      this.counts.afterDateFilterCount = valid.length;
      this.counts.afterDedupCount = items.length;
      this.counts.afterSourceFilterCount = items.length;
    }
    await this.save('summary', {
      counts: this.counts,
      errors: this.errors,
      decisions: this.decisions,
      items,
    });
    console.log(this.counts);
    if (!items.length)
      throw new SkipError(
        `NEWS_DISCOVERY_EMPTY: web sources=${this.counts.rawSourcesCount}, feed sources=${this.counts.feedSourcesCount}, extracted=${this.counts.extractedNewsCount}; ${this.errors.join('; ') || 'all candidates outside date window/duplicate/invalid; inspect discovery summary'}`,
      );
    return { items, diagnostics: { ...this.counts } };
  }
  async rank(w: Work, items: News[]): Promise<News[]> {
    if (!items.length) return [];
    return (await this.ai.rank(w, items)).map((n) => ({
      ...n,
      score: Math.min(100, n.score + sourceQuality(n)),
    }));
  }
  selectTopNews(items: News[]): News[] {
    const sorted = this.deduplicate(items).sort(
      (a, b) => b.score - a.score || b.confidence - a.confidence,
    );
    const selected: News[] = [];
    // Prefer distinct companies/topics and two news + one tool when available.
    for (const n of sorted) {
      if (n.kind === 'tool' && selected.some((p) => p.kind === 'tool')) continue;
      if (
        selected.filter((p) => p.company === n.company).length >= 2 ||
        selected.filter((p) => p.category === n.category).length >= 2
      )
        continue;
      selected.push(n);
      if (selected.length === 3) break;
    }
    for (const n of sorted) {
      if (selected.length === 3) break;
      if (!selected.some((s) => s.id === n.id)) selected.push(n);
    }
    this.counts.finalSelectedCount = selected.length;
    console.log(this.counts);
    if (!selected.length)
      throw new SkipError('NEWS_DISCOVERY_EMPTY: no valid items available for ranking');
    return selected;
  }
}
