import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { getDatabaseConnectionString } from '../config/env.js';

const { Pool } = pg;

export const dbTimingStorage = new AsyncLocalStorage();

let poolInstance = null;
let dbInstance = null;
let activeConnectionString = null;
let dbMutationVersion = 0;
let lastHealthyAt = 0;
let lastQueryLatencyMs = null;
let inflightHealthCheck = null;

const instrumentedClients = new WeakSet();
const MUTATION_SQL_RE = /^\s*(insert|update|delete|commit|alter|drop|truncate|create)\b/i;

export function getDbMutationVersion() {
  return dbMutationVersion;
}

export function bumpDbMutationVersion() {
  dbMutationVersion += 1;
}

function recordQueryExecution(sqlArg, durationMs, succeeded) {
  const sqlText = typeof sqlArg === 'string' ? sqlArg : sqlArg?.text || '';
  if (succeeded) {
    lastHealthyAt = Date.now();
    lastQueryLatencyMs = Math.max(1, Math.round(durationMs));
    if (MUTATION_SQL_RE.test(sqlText)) {
      dbMutationVersion += 1;
    }
  } else {
    lastHealthyAt = 0;
  }

  const store = dbTimingStorage.getStore();
  if (store) {
    store.dbQueryCount += 1;
    store.dbDurationMs += durationMs;
    store.queryDurationsMs.push(Number(durationMs.toFixed(2)));
  }
}

function wrapQueryTarget(target) {
  if (instrumentedClients.has(target)) return;
  instrumentedClients.add(target);

  const originalQuery = target.query.bind(target);
  target.query = async function instrumentedQuery(...args) {
    const start = performance.now();
    let succeeded = false;
    try {
      const res = await originalQuery(...args);
      succeeded = true;
      return res;
    } finally {
      const durationMs = performance.now() - start;
      recordQueryExecution(args[0], durationMs, succeeded);
    }
  };
}

function instrumentPool(pool) {
  wrapQueryTarget(pool);

  const originalConnect = pool.connect.bind(pool);
  pool.connect = async function instrumentedConnect(...args) {
    if (args.length > 0 && typeof args[0] === 'function') {
      return originalConnect(...args);
    }
    const client = await originalConnect(...args);
    wrapQueryTarget(client);
    return client;
  };
}

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
    lastHealthyAt = 0;
    lastQueryLatencyMs = null;
    poolInstance = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 15000,
      keepAlive: true,
    });

    instrumentPool(poolInstance);

    // Prevent Neon serverless idle connection closures from crashing Node.js
    poolInstance.on('error', (err) => {
      lastHealthyAt = 0;
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
    lastHealthyAt = 0;
    lastQueryLatencyMs = null;
    await p.end().catch(() => {});
  }
}

export async function checkDatabaseHealth({ force = false, maxAgeMs = 15000 } = {}) {
  const connectionString = getDatabaseConnectionString();
  if (!connectionString) {
    return {
      connected: false,
      reason: 'NOT_CONFIGURED',
    };
  }

  if (
    !force &&
    poolInstance &&
    activeConnectionString === connectionString &&
    lastHealthyAt > 0 &&
    Date.now() - lastHealthyAt < maxAgeMs
  ) {
    return {
      connected: true,
      latencyMs: lastQueryLatencyMs ?? 1,
    };
  }

  if (inflightHealthCheck) {
    return inflightHealthCheck;
  }

  inflightHealthCheck = (async () => {
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
    } finally {
      inflightHealthCheck = null;
    }
  })();

  return inflightHealthCheck;
}
