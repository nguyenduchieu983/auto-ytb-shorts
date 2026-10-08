import { readFile, stat } from 'node:fs/promises';
import { Config } from '../config';
import { PermanentError, Run } from '../domain';

export type TelegramCommand =
  { action: 'gen-new-video'; actor: string; requestKey: string } | ExistingTelegramCommand;
export interface ExistingTelegramCommand {
  action: 'publish' | 'regenerate' | 'skip' | 'status';
  runId: string;
  revision: number;
  target?: 'script' | 'voice' | 'visuals' | 'render';
  actor: string;
}
export function parseTelegramUpdate(update: any, c: Config): TelegramCommand {
  const msg = update.message,
    chat = String(msg?.chat?.id),
    user = String(msg?.from?.id);
  if (
    chat !== c.TELEGRAM_ADMIN_CHAT_ID ||
    !c.TELEGRAM_ADMIN_USER_IDS.split(',')
      .map((s) => s.trim())
      .includes(user) ||
    msg?.from?.is_bot
  )
    throw new PermanentError('Unauthorized Telegram user/chat');
  const parts = String(msg.text || '')
      .trim()
      .split(/\s+/),
    action = parts[0]?.replace(/^\//, '').split('@')[0];
  if (['gen-new-video', 'gen_new_video'].includes(action)) {
    if (parts.length !== 1) throw new PermanentError('Use /gen-new-video without arguments');
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0)
      throw new PermanentError('Missing Telegram update ID');
    return {
      action: 'gen-new-video',
      actor: `telegram:${user}`,
      requestKey: `telegram:${update.update_id}`,
    };
  }
  if (
    !['publish', 'regenerate', 'skip', 'status'].includes(action) ||
    !parts[1] ||
    !/^\d+$/.test(parts[2] || '')
  )
    throw new PermanentError(
      'Use /gen-new-video or /publish|skip|status <runId> <revision> or /regenerate <runId> <revision> script|voice|visuals|render',
    );
  const target = parts[3];
  if (action === 'regenerate' && !['script', 'voice', 'visuals', 'render'].includes(target))
    throw new PermanentError('Invalid regeneration target');
  return {
    action: action as ExistingTelegramCommand['action'],
    runId: parts[1],
    revision: Number(parts[2]),
    target: target as ExistingTelegramCommand['target'],
    actor: `telegram:${user}`,
  };
}
export class TelegramProvider {
  constructor(private c: Config) {}
  async call(method: string, body: any) {
    const r = await fetch(`https://api.telegram.org/bot${this.c.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      ...(body instanceof FormData
        ? { body }
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) {
      await r.text();
      throw new Error(`Telegram ${method} HTTP ${r.status}`);
    }
    const data: any = await r.json();
    if (!data.ok) throw new Error(`Telegram ${method} was rejected`);
    return data.result;
  }
  async preview(run: Run, video: any, metadata: any, news: any[], qc: any, cost: number) {
    const text = `${run.mock ? '🧪 DEMO — âm thanh/dữ liệu mẫu' : '✅ Video sẵn sàng duyệt'}\n${metadata.title}\nDuration: ${qc.duration.toFixed(1)}s | QC: ${qc.score}/100\nCost reservation: $${cost.toFixed(2)}\n\n${news.map((n, i) => `${i + 1}. ${n.title}\n${n.url}`).join('\n')}\n\nRun: ${run.id}\nRevision: ${run.revision}\n/publish ${run.id} ${run.revision}\n/regenerate ${run.id} ${run.revision} script\n/regenerate ${run.id} ${run.revision} voice\n/regenerate ${run.id} ${run.revision} visuals\n/regenerate ${run.id} ${run.revision} render\n/skip ${run.id} ${run.revision}\n/status ${run.id} ${run.revision}`;
    if (this.c.MOCK_TELEGRAM) return { mock: true, text, preview_path: video.path };
    // Bot API file limit: deliver an extra compressed preview when final video is too large.
    if ((await stat(video.path)).size > 49 * 1024 * 1024)
      throw new PermanentError(
        'Telegram preview exceeds 49 MiB; lower render bitrate before approval',
      );
    const form = new FormData();
    form.append('chat_id', this.c.TELEGRAM_ADMIN_CHAT_ID);
    form.append('supports_streaming', 'true');
    form.append(
      'video',
      new Blob([new Uint8Array(await readFile(video.path))], { type: 'video/mp4' }),
      'preview.mp4',
    );
    const message = await this.call('sendVideo', form);
    await this.call('sendMessage', {
      chat_id: this.c.TELEGRAM_ADMIN_CHAT_ID,
      text,
      disable_web_page_preview: true,
    });
    return { mock: false, message_id: message.message_id };
  }
  async notify(text: string) {
    if (this.c.MOCK_TELEGRAM) return;
    await this.call('sendMessage', {
      chat_id: this.c.TELEGRAM_ADMIN_CHAT_ID,
      text: text.slice(0, 4000),
      disable_web_page_preview: true,
    });
  }
}
