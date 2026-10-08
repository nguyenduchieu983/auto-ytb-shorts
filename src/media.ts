import { spawn } from 'node:child_process';
import { readFile, writeFile, stat, copyFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import sharp from 'sharp';
import { Config } from './config';
import { durationClass, PermanentError, Storyboard } from './domain';

export async function processFile(
  binary: string,
  args: string[],
  cwd?: string,
  timeout = 600_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, windowsHide: true, shell: false });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Media process timed out'));
    }, timeout);
    const collect = (d: Buffer) => {
      output = (output + d.toString()).slice(-24000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(output) : reject(new Error(`Media process exited ${code}: ${output}`));
    });
  });
}
function binary(configured: string, packageName: string, fallback: string) {
  if (configured) return configured;
  try {
    return require(packageName).path;
  } catch {
    return fallback;
  }
}
const xml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
function lines(text: string, size = 28): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > size && line) {
      out.push(line);
      line = word;
    } else line = (line + ' ' + word).trim();
  }
  if (line) out.push(line);
  return out.slice(0, 5);
}
export interface VoiceOutput {
  path: string;
  duration: number;
  timings: { scene_id: number; start: number; end: number }[];
  mock: boolean;
}
export interface VisualOutput {
  images: { scene_id: number; path: string; fallback: boolean }[];
}
export class Media {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  constructor(private c: Config) {
    this.ffmpeg = binary(c.FFMPEG_PATH, '@ffmpeg-installer/ffmpeg', 'ffmpeg');
    this.ffprobe = binary(c.FFPROBE_PATH, '@ffprobe-installer/ffprobe', 'ffprobe');
  }
  async probe(path: string): Promise<any> {
    return JSON.parse(
      await processFile(this.ffprobe, [
        '-v',
        'error',
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        path,
      ]),
    );
  }
  async card(path: string, headline: string, source: string, mock: boolean, image?: Buffer) {
    const title = lines(headline);
    const svg = Buffer.from(
      `<svg width="1080" height="1920"><rect width="1080" height="1920" fill="${image ? 'none' : '#081326'}"/><rect x="70" y="135" width="940" height="115" rx="25" fill="#101d35"/><text x="100" y="208" font-family="Arial" font-size="42" font-weight="bold" fill="#68e1f7">${xml(this.c.CHANNEL_NAME)}</text><rect x="70" y="390" width="900" height="${title.length * 90 + 120}" rx="30" fill="#0a1224" opacity=".92"/>${title.map((l, i) => `<text x="110" y="${500 + i * 90}" font-family="Arial" font-size="62" font-weight="bold" fill="white">${xml(l)}</text>`).join('')}<rect x="110" y="${550 + title.length * 90}" width="650" height="7" fill="#9b7dff"/><text x="100" y="1190" font-family="Arial" font-size="30" fill="#b5d5e7">${xml(source.slice(0, 52))}</text>${mock ? '<text x="100" y="1270" font-family="Arial" font-size="38" fill="#f8c667">DEMO • DỮ LIỆU VÀ ÂM THANH MẪU</text>' : ''}</svg>`,
    );
    const base = image
      ? sharp(image).resize(1080, 1920, { fit: 'cover' })
      : sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#081326' } });
    await base
      .composite([{ input: svg }])
      .png()
      .toFile(path);
  }
  async mockVoice(path: string, duration: number) {
    const rate = 24000,
      samples = Math.round(duration * rate),
      data = Buffer.alloc(samples * 2),
      header = Buffer.alloc(44);
    for (let i = 0; i < samples; i++) {
      const t = i / rate,
        phase = t % 1;
      data.writeInt16LE(
        Math.round(Math.sin(2 * Math.PI * 440 * t) * 1800 * (phase < 0.65 ? 1 : 0)),
        i * 2,
      );
    }
    header.write('RIFF');
    header.writeUInt32LE(data.length + 36, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    await writeFile(path, Buffer.concat([header, data]));
  }
  async joinVoice(
    dir: string,
    files: string[],
    sceneIds: number[],
    mock: boolean,
  ): Promise<VoiceOutput> {
    const timings: VoiceOutput['timings'] = [];
    let cursor = 0;
    for (let i = 0; i < files.length; i++) {
      const p = await this.probe(files[i]);
      const duration = Number(p.format.duration);
      timings.push({ scene_id: sceneIds[i], start: cursor, end: cursor + duration });
      cursor += duration;
    }
    await writeFile(
      join(dir, 'voice-list.txt'),
      files.map((f) => `file '${basename(f)}'`).join('\n'),
    );
    const path = join(dir, 'voice.mp3');
    await processFile(
      this.ffmpeg,
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '1',
        '-i',
        'voice-list.txt',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        'voice.mp3',
      ],
      dir,
    );
    return { path, duration: cursor, timings, mock };
  }
  async subtitles(dir: string, board: Storyboard, voice: VoiceOutput): Promise<{ path: string }> {
    const content = buildAss(board, voice);
    const path = join(dir, 'subtitles.ass');
    await writeFile(path, content, 'utf8');
    return { path };
  }
  async render(
    dir: string,
    visuals: VisualOutput,
    voice: VoiceOutput,
    subtitles: { path: string },
  ) {
    const clips: string[] = [];
    for (let i = 0; i < voice.timings.length; i++) {
      const timing = voice.timings[i],
        image = visuals.images.find((v) => v.scene_id === timing.scene_id);
      if (!image) throw new PermanentError('Missing scene visual');
      const length = timing.end - timing.start,
        frames = Math.ceil(length * 30);
      const name = `scene-${i}.mp4`;
      clips.push(name);
      // Moving crop with bounded zoom. Text and source cards remain within safe margins.
      const motion = `scale=1200:2134,zoompan=z='1+0.000025*on':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=${frames}:s=1080x1920:fps=30,format=yuv420p`;
      await processFile(
        this.ffmpeg,
        [
          '-y',
          '-i',
          image.path,
          '-vf',
          motion,
          '-frames:v',
          String(frames),
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-crf',
          '23',
          '-threads',
          '2',
          name,
        ],
        dir,
      );
    }
    await writeFile(join(dir, 'clips.txt'), clips.map((n) => `file '${n}'`).join('\n'));
    await copyFile(subtitles.path, join(dir, 'subtitles.ass'));
    await copyFile(voice.path, join(dir, 'voice.mp3'));
    const args = ['-y', '-f', 'concat', '-safe', '1', '-i', 'clips.txt', '-i', 'voice.mp3'];
    let filter = '[1:a]loudnorm=I=-16:TP=-1.5:LRA=11[a]';
    if (this.c.BACKGROUND_MUSIC_PATH) {
      args.push('-stream_loop', '-1', '-i', this.c.BACKGROUND_MUSIC_PATH);
      filter =
        '[2:a]volume=0.035[m];[1:a][m]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[a]';
    }
    args.push(
      '-vf',
      'ass=subtitles.ass',
      '-filter_complex',
      filter,
      '-map',
      '0:v:0',
      '-map',
      '[a]',
      '-t',
      voice.duration.toFixed(3),
      '-r',
      '30',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '22',
      '-threads',
      '2',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      'final.mp4',
    );
    await processFile(this.ffmpeg, args, dir);
    await processFile(
      this.ffmpeg,
      ['-y', '-ss', '1', '-i', 'final.mp4', '-frames:v', '1', 'thumbnail.png'],
      dir,
    );
    return {
      path: join(dir, 'final.mp4'),
      thumbnail: join(dir, 'thumbnail.png'),
      duration: voice.duration,
      mock: voice.mock,
    };
  }
  async validate(video: { path: string }, subtitles: { path: string }, mock: boolean) {
    const info = await this.probe(video.path),
      v = info.streams.find((s: any) => s.codec_type === 'video'),
      a = info.streams.find((s: any) => s.codec_type === 'audio');
    const duration = Number(info.format.duration),
      size = (await stat(video.path)).size;
    const subtitle = (await readFile(subtitles.path, 'utf8')).includes('Dialogue:');
    const audioLog = await processFile(
      this.ffmpeg,
      ['-i', video.path, '-vn', '-af', 'volumedetect', '-f', 'null', '-'],
      undefined,
      120_000,
    );
    const volume = Number(audioLog.match(/mean_volume:\s*(-?[\d.]+)/)?.[1] ?? '-Infinity');
    const fps = v
      ? Number(v.avg_frame_rate.split('/')[0]) / Number(v.avg_frame_rate.split('/')[1])
      : 0;
    const checks = {
      file: size > 0,
      resolution: v?.width === 1080 && v?.height === 1920,
      video_codec: v?.codec_name === 'h264',
      audio_codec: a?.codec_name === 'aac',
      pixel_format: v?.pix_fmt === 'yuv420p',
      fps: Math.abs(fps - 30) < 0.01,
      subtitle,
      audible_audio: Number.isFinite(volume) && volume > -45,
      duration: durationClass(duration) !== 'fail',
    };
    return {
      checks,
      hard_pass: Object.values(checks).every(Boolean),
      duration,
      duration_class: durationClass(duration),
      mean_volume_db: volume,
      mock,
    };
  }
}
export function assTime(seconds: number): string {
  const cs = Math.round(seconds * 100),
    h = Math.floor(cs / 360000),
    m = Math.floor(cs / 6000) % 60,
    s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}
export function assText(text: string): string {
  return text.replace(/[\\{}]/g, '').replace(/[\r\n]/g, ' ');
}
export function buildAss(board: Storyboard, voice: VoiceOutput): string {
  const events: string[] = [];
  for (const scene of board.scenes) {
    const timing = voice.timings.find((t) => t.scene_id === scene.scene_id);
    if (!timing) throw new PermanentError('Missing scene audio timing');
    const words = scene.narration.trim().split(/\s+/);
    const chunks: string[][] = [];
    for (let i = 0; i < words.length; i += 6) chunks.push(words.slice(i, i + 6));
    let cursor = timing.start;
    for (const chunk of chunks) {
      const end = cursor + ((timing.end - timing.start) * chunk.length) / words.length;
      const text =
        chunk.length > 4
          ? `${assText(chunk.slice(0, 3).join(' '))}\\N${assText(chunk.slice(3).join(' '))}`
          : assText(chunk.join(' '));
      events.push(`Dialogue: 0,${assTime(cursor)},${assTime(end)},Default,,0,0,0,,${text}`);
      cursor = end;
    }
  }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,58,&H00FFFFFF,&H000000FF,&H00101826,&H90000000,-1,0,0,0,100,100,0,0,1,4,1,2,100,150,410,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
}
