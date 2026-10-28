// Copies the SQL migrations next to the compiled code so that
// `node dist/db/migrate-cli.js` finds them (migrate.ts resolves its directory
// relative to import.meta.url). Run by `npm run build` (postbuild).
import { cpSync, mkdirSync, readdirSync } from 'node:fs';

const source = 'src/db/migrations';
const target = 'dist/db/migrations';

mkdirSync(target, { recursive: true });

const files = readdirSync(source).filter((name) => name.endsWith('.sql'));

if (files.length === 0) {
  console.error(`error: no .sql files found in ${source}`);
  process.exit(1);
}

for (const name of files) {
  cpSync(`${source}/${name}`, `${target}/${name}`);
}

console.log(`Copied ${files.length} migration file(s) to ${target}`);
