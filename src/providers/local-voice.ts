import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Config } from '../config';
import { Repository } from '../db';
import { PermanentError, Storyboard, Work } from '../domain';
import { Media, processFile, VoiceOutput } from '../media';

export async function localVoice(
  c: Config,
  repo: Repository,
  media: Media,
  w: Work,
  dir: string,
  board: Storyboard,
): Promise<VoiceOutput> {
  const python = resolve(c.LOCAL_VOICE_PYTHON),
    model = resolve(c.LOCAL_VOICE_MODEL);
  try {
    await access(python);
    await access(model);
  } catch {
    throw new PermanentError(
      'Local Piper voice unavailable; run setup:local-voice, no paid API fallback',
    );
  }
  const request = join(dir, 'local-voice-input.json');
  await writeFile(
    request,
    JSON.stringify({
      model,
      scenes: board.scenes.map((s) => ({ scene_id: s.scene_id, narration: s.narration })),
    }),
  );
  await repo.log(
    w,
    'Local Piper Vietnamese speech started; offline, $0 API; scene timings measured, word timings approximate',
  );
  await processFile(python, [resolve('scripts/local-voice.py'), request], undefined, 300000);
  const result = JSON.parse(await readFile(join(dir, 'local-voice-result.json'), 'utf8'));
  if (
    !Array.isArray(result.scenes) ||
    result.scenes.length !== board.scenes.length ||
    result.scenes.some(
      (s: any, i: number) =>
        s.scene_id !== board.scenes[i].scene_id || !Number.isFinite(s.duration) || s.duration <= 0,
    )
  )
    throw new PermanentError('Invalid local voice scene output');
  const output = await media.joinVoice(
    dir,
    result.scenes.map((s: any) => s.path),
    board.scenes.map((s) => s.scene_id),
    false,
  );
  const words = board.scenes.flatMap((s, i) => {
    const timing = output.timings[i],
      tokens = s.narration.trim().split(/\s+/);
    return tokens.map((word, j) => ({
      word,
      scene_id: s.scene_id,
      start: timing.start + ((timing.end - timing.start) * j) / tokens.length,
      end: timing.start + ((timing.end - timing.start) * (j + 1)) / tokens.length,
    }));
  });
  await repo.log(
    w,
    `Local Piper voice completed: ${output.duration.toFixed(1)}s; no transcription request`,
  );
  return { ...output, words, timing_method: 'measured-scenes-estimated-words' };
}
