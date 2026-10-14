import { UserRole } from '../db/schema';

/**
 * What replaces a client's address and device string once their retention window has
 * closed (`src/auth/clientAddressRetention.ts`).
 *
 * A marker rather than NULL: NULL already means "never recorded" — every seed row, and
 * every row written by a caller whose request carried no metadata — and an operator
 * reading the trail should be able to tell "we did not have it" from "we no longer keep
 * it". Any consumer must treat this value as absent, never as an address.
 */
export const REDACTED_CLIENT_DATA = '[redacted]';

export interface MaskedAddress {
  id?: string;
  userId?: string;
  label?: string;
  streetAddress: string;
  area: string;
  city: string;
  latitude?: number;
  longitude?: number;
  deliveryInstructions?: string;
}

/**
 * Masks a phone number based on caller's role.
 * Admins see full numbers. Drivers & Merchants see masked (+880 17****1234).
 * Unauthorized or anonymous callers see heavily redacted numbers.
 */
export function maskPhoneNumber(phone: string | undefined | null, viewerRole?: UserRole): string {
  if (!phone) return '';
  if (viewerRole === 'ADMIN') {
    return phone;
  }

  const cleaned = phone.replace(/[\s\-]/g, '');
  if (cleaned.length < 8) {
    return '***';
  }

  const prefix = cleaned.slice(0, 5);
  const suffix = cleaned.slice(-3);
  return `${prefix}****${suffix}`;
}

/**
 * Redacts or masks street-level address details for non-admin/non-assigned viewers.
 */
export function maskAddress(
  address: {
    id?: string;
    userId?: string;
    label?: string;
    streetAddress?: string;
    area?: string;
    city?: string;
    latitude?: number;
    longitude?: number;
    deliveryInstructions?: string;
  },
  viewerRole?: UserRole,
  isAssignedDriverOrMerchant: boolean = false
): MaskedAddress {
  const area = address.area || 'Cox\'s Bazar';
  const city = address.city || 'Cox\'s Bazar';

  if (viewerRole === 'ADMIN' || isAssignedDriverOrMerchant) {
    return {
      id: address.id,
      userId: address.userId,
      label: address.label,
      streetAddress: address.streetAddress || '',
      area,
      city,
      latitude: address.latitude,
      longitude: address.longitude,
      deliveryInstructions: address.deliveryInstructions
    };
  }

  return {
    id: address.id,
    label: address.label,
    streetAddress: '*** Masked for privacy ***',
    area,
    city
  };
}

/**
 * Sanitizes customer record for exposure to specific roles.
 */
export function sanitizeCustomerData<T extends Record<string, any>>(
  customer: T,
  viewerRole?: UserRole,
  isOwnData: boolean = false
): Partial<T> {
  if (viewerRole === 'ADMIN' || isOwnData) {
    return { ...customer };
  }

  const sanitized: Record<string, any> = { ...customer };
  
  if (sanitized.phone) {
    sanitized.phone = maskPhoneNumber(sanitized.phone, viewerRole);
  }
  if (sanitized.email) {
    const emailParts = String(sanitized.email).split('@');
    if (emailParts.length === 2) {
      const [user, domain] = emailParts;
      const maskedUser = user.length > 2 ? `${user.slice(0, 2)}***` : '***';
      sanitized.email = `${maskedUser}@${domain}`;
    } else {
      sanitized.email = '***@***.com';
    }
  }

  // Remove internal authentication and credential records if present
  delete sanitized.passwordHash;
  delete sanitized.credentials;
  delete sanitized.salt;
  delete sanitized.mfaSecret;

  return sanitized as Partial<T>;
}
