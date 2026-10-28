import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { createPool } from './pool.js';
import { defaultMigrationsDir, listMigrationFiles, runMigrations } from './migrate.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const skipReason = databaseUrl
  ? false
  : 'TEST_DATABASE_URL is not set; skipping PostgreSQL integration tests for the migration runner';

async function makeDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sig-migrate-'));
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith('/')) {
      await mkdir(path.join(dir, name));
    } else {
      await writeFile(path.join(dir, name), content);
    }
  }
  return dir;
}

describe('listMigrationFiles (directory scan, no database)', () => {
  it('returns only *.sql files in lexical order', async () => {
    const dir = await makeDir({
      '010_later.sql': 'SELECT 1;',
      '002_second.sql': 'SELECT 1;',
      '001_first.sql': 'SELECT 1;',
      'README.md': 'x',
      'notes.txt': 'x',
      '003_swp.sql.bak': 'x',
      'archive.sql/': '',
    });

    try {
      assert.deepEqual(await listMigrationFiles(dir), [
        '001_first.sql',
        '002_second.sql',
        '010_later.sql',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty list for an empty directory', async () => {
    const dir = await makeDir({});

    try {
      assert.deepEqual(await listMigrationFiles(dir), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly when the directory does not exist', async () => {
    await assert.rejects(listMigrationFiles(path.join(tmpdir(), `sig-missing-${randomUUID()}`)));
  });

  it('resolves the default directory to the bundled migrations including 001_initial.sql', async () => {
    assert.ok((await readdir(defaultMigrationsDir())).includes('001_initial.sql'));
    assert.ok((await listMigrationFiles(defaultMigrationsDir())).includes('001_initial.sql'));
  });

  it('resolves the default directory to the bundled migrations including 002_normalized_events.sql', async () => {
    assert.ok((await readdir(defaultMigrationsDir())).includes('002_normalized_events.sql'));
    assert.ok((await listMigrationFiles(defaultMigrationsDir())).includes('002_normalized_events.sql'));
  });

  it('resolves the default directory to the bundled migrations including 003_outbound_replies.sql', async () => {
    assert.ok((await readdir(defaultMigrationsDir())).includes('003_outbound_replies.sql'));
    assert.ok((await listMigrationFiles(defaultMigrationsDir())).includes('003_outbound_replies.sql'));
  });
});

describe('runMigrations (PostgreSQL integration)', { skip: skipReason }, () => {
  let admin: Pool;
  const schemas: string[] = [];

  /** A pool whose connections all live in a private schema, so runs are isolated. */
  async function isolatedPool(schema: string): Promise<Pool> {
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      options: `-c search_path=${schema}`,
    });
    return pool;
  }

  async function newSchema(): Promise<string> {
    const schema = `sig_mig_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    schemas.push(schema);
    return schema;
  }

  before(() => {
    admin = createPool(databaseUrl as string);
  });

  after(async () => {
    for (const schema of schemas) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
    await admin.end();
  });

  it('applies files in lexical order and records their names', async () => {
    const schema = await newSchema();
    const pool = await isolatedPool(schema);
    const dir = await makeDir({
      '002_b.sql': 'INSERT INTO order_log (n) VALUES (2);',
      '001_a.sql': 'CREATE TABLE order_log (seq serial PRIMARY KEY, n int NOT NULL);\nINSERT INTO order_log (n) VALUES (1);',
      '003_c.sql': 'INSERT INTO order_log (n) VALUES (3);',
    });

    try {
      const applied = await runMigrations(pool, dir);
      assert.deepEqual(applied, ['001_a.sql', '002_b.sql', '003_c.sql']);

      const rows = await pool.query('SELECT n FROM order_log ORDER BY seq');
      assert.deepEqual(rows.rows.map((row) => row.n), [1, 2, 3]);

      const recorded = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
      assert.deepEqual(recorded.rows.map((row) => row.name), ['001_a.sql', '002_b.sql', '003_c.sql']);
    } finally {
      await pool.end();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: a second run applies nothing, a new file applies only itself', async () => {
    const schema = await newSchema();
    const pool = await isolatedPool(schema);
    const dir = await makeDir({
      '001_a.sql': 'CREATE TABLE counter (n int NOT NULL);\nINSERT INTO counter VALUES (1);',
    });

    try {
      assert.deepEqual(await runMigrations(pool, dir), ['001_a.sql']);
      assert.deepEqual(await runMigrations(pool, dir), []);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM counter')).rows[0].c, 1);

      await writeFile(path.join(dir, '002_b.sql'), 'INSERT INTO counter VALUES (2);');
      assert.deepEqual(await runMigrations(pool, dir), ['002_b.sql']);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM counter')).rows[0].c, 2);
    } finally {
      await pool.end();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rolls back a failing migration, does not record it, keeps earlier ones, and stops', async () => {
    const schema = await newSchema();
    const pool = await isolatedPool(schema);
    const dir = await makeDir({
      '001_ok.sql': 'CREATE TABLE ok_table (id int);',
      '002_bad.sql': 'CREATE TABLE half_table (id int);\nSELECT 1/0;',
      '003_never.sql': 'CREATE TABLE never_table (id int);',
    });

    try {
      await assert.rejects(runMigrations(pool, dir));

      const tables = await pool.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
        [schema],
      );
      assert.deepEqual(tables.rows.map((row) => row.table_name), ['ok_table', 'schema_migrations']);

      const recorded = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
      assert.deepEqual(recorded.rows.map((row) => row.name), ['001_ok.sql']);

      // The advisory lock must have been released: a fixed directory now succeeds.
      await writeFile(path.join(dir, '002_bad.sql'), 'CREATE TABLE half_table (id int);');
      assert.deepEqual(await runMigrations(pool, dir), ['002_bad.sql', '003_never.sql']);
    } finally {
      await pool.end();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not double-apply when concurrent runners start together', async () => {
    const schema = await newSchema();
    const poolA = await isolatedPool(schema);
    const poolB = await isolatedPool(schema);
    const poolC = await isolatedPool(schema);
    const dir = await makeDir({
      // Not idempotent on purpose: a double apply would fail on CREATE TABLE or duplicate the row.
      '001_a.sql': 'CREATE TABLE once (n int NOT NULL);\nSELECT pg_sleep(0.3);\nINSERT INTO once VALUES (1);',
    });

    try {
      const results = await Promise.all([
        runMigrations(poolA, dir),
        runMigrations(poolB, dir),
        runMigrations(poolC, dir),
      ]);

      assert.equal(results.flat().length, 1, 'exactly one runner applies the file');
      assert.equal((await poolA.query('SELECT count(*)::int AS c FROM once')).rows[0].c, 1);
      assert.equal((await poolA.query('SELECT count(*)::int AS c FROM schema_migrations')).rows[0].c, 1);
    } finally {
      await Promise.all([poolA.end(), poolB.end(), poolC.end()]);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('applies the bundled 001_initial.sql and creates webhook_events', async () => {
    const schema = await newSchema();
    const pool = await isolatedPool(schema);

    try {
      assert.ok((await runMigrations(pool)).includes('001_initial.sql'));
      assert.deepEqual(await runMigrations(pool), []);
      const exists = await pool.query("SELECT to_regclass('webhook_events') AS t");
      assert.ok(exists.rows[0].t);
    } finally {
      await pool.end();
    }
  });

  it('applies the bundled migrations on an empty database and creates normalized_events', async () => {
    const schema = await newSchema();
    const pool = await isolatedPool(schema);

    try {
      const applied = await runMigrations(pool);
      assert.ok(applied.includes('002_normalized_events.sql'));
      const exists = await pool.query("SELECT to_regclass('normalized_events') AS t");
      assert.ok(exists.rows[0].t);
    } finally {
      await pool.end();
    }
  });

  it('applies the bundled migrations on an empty database and creates outbound_replies', async () => {
    const schema = await newSchema();
    const pool = await isolatedPool(schema);

    try {
      const applied = await runMigrations(pool);
      assert.ok(applied.includes('003_outbound_replies.sql'));
      const exists = await pool.query("SELECT to_regclass('outbound_replies') AS t");
      assert.ok(exists.rows[0].t);
    } finally {
      await pool.end();
    }
  });
});
