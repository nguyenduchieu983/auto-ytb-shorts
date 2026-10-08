import { Pool } from 'pg';
import { loadConfig } from './config';
import { migrate, Repository } from './db';
import { Pipeline } from './engine';
import { QueueRuntime } from './queues';

async function main() {
  const c = loadConfig(),
    pool = new Pool({ connectionString: c.DATABASE_URL, max: 16, connectionTimeoutMillis: 10000 });
  await migrate(pool);
  const runtime = new QueueRuntime(new Pipeline(c, new Repository(pool)));
  await runtime.start();
  console.log('Workers ready; schedule enabled:', c.SCHEDULE_ENABLED);
  const close = async () => {
    await runtime.close();
    await pool.end();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
main().catch(() => {
  console.error('Worker startup failed; check configuration, PostgreSQL and Redis');
  process.exitCode = 1;
});
