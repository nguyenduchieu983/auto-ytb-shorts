import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
async function main() {
  const password = randomBytes(24).toString('hex');
  const template = (await readFile('.env.example', 'utf8'))
    .replace('replace-with-at-least-32-random-characters', randomBytes(32).toString('hex'))
    .replace('replace-with-a-random-database-password', password)
    .replace(
      'postgresql://shorts:shorts@localhost:5432/shorts',
      `postgresql://shorts:${password}@localhost:5432/shorts`,
    );
  try {
    await writeFile('.env', template, { flag: 'wx', mode: 0o600 });
    console.log(
      '.env created with random local admin/database credentials. All providers are mock and schedule is disabled.',
    );
  } catch (e: any) {
    if (e.code === 'EEXIST') {
      console.log('.env already exists; preserved.');
      return;
    }
    throw e;
  }
}
main().catch(() => {
  console.error('Unable to create local .env');
  process.exitCode = 1;
});
