import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Config } from '../config';
import { Repository } from '../db';
import { Storyboard, Work, ReviewError } from '../domain';
import { Media, processFile, VoiceOutput } from '../media';
import { alignNarration, TimedWord } from '../narration';

export function edgeVoiceAlignment(board: Storyboard, words: TimedWord[], duration: number) {
  if (!Number.isFinite(duration) || duration <= 0 || !words.length)
    throw new ReviewError('Edge voice has no audio/word boundaries');
  return alignNarration(board, words, duration);
}
export async function edgeVoice(
  c: Config,
  repo: Repository,
  media: Media,
  w: Work,
  dir: string,
  board: Storyboard,
): Promise<VoiceOutput> {
  await mkdir(dir, { recursive: true });
  const input = join(dir, 'edge-voice-input.json'),
    path = join(dir, 'voice.mp3');
  await writeFile(
    input,
    JSON.stringify({
      narration: board.scenes.map((s) => s.narration).join(' '),
      voice: c.EDGE_TTS_VOICE,
      rate: c.EDGE_TTS_RATE,
      pitch: c.EDGE_TTS_PITCH,
    }),
  );
  await repo.log(
    w,
    `Edge voice ${c.EDGE_TTS_VOICE} started; rate=${c.EDGE_TTS_RATE}, pitch=${c.EDGE_TTS_PITCH}; online, no OpenAI API; no speed-up to fit duration`,
  );
  await processFile(
    resolve(c.LOCAL_VOICE_PYTHON),
    [resolve('scripts/edge-voice.py'), input],
    undefined,
    210000,
  );
  const result = JSON.parse(await readFile(join(dir, 'edge-voice-result.json'), 'utf8'));
  const probe = await media.probe(path),
    duration = Number(probe.format.duration);
  const alignment = edgeVoiceAlignment(board, result.words || [], duration);
  await repo.log(
    w,
    `Nam Minh voice completed: ${duration.toFixed(1)}s, text/word-boundary coverage ${(alignment.alignment_coverage * 100).toFixed(1)}%; not ASR verification`,
  );
  return {
    path,
    duration,
    mock: false,
    ...alignment,
    timing_method: 'edge-service-word-boundaries',
  };
}
