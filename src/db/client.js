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
const READ_ONLY_SQL_RE = /^\s*(select|with)\b/i;
const PRE_EXEC_CONNECT_CODES = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  '57P03',
]);
const SOCKET_DROP_CODES = new Set(['ECONNRESET', 'EPIPE', '57P01']);

/**
 * Extracts the root driver/network error (including Node AggregateError entries) from Drizzle wrappers.
 */
export function extractDbCause(err) {
  let cursor = err;
  let root = err;
  for (let i = 0; i < 5 && cursor; i++) {
    root = cursor;
    if (cursor.cause && typeof cursor.cause === 'object') {
      cursor = cursor.cause;
      continue;
    }
    if (Array.isArray(cursor.errors) && cursor.errors.length > 0) {
      cursor = cursor.errors[0];
      continue;
    }
    break;
  }
  const code = root?.code || err?.code || null;
  const message =
    root?.message ||
    (Array.isArray(root?.errors)
      ? root.errors.map((e) => e?.message || e?.code).filter(Boolean).join('; ')
      : '') ||
    err?.message ||
    '';
  return { code, message: String(message || '').trim() };
}

export function isTransientDbError(err, allowSocketDrop = false) {
  const { code, message } = extractDbCause(err);
  if (code && PRE_EXEC_CONNECT_CODES.has(String(code))) {
    return true;
  }
  if (/timeout exceeded when trying to connect|connection terminated due to connection timeout|getaddrinfo/i.test(message)) {
    return true;
  }
  if (!allowSocketDrop) {
    return false;
  }
  if (code && SOCKET_DROP_CODES.has(String(code))) {
    return true;
  }
  return /connection terminated unexpectedly|connection ended unexpectedly|client has encountered a connection error/i.test(
    message
  );
}

/**
 * Formats Drizzle/PostgreSQL errors so callers and UI see the root cause instead of raw SQL text alone.
 */
export function describeDbError(err) {
  if (!err) return 'Kesalahan database tidak diketahui.';
  const rawMsg = String(err.message || err);
  const { code, message } = extractDbCause(err);
  const causeLabel = [code, message && !/^Failed query:/i.test(message) ? message : null]
    .filter(Boolean)
    .join(': ');

  if (isTransientDbError(err, true)) {
    return `Koneksi database Neon gagal atau terputus (${causeLabel || 'timeout'}). Periksa koneksi internet / status Neon DB lalu coba lagi.`;
  }

  if (/^Failed query:/i.test(rawMsg)) {
    return causeLabel ? `Gagal query database (${causeLabel}).` : rawMsg;
  }

  return causeLabel || rawMsg;
}

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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function wrapQueryTarget(target, allowTransientRetry = false) {
  if (instrumentedClients.has(target)) return;
  instrumentedClients.add(target);

  const originalQuery = target.query.bind(target);
  target.query = async function instrumentedQuery(...args) {
    const start = performance.now();
    let succeeded = false;
    const sqlText = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
    const canRetrySocketDrop = READ_ONLY_SQL_RE.test(sqlText);

    try {
      try {
        const res = await originalQuery(...args);
        succeeded = true;
        return res;
      } catch (err) {
        if (allowTransientRetry && isTransientDbError(err, canRetrySocketDrop)) {
          lastHealthyAt = 0;
          await delay(350);
          const retryRes = await originalQuery(...args);
          succeeded = true;
          return retryRes;
        }
        throw err;
      }
    } finally {
      const durationMs = performance.now() - start;
      recordQueryExecution(args[0], durationMs, succeeded);
    }
  };
}

function instrumentPool(pool) {
  wrapQueryTarget(pool, true);

  const originalConnect = pool.connect.bind(pool);
  pool.connect = async function instrumentedConnect(...args) {
    if (args.length > 0 && typeof args[0] === 'function') {
      return originalConnect(...args);
    }
    let client;
    try {
      client = await originalConnect(...args);
    } catch (err) {
      if (isTransientDbError(err, true)) {
        lastHealthyAt = 0;
        await delay(350);
        client = await originalConnect(...args);
      } else {
        throw err;
      }
    }
    wrapQueryTarget(client, false);
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
      connectionTimeoutMillis: 30000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
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
      const { code } = extractDbCause(err);
      return {
        connected: false,
        reason: code || 'CONNECTION_ERROR',
      };
    } finally {
      inflightHealthCheck = null;
    }
  })();

  return inflightHealthCheck;
}
