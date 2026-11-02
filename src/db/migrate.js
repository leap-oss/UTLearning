import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDirectDatabaseConnectionString } from '../config/env.js';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations() {
  const connectionString = getDirectDatabaseConnectionString();
  if (!connectionString) {
    throw new Error('Cannot run migrations: DIRECT_URL or DATABASE_URL is not configured in .env');
  }

  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 15000,
  });

  try {
    const db = drizzle(pool);
    const migrationsFolder = path.resolve(__dirname, '../../drizzle');
    await migrate(db, { migrationsFolder });

    // Create partial index for fast lookup of succeeded cached jobs
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ai_jobs_cache_key_succeeded_idx
      ON ai_generation_jobs (cache_key, completed_at DESC)
      WHERE status = 'succeeded';
    `);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log('[db:migrate] Migrations applied successfully to Neon Postgres.');
    })
    .catch((err) => {
      console.error('[db:migrate] Migration failed:', err.message);
      process.exit(1);
    });
}
