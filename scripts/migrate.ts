import { Pool } from 'pg';
import { loadConfig } from '../src/config';
import { migrate } from '../src/db';
async function main() {
  const c = loadConfig(),
    pool = new Pool({ connectionString: c.DATABASE_URL });
  try {
    await migrate(pool);
    console.log('Migrations complete');
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error('Migration failed; check database configuration');
  process.exitCode = 1;
});
