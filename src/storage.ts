import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { Run, Step } from './domain';

export class Storage {
  constructor(public readonly root: string) {}
  safe(path: string): string {
    const full = resolve(path),
      rel = relative(this.root, full);
    if (rel.startsWith('..') || resolve(this.root, rel) !== full)
      throw new Error('Storage path escapes configured root');
    return full;
  }
  async directory(run: Run, step: Step, attempt: number): Promise<string> {
    const dir = this.safe(
      resolve(this.root, run.run_date, run.id, `rev-${run.revision}`, `${step}-attempt-${attempt}`),
    );
    await mkdir(dir, { recursive: true });
    return dir;
  }
  async json(dir: string, name: string, value: any) {
    const path = this.safe(resolve(dir, name));
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    await writeFile(path, bytes);
    return { path, checksum: createHash('sha256').update(bytes).digest('hex') };
  }
  async checksum(path: string) {
    return createHash('sha256')
      .update(await readFile(this.safe(path)))
      .digest('hex');
  }
}
