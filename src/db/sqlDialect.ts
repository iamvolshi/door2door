/**
 * The one place the platform's SQL changes shape between storage engines.
 *
 * The schema and every repository are written once, in the dialect SQLite speaks, and the
 * PostgreSQL driver translates each statement on its way out. Keeping the canon in one place
 * is deliberate: two hand-maintained copies of a growing schema drift, and the copy nobody
 * runs is the one that rots. What the translation has to preserve is not syntax but
 * *semantics* — the same values in the same columns under the same comparisons, arriving as
 * the same row shapes — so every rule below is written with the SQLite behaviour it matches.
 *
 * The rules, in the order they run and for the reason they run in that order:
 *
 * 1. `?` becomes `$1`, `$2`, … in the order the parameters are bound.
 * 2. `x COLLATE NOCASE` becomes `lower(x)` — before identifiers are quoted, so the `x` the
 *    rule finds is still bare.
 * 3. Every mixed-case identifier is quoted. This is the rule the port actually turns on:
 *    PostgreSQL folds an unquoted identifier to lower case, so `sessionId` would be stored as
 *    `sessionid` and `SELECT *` would hand the application a row whose key is `sessionid` —
 *    `row.sessionId` undefined, `Boolean(undefined)` false, and every camelCase field in the
 *    platform silently blank. Quoting both the DDL and the statements keeps the spelling
 *    SQLite preserves, on the column and in the row that comes back. All-caps SQL keywords
 *    and all-lowercase names are left alone, and SQL keywords in this canon are never written
 *    in mixed case, so nothing has to be told apart from anything else.
 * 4. DDL only: type keywords are widened to their PostgreSQL equivalents and text columns are
 *    pinned to the `"C"` collation, which is what SQLite's default BINARY collation compares
 *    like. `ADD COLUMN` becomes `ADD COLUMN IF NOT EXISTS`, because migrations re-run.
 *
 * Anything inside a string, a quoted identifier, a comment or a dollar-quoted body is left
 * exactly as it is: a `?` in an endpoint is text, and `'[redacted]'` is a value.
 */

import { AppError } from '../core/errors.js';

/**
 * Type keywords. `INTEGER` covers every integer column in the schema, including the ones
 * holding epoch milliseconds and the ones standing in for booleans; `BIGINT` keeps the 64-bit
 * width SQLite gives `INTEGER`, and the driver reads it back as a number so row shapes do not
 * change between engines.
 */
const DDL_TYPES: ReadonlyArray<readonly [RegExp, string]> = [
  // `"C"` and not the database default: SQLite compares and orders TEXT byte-wise, and ids,
  // ISO timestamps and token digests are all compared that way. A locale collation would make
  // `'2026-1' < '2026-10'` depend on the server's locale instead of on the bytes. The
  // lookahead keeps the rule idempotent: a column that already carries a collation keeps it.
  [/\bTEXT\b(?!\s+COLLATE\b)/gi, 'TEXT COLLATE "C"'],
  [/\bINTEGER\b/gi, 'BIGINT'],
  [/\bREAL\b/gi, 'DOUBLE PRECISION']
];

/** `x COLLATE NOCASE` — SQLite's ASCII-case-insensitive collation, spelled as `lower(x)`. */
const COLLATE_NOCASE = /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s+COLLATE\s+NOCASE\b/gi;

/** `ADD COLUMN` is not idempotent in PostgreSQL unless it says so; migrations must re-run. */
const ADD_COLUMN = /\b(ALTER\s+TABLE\s+[A-Za-z0-9_"]+\s+ADD\s+COLUMN\s+)(?!IF\s+NOT\s+EXISTS\b)/gi;

/** An identifier: a letter or underscore, then letters, digits or underscores. */
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/** A statement that creates or alters an object, and so carries column types. */
function isDdl(sql: string): boolean {
  return /^\s*(CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)|ALTER\s+TABLE|DROP\s+TABLE)\b/i.test(sql);
}

/** True for a token with both cases in it — the spelling PostgreSQL would fold away. */
function isMixedCase(token: string): boolean {
  return /[a-z]/.test(token) && /[A-Z]/.test(token);
}

function readQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      // A doubled quote is an escaped one, and the literal continues.
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

/**
 * Applies `rewrite` to the parts of a statement that are code, and copies everything else —
 * string literals, quoted identifiers, comments, dollar-quoted bodies — through untouched.
 *
 * One scanner for every rule rather than a regular expression per rule, because the rules
 * disagree about what a `?` or a word means depending on where it sits, and only a scan knows
 * that.
 */
function rewriteCode(sql: string, rewrite: (code: string) => string): string {
  let out = '';
  let index = 0;
  let codeStart = 0;

  const flush = (end: number): void => {
    if (end > codeStart) out += rewrite(sql.slice(codeStart, end));
  };

  while (index < sql.length) {
    const char = sql[index];
    let literalEnd = index;

    if (char === "'" || char === '"') {
      literalEnd = readQuoted(sql, index, char);
    } else if (char === '-' && sql[index + 1] === '-') {
      const newline = sql.indexOf('\n', index);
      literalEnd = newline === -1 ? sql.length : newline;
    } else if (char === '/' && sql[index + 1] === '*') {
      const close = sql.indexOf('*/', index + 2);
      literalEnd = close === -1 ? sql.length : close + 2;
    } else if (char === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(index));
      if (tag) {
        const close = sql.indexOf(tag[0], index + tag[0].length);
        literalEnd = close === -1 ? sql.length : close + tag[0].length;
      }
    }

    if (literalEnd > index) {
      flush(index);
      out += sql.slice(index, literalEnd);
      index = literalEnd;
      codeStart = literalEnd;
      continue;
    }

    index += 1;
  }

  flush(sql.length);
  return out;
}

/** Rewrites position placeholders into the numbered ones PostgreSQL uses. */
export function toNumberedPlaceholders(sql: string): string {
  let next = 1;
  return rewriteCode(sql, (code) => code.replace(/\?/g, () => `$${next++}`));
}

/** Quotes every mixed-case identifier, so the spelling survives PostgreSQL's folding. */
export function quoteMixedCaseIdentifiers(sql: string): string {
  return rewriteCode(sql, (code) =>
    code.replace(IDENTIFIER, (token) => (isMixedCase(token) ? `"${token}"` : token))
  );
}

/**
 * Translates one statement written for SQLite into the PostgreSQL spelling of the same
 * request. Pure and total: it either answers a statement or throws, so a failure surfaces as a
 * database error naming the statement rather than as a silently dropped clause.
 */
export function toPostgres(sql: string): string {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new AppError('Cannot translate an empty SQL statement', 500, 'SQL_TRANSLATION_ERROR');
  }

  const ddl = isDdl(sql);

  let translated = toNumberedPlaceholders(sql);
  // `NOCASE` has no counterpart in PostgreSQL; `lower(…)` is the case-insensitive form of the
  // same comparison, and every use in the canon is an ordering key, where the two agree: under
  // the `"C"` collation `lower()` folds exactly the ASCII range SQLite's NOCASE folds.
  translated = rewriteCode(translated, (code) => code.replace(COLLATE_NOCASE, 'lower($1)'));
  translated = quoteMixedCaseIdentifiers(translated);

  if (ddl) {
    for (const [pattern, replacement] of DDL_TYPES) {
      translated = translated.replace(pattern, replacement);
    }
    translated = translated.replace(ADD_COLUMN, '$1IF NOT EXISTS ');
  }

  return translated;
}

/**
 * Parameters as both drivers want them on the wire.
 *
 * SQLite has no boolean type and no `undefined`, and PostgreSQL will not accept either as a
 * bind value, so the same normalisation serves both: `true`/`false` become `1`/`0` (matching
 * the integer columns that stand in for booleans), `undefined` becomes `NULL`, and anything
 * else is JSON-encoded rather than sent as a type neither engine knows.
 */
export function toStorageParams(params: readonly unknown[]): Array<null | number | string | bigint | Uint8Array> {
  return params.map((param) => {
    if (param === null || param === undefined) return null;
    if (typeof param === 'boolean') return param ? 1 : 0;
    if (typeof param === 'number' || typeof param === 'string' || typeof param === 'bigint') {
      return param;
    }
    if (param instanceof Uint8Array) return param;
    return JSON.stringify(param) ?? String(param);
  });
}
