/** Local preview; no DB, Telegram or publishing. */
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config';
import { renderPhilosophy } from '../src/philosophy-render';
async function main() {
  const c = loadConfig();
  const spec = JSON.parse(
    await readFile(resolve(process.argv[2] || 'examples/philosophy-control.json'), 'utf8'),
  );
  const dir = join(c.STORAGE_ROOT, 'philosophy-preview', randomUUID());
  const report = await renderPhilosophy(c, dir, spec, async (message) => {
    console.log(message);
  });
  console.log('Preview:', report.render.path);
  console.log('Report:', join(dir, 'report.json'));
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
