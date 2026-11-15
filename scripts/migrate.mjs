/**
 * Apply db/migrations/*.sql to the Neon database in DATABASE_URL.
 *
 *   npm run migrate
 *
 * Safe to run repeatedly: every file is idempotent on its own, and applied
 * names are recorded in schema_migrations so a second run does nothing.
 *
 * This is a script rather than something the scanner does on boot. A
 * serverless function that migrates on cold start runs the migration from
 * every instance at once, which is a race for no benefit — the schema changes
 * when a person deploys one, not when traffic arrives.
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isConfigured, migrate } from '../server/db.mjs';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

/**
 * No database is a SKIP, not a failure, because this also runs in the build.
 *
 * The signal history is an addition to the app, not a prerequisite for it:
 * local builds, preview deployments and any deployment made before a database
 * was attached must all still build and serve the live scanner.
 *
 * What must NOT be silent is a migration that fails once there IS a database.
 * That would ship an app whose queries name columns the schema does not have,
 * so everything below this point is fatal and takes the build down with it.
 */
if (!isConfigured()) {
  console.log('migrate: no DATABASE_URL — skipping. The signal history is simply not configured yet.');
  process.exit(0);
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort() // 0001_, 0002_, … — order is the filename's job
  .map((name) => ({ name, text: readFileSync(path.join(dir, name), 'utf8') }));

const ran = await migrate(files);
console.log(ran.length === 0 ? 'Already up to date.' : `Applied: ${ran.join(', ')}`);
