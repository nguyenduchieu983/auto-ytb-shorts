/** A local editorial preview. Does not create DB runs, send Telegram, or upload. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { Config } from './config';
import { Repository } from './db';
import { Storyboard } from './domain';
import { Media, assText, assTime, VoiceOutput } from './media';
import { edgeVoice } from './providers/edge-voice';

export const philosophySpecSchema = z.object({
  title: z.array(z.string().min(1).max(22)).min(1).max(2),
  source: z.string().url(),
  source_note: z.string().min(20),
  scenes: z
    .array(
      z.object({
        art: z.enum(['burden', 'noise', 'journal', 'rain', 'steps', 'peace']),
        label: z.string().max(22).optional(),
        narration: z.string().min(10),
      }),
    )
    .min(4)
    .max(8),
});
type Art = z.infer<typeof philosophySpecSchema>['scenes'][number]['art'];
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const line = (d: string, color = '#f3f0e8', width = 7) =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
const text = (s: string, x: number, y: number, size = 35, color = '#eeeae1') =>
  `<text x="${x}" y="${y}" fill="${color}" font-family="Arial" font-size="${size}" font-weight="700" text-anchor="middle">${esc(s)}</text>`;
function person(
  x: number,
  y: number,
  pose: 'worried' | 'walk' | 'calm' | 'umbrella' = 'calm',
  scale = 1,
) {
  const face =
    pose === 'worried'
      ? line('M-27 -92 Q-17 -104 -8 -94 M12 -94 Q23 -104 32 -92', '#202020', 5) +
        line('M-12 -48 Q4 -63 22 -48', '#202020', 5)
      : line('M-26 -91 Q-17 -100 -8 -91 M12 -91 Q21 -100 30 -91', '#202020', 5) +
        line('M-15 -60 Q3 -42 24 -61', '#202020', 5);
  const arms =
    pose === 'umbrella'
      ? 'M-50 4 Q-114 53 -132 100 M52 8 Q105 -42 106 -123'
      : pose === 'worried'
        ? 'M-50 2 Q-108 -44 -90 -91 M52 3 Q114 -42 96 -86'
        : pose === 'walk'
          ? 'M-49 6 Q-91 58 -116 64 M53 6 Q100 43 124 12'
          : 'M-50 6 Q-93 70 -48 96 M53 6 Q99 70 44 96';
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <ellipse cx="0" cy="242" rx="132" ry="16" fill="#303030"/>
    ${line(pose === 'walk' ? 'M-30 130 L-82 235 L-124 239 M32 130 L97 211 L132 211' : 'M-31 130 L-44 231 L-88 239 M34 130 L46 231 L90 239', '#f3f0e8', 17)}
    <path d="M-52 -4 Q0 -25 55 -3 L65 133 Q4 153 -64 131 Z" fill="#ece9e0" stroke="#a9a79e" stroke-width="5"/>
    ${line(arms, '#eae7df', 17)}
    <path d="M-61 -95 C-65 -156 57 -161 65 -102 C81 -26 -54 -18 -61 -95Z" fill="#f6f2e8" stroke="#a8a69e" stroke-width="5"/>
    ${line('M-57 -112 Q-18 -156 39 -125 M-52 -105 Q-36 -148 13 -140', '#f6f2e8', 7)}
    ${face}${line('M-12 -22 L-10 -5 M22 -24 L20 -5', '#d7d3c9', 4)}
    ${line('M-29 21 Q-3 34 25 20 M-25 101 Q1 113 29 102', '#c5c1b8', 3)}
  </g>`;
}
function cloud(x: number, y: number, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})">${line('M-112 22 C-145 -30 -88 -66 -54 -37 C-33 -108 56 -103 71 -45 C122 -68 159 2 117 28 Z', '#b9b8b2', 6)}</g>`;
}
function artwork(art: Art, label?: string): string {
  let drawing = '';
  if (art === 'burden')
    drawing =
      person(540, 1040, 'worried', 1.3) +
      `<path d="M265 680 L354 552 L680 530 L804 660 L730 816 L337 805Z" fill="#31312e" stroke="#e0ded4" stroke-width="7"/>` +
      line(
        'M354 552 L414 691 L337 805 M414 691 L680 530 M414 691 L730 816 M414 691 L804 660',
        '#777870',
        4,
      ) +
      text(label || 'MỌI CHUYỆN', 540, 690, 46, '#ffe171') +
      cloud(240, 930, 0.6) +
      cloud(840, 950, 0.6);
  if (art === 'noise')
    drawing =
      person(540, 1000, 'worried', 1.38) +
      [
        [260, 690],
        [810, 720],
        [205, 1015],
        [855, 1080],
      ]
        .map(
          ([x, y], i) =>
            `<g transform="translate(${x} ${y}) rotate(${i % 2 ? 9 : -8})"><path d="M-104 -66 Q-115 -77 -122 -40 L-119 32 Q-117 62 -72 59 L-26 58 L0 94 L20 58 L101 57 Q128 53 121 16 L119 -45 Q115 -75 75 -69 Z" fill="#171717" stroke="#c7c6bd" stroke-width="5"/>${text(i % 2 ? '...' : '?!', 0, 18, 57, '#ffe171')}</g>`,
        )
        .join('');
  if (art === 'journal')
    drawing =
      person(352, 940, 'calm', 1.16) +
      line('M192 1130 L867 1130 M246 1130 L230 1383 M818 1130 L841 1383') +
      `<path d="M457 918 Q535 899 610 945 Q682 898 777 917 L779 1100 Q682 1083 610 1124 Q537 1084 454 1100Z" fill="#e8e5db" stroke="#b2b1a8" stroke-width="6"/>` +
      line(
        'M610 945 L610 1124 M480 958 L568 977 M480 989 L571 1008 M652 974 L750 950 M652 1007 L750 982',
        '#73766c',
        5,
      ) +
      text(label || 'VIỆC MÌNH CÓ THỂ LÀM', 540, 665, 42, '#ffe171') +
      line('M466 738 L500 777 L597 698', '#ffe171', 10);
  if (art === 'rain')
    drawing =
      cloud(340, 620, 1.15) +
      cloud(780, 680, 0.85) +
      Array.from({ length: 23 }, (_, i) => {
        const x = 145 + ((i * 139) % 790),
          y = 750 + ((i * 97) % 510);
        return line(`M${x} ${y} l-19 49`, '#7c8e94', 5);
      }).join('') +
      person(520, 1090, 'umbrella', 1.03) +
      `<path d="M310 877 Q551 558 791 877 Q722 833 666 884 Q608 836 551 885 Q491 837 431 884 Q377 835 310 877Z" fill="#e9c655" stroke="#ffe171" stroke-width="7"/>` +
      line(
        'M551 885 L551 1023 Q551 1080 589 1068 M551 680 Q469 747 431 884 M551 680 Q637 752 666 884',
        '#fff0b5',
        5,
      );
  if (art === 'steps')
    drawing =
      `<circle cx="805" cy="720" r="102" fill="#ffe171"/>` +
      Array.from({ length: 9 }, (_, i) => {
        const a = (i * Math.PI) / 4.5;
        return line(
          `M${805 + Math.cos(a) * 126} ${720 + Math.sin(a) * 126} l${Math.cos(a) * 25} ${Math.sin(a) * 25}`,
          '#d9c46b',
          5,
        );
      }).join('') +
      line(
        'M115 1360 L295 1360 L295 1240 L475 1240 L475 1120 L655 1120 L655 1000 L835 1000 L835 880 L958 880',
        '#e4e1d6',
        8,
      ) +
      person(445, 943, 'walk', 0.75) +
      line('M147 1274 Q198 1184 252 1138 M230 1140 L253 1136 L254 1167', '#ffe171', 6);
  if (art === 'peace')
    drawing =
      `<circle cx="540" cy="980" r="278" fill="none" stroke="#696557" stroke-width="3" stroke-dasharray="4 17"/>` +
      person(540, 1000, 'calm', 1.2) +
      line(
        'M170 1367 Q535 1320 907 1366 M209 1347 Q173 1297 192 1237 Q231 1277 209 1347 M833 1353 Q888 1290 863 1215 Q811 1275 833 1353',
        '#bebdb2',
        6,
      ) +
      line(
        'M736 677 Q756 658 776 677 Q798 658 817 677 M257 807 Q272 793 288 807 Q306 793 322 807',
        '#ffe171',
        5,
      ) +
      text(label || 'TỪNG BƯỚC MỘT', 540, 650, 39, '#ffe171');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920"><defs><radialGradient id="bg"><stop stop-color="#242421"/><stop offset="1" stop-color="#080909"/></radialGradient></defs><rect width="1080" height="1920" fill="url(#bg)"/>${drawing}</svg>`;
}
function captions(voice: VoiceOutput): string {
  if (!voice.words?.length) throw new Error('Preview requires word boundaries');
  const rows: string[] = [];
  for (let i = 0; i < voice.words.length;) {
    const first = voice.words[i],
      chunk = [first];
    i++;
    while (
      i < voice.words.length &&
      chunk.length < 6 &&
      voice.words[i].scene_id === first.scene_id &&
      !/[.!?,;:]$/.test(chunk.at(-1)!.word)
    )
      chunk.push(voice.words[i++]);
    rows.push(
      `Dialogue: 0,${assTime(first.start)},${assTime(chunk.at(-1)!.end)},Default,,0,0,0,,${assText(chunk.map((w) => w.word).join(' '))}`,
    );
  }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,53,&H006DE0FF,&H006DE0FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,1,2,100,160,360,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${rows.join('\n')}\n`;
}
export async function renderPhilosophy(
  c: Config,
  dir: string,
  input: unknown,
  onLog: (message: string) => Promise<void> = async () => {},
) {
  const spec = philosophySpecSchema.parse(input);
  if (c.CONTENT_PROVIDER !== 'codex' || c.PAID_API_ENABLED || c.LOCAL_VOICE_PROVIDER !== 'edge')
    throw new Error('Reels require codex/local mode, paid API disabled and Edge voice');
  const id = basename(dir);
  await mkdir(dir, { recursive: true });
  const report: any = {
    id,
    status: 'RUNNING',
    spec,
    voice_settings: { voice: c.EDGE_TTS_VOICE, rate: c.EDGE_TTS_RATE, pitch: c.EDGE_TTS_PITCH },
    events: [],
    paid_api_calls: 0,
    publication: 'local preview only',
  };
  const save = () => writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  const log = async (_w: unknown, message: string) => {
    await onLog(message);
    report.events.push(message);
    await save();
  };
  const board: Storyboard = {
    scenes: spec.scenes.map((s, i) => ({
      scene_id: i + 1,
      narration: s.narration,
      visual_type: 'image',
      visual_prompt: s.art,
      overlay_text: '',
      source_label: spec.source_note,
    })),
  };
  const media = new Media({ ...c, BACKGROUND_MUSIC_PATH: '' });
  try {
    report.board = board;
    await save();
    report.voice = await edgeVoice(
      c,
      { log } as unknown as Repository,
      media,
      { runId: id, revision: 1, step: 'voice' },
      dir,
      board,
    );
    if (report.voice.duration < 40 || report.voice.duration > 65)
      throw new Error(
        `Voice ${report.voice.duration.toFixed(1)}s outside 40–65s; revise narration, never speed it up`,
      );
    const title = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><defs><linearGradient id="fade" x2="0" y2="1"><stop stop-color="#090909"/><stop offset="1" stop-color="#090909" stop-opacity="0"/></linearGradient></defs><rect width="1080" height="450" fill="url(#fade)"/>${spec.title.map((s, i) => text(s, 540, 244 + i * 92, 78, '#ffe16d')).join('')}</svg>`;
    const overlay = join(dir, 'title.png');
    await sharp(Buffer.from(title)).png().toFile(overlay);
    report.visuals = { images: [] };
    for (const [i, s] of spec.scenes.entries()) {
      const svg = artwork(s.art, s.label),
        path = join(dir, `art-${i + 1}.png`);
      await writeFile(join(dir, `art-${i + 1}.svg`), svg);
      await sharp(Buffer.from(svg)).png().toFile(path);
      report.visuals.images.push({ scene_id: i + 1, path, overlay_path: overlay, fallback: false });
    }
    const subtitles = { path: join(dir, 'subtitles.ass') };
    await writeFile(subtitles.path, captions(report.voice));
    const renderDir = join(dir, 'render');
    await mkdir(renderDir, { recursive: true });
    report.render = await media.render(
      renderDir,
      report.visuals,
      report.voice,
      subtitles,
      (message) => log(null, message),
    );
    report.qc = await media.validate(report.render, subtitles, false);
    if (!report.qc.hard_pass) throw new Error('Preview technical QC failed');
    report.status = 'COMPLETE';
    return report;
  } catch (e) {
    report.status = 'FAILED';
    report.error = e instanceof Error ? e.message : 'Unknown error';
    throw e;
  } finally {
    await save();
  }
}
