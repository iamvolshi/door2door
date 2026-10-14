import { ForbiddenError, UnauthorizedError } from '../core/errors';
import { UserRole } from '../db/schema';

export type Permission =
  | 'profile:read:own'
  | 'profile:update:own'
  | 'order:create'
  | 'order:read:own'
  | 'order:cancel:own'
  | 'address:manage:own'
  | 'order:read:merchant'
  | 'order:update:merchant'
  | 'order:read:driver'
  | 'order:accept:driver'
  | 'order:update:driver'
  | 'rider:duty:own'
  | 'rider:read:all'
  | 'order:read:all'
  | 'order:manage:all'
  | 'catalog:read'
  | 'catalog:manage:merchant'
  | 'catalog:manage:all'
  | 'merchant:manage:own'
  | 'merchant:manage:all'
  | 'pii:read:full'
  | 'pii:read:operational'
  | 'audit:read'
  | 'registration:read'
  | 'registration:review'
  | 'otp:read'
  // Writing phone-login state rather than reading the SMS trail: the help-desk lever that
  // clears a stuck resend cooldown, which is a different act from reviewing who was texted.
  | 'otp:manage'
  | 'system:manage';

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  CUSTOMER: [
    'profile:read:own',
    'profile:update:own',
    'address:manage:own',
    'order:create',
    'order:read:own',
    'order:cancel:own',
    'catalog:read'
  ],
  MERCHANT: [
    'profile:read:own',
    'profile:update:own',
    'order:read:merchant',
    'order:update:merchant',
    'catalog:read',
    'catalog:manage:merchant',
    'merchant:manage:own',
    'pii:read:operational'
  ],
  DRIVER: [
    'profile:read:own',
    'profile:update:own',
    'order:read:driver',
    'order:accept:driver',
    'order:update:driver',
    // Putting oneself on and off the roster is a rider's own decision, which is why it is a
    // grant of its own rather than an edit of the profile dispatch created for them.
    'rider:duty:own',
    'catalog:read',
    'pii:read:operational'
  ],
  ADMIN: [
    'profile:read:own',
    'profile:update:own',
    'order:create',
    'order:read:own',
    'order:cancel:own',
    'address:manage:own',
    'order:read:merchant',
    'order:update:merchant',
    'order:read:driver',
    'order:accept:driver',
    'order:update:driver',
    'order:read:all',
    'order:manage:all',
    // Administrators hold every grant the other roles do; the rider ones are inert here
    // because an administrator has no rider profile, and are listed so that the set stays
    // readable as "everything above" rather than "everything above, minus two".
    'rider:duty:own',
    'rider:read:all',
    'catalog:read',
    'catalog:manage:merchant',
    'catalog:manage:all',
    'merchant:manage:own',
    'merchant:manage:all',
    'pii:read:full',
    'pii:read:operational',
    'audit:read',
    'registration:read',
    'registration:review',
    'otp:read',
    'otp:manage',
    'system:manage'
  ]
};

/**
 * Checks if a specific role possesses the requested permission.
 */
export function hasPermission(role: UserRole | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  const permissions = ROLE_PERMISSIONS[role];
  if (!permissions) return false;
  return permissions.includes(permission);
}

/**
 * Asserts that the role has the required permission, otherwise throws ForbiddenError.
 */
export function assertPermission(role: UserRole | undefined | null, permission: Permission): void {
  if (!role) {
    throw new UnauthorizedError('Authentication required');
  }
  if (!hasPermission(role, permission)) {
    throw new ForbiddenError(`Forbidden: role '${role}' lacks permission '${permission}'`);
  }
}

/**
 * Asserts that user belongs to one of the authorized roles.
 */
export function assertRole(currentRole: UserRole | undefined | null, allowedRoles: UserRole[]): void {
  if (!currentRole) {
    throw new UnauthorizedError('Authentication required');
  }
  if (!allowedRoles.includes(currentRole)) {
    throw new ForbiddenError(`Forbidden: role '${currentRole}' is not allowed to access this resource`);
  }
}
