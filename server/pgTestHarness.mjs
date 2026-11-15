/**
 * TEST-ONLY. A real PostgreSQL connection for the database tests.
 *
 * Nothing in the app imports this; it is here rather than inside one test
 * file because two test files need it and must not collide.
 *
 * WHY EACH FILE GETS ITS OWN SCHEMA
 * ─────────────────────────────────
 * Vitest runs test FILES in parallel workers. db.test.mjs and
 * scanner.e2e.test.mjs both create the same tables and both truncate between
 * tests, so sharing one schema means each file keeps deleting the other's
 * rows — producing failures that look like product bugs, move around between
 * runs, and vanish when either file is run on its own. That is a far worse
 * outcome than a slow suite, so each file gets a private schema and they stay
 * parallel.
 *
 * `search_path` is set on the connection, and db.mjs writes unqualified table
 * names, so its SQL is unchanged — which is the point: the tests must
 * exercise the statements production sends, not rewritten ones.
 */

/**
 * neon()'s interface, over node-postgres.
 *
 * neon() passes interpolated values as bind parameters rather than as text,
 * so this does too. Building SQL by concatenation here would test a query
 * shape the production driver never sends.
 */
export function pgDriver(pool) {
  const tagged = (strings, ...values) => {
    const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '');
    return pool.query(text, values).then((r) => r.rows);
  };
  tagged.query = (text, params = []) => pool.query(text, params).then((r) => r.rows);
  return tagged;
}

/**
 * A pool scoped to its own schema, dropped and recreated so every run starts
 * from nothing — which is also what proves the migration BUILDS the schema
 * rather than finding one already there.
 */
export async function createSchemaPool(connectionString, schema) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`unsafe schema name: ${schema}`);
  const { default: pg } = await import('pg');

  // A separate connection to do the dropping: the scoped pool's own
  // search_path would point at a schema that does not exist yet.
  const admin = new pg.Pool({ connectionString });
  try {
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.query(`create schema ${schema}`);
  } finally {
    await admin.end();
  }

  return new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
}
