export interface SerializedError {
  code: string;
  message: string;
  statusCode: number;
  details?: Record<string, unknown> | Array<unknown>;
  timestamp: string;
  stack?: string;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  public readonly details?: Record<string, unknown> | Array<unknown>;
  public readonly timestamp: string;

  constructor(
    message: string,
    statusCode = 500,
    code = 'INTERNAL_ERROR',
    isOperational = true,
    details?: Record<string, unknown> | Array<unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.details = details;
    this.timestamp = new Date().toISOString();
    Error.captureStackTrace(this, this.constructor);
  }

  public toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details,
      timestamp: this.timestamp
    };
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: Record<string, unknown> | Array<unknown>) {
    super(message, 400, 'VALIDATION_ERROR', true, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized access', details?: Record<string, unknown>) {
    super(message, 401, 'UNAUTHORIZED', true, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden action', details?: Record<string, unknown>) {
    super(message, 403, 'FORBIDDEN', true, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource', details?: Record<string, unknown>) {
    super(`${resource} not found`, 404, 'NOT_FOUND', true, details);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource conflict occurred', details?: Record<string, unknown>) {
    super(message, 409, 'CONFLICT', true, details);
  }
}

/**
 * A refresh token that had already been rotated or revoked was presented again. The whole
 * token family is revoked in response, so the client has to sign in again.
 */
export class TokenReuseError extends AppError {
  constructor(
    message = 'This refresh token was already used, so every session for that login has been revoked',
    details?: Record<string, unknown>
  ) {
    super(message, 401, 'REFRESH_TOKEN_REUSE', true, details);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests, please slow down', details?: Record<string, unknown>) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED', true, details);
  }
}

/**
 * A write that broke a uniqueness invariant — a phone claimed twice, a second completed
 * payment for one order, a login code inserted by two concurrent logins.
 *
 * Recognised for both storage engines, because the caller is answering the same question in
 * both cases and the two engines disagree about how to say it: SQLite reports a message
 * (`UNIQUE constraint failed: …`) and PostgreSQL reports a SQLSTATE (`23505`). Reading the
 * code where there is one keeps this from depending on a message a server version can change.
 */
export function isUniqueViolationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as { code?: unknown }).code === '23505') return true;
  return /UNIQUE constraint failed|duplicate key value violates unique constraint/i.test(error.message);
}

/**
 * A migration that tried to add a column the database already has. Expected on every boot
 * after the first, so `migrate()` treats it as "already applied" rather than as a fault.
 */
export function isDuplicateColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as { code?: unknown }).code === '42701') return true;
  return /duplicate column name/i.test(error.message);
}

/**
 * A table or index that two processes booting at the same instant both tried to create.
 * PostgreSQL refuses the loser with `42P07`/`42710` rather than making it a no-op, and the
 * object that was wanted exists either way.
 */
export function isDuplicateObjectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === '42P07' || code === '42710' || /already exists/i.test(error.message);
}

/**
 * The database is contended rather than broken: SQLite's write lock, an announced deadlock, or
 * a lock a statement was not willing to wait for. Worth retrying; a schema fault is not.
 */
export function isDatabaseBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === '40P01' ||
    code === '55P03' ||
    /database is locked|SQLITE_BUSY/i.test(error.message)
  );
}

export function serializeError(error: unknown, includeStack = false): SerializedError {
  if (error instanceof AppError) {
    const json = error.toJSON();
    if (includeStack && error.stack) {
      json.stack = error.stack;
    }
    return json;
  }

  if (error instanceof Error) {
    return {
      code: 'UNHANDLED_EXCEPTION',
      message: error.message,
      statusCode: 500,
      timestamp: new Date().toISOString(),
      ...(includeStack && error.stack ? { stack: error.stack } : {})
    };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: typeof error === 'string' ? error : 'An unexpected error occurred',
    statusCode: 500,
    timestamp: new Date().toISOString()
  };
}