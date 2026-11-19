import { getPool } from '../db/client.js';
import { getDatabaseConnectionString } from '../config/env.js';

let tableInitPromise = null;
let lastLoadedAt = 0;

async function ensureCooldownTable() {
  if (!getDatabaseConnectionString()) return false;
  if (!tableInitPromise) {
    tableInitPromise = (async () => {
      try {
        const pool = getPool();
        await pool.query(`
          CREATE TABLE IF NOT EXISTS ai_provider_cooldowns (
            cooldown_key VARCHAR(191) PRIMARY KEY,
            expires_at TIMESTAMPTZ NOT NULL,
            reason VARCHAR(64) NOT NULL DEFAULT 'cooldown',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS ai_provider_cooldowns_expires_at_idx
            ON ai_provider_cooldowns (expires_at);
        `);
        return true;
      } catch {
        tableInitPromise = null;
        return false;
      }
    })();
  }
  return tableInitPromise;
}

/**
 * Loads all active (non-expired) hashed API/model cooldown entries from Neon DB.
 * Survives Vercel serverless cold starts and cross-container requests.
 */
export async function loadActiveRemoteCooldowns({ force = false, maxAgeMs = 20_000 } = {}) {
  if (!getDatabaseConnectionString()) return null;
  const now = Date.now();
  if (!force && lastLoadedAt > 0 && now - lastLoadedAt < maxAgeMs) {
    return null;
  }

  try {
    const ready = await ensureCooldownTable();
    if (!ready) return null;

    const pool = getPool();
    const res = await pool.query(
      'SELECT cooldown_key, expires_at FROM ai_provider_cooldowns WHERE expires_at > NOW()'
    );
    lastLoadedAt = Date.now();

    const map = new Map();
    for (const row of res.rows || []) {
      const untilMs = new Date(row.expires_at).getTime();
      if (row.cooldown_key && Number.isFinite(untilMs) && untilMs > Date.now()) {
        map.set(row.cooldown_key, untilMs);
      }
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * Persists one or more hashed cooldown markers in a single batched SQL round-trip.
 * @param {Array<{ cooldownKey: string, expiresAtMs: number, reason?: string }>} entries
 */
export async function upsertRemoteCooldownBatch(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0 || !getDatabaseConnectionString()) {
    return false;
  }

  const valid = entries.filter(
    (e) => e && e.cooldownKey && Number.isFinite(e.expiresAtMs) && e.expiresAtMs > Date.now() + 10_000
  );
  if (valid.length === 0) return false;

  try {
    const ready = await ensureCooldownTable();
    if (!ready) return false;

    const pool = getPool();
    const keys = valid.map((e) => String(e.cooldownKey).slice(0, 191));
    const expiries = valid.map((e) => new Date(e.expiresAtMs).toISOString());
    const reasons = valid.map((e) => String(e.reason || 'cooldown').slice(0, 64));

    await pool.query(
      `
        INSERT INTO ai_provider_cooldowns (cooldown_key, expires_at, reason, updated_at)
        SELECT k, e::timestamptz, r, NOW()
        FROM UNNEST($1::varchar[], $2::text[], $3::varchar[]) AS t(k, e, r)
        ON CONFLICT (cooldown_key) DO UPDATE SET
          expires_at = GREATEST(ai_provider_cooldowns.expires_at, EXCLUDED.expires_at),
          reason = EXCLUDED.reason,
          updated_at = NOW()
      `,
      [keys, expiries, reasons]
    );
    return true;
  } catch {
    return false;
  }
}

export async function deleteRemoteCooldowns(cooldownKeys = []) {
  if (!Array.isArray(cooldownKeys) || cooldownKeys.length === 0 || !getDatabaseConnectionString()) {
    return false;
  }
  try {
    const ready = await ensureCooldownTable();
    if (!ready) return false;
    const pool = getPool();
    await pool.query(
      'DELETE FROM ai_provider_cooldowns WHERE cooldown_key = ANY($1::varchar[])',
      [cooldownKeys]
    );
    return true;
  } catch {
    return false;
  }
}

export function resetRemoteCooldownCacheState() {
  lastLoadedAt = 0;
}
