import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

const cli = fileURLToPath(new URL('./migrate-cli.ts', import.meta.url));
const projectRoot = path.resolve(path.dirname(cli), '..', '..');

function runCli(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    // Minimal env on purpose: nothing from the parent (e.g. TEST_DATABASE_URL) leaks in.
    const child = spawn(process.execPath, ['--import', 'tsx', cli], {
      cwd: projectRoot,
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

it('exits non-zero and names DATABASE_URL when it is not set', async () => {
  const { code, output } = await runCli({});

  assert.notEqual(code, 0);
  assert.match(output, /DATABASE_URL/);
});

it('exits non-zero on connection failure without leaking the connection string', async () => {
  const { code, output } = await runCli({
    DATABASE_URL: 'postgresql://sig_user:hunter2@127.0.0.1:1/never_connected',
  });

  assert.notEqual(code, 0);
  assert.match(output, /Database migration failed/);
  assert.doesNotMatch(output, /hunter2/);
  assert.doesNotMatch(output, /postgresql:\/\//);
  assert.doesNotMatch(output, /ECONNREFUSED/);
  assert.doesNotMatch(output, /\n\s+at /);
});
