import type { Pipeline } from './engine';
import type { TelegramCommand } from './providers/telegram';

export async function handleTelegramCommand(p: Pipeline, cmd: TelegramCommand): Promise<string> {
  if (cmd.action === 'gen-new-video') {
    const run = await p.run();
    const lead = ['PENDING', 'RUNNING'].includes(run.status)
      ? 'Đã nhận yêu cầu tạo video hôm nay. Pipeline đang chờ/chạy; xong sẽ gửi preview để duyệt.'
      : 'Hôm nay đã có video/run. Không tạo thêm bản trùng.';
    const uploadAttempt = ['FAILED', 'NEEDS_REVISION', 'SKIPPED'].includes(run.status)
      ? (await p.repo.detail(run.id)).uploads.find(
          (u: any) => u.revision === run.revision && u.status !== 'REJECTED',
        )
      : null;
    const action =
      run.status === 'WAITING_APPROVAL'
        ? `\n/publish ${run.id} ${run.revision}`
        : uploadAttempt
          ? '\nRun đã có phiên upload: kiểm tra lỗi và dùng retry/đối soát theo hướng dẫn; không tạo lại video.'
          : ['FAILED', 'NEEDS_REVISION', 'SKIPPED'].includes(run.status)
            ? `\nĐể làm lại run này: /regenerate ${run.id} ${run.revision} script`
            : '';
    return `${lead}\n${run.id} revision ${run.revision}: ${run.status}\n/status ${run.id} ${run.revision}${action}`;
  }
  if (cmd.action === 'publish') await p.repo.publish(cmd.runId, cmd.revision, cmd.actor);
  if (cmd.action === 'skip') await p.repo.skip(cmd.runId, cmd.revision, cmd.actor);
  if (cmd.action === 'regenerate') await p.regenerate(cmd.runId, cmd.revision, cmd.target!);
  const run = await p.repo.get(cmd.runId);
  return `${run.id} revision ${run.revision}: ${run.status}`;
}
