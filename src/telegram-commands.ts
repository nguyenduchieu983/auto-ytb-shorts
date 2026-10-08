import type { Pipeline } from './engine';
import type { TelegramCommand } from './providers/telegram';

export async function handleTelegramCommand(p: Pipeline, cmd: TelegramCommand): Promise<string> {
  if (cmd.action === 'gen-new-video') {
    const run = await p.run(new Date(), cmd.requestKey);
    return `Đã nhận yêu cầu tạo video riêng. Mỗi tin nhắn mới tạo một run mới; xong sẽ gửi preview để duyệt.\n${run.id} revision ${run.revision}: ${run.status}\n/status ${run.id} ${run.revision}`;
  }
  if (cmd.action === 'publish') await p.repo.publish(cmd.runId, cmd.revision, cmd.actor);
  if (cmd.action === 'skip') await p.repo.skip(cmd.runId, cmd.revision, cmd.actor);
  if (cmd.action === 'regenerate') await p.regenerate(cmd.runId, cmd.revision, cmd.target!);
  const run = await p.repo.get(cmd.runId);
  return `${run.id} revision ${run.revision}: ${run.status}`;
}
