/** Render an editorial product preview from a local seller clip. No publishing. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadConfig } from '../src/config';
import { Media, processFile, assText, assTime, VoiceOutput } from '../src/media';
import { edgeVoice } from '../src/providers/edge-voice';
import { Repository } from '../src/db';
import { Storyboard } from '../src/domain';

const schema = z.object({
  title: z.string().min(1).max(32),
  subtitle: z.string().min(1).max(48),
  source_url: z.string().url(),
  source_note: z.string().min(1),
  source_video: z.string().min(1),
  voice_speed: z.number().min(0.5).max(2).optional(),
  limitations: z.array(z.string()).default([]),
  narration: z.string().min(30).max(1800),
});

async function main() {
  if (!process.argv[2]) throw new Error('Usage: npm run video:product -- <spec.json>');
  const spec = schema.parse(JSON.parse(await readFile(resolve(process.argv[2]), 'utf8')));
  const c = loadConfig();
  if (spec.voice_speed !== undefined) {
    const percent = Math.round((spec.voice_speed - 1) * 100);
    c.EDGE_TTS_RATE = `${percent >= 0 ? '+' : ''}${percent}%`;
  }
  if (c.PAID_API_ENABLED || c.LOCAL_VOICE_PROVIDER !== 'edge')
    throw new Error('Product preview requires paid API disabled and Edge voice');
  const dir = resolve(c.STORAGE_ROOT, 'product-preview', randomUUID());
  await mkdir(dir, { recursive: true });
  const media = new Media(c);
  const report: any = {
    status: 'RUNNING',
    spec,
    paid_api_calls: 0,
    publication: 'local preview only',
    narration_origin: 'supplied editorial script',
    voice_provider: 'Edge TTS (online)',
    voice_rate: c.EDGE_TTS_RATE,
    events: [],
  };
  const save = () => writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  const log = async (_: unknown, message: string) => {
    report.events.push(message);
    console.log(message);
    await save();
  };
  try {
    const source = resolve(spec.source_video);
    const probe = await media.probe(source);
    const sourceDuration = Number(probe.format.duration);
    if (!probe.streams.some((s: any) => s.codec_type === 'video') || !(sourceDuration > 0))
      throw new Error('Source must contain a playable video');
    const board: Storyboard = {
      scenes: [
        {
          scene_id: 1,
          narration: spec.narration,
          visual_type: 'image',
          visual_prompt: 'Existing seller footage',
          overlay_text: '',
          source_label: spec.source_note,
        },
      ],
    };
    let voice: VoiceOutput;
    const reuseIndex = process.argv.indexOf('--reuse-voice');
    if (reuseIndex >= 0) {
      if (!process.argv[reuseIndex + 1]) throw new Error('--reuse-voice requires a report path');
      const priorPath = resolve(process.argv[reuseIndex + 1]);
      const prior = JSON.parse(await readFile(priorPath, 'utf8'));
      const priorInput = JSON.parse(
        await readFile(join(resolve(priorPath, '..'), 'edge-voice-input.json'), 'utf8'),
      );
      if (
        prior.spec?.narration !== spec.narration ||
        !prior.voice?.words?.length ||
        prior.status !== 'COMPLETE'
      )
        throw new Error('Cached voice must be a completed preview with identical narration');
      const originalSpeed = 1 + Number.parseFloat(priorInput.rate) / 100;
      const targetSpeed = 1 + Number.parseFloat(c.EDGE_TTS_RATE) / 100;
      const factor = targetSpeed / originalSpeed;
      if (!Number.isFinite(factor) || factor < 0.5 || factor > 2)
        throw new Error('Cached voice tempo factor must be between 0.5 and 2');
      const path = join(dir, 'voice.mp3');
      await processFile(media.ffmpeg, [
        '-y',
        '-i',
        prior.voice.path,
        '-af',
        `atempo=${factor}`,
        '-c:a',
        'libmp3lame',
        '-q:a',
        '2',
        path,
      ]);
      const duration = Number((await media.probe(path)).format.duration);
      voice = {
        ...prior.voice,
        path,
        duration,
        words: prior.voice.words.map((w: any) => ({
          ...w,
          start: w.start / factor,
          end: Math.min(duration, w.end / factor),
        })),
        timings: prior.voice.timings.map((t: any) => ({
          ...t,
          start: t.start / factor,
          end: Math.min(duration, t.end / factor),
        })),
        timing_method: 'cached-edge-word-boundaries-scaled-by-atempo',
      };
      report.voice_provider = 'Cached Edge TTS + FFmpeg atempo';
      report.reused_voice_report = priorPath;
      report.voice_tempo_factor = factor;
      await log(
        null,
        `Reusing existing voice: ${priorInput.rate} to ${c.EDGE_TTS_RATE}; pitch preserved`,
      );
    } else
      voice = await edgeVoice(
        c,
        { log } as unknown as Repository,
        media,
        { runId: 'product-preview', revision: 1, step: 'voice' },
        dir,
        board,
      );
    if (!voice.words?.length) throw new Error('Missing voice word boundaries');
    if (voice.duration > sourceDuration * 1.35)
      throw new Error('Narration too long for source clip; shorten script or supply a longer clip');
    report.voice = voice;
    const duration = voice.duration;
    const speed = Math.max(1, duration / sourceDuration);
    report.source_playback_duration_multiplier = speed;
    const rows = [
      `Dialogue: 1,0:00:00.00,${assTime(duration)},Title,,0,0,0,,${assText(spec.title)}`,
      `Dialogue: 1,0:00:00.00,${assTime(duration)},Deck,,0,0,0,,${assText(spec.subtitle)}`,
      `Dialogue: 1,0:00:00.00,${assTime(duration)},Credit,,0,0,0,,TƯ LIỆU SHOP • GIỌNG ĐỌC AI • BẢN XEM THỬ`,
    ];
    for (let i = 0; i < voice.words.length;) {
      const chunk = [voice.words[i++]];
      while (
        i < voice.words.length &&
        chunk.map((w) => w.word).join(' ').length < 27 &&
        !/[.!?;,]$/.test(chunk.at(-1)!.word)
      )
        chunk.push(voice.words[i++]);
      rows.push(
        `Dialogue: 2,${assTime(chunk[0].start)},${assTime(chunk.at(-1)!.end)},Caption,,0,0,0,,${assText(chunk.map((w) => w.word).join(' '))}`,
      );
    }
    const style = (name: string, size: number, color: string, align: number, margin: number) =>
      `Style: ${name},Arial,${size},${color},&H00FFFFFF,&H00131313,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,${align},40,40,${margin},1`;
    const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${[
      style('Title', 48, '&H00FFFFFF', 8, 70),
      style('Deck', 26, '&H008DE1F7', 8, 135),
      style('Caption', 36, '&H00FFFFFF', 2, 205),
      style('Credit', 15, '&H00DDDDDD', 2, 90),
    ].join(
      '\n',
    )}\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${rows.join('\n')}\n`;
    await writeFile(join(dir, 'subtitles.ass'), ass);
    await log(null, 'Rendering seller footage with new narration and timed subtitles');
    await processFile(
      media.ffmpeg,
      [
        '-y',
        '-i',
        source,
        '-i',
        voice.path,
        '-filter_complex',
        `[0:v]setpts=${speed}*(PTS-STARTPTS),scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,drawbox=x=0:y=0:w=iw:h=200:color=black@0.65:t=fill,drawbox=x=0:y=980:w=iw:h=300:color=black@0.55:t=fill,ass=subtitles.ass[v]`,
        '-map',
        '[v]',
        '-map',
        '1:a:0',
        '-t',
        String(duration),
        '-r',
        '30',
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        '-movflags',
        '+faststart',
        'preview.mp4',
      ],
      dir,
    );
    const output = join(dir, 'preview.mp4');
    const result = await media.probe(output);
    const video = result.streams.find((s: any) => s.codec_type === 'video');
    if (
      video?.width !== 720 ||
      video?.height !== 1280 ||
      !result.streams.some((s: any) => s.codec_type === 'audio') ||
      Math.abs(Number(result.format.duration) - duration) > 0.5
    )
      throw new Error('Rendered preview failed technical checks');
    await processFile(media.ffmpeg, [
      '-y',
      '-ss',
      String(Math.min(5, duration / 2)),
      '-i',
      output,
      '-frames:v',
      '1',
      join(dir, 'poster.jpg'),
    ]);
    report.render = {
      path: output,
      duration: Number(result.format.duration),
      width: 720,
      height: 1280,
    };
    report.status = 'COMPLETE';
    console.log('Preview:', output);
  } catch (e) {
    report.status = 'FAILED';
    report.error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    await save();
    console.log('Report:', join(dir, 'report.json'));
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
