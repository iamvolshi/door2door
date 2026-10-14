/**
 * Cox's Bazar Door2Door platform barrel.
 *
 * This module is intentionally side-effect free: importing it never opens a
 * database or binds a port. The runnable entry point is `src/main.ts` (which boots
 * `src/server.ts`; `npm start` runs `dist/main.js` after `npm run build`).
 */
export * from './config/env.js';
export * from './core/errors.js';
export * from './core/logger.js';
export * from './db/schema.js';
export * from './db/client.js';
export * from './db/sqliteDriver.js';
export * from './db/postgresDriver.js';
export * from './db/storage.js';
export * from './db/repositories.js';
export * from './db/seed.js';
export * from './auth/tokens.js';
export * from './auth/rbac.js';
export * from './auth/phoneAuth.js';
export * from './auth/otpStore.js';
export * from './auth/sessionService.js';
export * from './auth/otpDelivery.js';
export * from './auth/registrationService.js';
export * from './auth/smsProviders.js';
export * from './http/app.js';
export * from './http/rateLimiter.js';
export * from './server.js';
