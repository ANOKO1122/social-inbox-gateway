import { createPool } from './pool.js';
import { runMigrations } from './migrate.js';
import { logSafeError } from '../safe-log.js';

/** Reads only DATABASE_URL. Errors are logged through the whitelist, never via `error.message`. */
async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error('Missing required environment variable: DATABASE_URL');
    return 1;
  }

  const pool = createPool(databaseUrl);

  try {
    const applied = await runMigrations(pool);

    console.log(
      applied.length === 0
        ? 'No pending migrations'
        : `Applied ${applied.length} migration(s): ${applied.join(', ')}`,
    );
    return 0;
  } catch (error) {
    logSafeError('Database migration failed', error);
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

process.exitCode = await main();
