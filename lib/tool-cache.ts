import { createHash } from 'node:crypto';
import { sql } from './db';

export type CacheKey = string;

function hashInput(input: unknown): CacheKey {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 32);
}

export async function ensureTable() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS tool_cache (
        key TEXT PRIMARY KEY,
        result JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tool_cache_created_at
        ON tool_cache(created_at DESC);
    `;
  } catch (err) {
    console.error('Failed to create cache table:', err);
  }
}

export async function getCached<T>(key: CacheKey, ttlHours: number = 24): Promise<T | null> {
  try {
    const rows = await sql`
      SELECT result FROM tool_cache
      WHERE key = ${key}
      AND created_at > NOW() - INTERVAL '${ttlHours} hours'
      LIMIT 1
    `;
    if (rows.length > 0) {
      return JSON.parse(rows[0].result as string) as T;
    }
  } catch (err) {
    console.error(`Cache miss for key ${key}:`, err);
  }
  return null;
}

export async function setCached<T>(key: CacheKey, value: T): Promise<void> {
  try {
    await sql`
      INSERT INTO tool_cache (key, result, created_at)
      VALUES (${key}, ${JSON.stringify(value)}, NOW())
      ON CONFLICT (key) DO UPDATE SET
        result = EXCLUDED.result,
        created_at = NOW()
    `;
  } catch (err) {
    console.error(`Cache write failed for key ${key}:`, err);
  }
}

export function cacheKey(prefix: string, input: unknown): CacheKey {
  return `${prefix}:${hashInput(input)}`;
}
