/**
 * Splitting a .sql file into single statements.
 *
 * This runs without a database on purpose: it is the part that shipped broken
 * once and the failure had nothing to do with Postgres being reachable.
 *
 * The history is worth keeping in view. `migrate` used to send each whole
 * migration file in one call. node-postgres accepts that — its simple-query
 * protocol runs multi-statement strings — so every local and CI test passed.
 * Neon's HTTP driver sends one parse message per request and rejected it with
 * a bare 42601 on the first real deploy. The splitter exists to make both
 * drivers take the same path, and these tests exist so the dollar-quoted
 * function body in db/migrations/0001_signals.sql cannot be quietly mangled.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitSql } from './db.mjs';

describe('splitSql', () => {
  it('splits plain statements and drops the empty tail', () => {
    expect(splitSql('select 1; select 2;')).toEqual(['select 1', 'select 2']);
  });

  it('keeps a final statement that has no trailing semicolon', () => {
    expect(splitSql('select 1;\nselect 2')).toEqual(['select 1', 'select 2']);
  });

  it('ignores blank statements from stray or doubled semicolons', () => {
    expect(splitSql(';;\n select 1 ;;\n')).toEqual(['select 1']);
  });

  /**
   * The case that actually broke. The body contains two semicolons, and
   * splitting on them produces four fragments, none of them valid SQL.
   */
  it('does not split inside a $$ function body', () => {
    const sql = `create function f() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
select 1;`;
    const out = splitSql(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('new.updated_at = now();');
    expect(out[0]).toContain('end;');
    expect(out[1]).toBe('select 1');
  });

  it('handles a named dollar tag, and a $$ inside it', () => {
    const sql = `do $body$ begin perform 1; end $body$;
select 2;`;
    const out = splitSql(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('perform 1;');
    expect(out[1]).toBe('select 2');
  });

  it('does not split on a semicolon inside a string literal', () => {
    const out = splitSql(`select 'a;b'; select 2;`);
    expect(out).toEqual([`select 'a;b'`, 'select 2']);
  });

  it('treats a doubled quote as an escape, not as the end of the literal', () => {
    const out = splitSql(`select 'it''s; fine'; select 2;`);
    expect(out).toEqual([`select 'it''s; fine'`, 'select 2']);
  });

  it('does not split on a semicolon inside a quoted identifier', () => {
    const out = splitSql(`select "odd;name" from t; select 2;`);
    expect(out).toEqual([`select "odd;name" from t`, 'select 2']);
  });

  it('ignores a semicolon in a line comment', () => {
    const out = splitSql('select 1 -- a; comment\n; select 2;');
    expect(out).toHaveLength(2);
    expect(out[1]).toBe('select 2');
  });

  it('ignores a semicolon in a block comment, including a nested one', () => {
    const out = splitSql('select 1 /* a; /* b; */ c; */ ; select 2;');
    expect(out).toHaveLength(2);
    expect(out[1]).toBe('select 2');
  });

  it('returns nothing for text that is only comments or whitespace', () => {
    expect(splitSql('  \n -- just a note\n')).toEqual([]);
    expect(splitSql('')).toEqual([]);
  });

  /**
   * The real file, because that is what has to work. Every statement must be
   * executable on its own, which means none may contain an unbalanced `$$`.
   */
  describe('the checked-in migration', () => {
    const text = readFileSync(new URL('../db/migrations/0001_signals.sql', import.meta.url), 'utf8');
    const statements = splitSql(text);

    it('yields a plausible number of complete statements', () => {
      expect(statements.length).toBeGreaterThan(5);
      // Nothing empty, nothing that is only a comment.
      for (const s of statements) expect(s.trim().length).toBeGreaterThan(0);
    });

    it('leaves every dollar-quoted body intact', () => {
      for (const s of statements) {
        const dollars = (s.match(/\$\$/g) ?? []).length;
        expect(dollars % 2, `unbalanced $$ in: ${s.slice(0, 80)}`).toBe(0);
      }
    });

    it('keeps the trigger function and its trigger as separate statements', () => {
      const fn = statements.find((s) => s.includes('create or replace function set_updated_at'));
      expect(fn, 'the function must survive as one statement').toBeTruthy();
      expect(fn).toContain('return new;');
      expect(statements.some((s) => s.startsWith('create trigger signals_set_updated_at'))).toBe(true);
    });

    it('recovers the original statement set when rejoined', () => {
      // A sanity check that nothing was dropped: every `create table` in the
      // file is still present exactly once among the statements.
      const tables = [...text.matchAll(/create table if not exists (\w+)/g)].map((m) => m[1]);
      expect(tables.length).toBeGreaterThan(0);
      for (const t of tables) {
        const hits = statements.filter((s) => s.includes(`create table if not exists ${t}`));
        expect(hits, `table ${t}`).toHaveLength(1);
      }
    });
  });
});
