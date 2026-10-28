import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

const entry = fileURLToPath(new URL('./server.ts', import.meta.url));
const projectRoot = path.resolve(path.dirname(entry), '..');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  it(`the real entry point exits 0 promptly on ${signal} (the pool connects lazily, so no database is needed)`, async () => {
    const port = await freePort();
    // Minimal env on purpose: nothing from the parent leaks in.
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH ?? '',
        PORT: String(port),
        HOST: '127.0.0.1',
        DATABASE_URL: 'postgresql://sig:fake@127.0.0.1:1/never_connected',
        META_VERIFY_TOKEN: 'fake-verify-token',
        META_APP_SECRET: 'fake-app-secret',
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 15_000);
        child.stdout.on('data', () => {
          if (output.includes('Listening on')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once('close', () => reject(new Error(`server exited early: ${output}`)));
      });

      const health = await fetch(`http://127.0.0.1:${port}/health/live`);
      assert.equal(health.status, 200);

      const webhook = await fetch(
        `http://127.0.0.1:${port}/webhooks/meta?hub.mode=subscribe&hub.verify_token=fake-verify-token&hub.challenge=abc`,
      );
      assert.equal(webhook.status, 200);
      assert.equal(await webhook.text(), 'abc');

      const reply = await fetch(
        `http://127.0.0.1:${port}/api/events/00000000-0000-4000-8000-000000000001/replies`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer not-configured' },
          body: JSON.stringify({ text: 'should-not-echo', idempotencyKey: 'idem-key-1' }),
        },
      );
      assert.equal(reply.status, 401);
      assert.equal((await reply.text()).includes('should-not-echo'), false);

      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('close', (code, sig) => resolve({ code, signal: sig }));
      });
      const started = Date.now();
      child.kill(signal);
      const result = await closed;

      assert.deepEqual(result, { code: 0, signal: null });
      assert.ok(Date.now() - started < 5_000, 'shutdown must not wait for the 10 s hard timeout');
    } finally {
      child.kill('SIGKILL');
    }
  });
}
