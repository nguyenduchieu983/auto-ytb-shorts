require('dotenv/config');
const { Pool } = require('pg');
async function main() {
  const [apiPid, workerPid] = process.argv.slice(2).map(Number);
  process.kill(apiPid, 0);
  process.kill(workerPid, 0);
  const host = ['0.0.0.0', '::'].includes(process.env.HOST)
    ? '127.0.0.1'
    : process.env.HOST || '127.0.0.1';
  const response = await fetch(
    `http://${host.includes(':') ? `[${host}]` : host}:${process.env.PORT || 3000}/health`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!response.ok || !(await response.json()).ok) throw new Error('API unavailable');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    const result = await pool.query(
      "SELECT 1 FROM runtime_heartbeats WHERE pid=$1 AND updated_at > now() - interval '45 seconds'",
      [workerPid],
    );
    if (!result.rowCount) throw new Error('Worker heartbeat unavailable');
  } finally {
    await pool.end();
  }
  console.log('API health and worker heartbeat verified.');
}
main().catch(() => {
  console.error('Runtime not ready; inspect local process logs.');
  process.exitCode = 1;
});
