import { z } from 'zod';

export const STEPS = [
  'discover',
  'rank',
  'script',
  'verify',
  'storyboard',
  'voice',
  'visuals',
  'metadata',
  'subtitles',
  'render',
  'qc',
  'approval',
  'upload',
] as const;
export type Step = (typeof STEPS)[number];
export const DEPENDENCIES: Record<Step, Step[]> = {
  discover: [],
  rank: ['discover'],
  script: ['rank'],
  verify: ['script'],
  storyboard: ['verify'],
  voice: ['storyboard'],
  visuals: ['storyboard'],
  metadata: ['verify'],
  subtitles: ['voice', 'storyboard'],
  render: ['subtitles', 'visuals'],
  qc: ['render', 'metadata'],
  approval: ['qc'],
  upload: ['approval'],
};
export type RunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'NEEDS_REVISION'
  | 'UPLOADING'
  | 'UPLOADED_PRIVATE'
  | 'PUBLISHED'
  | 'UPLOAD_UNCERTAIN'
  | 'FAILED'
  | 'SKIPPED';
export interface Run {
  id: string;
  run_date: string;
  revision: number;
  status: RunStatus;
  mock: boolean;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface StepRow {
  run_id: string;
  revision: number;
  step: Step;
  status: string;
  attempts: number;
  output: any;
  error_message: string | null;
}
export interface Work {
  runId: string;
  revision: number;
  step: Step;
}
export class ReviewError extends Error {}
export class SkipError extends Error {}
export class PermanentError extends Error {}
export class UploadUncertainError extends Error {}
export class StaleWorkError extends Error {}
export const newsSchema = z.object({
  id: z.string(),
  title: z.string().min(5).max(300),
  source: z.string().min(1),
  url: z.string().url(),
  canonical_url: z.string().url(),
  published_at: z.string().datetime().nullable(),
  freshness_hours: z.number().nullable().optional(),
  date_parse_failed: z.boolean().optional(),
  event_date: z.string().nullable(),
  summary: z.string().min(10),
  evidence: z.string().min(20),
  why_it_matters: z.string(),
  category: z.string(),
  company: z.string(),
  kind: z.enum(['news', 'tool']),
  confidence: z.number().min(0).max(1),
  older_than_24h: z.boolean(),
  score: z.number().min(0).max(100),
});
export type News = z.infer<typeof newsSchema>;
export const newsListSchema = z.object({ items: z.array(newsSchema).max(15) });
export const scriptSchema = z.object({
  hook: z.string().min(1),
  segments: z
    .array(
      z.object({
        news_id: z.string(),
        narration: z.string().min(1),
        headline: z.string(),
        key_takeaway: z.string(),
      }),
    )
    .min(1)
    .max(3),
  takeaway: z.string(),
  cta: z.string(),
  full_script: z.string().min(100),
  estimated_duration_sec: z.number(),
});
export type Script = z.infer<typeof scriptSchema>;
export const verificationSchema = z.object({
  unsupported_claims: z.array(z.object({ claim: z.string(), reason: z.string() })),
  needs_rewrite: z.boolean(),
});
export const storyboardSchema = z.object({
  scenes: z
    .array(
      z.object({
        scene_id: z.number().int(),
        narration: z.string().min(1),
        visual_type: z.enum([
          'image',
          'headline-card',
          'logo-card',
          'quote-card',
          'motion-card',
          'metric-card',
          'comparison-card',
        ]),
        visual_prompt: z.string(),
        visual_labels: z.array(z.string().max(32)).max(3).optional(),
        overlay_text: z.string().max(160),
        source_label: z.string(),
      }),
    )
    .min(4)
    .max(12),
});
export type Storyboard = z.infer<typeof storyboardSchema>;
export const metadataSchema = z.object({
  title: z.string().min(1).max(70),
  description: z.string().min(1).max(5000),
  hashtags: z.array(z.string()).min(3).max(5),
  tags: z.array(z.string()).max(20),
});
export type Metadata = z.infer<typeof metadataSchema>;
export function descendants(step: Step): Set<Step> {
  const result = new Set<Step>([step]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of STEPS)
      if (!result.has(s) && DEPENDENCIES[s].some((d) => result.has(d))) {
        result.add(s);
        changed = true;
      }
  }
  return result;
}
export function jobId(w: Work): string {
  return `${w.runId}-${w.step}-r${w.revision}`;
}
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
export function canonicalUrl(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new PermanentError('News source must use HTTPS');
  u.hash = '';
  for (const key of [...u.searchParams.keys()])
    if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  return u.toString().replace(/\/$/, '');
}
export function similarity(a: string, b: string): number {
  const x = new Set(normalize(a).split(' ')),
    y = new Set(normalize(b).split(' '));
  return (2 * [...x].filter((v) => y.has(v)).length) / (x.size + y.size);
}
export function sourceQuality(n: News): number {
  const host = new URL(n.url).hostname.replace(/^www\./, '');
  if (
    /(^|\.)(openai\.com|anthropic\.com|google\.com|blog\.google|deepmind\.google|microsoft\.com|github\.com|github\.blog|nvidia\.com|amd\.com|aws\.amazon\.com|cloudflare\.com|meta\.com|huggingface\.co)$/.test(
      host,
    )
  )
    return 10;
  if (/(^|\.)(reuters\.com|apnews\.com)$/.test(host)) return 9;
  if (
    /(^|\.)(techcrunch\.com|theverge\.com|venturebeat\.com|arstechnica\.com|thenewstack\.io|bleepingcomputer\.com|theregister\.com|the-decoder\.com|zdnet\.com|vnexpress\.net)$/.test(
      host,
    )
  )
    return 7;
  return 4;
}
export function dedupNews(items: News[], previous: News[] = []): News[] {
  const result: News[] = [];
  for (const n of [...items].sort((a, b) => sourceQuality(b) - sourceQuality(a))) {
    if (
      ![...previous, ...result].some(
        (p) => canonicalUrl(p.url) === canonicalUrl(n.url) || similarity(p.title, n.title) > 0.85,
      )
    )
      result.push(n);
  }
  return result;
}
export function selectNews(items: News[]): News[] {
  const selected = [...items]
    .filter((n) => n.confidence >= 0.8)
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence)
    .slice(0, 1);
  if (!selected.length) throw new SkipError('Insufficient verified news: need one sourced topic');
  return selected;
}
export function durationClass(seconds: number): 'pass' | 'review' | 'fail' {
  if (!Number.isFinite(seconds) || seconds < 40 || seconds > 65) return 'fail';
  return seconds >= 45 && seconds <= 60 ? 'pass' : 'review';
}
