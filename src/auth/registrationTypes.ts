import { IssuedSession } from './sessionService';
import { MerchantRecord, RiderProfileRecord, RiderVehicleType, UserRecord, UserRole } from '../db/schema';

/** Roles a person may register for themselves. Admin accounts are provisioned, never self-served. */
export const SELF_REGISTRABLE_ROLES: readonly UserRole[] = ['CUSTOMER', 'MERCHANT', 'DRIVER'];

/** Roles that stay PENDING until an admin reviews the application. */
export const APPROVAL_REQUIRED_ROLES: readonly UserRole[] = ['MERCHANT', 'DRIVER'];

export const RIDER_VEHICLE_TYPES: readonly RiderVehicleType[] = ['BICYCLE', 'MOTORCYCLE', 'WALKER', 'EV_SCOOTER'];

/** The label the shop address the merchant works from is stored under. */
export const SHOP_ADDRESS_LABEL = 'Shop';

/**
 * Category given to a store whose owner did not name one. A real category is better, but an
 * uncategorised store is better than an unapprovable application.
 */
export const DEFAULT_MERCHANT_CATEGORY = 'General';

export interface RegistrationOutcome {
  user: UserRecord;
  /** True when the account cannot use its role permissions until an admin approves it. */
  approvalRequired: boolean;
  session: IssuedSession;
}

/** A validated application. Parsing it touches no storage, so it can run before the OTP. */
export interface RegistrationApplication {
  role: UserRole;
  fullName: string;
  email?: string;
  details: Record<string, string> | null;
}

export interface ReviewResult {
  user: UserRecord;
  decision: 'APPROVED' | 'REJECTED';
  /** What approval created for the account, so the reviewer can see it landed. */
  profile?: SeededProfile | null;
}

/** A shop address, as supplied by an applicant or typed in by the approving admin. */
export interface ShopAddressInput {
  streetAddress: string;
  area: string;
  district: string;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
}

/** The operational record approval creates: a store, or a rider's identity and duty state. */
export type SeededProfile =
  | { role: 'MERCHANT'; merchant: MerchantRecord }
  | { role: 'DRIVER'; rider: RiderProfileRecord };

export interface ReviewOptions {
  /**
   * Shop address supplied by the reviewer, used only for applications that predate the
   * address requirement — a current application carries its own.
   */
  address?: ShopAddressInput;
  /**
   * A rider's identity and vehicle as taken down by the reviewer, for an application that
   * arrived without them. Each field is independent: whatever the reviewer supplies wins,
   * whatever they do not still comes from the application.
   */
  rider?: RiderProfileOverride;
}

/** The identity fields a reviewer may complete over the phone. All optional. */
export interface RiderProfileOverride {
  nidNumber?: string;
  vehicleType?: RiderVehicleType;
  licenseNumber?: string | null;
}

/**
 * Why an application cannot be approved as it was filed.
 *
 * `field` names the same field an approval would fail on, so the queue and the `400` tell an
 * operator the same thing instead of two different things. `fixableByReviewer` says whether
 * the approve call can carry the missing piece at all: a shop address and a rider's identity
 * can be taken down over the phone and passed in, while a trade licence another store already
 * holds cannot be resolved by approving anything.
 */
export type ApplicationBlockerCode =
  | 'SHOP_ADDRESS_MISSING'
  | 'TRADE_LICENCE_MISSING'
  | 'TRADE_LICENCE_IN_USE'
  | 'NID_MISSING'
  | 'VEHICLE_MISSING'
  | 'VEHICLE_INVALID';

export interface ApplicationBlocker {
  code: ApplicationBlockerCode;
  /** The request field to fix, mirroring the approval error's `details.field`. */
  field: string;
  /** What is missing, in the operator's words. */
  message: string;
  /** True when passing it in the approve body clears the blocker. */
  fixableByReviewer: boolean;
  /** What the operator can do about it, stated rather than implied. */
  remedy: string;
}

export interface ApplicationReadiness {
  /** True when approving this application exactly as filed would succeed. */
  approvable: boolean;
  blockedBy: ApplicationBlocker[];
}
