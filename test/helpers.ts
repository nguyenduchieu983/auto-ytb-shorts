import { newDb } from 'pg-mem';
import { loadConfig } from '../src/config';
import { migrate, Repository } from '../src/db';
export async function setup() {
  const pg = newDb().adapters.createPg(),
    pool = new pg.Pool();
  await migrate(pool as any, true);
  const repo = new Repository(pool as any);
  const c = loadConfig({
    ADMIN_TOKEN: 'test-only-token-with-at-least-32-characters',
    DATABASE_URL: 'postgres://test:test@localhost/test',
    REDIS_URL: 'redis://localhost:6379',
    MOCK_OPENAI: 'true',
    MOCK_YOUTUBE: 'true',
    MOCK_TELEGRAM: 'true',
    STORAGE_ROOT: './storage/tests',
  });
  return { pool, repo, c };
}
