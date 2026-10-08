import { ReviewError, Storyboard, normalize } from './domain';
export interface TimedWord {
  word: string;
  start: number;
  end: number;
}
const token = (s: string) => normalize(s).replace(/[^\p{L}\p{N}]/gu, '');

// Match the known narration to ASR words; interpolate only the unmatched tokens.
// Low-coverage speech is rejected instead of silently using fabricated timestamps.
export function alignNarration(board: Storyboard, recognized: TimedWord[], duration: number) {
  const script = board.scenes.flatMap((s) =>
    s.narration
      .trim()
      .split(/\s+/)
      .map((word) => ({ word, scene_id: s.scene_id })),
  );
  const heard = recognized.flatMap((w) => {
    const parts = w.word.trim().split(/\s+/);
    return parts.map((word, i) => ({
      word,
      start: w.start + ((w.end - w.start) * i) / parts.length,
      end: w.start + ((w.end - w.start) * (i + 1)) / parts.length,
    }));
  });
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !heard.length ||
    heard.some(
      (w, i) =>
        !Number.isFinite(w.start) ||
        !Number.isFinite(w.end) ||
        w.start < 0 ||
        w.end < w.start ||
        w.end > duration + 0.3 ||
        (i > 0 && w.start < heard[i - 1].start),
    )
  )
    throw new ReviewError('Invalid transcription timestamps');
  const a = script.map((w) => token(w.word)),
    b = heard.map((w) => token(w.word));
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] =
        a[i] && a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const anchors = new Map<number, number>();
  let i = 0,
    j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] && a[i] === b[j]) {
      anchors.set(i++, j++);
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const coverage = anchors.size / script.length;
  const missingScenes = board.scenes.flatMap((s) => {
    const indices = script.flatMap((w, n) => (w.scene_id === s.scene_id ? [n] : []));
    const sceneCoverage = indices.filter((n) => anchors.has(n)).length / indices.length;
    return sceneCoverage < 0.45
      ? [`scene ${s.scene_id} (${(sceneCoverage * 100).toFixed(0)}%): ${s.narration.slice(0, 100)}`]
      : [];
  });
  if (coverage < 0.65 || missingScenes.length)
    throw new ReviewError(
      `Voice alignment coverage ${(coverage * 100).toFixed(0)}%` +
        (missingScenes.length ? `; insufficient speech for ${missingScenes.join('; ')}` : '') +
        '; review pronunciation/script before rendering',
    );
  const starts = script.map((_, n) => (anchors.has(n) ? heard[anchors.get(n)!].start : NaN));
  for (let n = 0; n < starts.length;) {
    if (Number.isFinite(starts[n])) {
      n++;
      continue;
    }
    const first = n;
    while (n < starts.length && !Number.isFinite(starts[n])) n++;
    const left = first ? starts[first - 1] : 0,
      right = n < starts.length ? starts[n] : duration;
    for (let k = first; k < n; k++)
      starts[k] = left + ((right - left) * (k - first + 1)) / (n - first + 1);
  }
  const words = script.map((w, n) => ({
    ...w,
    start: starts[n],
    end: n + 1 < starts.length ? starts[n + 1] : duration,
  }));
  const timings = board.scenes.map((s, n) => {
    const first = words.find((w) => w.scene_id === s.scene_id)!;
    const next = board.scenes[n + 1];
    return {
      scene_id: s.scene_id,
      start: n ? first.start : 0,
      end: next ? words.find((w) => w.scene_id === next.scene_id)!.start : duration,
    };
  });
  if (timings.some((t) => t.end - t.start < 0.1))
    throw new ReviewError('Voice alignment produced an empty scene');
  return { words, timings, alignment_coverage: coverage };
}
