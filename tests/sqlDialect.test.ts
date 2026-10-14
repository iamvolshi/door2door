import { describe, expect, it } from 'vitest';
import { toPostgres, toStorageParams } from '../src/db/sqlDialect';
import { DDL_STATEMENTS, MIGRATION_STATEMENTS } from '../src/db/schema';

/**
 * The translation is the whole interface between the SQL this platform is written in and the
 * one PostgreSQL understands, so it is tested as a contract rather than through the driver:
 * every statement the schema and the repositories actually contain, plus the shapes a future
 * one might take (a `?` inside a literal, a value that is not a scalar).
 */
describe('SQLite statements translated for PostgreSQL', () => {
  it('numbers placeholders in the order they are bound', () => {
    expect(toPostgres(`SELECT * FROM auth_sessions WHERE id = ? AND userId = ?`)).toBe(
      'SELECT * FROM auth_sessions WHERE id = $1 AND "userId" = $2'
    );
  });

  it('numbers a placeholder that repeats, which is what makes a full scan unnecessary', () => {
    expect(
      toPostgres(
        `UPDATE auth_sessions SET replacedBy = ?, isRevoked = ? WHERE tokenHash = ? AND isRevoked = ?`
      )
    ).toBe(
      'UPDATE auth_sessions SET "replacedBy" = $1, "isRevoked" = $2 WHERE "tokenHash" = $3 AND "isRevoked" = $4'
    );
  });

  it('quotes every mixed-case identifier, which is what keeps row keys as SQLite spells them', () => {
    // Left unquoted, PostgreSQL folds these to `sessionid` / `isrevoked`, and the application
    // reads `row.sessionId` as undefined: `Boolean(undefined)` is false, so an active session
    // would look revoked and an active account would look suspended.
    expect(
      toPostgres(
        `SELECT sessionId, isRevoked, windowStart FROM auth_sessions WHERE id = ? ORDER BY createdAt`
      )
    ).toBe(
      'SELECT "sessionId", "isRevoked", "windowStart" FROM auth_sessions WHERE id = $1 ORDER BY "createdAt"'
    );
    // A qualified name keeps its qualification, and a lowercase one is left bare.
    expect(toPostgres(`SELECT excluded.orderId, notes FROM refunds`)).toBe(
      'SELECT excluded."orderId", notes FROM refunds'
    );
    // SQL keywords this canon writes in upper case are never mistaken for identifiers.
    expect(toPostgres(`SELECT 1 FROM users WHERE id <> ?`)).toBe('SELECT 1 FROM users WHERE id <> $1');
  });

  it('leaves a question mark inside a literal alone', () => {
    // The endpoint is part of an idempotency key, so a `?` in it is text, not a bind marker.
    expect(toPostgres(`SELECT id FROM idempotency_keys WHERE endpoint = ? AND action = 'paid?'`)).toBe(
      "SELECT id FROM idempotency_keys WHERE endpoint = $1 AND action = 'paid?'"
    );
  });

  it('leaves a doubled quote and a dollar-quoted body alone', () => {
    expect(toPostgres(`SELECT 'it''s ? that' AS x FROM users WHERE id = ?`)).toBe(
      `SELECT 'it''s ? that' AS x FROM users WHERE id = $1`
    );
    expect(toPostgres(`SELECT $$a body with ? in it$$ AS x FROM users WHERE id = ?`)).toBe(
      `SELECT $$a body with ? in it$$ AS x FROM users WHERE id = $1`
    );
  });

  it('widens integer columns and keeps text comparisons byte-wise', () => {
    const translated = toPostgres(
      `CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, hits INTEGER NOT NULL, latitude REAL)`
    );
    // `BIGINT` keeps SQLite's 64-bit width, and every value is parsed back as a number, so a
    // row read from PostgreSQL has the same shape as one read from SQLite.
    expect(translated).toContain('hits BIGINT NOT NULL');
    expect(translated).toContain('latitude DOUBLE PRECISION');
    // SQLite's default collation is BINARY, so ids, ISO timestamps and token digests compare
    // byte-wise; a locale collation on the server would silently change that ordering.
    expect(translated).toContain('id TEXT COLLATE "C" PRIMARY KEY');
  });

  it('spells a case-insensitive ordering the way PostgreSQL can', () => {
    expect(toPostgres(`SELECT * FROM catalog_items ORDER BY name COLLATE NOCASE, id`)).toBe(
      'SELECT * FROM catalog_items ORDER BY lower(name), id'
    );
    // The column the ordering folds is quoted by the rule that runs after this one.
    expect(toPostgres(`SELECT * FROM users ORDER BY fullName COLLATE NOCASE, id`)).toBe(
      'SELECT * FROM users ORDER BY lower("fullName"), id'
    );
  });

  it('makes a migration idempotent instead of failing on a column that is already there', () => {
    expect(toPostgres(`ALTER TABLE audit_logs ADD COLUMN sessionId TEXT`)).toBe(
      'ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "sessionId" TEXT COLLATE "C"'
    );
    // Translating an already-translated statement must not double the clause.
    const once = toPostgres(`ALTER TABLE users ADD COLUMN reviewedBy TEXT`);
    expect(toPostgres(once)).toBe(once);
  });

  it('does not rewrite a word that merely contains a type keyword', () => {
    expect(toPostgres(`SELECT id FROM t WHERE textSearch = ?`)).toBe(
      'SELECT id FROM t WHERE "textSearch" = $1'
    );
  });

  it('keeps the counter upsert a single statement, which is what makes it race-free', () => {
    const translated = toPostgres(
      `INSERT INTO request_rate_limits (key, windowStart, hits, sessionId)
       VALUES (?, ?, 1, NULL)
       ON CONFLICT(key) DO UPDATE SET hits = request_rate_limits.hits + 1
       RETURNING hits, windowStart, sessionId`
    );
    expect(translated).toContain('VALUES ($1, $2, 1, NULL)');
    expect(translated).toContain('ON CONFLICT(key) DO UPDATE SET');
    expect(translated).toContain('RETURNING hits, "windowStart", "sessionId"');
    expect(translated.match(/;/g)).toBeNull();
  });

  it('translates every statement the schema ships, with nothing left to bind by position', () => {
    for (const statement of [...DDL_STATEMENTS, ...MIGRATION_STATEMENTS]) {
      const translated = toPostgres(statement);
      expect(translated, statement.slice(0, 60)).not.toContain('?');
      expect(translated, statement.slice(0, 60)).not.toMatch(/\bREAL\b/);
      expect(translated, statement.slice(0, 60)).not.toMatch(/\bINTEGER\b/);
      // No table may be created without its text columns pinned to the byte-wise collation.
      if (/CREATE\s+TABLE/i.test(statement)) {
        expect(translated, statement.slice(0, 60)).toContain('COLLATE "C"');
      }
      if (/ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN/i.test(statement)) {
        expect(translated, statement.slice(0, 60)).toContain('ADD COLUMN IF NOT EXISTS');
      }
    }
  });

  it('binds the same values on both engines', () => {
    // SQLite has no boolean type and PostgreSQL will not accept `undefined`; the same
    // normalisation is what keeps `isRevoked` an integer on the way in for both.
    expect(toStorageParams([true, false, undefined, null, 7, 'x', 12n, new Uint8Array([1])])).toEqual([
      1,
      0,
      null,
      null,
      7,
      'x',
      12n,
      new Uint8Array([1])
    ]);
    // A structured value becomes JSON rather than an object neither engine knows how to bind.
    expect(toStorageParams([{ a: 1 }])).toEqual(['{"a":1}']);
  });

  it('refuses to translate nothing rather than sending an empty statement', () => {
    expect(() => toPostgres('   ')).toThrow(/empty SQL statement/);
  });
});
