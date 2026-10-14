import { describe, it, expect } from 'vitest';
import {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  serializeError
} from '../src/core/errors';

describe('Domain Errors & Serialization', () => {
  it('creates AppError with correct defaults', () => {
    const err = new AppError('Server error');
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.isOperational).toBe(true);
    expect(err.timestamp).toBeDefined();
  });

  it('instantiates specific domain errors with correct status codes', () => {
    const valErr = new ValidationError('Bad input', { field: 'email' });
    expect(valErr.statusCode).toBe(400);
    expect(valErr.code).toBe('VALIDATION_ERROR');
    expect(valErr.details).toEqual({ field: 'email' });

    const unauth = new UnauthorizedError();
    expect(unauth.statusCode).toBe(401);
    expect(unauth.code).toBe('UNAUTHORIZED');

    const forbidden = new ForbiddenError();
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.code).toBe('FORBIDDEN');

    const notFound = new NotFoundError('Order');
    expect(notFound.statusCode).toBe(404);
    expect(notFound.message).toBe('Order not found');

    const conflict = new ConflictError('Email already registered');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.code).toBe('CONFLICT');

    const rateLimit = new RateLimitError();
    expect(rateLimit.statusCode).toBe(429);
    expect(rateLimit.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('serializes AppError into JSON payload', () => {
    const err = new ValidationError('Invalid phone', [{ path: 'phone', msg: 'required' }]);
    const serialized = serializeError(err);
    expect(serialized.code).toBe('VALIDATION_ERROR');
    expect(serialized.statusCode).toBe(400);
    expect(serialized.details).toEqual([{ path: 'phone', msg: 'required' }]);
  });

  it('serializes native Error correctly', () => {
    const nativeErr = new Error('Database connection failed');
    const serialized = serializeError(nativeErr, false);
    expect(serialized.code).toBe('UNHANDLED_EXCEPTION');
    expect(serialized.statusCode).toBe(500);
    expect(serialized.message).toBe('Database connection failed');
  });
});