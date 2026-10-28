import type { Express } from 'express';
import type { Server } from 'node:http';
import type { Pool } from 'pg';

import { logSafeError } from './safe-log.js';

export const SHUTDOWN_TIMEOUT_MS = 10_000;
/** After this long, connections that are still busy are closed forcibly. Must be < the hard timeout. */
export const SHUTDOWN_GRACE_MS = 8_000;
/** How often connections that just became idle are reclaimed while draining. */
export const IDLE_SWEEP_MS = 100;

export interface StartServerOptions {
  app: Express;
  host: string;
  port: number;
}

/** Resolves once listening; rejects on bind errors such as EADDRINUSE. */
export function startServer({ app, host, port }: StartServerOptions): Promise<Server> {
  return new Promise((resolve, reject) => {
    // Express 5 passes listen errors (EADDRINUSE, ...) to this callback.
    const server = app.listen(port, host, (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(server);
    });
  });
}

export interface ShutdownOptions {
  server: Server;
  pool: Pool;
  /** Stop background consumers before releasing their shared database pool. */
  stopBackground?: () => Promise<void>;
  /** Defaults to `process.exit`; injected in tests. */
  exit?: (code: number) => void;
  /** Hard timeout: exit 1 if shutdown has not finished by then. */
  timeoutMs?: number;
  /** Grace period before `closeAllConnections()`; keep it below `timeoutMs`. */
  graceMs?: number;
  /** Interval of the `closeIdleConnections()` sweep while draining. */
  idleSweepMs?: number;
}

/**
 * Returns an idempotent `shutdown(signal)`: stop accepting connections
 * (`server.close()`), then `pool.end()`, then exit 0.
 *
 * `server.close()` only drops connections that are idle at that instant, and a
 * request that is in flight keeps its keep-alive connection open afterwards.
 * So idle connections are swept right away and then every `idleSweepMs` until
 * the server has closed (in-flight requests are allowed to finish). Connections
 * that are still busy after `graceMs` are closed forcibly. A hard timeout exits
 * 1 if shutdown has still not finished; any failure also exits 1.
 */
export function createShutdown({
  server,
  pool,
  stopBackground,
  exit = (code) => process.exit(code),
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
  graceMs = SHUTDOWN_GRACE_MS,
  idleSweepMs = IDLE_SWEEP_MS,
}: ShutdownOptions): (signal: string) => Promise<void> {
  let running: Promise<void> | undefined;

  return (signal) => {
    running ??= (async () => {
      // `signal` is a fixed name from our own handler registration, not input.
      console.log(`Received ${signal}, shutting down`);
      let sweepTimer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;
      const clearDrainTimers = (): void => {
        clearInterval(sweepTimer);
        clearTimeout(graceTimer);
      };
      const hardTimer = setTimeout(() => {
        clearDrainTimers();
        console.error(`Shutdown timed out after ${timeoutMs} ms`);
        exit(1);
      }, timeoutMs);
      let exitCode = 0;
      const backgroundDrained = stopBackground?.().catch((error: unknown) => {
        logSafeError('Failed to stop background work', error);
        exitCode = 1;
      });

      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections();
          // Must not keep the process alive on its own.
          sweepTimer = setInterval(() => server.closeIdleConnections(), idleSweepMs);
          sweepTimer.unref();
          graceTimer = setTimeout(() => {
            console.error(`Closing remaining connections after ${graceMs} ms`);
            server.closeAllConnections();
          }, graceMs);
        });
      } catch (error) {
        logSafeError('Failed to close the HTTP server', error);
        exitCode = 1;
      } finally {
        clearDrainTimers();
      }

      try {
        await backgroundDrained;
        await pool.end();
      } catch (error) {
        logSafeError('Failed to end the PostgreSQL pool', error);
        exitCode = 1;
      }

      clearTimeout(hardTimer);
      exit(exitCode);
    })();

    return running;
  };
}

/** Registers SIGTERM/SIGINT handlers that run `shutdown`. */
export function registerShutdownSignals(shutdown: (signal: string) => Promise<void>): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}
