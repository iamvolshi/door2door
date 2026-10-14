/**
 * Persistence barrel: one repository per domain file, re-exported here so every
 * existing import path keeps working. Put new storage in the domain file it belongs
 * to, not here.
 */
export * from './userRepository.js';
export * from './authRepository.js';
export * from './merchantRepository.js';
export * from './catalogRepository.js';
export * from './paymentRepository.js';
export * from './idempotencyRepository.js';
export * from './auditLogRepository.js';
export * from './addressRepository.js';
export * from './riderRepository.js';
export * from './orderRepository.js';
export * from './retentionRepository.js';
export * from './notificationRepository.js';
export * from './otpDeliveryRepository.js';
export * from './rateLimitRepository.js';
export * from './refundRepository.js';
