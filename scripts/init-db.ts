import 'dotenv/config';
import { Client, escapeIdentifier, escapeLiteral } from 'pg';
import { readFile } from 'node:fs/promises';
function normalizeConnection(raw: string): string {
  const start = raw.indexOf('://') + 3,
    end = raw.lastIndexOf('@');
  if (start < 3 || end < start) return raw;
  const credentials = raw.slice(start, end),
    colon = credentials.indexOf(':');
  if (colon < 0) return raw;
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  return (
    raw.slice(0, start) +
    encodeURIComponent(decode(credentials.slice(0, colon))) +
    ':' +
    encodeURIComponent(decode(credentials.slice(colon + 1))) +
    raw.slice(end)
  );
}
async function main() {
  if (!process.env.POSTGRES_ADMIN_URL)
    throw new Error('Set POSTGRES_ADMIN_URL locally in .env; never send it to chat');
  let adminConnection = process.env.POSTGRES_ADMIN_URL;
  // An unquoted # in .env is parsed as a comment. Recover only this explicitly
  // requested connection locally, and percent-encode URI credentials in memory.
  const file = await readFile('.env', 'utf8').catch(() => '');
  const raw = file
    .split(/\r?\n/)
    .find((line) => /^POSTGRES_ADMIN_URL\s*=/.test(line))
    ?.replace(/^POSTGRES_ADMIN_URL\s*=\s*/, '')
    .trim();
  if (raw?.includes('#') && !/^["']/.test(raw)) adminConnection = raw;
  adminConnection = normalizeConnection(adminConnection);
  const app = new URL(process.env.DATABASE_URL || ''),
    admin = new URL(adminConnection);
  const host = (value: string) =>
    ['localhost', '127.0.0.1', '[::1]'].includes(value) ? 'loopback' : value;
  if (
    host(app.hostname) !== host(admin.hostname) ||
    (app.port || '5432') !== (admin.port || '5432')
  )
    throw new Error('Admin and app connections must use the same PostgreSQL server');
  const role = decodeURIComponent(app.username),
    database = decodeURIComponent(app.pathname.slice(1)),
    password = decodeURIComponent(app.password);
  if (
    !/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(role) ||
    !/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(database) ||
    !password
  )
    throw new Error(
      'App URL requires a role, database and password; names must be simple identifiers',
    );
  const client = new Client({ connectionString: adminConnection, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const exists = (await client.query('SELECT rolname FROM pg_roles WHERE rolname=$1', [role]))
      .rows.length;
    if (!exists) {
      await client.query(
        `CREATE ROLE ${escapeIdentifier(role)} LOGIN PASSWORD ${escapeLiteral(password)}`,
      );
      console.log('Created project role');
    } else console.log('Existing role preserved; password was not changed');
    const db = (
      await client.query(
        'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',
        [database],
      )
    ).rows[0];
    if (db && db.owner !== role)
      throw new Error(
        'Existing database belongs to another role; choose a dedicated project database',
      );
    if (!db) {
      await client.query(
        `CREATE DATABASE ${escapeIdentifier(database)} OWNER ${escapeIdentifier(role)}`,
      );
      console.log('Created project database');
    } else console.log('Existing project database preserved');
  } finally {
    await client.end();
  }
  const check = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await check.connect();
    await check.query('SELECT 1');
    console.log('Project database connection verified. Run npm run migrate.');
  } finally {
    await check.end();
  }
}
main().catch((e: any) => {
  console.error(
    e.code
      ? `Database initialization failed (${e.code}); inspect local configuration`
      : e.message || 'Database initialization failed',
  );
  process.exitCode = 1;
});
