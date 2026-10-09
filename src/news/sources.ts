import { load } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { canonicalUrl } from '../domain';

export const preferredDomains = [
  'openai.com',
  'anthropic.com',
  'blog.google',
  'deepmind.google',
  'github.blog',
  'microsoft.com',
  'nvidia.com',
  'amd.com',
  'aws.amazon.com',
  'cloudflare.com',
  'reuters.com',
  'apnews.com',
  'techcrunch.com',
  'theverge.com',
  'venturebeat.com',
  'arstechnica.com',
  'thenewstack.io',
  'bleepingcomputer.com',
  'theregister.com',
  'the-decoder.com',
  'zdnet.com',
  'huggingface.co',
  'vnexpress.net',
];
export const fallbackFeeds = [
  { source: 'OpenAI', url: 'https://openai.com/news/rss.xml' },
  { source: 'Anthropic', url: 'https://www.anthropic.com/rss.xml' },
  { source: 'Google AI', url: 'https://blog.google/technology/ai/rss/' },
  { source: 'GitHub', url: 'https://github.blog/feed/' },
  { source: 'Microsoft', url: 'https://blogs.microsoft.com/feed/' },
  { source: 'NVIDIA', url: 'https://blogs.nvidia.com/feed/' },
  { source: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
  { source: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  { source: 'The Register', url: 'https://www.theregister.com/headlines.atom' },
  { source: 'The New Stack', url: 'https://thenewstack.io/feed/' },
  { source: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/' },
  { source: 'AWS Machine Learning', url: 'https://aws.amazon.com/blogs/machine-learning/feed/' },
  { source: 'The Decoder', url: 'https://the-decoder.com/feed/' },
  { source: 'ZDNet', url: 'https://www.zdnet.com/rss/news/' },
  { source: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml' },
  { source: 'VnExpress Công nghệ', url: 'https://vnexpress.net/rss/khoa-hoc-cong-nghe.rss' },
];

// Preference affects ranking only. Fetching arbitrary discovery URLs still excludes
// credentials, non-web schemes and internal network destinations on every redirect.
export function sourceAllowed(raw: string): boolean {
  try {
    const u = new URL(raw),
      host = u.hostname.toLowerCase();
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === '443') &&
      !isIP(host.replace(/^\[|\]$/g, '')) &&
      host.includes('.') &&
      !/(^|\.)(localhost|local|internal|test|invalid)$/.test(host)
    );
  } catch {
    return false;
  }
}
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  // Only global-unicast IPv6; excludes mapped IPv4, loopback, link-local and ULA.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address);
}
export interface Document {
  url: string;
  body: string;
  contentType: string;
}
export type DocumentLoader = (url: string) => Promise<Document>;
export async function fetchDocument(url: string): Promise<Document> {
  for (let hop = 0; hop < 5; hop++) {
    if (!sourceAllowed(url)) throw new Error('invalid_or_private_url');
    const addresses = await lookup(new URL(url).hostname, { all: true });
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
      throw new Error('private_network_address');
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      headers: {
        'User-Agent': 'AI-Tech-Daily/0.2 (news source reader)',
        Accept: 'text/html,application/rss+xml,application/atom+xml,application/xml,text/xml',
      },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('redirect_without_location');
      url = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`http_${response.status}`);
    }
    if (!response.body) throw new Error('empty_body');
    const reader = response.body.getReader(),
      parts: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 4_000_000) {
        await reader.cancel();
        throw new Error('document_too_large');
      }
      parts.push(next.value);
    }
    return {
      url,
      body: Buffer.concat(parts).toString('utf8'),
      contentType: response.headers.get('content-type') || '',
    };
  }
  throw new Error('too_many_redirects');
}

export function parsePublishedDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let s = value.trim().replace(/\s+/g, ' ');
  if (!s || !/\b(?:19|20|21)\d{2}\b/.test(s)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00Z';
  else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(s))
    s = s.replace(' ', 'T') + 'Z';
  else if (!/(Z|[+-]\d{2}:?\d{2}|GMT|UTC|[ECMP][DS]T)\s*$/i.test(s)) s += ' UTC';
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  if (/^\d{4}-\d{2}-\d{2}T.*Z$/.test(s) && d.toISOString().slice(0, 10) !== s.slice(0, 10))
    return null;
  return d.toISOString();
}
export function publishedDate(html: string): string | null {
  const $ = load(html),
    values: unknown[] = [];
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (node.datePublished) values.push(node.datePublished);
    for (const child of Object.values(node)) if (typeof child === 'object') walk(child);
  };
  $('script').each((_i, e) => {
    try {
      walk(JSON.parse($(e).text()));
    } catch {
      /* Non-JSON script. */
    }
  });
  $('meta').each((_i, e) => {
    if (
      /^(article:published_time|datePublished|pubdate|date|dc\.date|dcterms\.created|sailthru\.date)$/i.test(
        $(e).attr('property') || $(e).attr('name') || '',
      )
    )
      values.push($(e).attr('content'));
  });
  $('time').each((_i, e) => {
    if (!/modified|updated/i.test(`${$(e).attr('class')} ${$(e).attr('itemprop')}`))
      values.push($(e).attr('datetime') || $(e).text());
  });
  for (const value of values) {
    const date = parsePublishedDate(value);
    if (date) return date;
  }
  return null;
}
export interface SourceSnapshot {
  url: string;
  aliases: string[];
  title: string;
  published_at: string | null;
  text: string;
  source: string;
  origin: 'web' | 'rss';
}
export function snapshot(
  document: Document,
  originalUrl: string,
  origin: 'web' | 'rss' = 'web',
): SourceSnapshot {
  if (!sourceAllowed(document.url)) throw new Error('invalid_final_url');
  const $ = load(document.body);
  const title = (
    $('meta[property="og:title"]').attr('content') ||
    $('h1').first().text() ||
    $('title').text()
  ).trim();
  const pathname = new URL(document.url).pathname.replace(/\/+$/, '');
  if (
    !pathname ||
    /^\/(archives?|category|categories|tags?|page)(\/|$)/i.test(pathname) ||
    /\/\d{4}\/\d{1,2}$/.test(pathname) ||
    /^\/(news|research|research\/index|research\/index\/publication|blog|tag\/[^/]+|c\/[^/]+\/\d+)$/i.test(
      pathname,
    )
  )
    throw new Error('listing_page');
  if (/just a moment|access denied|verify you are human|captcha/i.test(title))
    throw new Error('blocked_page');
  let url = canonicalUrl(document.url);
  const canonical = $('link[rel="canonical"]').attr('href');
  if (canonical) {
    const resolved = new URL(canonical, document.url);
    if (sourceAllowed(resolved.href) && resolved.hostname === new URL(document.url).hostname)
      url = canonicalUrl(resolved.href);
  }
  const date = publishedDate(document.body);
  $('script,style,nav,footer,aside,form,noscript').remove();
  $('p,h1,h2,h3,h4,li,br,div').append('\n');
  const article = $('[itemprop="articleBody"]').first();
  const root = article.length
    ? article
    : $('article').length
      ? $('article').first()
      : $('main').length
        ? $('main').first()
        : $('body');
  const text = root
    .text()
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 20000);
  if (text.length < 40) throw new Error('insufficient_page_text');
  return {
    url,
    aliases: [...new Set([url, canonicalUrl(originalUrl), canonicalUrl(document.url)])],
    title,
    published_at: date,
    text,
    source: new URL(url).hostname,
    origin,
  };
}
export interface FeedEntry {
  url: string;
  title: string;
  published_at: string | null;
  summary: string;
  source: string;
}
export function parseFeed(xml: string, base: string, source: string): FeedEntry[] {
  // Article code examples inside CDATA are text, not XML declarations.
  const declarations = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(declarations)) throw new Error('unsupported_feed_entities');
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: true,
  }).parse(xml);
  const rows = parsed.rss?.channel?.item || parsed.feed?.entry || [];
  const result: FeedEntry[] = [];
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    const links = Array.isArray(row.link) ? row.link : [row.link];
    const link = links.find(
      (v: any) => typeof v === 'string' || !v?.['@_rel'] || v?.['@_rel'] === 'alternate',
    );
    const raw = typeof link === 'string' ? link : link?.['@_href'];
    if (!raw) continue;
    try {
      const url = new URL(raw, base).href;
      if (!sourceAllowed(url)) continue;
      const title = typeof row.title === 'string' ? row.title : row.title?.['#text'] || '';
      const description =
        row.description || row.summary || row['content:encoded'] || row.content || '';
      result.push({
        url: canonicalUrl(url),
        title,
        published_at: parsePublishedDate(row.pubDate || row.published || row['dc:date']),
        summary: load(typeof description === 'string' ? description : description?.['#text'] || '')
          .text()
          .slice(0, 2000),
        source,
      });
    } catch {
      /* Invalid item does not discard the other feed entries. */
    }
  }
  return result;
}
