/**
 * Admin routes barrel: one concern per file under ./admin/, assembled here so every
 * existing import path keeps working. Put new operator endpoints in the concern file
 * they belong to, not here.
 */
import type { Route } from '../httpUtils.js';
import type { AdminRouteDeps } from './admin/adminShared.js';
import { createRegistrationRoutes } from './admin/registrationRoutes.js';
import { createPhoneLoginRoutes } from './admin/phoneLoginRoutes.js';
import { createUserModerationRoutes } from './admin/userModerationRoutes.js';
import { createOtpAdminRoutes } from './admin/otpAdminRoutes.js';
import { createSecurityNoticeRoutes } from './admin/securityNoticeRoutes.js';

export type { AdminRouteDeps } from './admin/adminShared.js';
export * from './admin/adminSerializers.js';

export function createAdminRoutes(deps: AdminRouteDeps): Route[] {
  return [
    ...createRegistrationRoutes(deps),
    ...createPhoneLoginRoutes(deps),
    ...createUserModerationRoutes(deps),
    ...createOtpAdminRoutes(deps),
    ...createSecurityNoticeRoutes(deps),
  ];
}
