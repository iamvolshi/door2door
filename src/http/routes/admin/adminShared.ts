import {
  DEFAULT_OPERATOR_NOTICE_LIMIT,
  MAX_NOTIFICATION_LIMIT,
  type AuditLogRepository,
  type NotificationRepository,
  type OtpDeliveryRepository,
  type SecurityNoticeRow,
} from '../../../db/repositories';
import type { AccountStatusService } from '../../../auth/accountStatusService';
import {
  dispatchOtp,
  type OtpDispatchResult,
} from '../../../auth/otpDelivery';
import type { OtpDeliveryLog } from '../../../auth/otpDeliveryLog';
import {
  normalizePhoneNumber,
  type PhoneAuthService,
} from '../../../auth/phoneAuth';
import {
  RIDER_VEHICLE_TYPES,
  type RegistrationService,
  type RiderProfileOverride,
  type ShopAddressInput,
} from '../../../auth/registrationService';
import {
  SECURITY_NOTICE_COPY,
  type SecurityNoticeType,
} from '../../../auth/securityNotices';
import { ValidationError } from '../../../core/errors';
import type {
  ApprovalStatus,
  OutOfBandState,
  SmsReceiptState,
  UserRole,
} from '../../../db/schema';
import { parseShopAddress } from '../../../services/merchantProfileRules';

export function parsePhoneQuery(raw: string | null): string | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const value = normalizePhoneNumber(raw);
  if (value.length > 20) {
    throw new ValidationError(
      `Query 'phone' must be a Bangladeshi phone number (E.164), got ${raw.trim()}`,
      { field: 'phone' }
    );
  }
  return value;
}

export function parseSince(raw: string | null): string | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError("Query 'since' must be an ISO-8601 timestamp", { field: 'since' });
  }
  return parsed.toISOString();
}

export const API_PREFIX = '/api/v1';

export const REVIEWABLE_ROLES: readonly UserRole[] = ['MERCHANT', 'DRIVER'];

export const REVIEW_STATUSES: readonly ApprovalStatus[] = ['PENDING', 'APPROVED', 'REJECTED'];

/** How many applications the review queue reads per request. Each row is assessed against the
 * database, so the page is bounded and reported as bounded rather than silently truncated. */
export const DEFAULT_REVIEW_LIMIT = 100;

export const MAX_REVIEW_LIMIT = 200;

export interface AdminRouteDeps {
  registrationService: RegistrationService;
  otpDeliveryRepo: OtpDeliveryRepository;
  /** The account holder's notice list, read here as the operator's follow-up view. */
  notificationRepo: NotificationRepository;
  /** Suspending and reinstating accounts, which is also what warns their owners. */
  accountStatus: AccountStatusService;
  /**
   * The same phone-login service the OTP routes use, so the help desk clears the state a
   * login actually reads rather than a copy of it.
   */
  otpService: PhoneAuthService;
  /** The trail every other administrator action writes to. */
  auditRepo: AuditLogRepository;
  /** Writes the SMS attempt trail; omitted by callers that do not persist it. */
  otpDeliveryLog?: OtpDeliveryLog;
  /** Injectable for tests; defaults to the configured SMS gateway. */
  dispatchOtp?: (phone: string, otp: string, expiresInSeconds: number) => Promise<OtpDispatchResult>;
}

/** The operator summary answers "is SMS working right now?", so it has a fixed window. */
export const DELIVERY_SUMMARY_WINDOW_HOURS = 24;

/** Accepts `true`, `false` or `ALL`; absent means no filter. */
export function parseDeliveredFilter(raw: string | null): boolean | undefined {
  if (raw === null || raw.trim() === '' || raw.trim().toUpperCase() === 'ALL') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ValidationError("Query 'delivered' must be true, false or ALL", { field: 'delivered' });
}

/**
 * Accepts `DELIVERED`, `FAILED`, `UNKNOWN` or `ALL`; absent means no filter.
 *
 * A filter rather than an extra column, because the question it answers is "show me the ones
 * the gateway says failed" — which is how an operator finds the customers to call back.
 */
export function parseReceiptFilter(raw: string | null): SmsReceiptState | undefined {
  if (raw === null || raw.trim() === '' || raw.trim().toUpperCase() === 'ALL') return undefined;
  const value = raw.trim().toUpperCase();
  if (value === 'DELIVERED' || value === 'FAILED' || value === 'UNKNOWN') return value;
  throw new ValidationError("Query 'receipt' must be DELIVERED, FAILED, UNKNOWN or ALL", {
    field: 'receipt'
  });
}

export function parseProviderFilter(raw: string | null): string | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const value = raw.trim().toLowerCase();
  if (value.length > 40) {
    throw new ValidationError("Query 'provider' must be 40 characters or fewer", { field: 'provider' });
  }
  return value;
}

export function parseLimit(raw: string | null): number {
  if (raw === null || raw.trim() === '') return 50;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new ValidationError("Query 'limit' must be an integer between 1 and 200", { field: 'limit' });
  }
  return value;
}

/**
 * The rider identity an admin can attach to an approval, for an application that arrived
 * without it. Every field is optional and independent: the reviewer completes whatever the
 * application is missing, and nothing else.
 */
export function parseApprovalRider(body: Record<string, unknown>): RiderProfileOverride | undefined {
  const raw = body.rider;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError("Field 'rider' must be an object", { field: 'rider' });
  }

  const source = raw as Record<string, unknown>;
  const rider: RiderProfileOverride = {};

  if (source.nidNumber !== undefined) {
    const value = typeof source.nidNumber === 'string' ? source.nidNumber.trim() : '';
    if (value.length < 4 || value.length > 40) {
      throw new ValidationError(
        "Field 'rider.nidNumber' must be between 4 and 40 characters",
        { field: 'rider.nidNumber' }
      );
    }
    rider.nidNumber = value;
  }

  if (source.vehicleType !== undefined) {
    // Normalized the way registration normalizes it, so an operator reading a vehicle off the
    // paperwork does not have to know which case the list is written in.
    const value = typeof source.vehicleType === 'string' ? source.vehicleType.trim().toUpperCase() : '';
    if (!(RIDER_VEHICLE_TYPES as readonly string[]).includes(value)) {
      throw new ValidationError(
        `Field 'rider.vehicleType' must be one of ${RIDER_VEHICLE_TYPES.join(', ')}`,
        { field: 'rider.vehicleType' }
      );
    }
    rider.vehicleType = value as RiderProfileOverride['vehicleType'];
  }

  if (source.licenseNumber !== undefined) {
    if (source.licenseNumber === null) {
      rider.licenseNumber = null;
    } else {
      const value = typeof source.licenseNumber === 'string' ? source.licenseNumber.trim() : '';
      if (value.length > 40) {
        throw new ValidationError(
          "Field 'rider.licenseNumber' must be 40 characters or fewer",
          { field: 'rider.licenseNumber' }
        );
      }
      rider.licenseNumber = value;
    }
  }

  if (Object.keys(rider).length === 0) {
    throw new ValidationError(
      "Field 'rider' must carry at least one of nidNumber, vehicleType, licenseNumber",
      { field: 'rider' }
    );
  }
  return rider;
}

/**
 * The address an admin can attach to an approval. Only applications filed before merchants
 * had to state a shop address need it; a current one carries its own.
 *
 * The parsing is the shared shop-address rule (`src/services/merchantProfileRules.ts`), which a
 * merchant opening its own store also goes through: one definition of what a shop address is,
 * rather than an administrator's copy and a merchant's copy that can drift.
 */
export function parseApprovalAddress(body: Record<string, unknown>): ShopAddressInput | undefined {
  return parseShopAddress(body.address);
}

/**
 * Accepts `true` or `false`; absent means "clear the wait, do not text the number yourself".
 *
 * The default is deliberately the quieter half of the action: a desk that clears a cooldown
 * lets the customer ask for their own code, which is the code they are expecting.
 */
export function parseSendFlag(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'boolean') {
    throw new ValidationError("Field 'send' must be a boolean", { field: 'send' });
  }
  return raw;
}

/**
 * Accepts `true`, `false` or `ALL`; absent means no filter.
 *
 * `false` is the one an operator wants: applications that cannot be approved as filed, so
 * they are worked before an approval is attempted rather than after it fails.
 */
export function parseApprovableFilter(raw: string | null): boolean | undefined {
  if (raw === null || raw.trim() === '' || raw.trim().toUpperCase() === 'ALL') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ValidationError("Query 'approvable' must be true, false or ALL", {
    field: 'approvable'
  });
}

/** The review queue's page size. Bounded, because readiness is assessed row by row. */
export function parseReviewLimit(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_REVIEW_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_REVIEW_LIMIT) {
    throw new ValidationError(
      `Query 'limit' must be an integer between 1 and ${MAX_REVIEW_LIMIT}`,
      { field: 'limit' }
    );
  }
  return value;
}

export function parseStatusFilter(raw: string | null): ApprovalStatus | undefined {
  if (raw === null || raw.trim() === '') return 'PENDING';
  const value = raw.trim().toUpperCase();
  if (value === 'ALL') return undefined;
  if (!(REVIEW_STATUSES as readonly string[]).includes(value)) {
    throw new ValidationError(`Query 'status' must be one of ${REVIEW_STATUSES.join(', ')}, ALL`, {
      field: 'status'
    });
  }
  return value as ApprovalStatus;
}

export function parseRoleFilter(raw: string | null): UserRole | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const value = raw.trim().toUpperCase();
  if (!(REVIEWABLE_ROLES as readonly string[]).includes(value)) {
    throw new ValidationError(`Query 'role' must be one of ${REVIEWABLE_ROLES.join(', ')}`, {
      field: 'role'
    });
  }
  return value as UserRole;
}

/**
 * Accepts one of the notice types, or `ALL`.
 *
 * Worth having because the types are not equally urgent: a claimed number is a notice the
 * owner has a working session to read, while a suspended account cannot sign in at all, and
 * an operator wants the second without the first.
 */
export function parseNoticeTypeFilter(raw: string | null): SecurityNoticeType | undefined {
  if (raw === null || raw.trim() === '' || raw.trim().toUpperCase() === 'ALL') return undefined;
  const value = raw.trim().toUpperCase();
  const known = Object.keys(SECURITY_NOTICE_COPY);
  if (!known.includes(value)) {
    throw new ValidationError(`Query 'type' must be one of ${known.join(', ')}, ALL`, {
      field: 'type'
    });
  }
  return value as SecurityNoticeType;
}

/**
 * Accepts `DELIVERED`, `FAILED`, `UNKNOWN` or `ALL`; absent means no filter.
 *
 * The state is the out-of-band outcome written back onto the notice itself, so this is a
 * column read rather than a reconstruction from the audit trail.
 */
export function parseNoticeStateFilter(raw: string | null): OutOfBandState | undefined {
  if (raw === null || raw.trim() === '' || raw.trim().toUpperCase() === 'ALL') return undefined;
  const value = raw.trim().toUpperCase();
  if (value === 'DELIVERED' || value === 'FAILED' || value === 'UNKNOWN') return value;
  throw new ValidationError("Query 'state' must be DELIVERED, FAILED, UNKNOWN or ALL", {
    field: 'state'
  });
}

export function noticeOutOfBandState(notice: SecurityNoticeRow): OutOfBandState {
  return notice.outOfBandState ?? 'UNKNOWN';
}

export function isNoticeFollowUp(notice: SecurityNoticeRow): boolean {
  return noticeOutOfBandState(notice) !== 'DELIVERED' && (notice.readAt ?? null) === null;
}

export function isNoticeLockedOut(notice: SecurityNoticeRow): boolean {
  return (
    notice.customerActive !== null &&
    notice.customerActive !== undefined &&
    Number(notice.customerActive) === 0
  );
}

/**
 * The operator summary answers "how much of this is still work?", so it is counted over
 * every notice the account and time filters admit — narrowing the worklist never changes
 * the numbers reported beside it.
 */
export function summarizeNotices(notices: SecurityNoticeRow[]): Record<string, number> {
  return {
    total: notices.length,
    delivered: notices.filter((notice) => noticeOutOfBandState(notice) === 'DELIVERED').length,
    failed: notices.filter((notice) => noticeOutOfBandState(notice) === 'FAILED').length,
    unknown: notices.filter((notice) => noticeOutOfBandState(notice) === 'UNKNOWN').length,
    read: notices.filter((notice) => (notice.readAt ?? null) !== null).length,
    followUp: notices.filter(isNoticeFollowUp).length
  };
}

/** Accepts `true` or `false`; absent means the filter is not applied. */
export function parseBooleanFilter(raw: string | null, field: string): boolean {
  if (raw === null || raw.trim() === '') return false;
  const value = raw.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ValidationError(`Query '${field}' must be true or false`, { field });
}

export function parseNoticeLimit(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_OPERATOR_NOTICE_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_NOTIFICATION_LIMIT) {
    throw new ValidationError(
      `Query 'limit' must be an integer between 1 and ${MAX_NOTIFICATION_LIMIT}`,
      { field: 'limit' }
    );
  }
  return value;
}

/** Tolerant on purpose: the outcome is a report, and an unreadable one is reported absent. */
export function parseOutcomeDetail(raw?: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
