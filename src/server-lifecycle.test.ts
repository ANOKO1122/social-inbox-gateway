import assert from 'node:assert/strict';
import { request, Agent, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express from 'express';
import type { Pool } from 'pg';

import { createShutdown, startServer } from './server-lifecycle.js';

type CloseCallback = (error?: Error) => void;

interface FakeServerCalls {
  idleSweeps: number;
  closeAll: number;
}

function fakeServer(onClose: (callback: CloseCallback) => void, calls?: FakeServerCalls) {
  return {
    close: (callback?: CloseCallback) => onClose(callback ?? (() => undefined)),
    closeIdleConnections: () => {
      if (calls) calls.idleSweeps += 1;
    },
    closeAllConnections: () => {
      if (calls) calls.closeAll += 1;
    },
  } as unknown as Server;
}

function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
}

function fakePool(onEnd: () => Promise<void>) {
  return { end: onEnd } as unknown as Pool;
}

describe('createShutdown (injected server, pool, exit)', () => {
  it('closes the server first, then ends the pool, then exits 0', async () => {
    const steps: string[] = [];
    const exits: number[] = [];
    const server = fakeServer((callback) => {
      steps.push('server.close');
      callback();
    });
    const pool = fakePool(async () => {
      steps.push('pool.end');
    });

    const shutdown = createShutdown({ server, pool, exit: (code) => { exits.push(code); steps.push('exit'); } });
    await shutdown('SIGTERM');

    assert.deepEqual(steps, ['server.close', 'pool.end', 'exit']);
    assert.deepEqual(exits, [0]);
  });

  it('does not end the pool before the server has finished closing', async () => {
    const steps: string[] = [];
    let finishClose: CloseCallback = () => undefined;
    const server = fakeServer((callback) => {
      steps.push('server.close');
      finishClose = callback;
    });
    const pool = fakePool(async () => {
      steps.push('pool.end');
    });

    const shutdown = createShutdown({ server, pool, exit: () => undefined });
    const running = shutdown('SIGINT');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(steps, ['server.close']);

    finishClose();
    await running;
    assert.deepEqual(steps, ['server.close', 'pool.end']);
  });

  it('exits non-zero after the hard timeout when the server never finishes closing', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const exits: number[] = [];
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    let poolEnded = false;
    const server = fakeServer(() => undefined);
    const pool = fakePool(async () => {
      poolEnded = true;
    });

    const shutdown = createShutdown({ server, pool, exit: (code) => { exits.push(code); } });
    void shutdown('SIGTERM');

    t.mock.timers.tick(9_999);
    assert.deepEqual(exits, []);
    t.mock.timers.tick(1);

    assert.deepEqual(exits, [1]);
    assert.equal(poolEnded, false);
    assert.match(logged.join('\n'), /timed out/i);
  });

  it('honours a custom timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(console, 'error', () => undefined);
    const exits: number[] = [];

    const shutdown = createShutdown({
      server: fakeServer(() => undefined),
      pool: fakePool(async () => undefined),
      exit: (code) => { exits.push(code); },
      timeoutMs: 50,
    });
    void shutdown('SIGTERM');
    t.mock.timers.tick(50);

    assert.deepEqual(exits, [1]);
  });

  it('cancels the hard timeout after a clean shutdown', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const exits: number[] = [];
    const server = fakeServer((callback) => callback());

    const shutdown = createShutdown({
      server,
      pool: fakePool(async () => undefined),
      exit: (code) => { exits.push(code); },
    });
    await shutdown('SIGTERM');
    t.mock.timers.tick(60_000);

    assert.deepEqual(exits, [0]);
  });

  it('is idempotent: a second signal does not close or exit again', async () => {
    let closes = 0;
    let ends = 0;
    const exits: number[] = [];
    const server = fakeServer((callback) => {
      closes += 1;
      callback();
    });
    const pool = fakePool(async () => {
      ends += 1;
    });

    const shutdown = createShutdown({ server, pool, exit: (code) => { exits.push(code); } });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    assert.equal(closes, 1);
    assert.equal(ends, 1);
    assert.deepEqual(exits, [0]);
  });

  it('exits non-zero and logs only whitelisted fields when pool.end fails', async (t) => {
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    const exits: number[] = [];
    const server = fakeServer((callback) => callback());
    const pool = fakePool(async () => {
      throw Object.assign(new Error('failed postgresql://user:hunter2@db/app'), { name: 'PoolError' });
    });

    const shutdown = createShutdown({ server, pool, exit: (code) => { exits.push(code); } });
    await shutdown('SIGTERM');

    assert.deepEqual(exits, [1]);
    assert.match(logged.join('\n'), /PoolError/);
    assert.doesNotMatch(logged.join('\n'), /hunter2/);
  });

  it('still ends the pool and exits non-zero when server.close reports an error', async (t) => {
    t.mock.method(console, 'error', () => undefined);
    const exits: number[] = [];
    let poolEnded = false;
    const server = fakeServer((callback) => callback(new Error('close failed')));
    const pool = fakePool(async () => {
      poolEnded = true;
    });

    const shutdown = createShutdown({ server, pool, exit: (code) => { exits.push(code); } });
    await shutdown('SIGTERM');

    assert.equal(poolEnded, true);
    assert.deepEqual(exits, [1]);
  });
});

describe('createShutdown connection draining (injected server, mocked timers)', () => {
  it('sweeps idle connections right after close() and then periodically until close completes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const calls: FakeServerCalls = { idleSweeps: 0, closeAll: 0 };
    let finishClose: CloseCallback = () => undefined;
    const server = fakeServer((callback) => {
      finishClose = callback;
    }, calls);
    const exits: number[] = [];

    const shutdown = createShutdown({
      server,
      pool: fakePool(async () => undefined),
      exit: (code) => { exits.push(code); },
      idleSweepMs: 100,
    });
    const running = shutdown('SIGTERM');
    await Promise.resolve();

    assert.equal(calls.idleSweeps, 1, 'one sweep immediately after server.close()');
    t.mock.timers.tick(100);
    t.mock.timers.tick(100);
    assert.equal(calls.idleSweeps, 3);

    finishClose();
    await running;
    const sweepsAtClose = calls.idleSweeps;
    t.mock.timers.tick(1_000);

    assert.equal(calls.idleSweeps, sweepsAtClose, 'the sweep timer is cleared once close completes');
    assert.equal(calls.closeAll, 0);
    assert.deepEqual(exits, [0]);
  });

  it('force-closes all connections after the grace period, before the hard timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    t.mock.method(console, 'error', () => undefined);
    const calls: FakeServerCalls = { idleSweeps: 0, closeAll: 0 };
    const exits: number[] = [];
    const server = fakeServer(() => undefined, calls);

    const shutdown = createShutdown({
      server,
      pool: fakePool(async () => undefined),
      exit: (code) => { exits.push(code); },
      graceMs: 8_000,
      timeoutMs: 10_000,
    });
    void shutdown('SIGTERM');

    t.mock.timers.tick(7_999);
    assert.equal(calls.closeAll, 0);
    t.mock.timers.tick(1);
    assert.equal(calls.closeAll, 1);
    assert.deepEqual(exits, []);

    t.mock.timers.tick(2_000);
    assert.deepEqual(exits, [1], 'the 10 s hard timeout is unchanged');
    const sweeps = calls.idleSweeps;
    t.mock.timers.tick(5_000);
    assert.equal(calls.idleSweeps, sweeps, 'the hard timeout also stops the sweep timer');
  });

  it('does not force-close anything when the server closes within the grace period', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const calls: FakeServerCalls = { idleSweeps: 0, closeAll: 0 };
    const server = fakeServer((callback) => callback(), calls);

    const shutdown = createShutdown({ server, pool: fakePool(async () => undefined), exit: () => undefined });
    await shutdown('SIGTERM');
    t.mock.timers.tick(60_000);

    assert.equal(calls.closeAll, 0);
  });

  it('leaves no timers behind after a clean shutdown', async () => {
    const before = activeTimers();
    const server = fakeServer((callback) => {
      setTimeout(callback, 30);
    });

    await createShutdown({
      server,
      pool: fakePool(async () => undefined),
      exit: () => undefined,
      idleSweepMs: 5,
    })('SIGTERM');

    assert.ok(activeTimers() <= before, `leaked timers: before=${before} after=${activeTimers()}`);
  });
});

describe('startServer (real HTTP server on loopback)', () => {
  const app = express();
  app.get('/health/live', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  it('binds to the requested host and port', async () => {
    const server = await startServer({ app, host: '127.0.0.1', port: 0 });

    try {
      const address = server.address() as AddressInfo;
      assert.equal(address.address, '127.0.0.1');
      assert.ok(address.port > 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects when the port cannot be bound', async () => {
    const first = await startServer({ app, host: '127.0.0.1', port: 0 });

    try {
      const { port } = first.address() as AddressInfo;
      await assert.rejects(startServer({ app, host: '127.0.0.1', port }), /EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => first.close(() => resolve()));
    }
  });

  it('shutdown completes promptly even with an idle keep-alive client connected', async () => {
    const server = await startServer({ app, host: '127.0.0.1', port: 0 });
    const { port } = server.address() as AddressInfo;
    const agent = new Agent({ keepAlive: true });

    try {
      const status = await new Promise<number>((resolve, reject) => {
        request({ host: '127.0.0.1', port, path: '/health/live', agent }, (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        }).on('error', reject).end();
      });
      assert.equal(status, 200);

      const exits: number[] = [];
      let poolEnded = false;
      const shutdown = createShutdown({
        server,
        pool: fakePool(async () => {
          poolEnded = true;
        }),
        exit: (code) => { exits.push(code); },
        timeoutMs: 5_000,
      });
      const started = Date.now();
      await shutdown('SIGTERM');

      assert.ok(Date.now() - started < 2_000, 'idle keep-alive connections must not delay shutdown');
      assert.equal(poolEnded, true);
      assert.deepEqual(exits, [0]);
    } finally {
      agent.destroy();
    }
  });
  it('lets an in-flight request on a keep-alive connection finish, then closes quickly and exits 0', async () => {
    let handlerStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    let releaseWrite: () => void = () => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let written = false;
    const slowApp = express();
    slowApp.get('/ping', (_request, response) => {
      response.status(200).send('pong');
    });
    slowApp.get('/slow', async (_request, response) => {
      handlerStarted();
      await writeGate; // stands in for the database write
      written = true;
      response.status(200).send('stored');
    });

    const server = await startServer({ app: slowApp, host: '127.0.0.1', port: 0 });
    const { port } = server.address() as AddressInfo;
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const get = (path: string) => new Promise<{ status: number; body: string; response: IncomingMessage }>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path, agent }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body, response }));
      }).on('error', reject).end();
    });

    try {
      // Establish the keep-alive connection, then reuse it for the slow request.
      assert.equal((await get('/ping')).body, 'pong');
      const slow = get('/slow');
      await started;

      const exits: number[] = [];
      let poolEnded = false;
      const shutdown = createShutdown({
        server,
        pool: fakePool(async () => {
          poolEnded = true;
        }),
        exit: (code) => { exits.push(code); },
        timeoutMs: 20_000,
        graceMs: 15_000,
        idleSweepMs: 20,
      });
      const begin = Date.now();
      const shuttingDown = shutdown('SIGTERM');

      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(exits, [], 'shutdown must wait for the in-flight request');
      assert.equal(poolEnded, false, 'the pool must stay open while a request is in flight');

      releaseWrite();
      const result = await slow;
      assert.equal(result.status, 200);
      assert.equal(result.body, 'stored');
      assert.equal(written, true);

      await shuttingDown;
      assert.ok(Date.now() - begin < 2_000, `close took ${Date.now() - begin} ms`);
      assert.equal(poolEnded, true);
      assert.deepEqual(exits, [0]);
    } finally {
      agent.destroy();
    }
  });

  it('force-closes a request that never finishes once the grace period is over', async () => {
    let handlerStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const hangingApp = express();
    hangingApp.get('/hang', () => {
      handlerStarted(); // never responds
    });
    const server = await startServer({ app: hangingApp, host: '127.0.0.1', port: 0 });
    const { port } = server.address() as AddressInfo;
    const clientResult = new Promise<string>((resolve) => {
      request({ host: '127.0.0.1', port, path: '/hang', agent: false }, () => resolve('response'))
        .on('error', () => resolve('connection-error'))
        .end();
    });
    await started;

    const exits: number[] = [];
    const before = activeTimers();
    const begin = Date.now();
    await createShutdown({
      server,
      pool: fakePool(async () => undefined),
      exit: (code) => { exits.push(code); },
      graceMs: 200,
      timeoutMs: 5_000,
      idleSweepMs: 20,
    })('SIGTERM');

    assert.equal(await clientResult, 'connection-error');
    assert.ok(Date.now() - begin >= 150, 'must wait for the grace period first');
    assert.ok(Date.now() - begin < 2_000, `forced close took ${Date.now() - begin} ms`);
    assert.deepEqual(exits, [0]);
    assert.ok(activeTimers() <= before, 'no timers left behind');
  });
});
