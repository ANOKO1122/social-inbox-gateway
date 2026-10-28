import { Pool } from 'pg';

import { logSafeError } from '../safe-log.js';

export function createPool(databaseUrl: string): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // An idle client error with no listener would crash the process. Log through
  // the whitelist only: pg messages can embed the connection string.
  pool.on('error', (error) => {
    logSafeError('Unexpected PostgreSQL pool error', error);
  });

  return pool;
}
