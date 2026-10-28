import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';

/*
 * Migration file rules (enforced by convention, not by code):
 * - Each file runs inside its own transaction, so it must not contain statements that
 *   cannot run in a transaction (CREATE INDEX CONCURRENTLY, VACUUM, ...) and must not
 *   contain its own BEGIN/COMMIT.
 * - Name files with a zero-padded numeric prefix (001_, 002_, ...): they are applied in
 *   lexical order.
 * - Never edit a file that has already been applied: there is no checksum, so the change
 *   would be silently ignored on databases that already recorded the file.
 */

/** Arbitrary constant key for the session-level advisory lock that serialises runners. */
const MIGRATION_LOCK_KEY = 7_340_001;

/**
 * Resolved relative to this module, so it works from `src/` (tsx tests) and
 * from `dist/` (the build copies the `.sql` files next to the compiled code).
 */
export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('./migrations/', import.meta.url));
}

/** Plain `*.sql` files only (no directories, no `.sql.bak`), in lexical order. */
export async function listMigrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Applies pending migrations and returns the names applied by this call.
 * Each file runs in its own transaction together with its bookkeeping row, and
 * the whole run is guarded by an advisory lock so concurrent processes cannot
 * both apply the same file. A failure stops the run; earlier files stay applied.
 */
export async function runMigrations(
  pool: Pool,
  dir: string = defaultMigrationsDir(),
): Promise<string[]> {
  const files = await listMigrationFiles(dir);
  const applied: string[] = [];
  const client = await pool.connect();
  // If the unlock fails the session state is unknown: destroy the connection
  // instead of returning it to the pool, which also drops the advisory lock.
  let destroyClient = false;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           name text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const done = new Set(
        (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
          (row) => row.name,
        ),
      );

      for (const name of files) {
        if (done.has(name)) {
          continue;
        }

        const sql = await readFile(path.join(dir, name), 'utf8');

        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }

        applied.push(name);
      }
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
        .catch(() => {
          destroyClient = true;
        });
    }
  } finally {
    client.release(destroyClient);
  }

  return applied;
}
