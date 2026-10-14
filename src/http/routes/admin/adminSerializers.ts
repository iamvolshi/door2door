import {
  parseReceiptDetail,
  type SecurityNoticeRow,
} from '../../../db/repositories';
import type { OtpChallengeStatus } from '../../../auth/phoneAuth';
import type {
  ApplicationReadiness,
  SeededProfile,
} from '../../../auth/registrationService';
import type {
  OtpDeliveryRecord,
  OutOfBandState,
  UserRecord,
} from '../../../db/schema';
import { serializeNotification } from '../notificationRoutes';
import { parseOutcomeDetail } from './adminShared.js';

/**
 * What an operator sees for one attempt: enough to answer "did the code go out?".
 *
 * Two facts about delivery sit side by side and are not the same one. `delivered` is the send
 * being accepted by the gateway; `receipt.state` is the gateway's later report about the
 * handset. `UNKNOWN` means no report has arrived *or* that one arrived and could not be read —
 * distinguished by `receipt.detail`, which carries the gateway's own status token and the field
 * names it was taken from, so the operator can see what the gateway actually said.
 */
export function serializeDelivery(delivery: OtpDeliveryRecord): Record<string, unknown> {
  return {
    id: delivery.id,
    phone: delivery.phone,
    provider: delivery.provider,
    delivered: delivery.delivered,
    providerStatus: delivery.providerStatus ?? null,
    failureCode: delivery.failureCode ?? null,
    failureReason: delivery.failureReason ?? null,
    messageId: delivery.messageId ?? null,
    attempts: delivery.attempts,
    latencyMs: delivery.latencyMs ?? null,
    requestId: delivery.requestId ?? null,
    sentAt: delivery.createdAt,
    receipt: {
      state: delivery.receiptState ?? 'UNKNOWN',
      detail: parseReceiptDetail(delivery.receiptDetail)
    }
  };
}

/** An account as a status change reports it: identity, grant and whether it may be used. */
export function serializeStatusAccount(user: UserRecord): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    fullName: user.fullName,
    role: user.role,
    isActive: user.isActive,
    approvalStatus: user.approvalStatus ?? 'APPROVED'
  };
}

/** Review-queue shape: the account plus the onboarding answers an admin is judging. */
export function serializeRegistration(user: UserRecord): Record<string, unknown> {
  let details: unknown = null;
  if (user.registrationDetails) {
    try {
      details = JSON.parse(user.registrationDetails) as unknown;
    } catch {
      details = null;
    }
  }

  return {
    userId: user.id,
    fullName: user.fullName,
    phone: user.phone,
    email: user.email,
    role: user.role,
    approvalStatus: user.approvalStatus ?? 'APPROVED',
    approvalReason: user.approvalReason ?? null,
    reviewedBy: user.reviewedBy ?? null,
    reviewedAt: user.reviewedAt ?? null,
    submittedAt: user.createdAt,
    details
  };
}

/** The operational record approval created, in the shape the reviewer asked for. */
export function serializeProfile(profile: SeededProfile | null | undefined): Record<string, unknown> | null {
  if (!profile) return null;

  if (profile.role === 'MERCHANT') {
    const { merchant } = profile;
    return {
      role: 'MERCHANT',
      merchantId: merchant.id,
      businessName: merchant.businessName,
      tradeLicenseNumber: merchant.tradeLicenseNumber,
      category: merchant.category,
      description: merchant.description ?? null,
      addressId: merchant.addressId,
      phone: merchant.phone,
      isOpen: merchant.isOpen,
      rating: merchant.rating
    };
  }

  const { rider } = profile;
  return {
    role: 'DRIVER',
    userId: rider.userId,
    nidNumber: rider.nidNumber,
    vehicleType: rider.vehicleType,
    licenseNumber: rider.licenseNumber ?? null,
    zoneId: rider.zoneId ?? null,
    dutyStatus: rider.dutyStatus
  };
}

/** A number's login state as the operator sees it. No code and no hash. */
export function serializeChallenge(status: OtpChallengeStatus): Record<string, unknown> {
  return {
    phone: status.phone,
    hasChallenge: status.hasChallenge,
    attempts: status.attempts,
    maxAttempts: status.maxAttempts,
    lockedOut: status.lockedOut,
    codeLive: status.codeLive,
    expiresAt: status.expiresAt,
    lastSentAt: status.lastSentAt,
    // When the customer's own request would be answered again. Null is the point of the
    // action: nothing is waiting any more.
    resendAllowedAt: status.resendAllowedAt,
    secondsUntilResend: status.secondsUntilResend
  };
}

/** One application with the reviewer's judgement on it: whether it can be approved as filed,
 * and what would have to be supplied if not. */
export function serializeReadiness(readiness: ApplicationReadiness): Record<string, unknown> {
  return {
    approvable: readiness.approvable,
    blockedBy: readiness.blockedBy.map((blocker) => ({ ...blocker }))
  };
}

/**
 * One notice as an operator needs it: the customer it belongs to, whether they were ever
 * actually reached, and whether the list the warning sits in is readable to them at all.
 *
 * `followUp` is the first half of the reason this view exists — it is true only when neither
 * channel got through, so the list can be read as a worklist instead of a wall of incidents.
 * A notice the owner has acknowledged is not a follow-up, because the warning did reach them,
 * on this list.
 *
 * `lockedOut` is the second half, and it is what turns the worklist into a priority: an
 * unreached warning on a working account can still be read the next time its owner signs in,
 * while one on a suspended account cannot be read by anybody — that owner has to be reached
 * some other way, or reinstated. It is derived from the account, never stored on the notice,
 * because an account can be suspended and reinstated after the notice was written.
 */
export function serializeSecurityNotice(notice: SecurityNoticeRow): Record<string, unknown> {
  const state: OutOfBandState = notice.outOfBandState ?? 'UNKNOWN';
  const readAt = notice.readAt ?? null;
  // Only suspension takes the list away: a rejected or pending applicant can still sign in
  // and read its own notices, so it is not counted as locked out here.
  const lockedOut = notice.customerActive === null || notice.customerActive === undefined
    ? false
    : Number(notice.customerActive) === 0;
  return {
    ...serializeNotification(notice),
    // The account it belongs to, stated on the notice itself so the operator view reads the
    // same way its `userId` filter does rather than making a caller reach into `customer`.
    userId: notice.userId,
    // Whatever the attempt said about itself. Absent before it reported, or when it never did.
    outOfBand: { state, ...(parseOutcomeDetail(notice.outOfBandDetail) ?? {}) },
    followUp: state !== 'DELIVERED' && readAt === null,
    lockedOut,
    customer: {
      id: notice.userId,
      fullName: notice.customerName ?? null,
      phone: notice.customerPhone ?? null,
      role: notice.customerRole ?? null,
      // Why the account is where it is, so "can I still reach them by text?" does not need a
      // second lookup: an inactive account is one nobody can sign in to read the list from.
      isActive: notice.customerActive === null || notice.customerActive === undefined
        ? null
        : Number(notice.customerActive) === 1,
      approvalStatus: notice.customerApprovalStatus ?? null
    }
  };
}
