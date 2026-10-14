import { SecurityNoticeService } from './securityNotices';
import { SessionService, SessionMeta } from './sessionService';
import { isApprovalRequiredRole, placeholderEmail, storedDetails, shopAddressFromApplication, newId } from './registrationParsing';
import { RIDER_VEHICLE_TYPES, SHOP_ADDRESS_LABEL, DEFAULT_MERCHANT_CATEGORY, RegistrationOutcome, RegistrationApplication, ReviewResult, ShopAddressInput, SeededProfile, ReviewOptions, RiderProfileOverride, ApplicationBlocker, ApplicationReadiness } from './registrationTypes';
import { ConflictError, NotFoundError, ValidationError } from '../core/errors';
import { logger } from '../core/logger';
import { DatabaseClient } from '../db/client';
import { AddressRepository, AuditLogRepository, MerchantRepository, RiderProfileRepository, UserRepository } from '../db/repositories';
import { ApprovalStatus, MerchantRecord, RiderProfileRecord, RiderVehicleType, UserRecord, UserRole } from '../db/schema';
import * as crypto from 'crypto';

export * from './registrationTypes';
export * from './registrationParsing';

/**
 * Owns self-service account creation and the admin review that unlocks merchant and
 * rider accounts. Phone ownership is proven by the OTP before this runs.
 */
export interface RegistrationServiceOptions {
  /**
   * How an account holder is warned. Overridable for tests; defaults to the account's own
   * notice list in this database plus an SMS attempt through the configured gateway.
   */
  notices?: SecurityNoticeService;
}

export class RegistrationService {
  private readonly client: DatabaseClient;
  private readonly userRepo: UserRepository;
  private readonly merchantRepo: MerchantRepository;
  private readonly auditRepo: AuditLogRepository;
  private readonly sessionService: SessionService;
  private readonly notices: SecurityNoticeService;

  constructor(client: DatabaseClient, options: RegistrationServiceOptions = {}) {
    this.client = client;
    this.userRepo = new UserRepository(client);
    this.merchantRepo = new MerchantRepository(client);
    this.auditRepo = new AuditLogRepository(client);
    this.sessionService = new SessionService(client);
    this.notices = options.notices ?? new SecurityNoticeService(client);
  }

  /**
   * Creates the account for an already-verified phone. Uniqueness is checked here rather
   * than during parsing so an unauthenticated caller cannot probe which numbers or
   * addresses are registered.
   */
  public async createAccount(
    phone: string,
    application: RegistrationApplication,
    meta: SessionMeta = {}
  ): Promise<RegistrationOutcome> {
    const { role, fullName, details } = application;
    const email = application.email ?? placeholderEmail(phone);

    if (await this.userRepo.findByPhone(phone)) {
      throw new ConflictError('An account already exists for this phone number');
    }
    if (await this.userRepo.findByEmail(email)) {
      throw new ConflictError('That email address is already registered');
    }
    // Caught here rather than at approval: a licence another store already holds can only
    // be refused, and the applicant is the one who can fix it.
    if (role === 'MERCHANT' && details?.tradeLicenseNumber) {
      const holder = await this.merchantRepo.findByTradeLicenseNumber(details.tradeLicenseNumber);
      if (holder) {
        throw new ConflictError('That trade licence number is already registered to another store');
      }
    }

    const approvalRequired = isApprovalRequiredRole(role);
    const user = await this.userRepo.create({
      id: `usr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      email,
      phone,
      fullName,
      role,
      isActive: true,
      approvalStatus: approvalRequired ? 'PENDING' : 'APPROVED',
      registrationDetails: details ? JSON.stringify(details) : null
    });

    await this.auditRepo.log({
      id: `aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
      userId: user.id,
      action: 'ACCOUNT_REGISTER',
      entityType: 'USER',
      entityId: user.id,
      newValues: JSON.stringify({ role, approvalStatus: user.approvalStatus }),
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
      // Null by construction: registration is authorised by a code sent to a phone, so there
      // is no session yet — the account is being created, not acting.
      sessionId: meta.sessionId ?? null
    });

    logger.info('Account registered', { userId: user.id, role, approvalRequired });

    // The number now has an account on it, and that is worth telling whoever holds the
    // phone: a code proved the number moments ago, but a claim that was not theirs — a
    // forwarded message, a recycled SIM — is exactly what this notice exists to surface.
    // Raised here rather than in the route so every path that creates an account warns once.
    await this.notices.raise({
      type: 'PHONE_CLAIMED',
      userId: user.id,
      phone: user.phone,
      context: { role, approvalStatus: user.approvalStatus ?? 'APPROVED' }
    });

    // The phone was verified by the OTP in this same request, so the account signs in
    // immediately — a pending applicant needs a session to watch their own review state.
    return {
      user,
      approvalRequired,
      session: await this.sessionService.startSession(user, meta)
    };
  }

  /** The review queue. Defaults to everything awaiting a decision. */
  public async list(filter: {
    status?: ApprovalStatus;
    role?: UserRole;
    limit?: number;
  } = {}): Promise<UserRecord[]> {
    return this.userRepo.listByApproval(filter);
  }

  /**
   * Whether an approval would succeed as the application stands, and what is missing if not.
   *
   * The question is worth answering before an operator tries, because an approval that cannot
   * be built is currently only discovered by making the call: an application filed before a
   * requirement existed, or one whose trade licence has since been taken by another store,
   * answers `400` (or `409`) and nothing in the queue said so. This mirrors what
   * `seedOperationalProfile` demands — the same helpers, the same vehicle list, the same
   * licence check — so the two cannot disagree about what is approvable.
   *
   * It reads the account, so it is answered per application rather than stored: a store that
   * already exists clears every merchant blocker, and an account can gain one later (a second
   * store claiming its licence) without the row changing at all.
   */
  public async readiness(user: UserRecord): Promise<ApplicationReadiness> {
    if (!isApprovalRequiredRole(user.role)) {
      return { approvable: true, blockedBy: [] };
    }

    const blockedBy: ApplicationBlocker[] = [];

    if (user.role === 'MERCHANT') {
      // The store the approval would reuse. If it is already there, there is nothing left to
      // build, so nothing left to be blocked on.
      if (await this.merchantRepo.findByOwnerUserId(user.id)) {
        return { approvable: true, blockedBy: [] };
      }

      const details = storedDetails(user.registrationDetails);
      const tradeLicenseNumber = details?.tradeLicenseNumber;

      if (!tradeLicenseNumber) {
        blockedBy.push({
          code: 'TRADE_LICENCE_MISSING',
          field: 'details.tradeLicenseNumber',
          message:
            'This application carries no trade licence number, so its store cannot be created.',
          fixableByReviewer: false,
          remedy:
            'Nothing the reviewer can supply: the licence number has to come from the applicant, and this number already has an account on it.'
        });
      } else {
        const holder = await this.merchantRepo.findByTradeLicenseNumber(tradeLicenseNumber);
        if (holder && holder.ownerUserId !== user.id) {
          blockedBy.push({
            code: 'TRADE_LICENCE_IN_USE',
            field: 'details.tradeLicenseNumber',
            message: `Trade licence ${tradeLicenseNumber} is already held by another store.`,
            fixableByReviewer: false,
            remedy:
              'Reject it: approving would create a second store on a licence that is already spoken for, and only the applicant can sort out which store holds it.'
          });
        }
      }

      // Address last, so the order reads the way an operator would check the paperwork.
      if (!shopAddressFromApplication(user)) {
        blockedBy.push({
          code: 'SHOP_ADDRESS_MISSING',
          field: 'address',
          message:
            'This application has no shop address, so its store cannot be created without one.',
          fixableByReviewer: true,
          remedy:
            'Pass an `address` object in the approve body; the shop address can be taken down by phone and attached to the approval.'
        });
      }

      return { approvable: blockedBy.length === 0, blockedBy };
    }

    // A rider's profile is the identity record dispatch works from, so an application without
    // one has nothing to enable.
    if (await new RiderProfileRepository(this.client).findByUserId(user.id)) {
      return { approvable: true, blockedBy: [] };
    }

    const details = storedDetails(user.registrationDetails) ?? {};

    if (!details.nidNumber) {
      blockedBy.push({
        code: 'NID_MISSING',
        field: 'details.nidNumber',
        message: 'This application carries no NID number, so no rider profile can be created.',
        fixableByReviewer: true,
        remedy:
          'Pass `rider.nidNumber` in the approve body once the number has been read off the paperwork.'
      });
    }

    const vehicleType = details.vehicleType;
    if (!vehicleType) {
      blockedBy.push({
        code: 'VEHICLE_MISSING',
        field: 'details.vehicleType',
        message: 'This application names no vehicle, so the rider cannot be dispatched.',
        fixableByReviewer: true,
        remedy: `Pass \`rider.vehicleType\` in the approve body, one of ${RIDER_VEHICLE_TYPES.join(', ')}.`
      });
    } else if (!(RIDER_VEHICLE_TYPES as readonly string[]).includes(vehicleType)) {
      blockedBy.push({
        code: 'VEHICLE_INVALID',
        field: 'details.vehicleType',
        message: `Vehicle type '${vehicleType}' is not one the platform dispatches.`,
        fixableByReviewer: true,
        remedy: `Pass \`rider.vehicleType\` in the approve body, one of ${RIDER_VEHICLE_TYPES.join(', ')}.`
      });
    }

    return { approvable: blockedBy.length === 0, blockedBy };
  }

  public async review(
    userId: string,
    decision: 'APPROVE' | 'REJECT',
    admin: UserRecord,
    reason?: string,
    meta: SessionMeta = {},
    options: ReviewOptions = {}
  ): Promise<ReviewResult> {
    const target = await this.userRepo.findById(userId);
    if (!target) {
      throw new NotFoundError('Registration');
    }
    if (!isApprovalRequiredRole(target.role)) {
      throw new ValidationError(`${target.role} accounts are not subject to registration review`, {
        field: 'userId'
      });
    }

    const approvalStatus: ApprovalStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    if (target.approvalStatus === approvalStatus) {
      throw new ConflictError(`Registration is already ${approvalStatus.toLowerCase()}`);
    }

    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (decision === 'REJECT' && trimmedReason === '') {
      throw new ValidationError('A reason is required to reject a registration', { field: 'reason' });
    }

    // The decision and the profile it unlocks are one unit of work. An account that is
    // permitted but has no store to trade from, or no rider record to be dispatched to, is
    // the exact half-state approval is supposed to end — so if the profile cannot be built,
    // the approval does not stand either.
    const { user, profile } = await this.client.transaction(async (tx) => {
      const users = new UserRepository(tx);
      const audits = new AuditLogRepository(tx);

      const updated = await users.updateApproval(userId, {
        approvalStatus,
        reason: trimmedReason === '' ? null : trimmedReason.slice(0, 500),
        reviewedBy: admin.id
      });

      const seeded =
        decision === 'APPROVE'
          ? await this.seedOperationalProfile(tx, updated, options.address, options.rider)
          : null;

      await audits.log({
        id: newId('aud_'),
        userId: admin.id,
        action: `REGISTRATION_${decision}`,
        entityType: 'USER',
        entityId: userId,
        oldValues: JSON.stringify({ approvalStatus: target.approvalStatus ?? 'APPROVED' }),
        newValues: JSON.stringify({
          approvalStatus,
          reason: updated.approvalReason ?? null,
          profile: describeProfile(seeded),
          // Which fields the reviewer typed in themselves, so an identity number that came
          // from a phone call rather than an application is traceable. The values are not
          // recorded here: the profile holds them, and this log is not the place for a NID.
          suppliedByReviewer: reviewerSuppliedFields(options)
        }),
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
        sessionId: meta.sessionId ?? null
      });

      return { user: updated, profile: seeded };
    });

    logger.info('Registration reviewed', {
      userId,
      role: target.role,
      decision,
      reviewedBy: admin.id,
      seededProfile: profile?.role ?? null
    });

    if (decision === 'REJECT') {
      // A rejected applicant holds no role permissions and may be about to be refused at
      // sign-in; the notice is how the platform tells them a human looked and said no, and
      // it carries the reason the administrator wrote — in the record, not in the text.
      await this.notices.raise({
        type: 'REGISTRATION_REJECTED',
        userId: user.id,
        phone: user.phone,
        context: {
          role: target.role,
          reason: user.approvalReason ?? null,
          reviewedBy: admin.id
        }
      });
    }

    return { user, decision: approvalStatus, profile };
  }

  /**
   * Builds the operational profile a role cannot work without. Reuses whatever is already
   * there, so re-running an approval (or approving an account whose store was created by
   * another route) cannot produce a duplicate store or rider record.
   */
  private async seedOperationalProfile(
    tx: DatabaseClient,
    user: UserRecord,
    addressOverride?: ShopAddressInput,
    riderOverride?: RiderProfileOverride
  ): Promise<SeededProfile | null> {
    if (user.role === 'MERCHANT') {
      return { role: 'MERCHANT', merchant: await this.seedMerchantStore(tx, user, addressOverride) };
    }
    if (user.role === 'DRIVER') {
      return { role: 'DRIVER', rider: await this.seedRiderProfile(tx, user, riderOverride) };
    }
    return null;
  }

  /**
   * Creates the store, together with the shop address its `addressId` requires. The licence
   * is unique platform-wide, so a store that already holds it is a conflict rather than a
   * crash on the constraint.
   */
  private async seedMerchantStore(
    tx: DatabaseClient,
    user: UserRecord,
    addressOverride?: ShopAddressInput
  ): Promise<MerchantRecord> {
    const merchants = new MerchantRepository(tx);

    const existing = await merchants.findByOwnerUserId(user.id);
    if (existing) return existing;

    const details = storedDetails(user.registrationDetails);
    const tradeLicenseNumber = details?.tradeLicenseNumber;
    if (!tradeLicenseNumber) {
      throw new ValidationError(
        'This application carries no trade licence number, so its store cannot be created',
        { field: 'details.tradeLicenseNumber' }
      );
    }

    const holder = await merchants.findByTradeLicenseNumber(tradeLicenseNumber);
    if (holder) {
      throw new ConflictError(
        `Trade licence ${tradeLicenseNumber} is already held by another store`
      );
    }

    const address = addressOverride ?? shopAddressFromApplication(user);
    if (!address) {
      throw new ValidationError(
        'This application has no shop address, so its store cannot be created; supply one as `address` to approve it',
        { field: 'address' }
      );
    }

    const addressRow = await new AddressRepository(tx).create({
      id: newId('addr_'),
      userId: user.id,
      label: SHOP_ADDRESS_LABEL,
      streetAddress: address.streetAddress,
      area: address.area,
      district: address.district,
      postalCode: address.postalCode,
      latitude: address.latitude,
      longitude: address.longitude,
      isDefault: true,
      // A shop is a public place: its entrance is what a rider needs, and it is not the
      // owner's home, so it is not PII-restricted the way a customer address is.
      isPiiRestricted: false
    });

    return merchants.create({
      id: newId('merch_'),
      ownerUserId: user.id,
      businessName: details?.businessName ?? user.fullName,
      tradeLicenseNumber,
      description: details?.description ?? null,
      category: details?.category ?? DEFAULT_MERCHANT_CATEGORY,
      addressId: addressRow.id,
      phone: user.phone,
      isOpen: true,
      rating: 5.0
    });
  }

  /**
   * Creates the rider's identity and vehicle record from the application, or from what the
   * reviewer took down when the application arrived without it. Duty state starts OFF_DUTY:
   * an approved rider joins the roster, and decides for themselves when to work.
   *
   * The two errors name the field that is missing rather than 'details', because that is the
   * field the reviewer has to supply — and the same field the queue's readiness assessment
   * reports, so a flagged application and a refused approval point at one thing.
   */
  private async seedRiderProfile(
    tx: DatabaseClient,
    user: UserRecord,
    override?: RiderProfileOverride
  ): Promise<RiderProfileRecord> {
    const riders = new RiderProfileRepository(tx);

    const existing = await riders.findByUserId(user.id);
    if (existing) return existing;

    const details = storedDetails(user.registrationDetails) ?? {};
    const { licenseNumber, zoneId } = details;
    // Whatever the reviewer supplied wins; whatever they did not still comes from the
    // application. The reviewer's vehicle type is normalized the way registration normalizes
    // it, while a value already on the application is taken exactly as stored — a stored
    // value that never matched the list is a blocker the queue reports, not a typo to paper
    // over here.
    const nidNumber = override?.nidNumber ?? details.nidNumber;
    const vehicleType = override?.vehicleType ?? details.vehicleType;

    if (!nidNumber) {
      throw new ValidationError(
        'This application carries no NID number, so the rider profile cannot be created; supply one as `rider.nidNumber` to approve it',
        { field: 'details.nidNumber' }
      );
    }
    if (!vehicleType) {
      throw new ValidationError(
        'This application names no vehicle type, so the rider profile cannot be created; supply one as `rider.vehicleType` to approve it',
        { field: 'details.vehicleType' }
      );
    }
    if (!(RIDER_VEHICLE_TYPES as readonly string[]).includes(vehicleType)) {
      throw new ValidationError(
        `Field 'details.vehicleType' must be one of ${RIDER_VEHICLE_TYPES.join(', ')}`,
        { field: 'details.vehicleType' }
      );
    }

    return riders.create({
      userId: user.id,
      nidNumber,
      vehicleType: vehicleType as RiderVehicleType,
      licenseNumber: override?.licenseNumber ?? licenseNumber ?? null,
      zoneId: zoneId ?? null,
      dutyStatus: 'OFF_DUTY'
    });
  }
}

/**
 * The review options the reviewer typed in, as field names only.
 *
 * Accountability without copying an identity number into a log: which parts of the approval
 * came from the reviewer rather than the application is the part that is not reproducible
 * from the application alone.
 */
function reviewerSuppliedFields(options: ReviewOptions): string[] {
  const supplied: string[] = [];
  if (options.address) supplied.push('address');
  if (options.rider) {
    if (options.rider.nidNumber !== undefined) supplied.push('rider.nidNumber');
    if (options.rider.vehicleType !== undefined) supplied.push('rider.vehicleType');
    if (options.rider.licenseNumber !== undefined) supplied.push('rider.licenseNumber');
  }
  return supplied;
}

/** What the audit row records about a seeded profile: enough to trace it, no PII. */
function describeProfile(profile: SeededProfile | null): Record<string, unknown> | null {
  if (!profile) return null;
  if (profile.role === 'MERCHANT') {
    return {
      role: 'MERCHANT',
      merchantId: profile.merchant.id,
      addressId: profile.merchant.addressId,
      category: profile.merchant.category
    };
  }
  return {
    role: 'DRIVER',
    riderUserId: profile.rider.userId,
    vehicleType: profile.rider.vehicleType,
    dutyStatus: profile.rider.dutyStatus
  };
}
