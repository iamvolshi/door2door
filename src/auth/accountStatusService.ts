import * as crypto from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../core/errors';
import { logger } from '../core/logger';
import type { DatabaseClient } from '../db/client';
import { AuditLogRepository, AuthRepository, UserRepository } from '../db/repositories';
import type { UserRecord } from '../db/schema';
import { SecurityNoticeService } from './securityNotices';
import type { SessionMeta } from './sessionService';

export interface AccountStatusServiceOptions {
  /**
   * How the account holder is warned. Overridable for tests; defaults to the account's own
   * notice list in this database plus an SMS attempt through the configured gateway.
   */
  notices?: SecurityNoticeService;
}

export interface AccountStatusChange {
  user: UserRecord;
  /** Sessions this call retired. Always 0 for a reinstatement — see the class doc. */
  revokedSessions: number;
}

/** Why an account cannot be suspended through this surface, when it cannot. */
function refuseUnmanageableTarget(target: UserRecord, admin: UserRecord): void {
  if (target.id === admin.id) {
    throw new ValidationError(
      'An administrator cannot change the status of their own account',
      { field: 'userId' }
    );
  }
  // Administrator accounts are provisioned rather than self-served, and there is no second
  // administrator to undo a mistake: suspending one is how a platform locks itself out.
  if (target.role === 'ADMIN') {
    throw new ValidationError(
      'Administrator accounts cannot be suspended or reinstated here',
      { field: 'userId' }
    );
  }
}

/**
 * Suspending and reinstating accounts.
 *
 * `users.isActive` is the platform's own answer to "may this account be used": phone login
 * refuses an inactive account, and token rotation refuses one too. What the flag did not do
 * on its own is *end* the sessions an account already holds — an access token is accepted
 * while the session that minted it is alive — so a suspension that only flipped the flag
 * would leave a suspended customer working for the remaining minutes of their token. A
 * suspension therefore deactivates and revokes in one transaction, and the change is
 * immediate for every device.
 *
 * This lives outside `RegistrationService` because it is not a registration decision:
 * nothing about the account's review state changes, and the merchant or rider profile it
 * already has is left alone. Reinstatement is deliberately not a notice of its own — it
 * restores access, it does not warn anybody — but it is the event that makes the suspension
 * notice readable, since a suspended account cannot sign in to read its list.
 */
export class AccountStatusService {
  private readonly client: DatabaseClient;
  private readonly userRepo: UserRepository;
  private readonly authRepo: AuthRepository;
  private readonly auditRepo: AuditLogRepository;
  private readonly notices: SecurityNoticeService;

  constructor(client: DatabaseClient, options: AccountStatusServiceOptions = {}) {
    this.client = client;
    this.userRepo = new UserRepository(client);
    this.authRepo = new AuthRepository(client);
    this.auditRepo = new AuditLogRepository(client);
    this.notices = options.notices ?? new SecurityNoticeService(client);
  }

  /** Finds the account a status change is about, or explains why it cannot be touched. */
  private async requireTarget(userId: string, admin: UserRecord): Promise<UserRecord> {
    const target = await this.userRepo.findById(userId);
    if (!target) {
      throw new NotFoundError('Account');
    }
    refuseUnmanageableTarget(target, admin);
    return target;
  }

  /**
   * Ends an account's access: it can no longer sign in, the sessions it holds are retired
   * there and then, and its owner is told why.
   */
  public async suspend(
    userId: string,
    admin: UserRecord,
    reason: string,
    meta: SessionMeta = {}
  ): Promise<AccountStatusChange> {
    const target = await this.requireTarget(userId, admin);

    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (trimmedReason === '') {
      throw new ValidationError('A reason is required to suspend an account', { field: 'reason' });
    }
    if (!target.isActive) {
      throw new ConflictError('This account is already suspended');
    }

    // One unit of work: an account that is deactivated without its sessions retired would
    // keep working, and sessions retired without the deactivation would let it sign back in.
    const { user, revokedSessions } = await this.client.transaction(async (tx) => {
      const updated = await new UserRepository(tx).updateStatus(userId, false);
      const retired = await new AuthRepository(tx).revokeSessionsForUser(userId);

      await new AuditLogRepository(tx).log({
        id: `aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
        userId: admin.id,
        action: 'ACCOUNT_SUSPENDED',
        entityType: 'USER',
        entityId: userId,
        oldValues: JSON.stringify({ isActive: true }),
        newValues: JSON.stringify({
          isActive: false,
          role: updated.role,
          reason: trimmedReason.slice(0, 500),
          revokedSessions: retired
        }),
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
        sessionId: meta.sessionId ?? null
      });

      return { user: updated, revokedSessions: retired };
    });

    logger.warn('Account suspended', {
      userId,
      role: user.role,
      suspendedBy: admin.id,
      revokedSessions
    });

    // The notice is written even though the account cannot sign in to read it. Reinstatement
    // restores access and the warning is waiting there; the list is the channel that does not
    // depend on a text message arriving, which is worth having precisely when the account is
    // locked out.
    await this.notices.raise({
      type: 'ACCOUNT_SUSPENDED',
      userId: user.id,
      phone: user.phone,
      context: {
        role: user.role,
        reason: trimmedReason.slice(0, 500),
        suspendedBy: admin.id
      }
    });

    return { user, revokedSessions };
  }

  /**
   * Restores an account, so a suspension is not a one-way door.
   *
   * The sessions retired at suspension stay retired: the owner signs in again, which is the
   * step that proves they still hold the phone, and which is where they find the notice
   * explaining what happened.
   */
  public async reinstate(
    userId: string,
    admin: UserRecord,
    meta: SessionMeta = {}
  ): Promise<AccountStatusChange> {
    const target = await this.requireTarget(userId, admin);
    if (target.isActive) {
      throw new ConflictError('This account is not suspended');
    }

    const user = await this.client.transaction(async (tx) => {
      const updated = await new UserRepository(tx).updateStatus(userId, true);

      await new AuditLogRepository(tx).log({
        id: `aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
        userId: admin.id,
        action: 'ACCOUNT_REINSTATED',
        entityType: 'USER',
        entityId: userId,
        oldValues: JSON.stringify({ isActive: false }),
        newValues: JSON.stringify({ isActive: true, role: updated.role }),
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
        sessionId: meta.sessionId ?? null
      });

      return updated;
    });

    logger.info('Account reinstated', { userId, role: user.role, reinstatedBy: admin.id });

    return { user, revokedSessions: 0 };
  }
}
