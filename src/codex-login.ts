import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Config } from './config';
import { codexEnvironment, resolveCodexBinary } from './codex-runtime';

export function validatedCodexAuthUrl(value: unknown) {
  const url = new URL(String(value));
  if (
    url.protocol !== 'https:' ||
    !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error('Invalid Codex sign-in URL');
  return url.href;
}
export class CodexLogin {
  private child?: ChildProcessWithoutNullStreams;
  private seq = 0;
  private generation = 0;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private deadline?: NodeJS.Timeout;
  private starting?: Promise<any>;
  private checking?: Promise<any>;
  private state: {
    status: string;
    account_status: string;
    auth_url?: string;
    expires_at?: string;
    message?: string;
  } = { status: 'idle', account_status: 'unknown' };
  constructor(
    private c: Config,
    private launch: typeof spawn = spawn,
    private resolveBinary = () => resolveCodexBinary(c),
    private ttlMs = 10 * 60 * 1000,
  ) {}
  view() {
    return { ...this.state };
  }
  private stop() {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = undefined;
    const child = this.child;
    this.child = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Codex sign-in process stopped'));
    }
    this.pending.clear();
    child?.stdin.end();
    child?.kill();
  }
  close() {
    this.generation++;
    this.stop();
  }
  cancel() {
    this.generation++;
    this.state = {
      status: 'cancelled',
      account_status: this.state.account_status,
      message: 'Đã hủy phiên đăng nhập; thông tin đăng nhập hiện có được giữ nguyên.',
    };
    this.stop();
    return this.view();
  }
  private rpc(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(new Error('Codex unavailable'));
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex auth request timed out'));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  private async boot() {
    const binary = await this.resolveBinary();
    const child = this.launch(
      binary,
      ['app-server', '-c', 'forced_login_method="chatgpt"', '--listen', 'stdio://'],
      { env: codexEnvironment(), shell: false, windowsHide: true, stdio: 'pipe' },
    ) as ChildProcessWithoutNullStreams;
    this.child = child;
    const failed = () => {
      if (this.child !== child) return;
      if (['starting', 'waiting'].includes(this.state.status))
        this.state = {
          status: 'failed',
          account_status: 'unknown',
          message: 'Không mở được phiên đăng nhập Codex. Kiểm tra Codex đã cài hoặc thử lại.',
        };
      this.stop();
    };
    child.on('error', failed);
    child.on('close', failed);
    child.stdin.on('error', failed);
    child.stderr.on('data', () => {}); // Auth diagnostics can contain sensitive URLs; never persist/forward them.
    const lines = createInterface({ input: child.stdout });
    child.on('close', () => lines.close());
    lines.on('line', (line) => {
      if (this.child !== child) return;
      if (line.length > 100000) {
        failed();
        return;
      }
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.id !== undefined) {
        const request = this.pending.get(event.id);
        if (request) {
          clearTimeout(request.timer);
          this.pending.delete(event.id);
          event.error
            ? request.reject(new Error('Codex rejected auth request'))
            : request.resolve(event.result);
        } else if (event.method)
          child.stdin.write(
            JSON.stringify({
              id: event.id,
              error: { code: -32601, message: 'Unsupported method' },
            }) + '\n',
          );
      } else if (event.method === 'account/login/completed' && this.state.status === 'waiting') {
        this.state = event.params?.success
          ? {
              status: 'succeeded',
              account_status: 'chatgpt',
              message: 'Đăng nhập Codex thành công. Có thể quay lại video lỗi và bấm Thử lại.',
            }
          : {
              status: 'failed',
              account_status: 'unknown',
              message:
                'Đăng nhập chưa hoàn tất hoặc bị từ chối. Bấm đăng nhập lại để mở phiên mới.',
            };
        this.stop();
      }
    });
    await this.rpc('initialize', {
      clientInfo: { name: 'shorts_studio', title: 'Shorts Studio', version: '0.1.0' },
    });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }
  async start() {
    if (this.checking) await this.checking;
    if (this.starting) return this.starting;
    if (this.state.status === 'waiting') return this.view();
    const generation = ++this.generation;
    const task = (async () => {
      this.stop();
      this.state = {
        status: 'starting',
        account_status: 'unknown',
        message: 'Đang mở phiên đăng nhập…',
      };
      try {
        if (this.c.CONTENT_PROVIDER !== 'codex') throw new Error('Not Codex mode');
        await this.boot();
        const result = await this.rpc('account/login/start', { type: 'chatgpt' });
        if (generation !== this.generation) return this.view();
        this.state = {
          status: 'waiting',
          account_status: 'unknown',
          auth_url: validatedCodexAuthUrl(result.authUrl),
          expires_at: new Date(Date.now() + this.ttlMs).toISOString(),
          message: 'Hoàn tất đăng nhập ở tab mới. Trang này sẽ tự cập nhật.',
        };
        this.deadline = setTimeout(() => {
          this.state = {
            status: 'expired',
            account_status: 'unknown',
            message: 'Phiên đăng nhập đã hết thời gian chờ. Bấm đăng nhập lại để lấy link mới.',
          };
          this.stop();
        }, this.ttlMs);
        return this.view();
      } catch {
        if (generation === this.generation) {
          this.state = {
            status: 'failed',
            account_status: 'unknown',
            message:
              'Không tạo được link đăng nhập Codex. Kiểm tra executable, kết nối hoặc cổng callback; sau đó thử lại.',
          };
          this.stop();
        }
        return this.view();
      }
    })();
    this.starting = task;
    try {
      return await task;
    } finally {
      if (this.starting === task) this.starting = undefined;
    }
  }
  async check() {
    if (this.starting || this.state.status === 'waiting') return this.view();
    if (this.checking) return this.checking;
    const task = (async () => {
      try {
        await this.boot();
        const result = await this.rpc('account/read', { refreshToken: true });
        this.state =
          result.account?.type === 'chatgpt'
            ? {
                status: 'idle',
                account_status: 'chatgpt',
                message:
                  'Codex đã xác nhận đăng nhập ChatGPT. Đây không phải kiểm tra quota còn lại.',
              }
            : {
                status: 'idle',
                account_status: 'sign_in_required',
                message: 'Cần đăng nhập bằng ChatGPT để dùng quota Codex.',
              };
      } catch {
        this.state = {
          status: 'failed',
          account_status: 'unknown',
          message:
            'Không kiểm tra được đăng nhập. Có thể cần đăng nhập lại hoặc kiểm tra Codex/kết nối.',
        };
      } finally {
        this.stop();
      }
      return this.view();
    })();
    this.checking = task;
    try {
      return await task;
    } finally {
      if (this.checking === task) this.checking = undefined;
    }
  }
}
