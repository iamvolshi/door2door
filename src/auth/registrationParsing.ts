import { SELF_REGISTRABLE_ROLES, APPROVAL_REQUIRED_ROLES, RIDER_VEHICLE_TYPES, RegistrationApplication, ShopAddressInput } from './registrationTypes';
import { ValidationError } from '../core/errors';
import { UserRecord, UserRole } from '../db/schema';
import { POSTAL_CODE_PATTERN } from '../services/addressRules';
import * as crypto from 'crypto';

/**
 * Answers collected at registration, by role. Merchants state where their shop is: the
 * `merchants` row needs a location, and the applicant is the only one who knows it.
 */
const REQUIRED_DETAIL_FIELDS: Record<UserRole, readonly string[]> = {
  CUSTOMER: [],
  MERCHANT: ['businessName', 'tradeLicenseNumber', 'streetAddress', 'area', 'district'],
  DRIVER: ['nidNumber', 'vehicleType'],
  ADMIN: []
};

const OPTIONAL_DETAIL_FIELDS: Record<UserRole, readonly string[]> = {
  CUSTOMER: [],
  MERCHANT: ['zoneId', 'category', 'description', 'postalCode'],
  DRIVER: ['licenseNumber', 'zoneId'],
  ADMIN: []
};

/** Length limits mirror the delivery-address rules, so both agree on what an address is. */
const DETAIL_MAX_LENGTHS: Record<string, number> = {
  streetAddress: 200,
  area: 80,
  district: 80
};

const DETAIL_MIN_LENGTHS: Record<string, number> = {
  streetAddress: 3
};

/**
 * Validates the registration payload without consuming the OTP or reading the database,
 * so a malformed application is rejected without burning the applicant's code.
 */
export function parseRegistrationApplication(
  body: Record<string, unknown>
): RegistrationApplication {
  const role = parseRole(body.role);
  return {
    role,
    fullName: parseFullName(body.fullName),
    email: body.email === undefined ? undefined : parseEmail(body.email),
    details: parseDetails(body.details, role)
  };
}

export function isApprovalRequiredRole(role: UserRole): boolean {
  return APPROVAL_REQUIRED_ROLES.includes(role);
}

export function parseRole(raw: unknown): UserRole {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if ((SELF_REGISTRABLE_ROLES as readonly string[]).includes(value)) {
    return value as UserRole;
  }
  throw new ValidationError(
    `Field 'role' must be one of ${SELF_REGISTRABLE_ROLES.join(', ')}`,
    { field: 'role' }
  );
}

export function parseFullName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ValidationError("Field 'fullName' is required", { field: 'fullName' });
  }
  const value = raw.trim().replace(/\s+/g, ' ');
  if (value.length < 2 || value.length > 120) {
    throw new ValidationError("Field 'fullName' must be between 2 and 120 characters", {
      field: 'fullName'
    });
  }
  return value;
}

export function parseEmail(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ValidationError("Field 'email' must be a string", { field: 'email' });
  }
  const value = raw.trim().toLowerCase();
  if (value.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
    throw new ValidationError("Field 'email' must be a valid email address", { field: 'email' });
  }
  return value;
}

/**
 * Phone-only accounts still need a unique email because the users table requires one.
 * The reserved domain makes it obvious that nothing is delivered there.
 */
export function placeholderEmail(phone: string): string {
  return `${phone.replace(/\D/g, '')}@phone.coxsbazar.delivery`;
}

export function requireDetailString(
  details: Record<string, unknown>,
  field: string,
  role: UserRole,
  limits: { minLength?: number; maxLength?: number } = {}
): string {
  const maxLength = limits.maxLength ?? 160;
  const raw = details[field];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationError(`Field 'details.${field}' is required to register as ${role}`, {
      field: `details.${field}`
    });
  }
  const value = raw.trim().replace(/\s+/g, ' ');
  if (value.length > maxLength) {
    throw new ValidationError(`Field 'details.${field}' must be ${maxLength} characters or fewer`, {
      field: `details.${field}`
    });
  }
  if (limits.minLength !== undefined && value.length < limits.minLength) {
    throw new ValidationError(
      `Field 'details.${field}' must be at least ${limits.minLength} characters`,
      { field: `details.${field}` }
    );
  }
  return value;
}

/** Whitelists and validates the onboarding answers so only expected fields are stored. */
export function parseDetails(raw: unknown, role: UserRole): Record<string, string> | null {
  if (raw === undefined || raw === null) {
    if (REQUIRED_DETAIL_FIELDS[role].length > 0) {
      throw new ValidationError(
        `Field 'details' is required to register as ${role} (${REQUIRED_DETAIL_FIELDS[role].join(', ')})`,
        { field: 'details' }
      );
    }
    return null;
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError("Field 'details' must be an object", { field: 'details' });
  }

  const source = raw as Record<string, unknown>;
  const details: Record<string, string> = {};

  for (const field of REQUIRED_DETAIL_FIELDS[role]) {
    details[field] = requireDetailString(source, field, role, {
      ...(DETAIL_MIN_LENGTHS[field] !== undefined ? { minLength: DETAIL_MIN_LENGTHS[field] } : {}),
      ...(DETAIL_MAX_LENGTHS[field] !== undefined ? { maxLength: DETAIL_MAX_LENGTHS[field] } : {})
    });
  }
  for (const field of OPTIONAL_DETAIL_FIELDS[role]) {
    const value = source[field];
    if (typeof value === 'string' && value.trim() !== '') {
      details[field] = value.trim().slice(0, 160);
    }
  }

  if (role === 'MERCHANT') {
    const postalCode = details.postalCode;
    if (postalCode !== undefined && !POSTAL_CODE_PATTERN.test(postalCode)) {
      throw new ValidationError("Field 'details.postalCode' must be 4 digits", {
        field: 'details.postalCode'
      });
    }
  }

  if (role === 'DRIVER') {
    const vehicleType = details.vehicleType.toUpperCase();
    if (!(RIDER_VEHICLE_TYPES as readonly string[]).includes(vehicleType)) {
      throw new ValidationError(
        `Field 'details.vehicleType' must be one of ${RIDER_VEHICLE_TYPES.join(', ')}`,
        { field: 'details.vehicleType' }
      );
    }
    details.vehicleType = vehicleType;
  }

  return Object.keys(details).length > 0 ? details : null;
}

/** The onboarding answers as stored, or null when the row carries none we can read. */
export function storedDetails(raw: string | null | undefined): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const details: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim() !== '') details[key] = value;
    }
    return details;
  } catch {
    return null;
  }
}

/**
 * The shop address an application carries, or null when it has none — either because it was
 * filed before merchants had to state one, or because the row is not a merchant's.
 */
export function shopAddressFromApplication(user: UserRecord): ShopAddressInput | null {
  const details = storedDetails(user.registrationDetails);
  if (!details) return null;

  const { streetAddress, area, district } = details;
  if (!streetAddress || !area || !district) return null;

  return {
    streetAddress,
    area,
    district,
    postalCode: details.postalCode ?? '',
    // Onboarding answers are strings only, so an application never carries coordinates.
    latitude: null,
    longitude: null
  };
}

export function newId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
