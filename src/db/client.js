import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { getDatabaseConnectionString } from '../config/env.js';

const { Pool } = pg;

let poolInstance = null;
let dbInstance = null;
let activeConnectionString = null;

export function getPool() {
  const connectionString = getDatabaseConnectionString();
  if (!connectionString) {
    throw new Error('Database connection string (DATABASE_URL or DIRECT_URL) is not configured.');
  }

  if (!poolInstance || activeConnectionString !== connectionString) {
    if (poolInstance) {
      poolInstance.end().catch(() => {});
    }
    activeConnectionString = connectionString;
    poolInstance = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 15000,
      keepAlive: true,
    });

    // Prevent Neon serverless idle connection closures from crashing Node.js
    poolInstance.on('error', (err) => {
      console.warn('[db:pool] Idle connection closed by database:', err?.message || err);
    });

    dbInstance = drizzle(poolInstance, { schema });
  }

  return poolInstance;
}

export function getDb() {
  getPool();
  return dbInstance;
}

export async function closeDb() {
  if (poolInstance) {
    const p = poolInstance;
    poolInstance = null;
    dbInstance = null;
    activeConnectionString = null;
    await p.end().catch(() => {});
  }
}

export async function checkDatabaseHealth() {
  const connectionString = getDatabaseConnectionString();
  if (!connectionString) {
    return {
      connected: false,
      reason: 'NOT_CONFIGURED',
    };
  }

  try {
    const pool = getPool();
    const start = Date.now();
    await pool.query('SELECT 1 AS ok');
    return {
      connected: true,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      connected: false,
      reason: err?.code || 'CONNECTION_ERROR',
    };
  }
}
