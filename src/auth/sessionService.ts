import * as crypto from 'crypto';
import { ForbiddenError, NotFoundError, TokenReuseError, UnauthorizedError } from '../core/errors';
import { logger } from '../core/logger';
import type { DatabaseClient } from '../db/client';
import { AuditLogRepository, AuthRepository, UserRepository } from '../db/repositories';
import type { AuthSessionRecord, AuthSessionView, UserRecord } from '../db/schema';
import { SecurityNoticeService } from './securityNotices';
import { generateTokenPair, verifyToken, type TokenPayload } from './tokens';

export const ACCESS_TOKEN_TTL_SECONDS = 900; // 15 minutes
export const REFRESH_TOKEN_TTL_SECONDS = 604800; // 7 days

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresInSeconds: number;
  refreshExpiresAt: string;
  tokenType: 'Bearer';
}

export interface SessionMeta {
  ipAddress?: string;
  userAgent?: string;
  /**
   * The session the request being handled came through, when it was authenticated.
   *
   * Carried here so that the audit rows written deeper in than the route — a session ended by
   * its owner, an account suspended by an administrator — say which login asked for it, the
   * same way the rows written by the route itself do.
   */
  sessionId?: string;
}

export interface SessionServiceOptions {
  /**
   * How the owner is warned. Overridable for tests; defaults to the account's own notice
   * list in this database plus an SMS attempt through the configured gateway.
   */
  notices?: SecurityNoticeService;
}

/** Refresh tokens are persisted only as a SHA-256 digest, never in plaintext. */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** A session written before families existed is its own family root. */
function familyRootOf(session: AuthSessionRecord): string {
  return session.familyId ?? session.id;
}

/**
 * Owns the refresh-token half of authentication.
 *
 * Every login opens a *session family* — a rotation chain of single-use refresh tokens.
 * Using a token retires it immediately, so seeing one a second time means it was either
 * stolen or replayed by a client that lost a race. The two are indistinguishable, so the
 * whole family is revoked: the attacker's copy and the legitimate client's current token
 * both stop working, and only a fresh login (a new family) restores access. Sessions from
 * other logins are untouched, so burning one device does not sign the account out
 * everywhere.
 */
export class SessionService {
  private readonly client: DatabaseClient;
  private readonly authRepo: AuthRepository;
  private readonly userRepo: UserRepository;
  private readonly auditRepo: AuditLogRepository;
  private readonly notices: SecurityNoticeService;

  constructor(client: DatabaseClient, options: SessionServiceOptions = {}) {
    this.client = client;
    this.authRepo = new AuthRepository(client);
    this.userRepo = new UserRepository(client);
    this.auditRepo = new AuditLogRepository(client);
    this.notices = options.notices ?? new SecurityNoticeService(client);
  }

  /**
   * Every session the account still holds, newest first.
   *
   * What a person means by "my devices": rotation retires the row it replaces, so a chain of
   * refreshes is one entry however many times the token has been exchanged, and a session whose
   * refresh token has run out is excluded because nobody is holding it any more.
   *
   * The token digest is not part of what this answers with — see `AuthSessionView` for why that
   * is a type rather than a habit.
   */
  public listActiveSessions(userId: string): Promise<AuthSessionView[]> {
    return this.authRepo.listLiveSessionsForUser(userId);
  }

  /**
   * Ends every session the account holds, including the one that asked.
   *
   * This is the account owner's own panic button: a phone left in a taxi, a shared laptop, a
   * token that may have been read over a shoulder. Rotation and reuse detection already revoke
   * one family each, which is what makes a *stolen* token survivable; what they cannot do is
   * end the sessions the owner signed in on and no longer trusts, because nothing knows which
   * those are except the owner. Since an access token is only accepted while the session behind
   * it exists and is not revoked, revoking here also kills the fifteen-minute tail of every
   * token already minted — the caller's own included, which is why the reply says so instead of
   * leaving a client to discover it on its next request.
   *
   * The read and the write share one transaction, so the count is the number of sessions that
   * were genuinely live when the call ran rather than a number half of which a concurrent login
   * produced, and a login racing this call is either counted or left alone, never miscounted.
   *
   * A security notice is deliberately not raised. A notice exists to tell the owner about
   * something they probably did not do (see SecurityNoticeService); this is something only they
   * can do, on purpose, and waking a phone at 2am to confirm a button the owner just pressed
   * would train them to ignore the channel that matters. The audit row below is the record.
   */
  public async revokeAllSessions(
    userId: string,
    currentSessionId: string,
    meta: SessionMeta = {}
  ): Promise<{ revokedSessions: number; currentSessionRevoked: boolean }> {
    const outcome = await this.client.transaction(async (tx) => {
      const authRepo = new AuthRepository(tx);
      const auditRepo = new AuditLogRepository(tx);

      const live = await authRepo.listLiveSessionsForUser(userId);
      // Whether the caller's own session is among them decides what the reply promises, and it
      // is read here so the answer and the effect come from the same transaction.
      const currentSessionRevoked = live.some((session) => session.id === currentSessionId);
      // Every row still marked live, expired leftovers included: the column is retired with the
      // session it describes, so nothing is left claiming to be a usable session.
      const retiredRows = await authRepo.revokeSessionsForUser(userId);

      await auditRepo.log({
        id: `aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
        userId,
        action: 'SESSIONS_REVOKED_ALL',
        entityType: 'USER',
        entityId: userId,
        oldValues: JSON.stringify({
          sessionIds: live.map((session) => session.id),
          revokedSessions: live.length
        }),
        newValues: JSON.stringify({ retiredRows, currentSessionRevoked }),
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
        sessionId: meta.sessionId ?? null
      });

      return { revokedSessions: live.length, retiredRows, currentSessionRevoked };
    });

    logger.warn('Every session for an account was revoked by its owner', {
      userId,
      currentSessionId,
      revokedSessions: outcome.revokedSessions,
      retiredRows: outcome.retiredRows,
      ipAddress: meta.ipAddress
    });

    return {
      revokedSessions: outcome.revokedSessions,
      currentSessionRevoked: outcome.currentSessionRevoked
    };
  }

  /**
   * Ends one of the account's own sessions — the device it no longer trusts, leaving the one
   * it is holding signed in.
   *
   * This is the same decision as the panic button above, cut to one device: a phone left in a
   * taxi is not a reason to sign the owner out of the laptop they are working on. The session
   * is revoked and the trail row recording it is written in one transaction, because a device
   * cut off with no record of who cut it off is the state an incident cannot reconstruct.
   *
   * Three ways to name a session that cannot be ended — somebody else's, an id that names
   * nothing, and one this account already ended — are answered identically, as not found. That
   * is deliberate: distinguishing them would tell a caller which session ids exist for other
   * accounts, which is the one thing a session id must never be worth. The scoping is in the
   * UPDATE itself rather than a read before it (see `revokeSessionForUser`).
   *
   * No security notice is raised, for the reason `revokeAllSessions` records: the owner did it
   * on purpose. When the caller names the session its own request came through, the reply says
   * so instead of leaving the client to discover it on its next call.
   */
  public async endSession(
    userId: string,
    sessionId: string,
    currentSessionId: string,
    meta: SessionMeta = {}
  ): Promise<{ sessionId: string; currentSessionRevoked: boolean }> {
    const outcome = await this.client.transaction(async (tx) => {
      const authRepo = new AuthRepository(tx);
      const revoked = await authRepo.revokeSessionForUser(userId, sessionId);
      if (!revoked) return { revoked, currentSessionRevoked: false };

      const currentSessionRevoked = sessionId === currentSessionId;
      await new AuditLogRepository(tx).log({
        id: `aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
        userId,
        action: 'SESSION_REVOKED',
        entityType: 'SESSION',
        entityId: sessionId,
        // The session named is the one that was ended; `sessionId` below is the session the
        // request came through, which is a different row whenever the owner ended a device
        // other than the one in their hand.
        oldValues: JSON.stringify({ sessionId, endedBy: currentSessionId }),
        newValues: JSON.stringify({ currentSessionRevoked }),
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
        sessionId: meta.sessionId ?? null
      });

      return { revoked, currentSessionRevoked };
    });

    if (!outcome.revoked) {
      throw new NotFoundError('Live session');
    }

    logger.warn('A session was ended by its owner', {
      userId,
      sessionId,
      currentSessionId,
      currentSessionRevoked: outcome.currentSessionRevoked,
      ipAddress: meta.ipAddress
    });

    return { sessionId, currentSessionRevoked: outcome.currentSessionRevoked };
  }

  /** A login opens a brand-new family. */
  public async startSession(user: UserRecord, meta: SessionMeta = {}): Promise<IssuedSession> {
    return this.issue(user, meta);
  }

  /**
   * Exchanges a refresh token for a fresh pair inside the same family.
   *
   * The presented token is claimed with a compare-and-set that only succeeds while it is
   * still live, so a replay — concurrent or later — fails instead of quietly minting a
   * second session.
   */
  public async rotate(refreshToken: string, meta: SessionMeta = {}): Promise<IssuedSession> {
    const payload = verifyToken<TokenPayload>(refreshToken, 'refresh');
    const tokenHash = hashToken(refreshToken);

    const session = await this.authRepo.getSessionByTokenHash(tokenHash);
    if (!session) {
      throw new UnauthorizedError('Session is no longer valid');
    }
    // A token that names a different session than the row it hashes to is malformed, not
    // merely old: tokens issued before sessions were bound carry no session id at all.
    if (payload.sessionId !== undefined && payload.sessionId !== session.id) {
      throw new UnauthorizedError('Refresh token does not belong to the session it names');
    }
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      throw new UnauthorizedError('Session has expired');
    }

    const user = await this.userRepo.findById(payload.userId);
    if (!user) {
      throw new UnauthorizedError('Session user no longer exists');
    }
    if (!user.isActive) {
      throw new ForbiddenError('Account is inactive');
    }

    const nextSessionId = this.newSessionId();
    const claimed = await this.authRepo.markSessionRotated(tokenHash, nextSessionId);
    if (!claimed) {
      // Already rotated or revoked: someone replayed a spent token.
      throw await this.reportReuse(session, user, meta);
    }

    const familyId = familyRootOf(session);
    const issued = await this.issue(user, meta, familyId, nextSessionId);

    logger.info('Session rotated', {
      userId: user.id,
      previousSessionId: session.id,
      sessionId: issued.sessionId,
      familyId
    });

    return issued;
  }

  /** Returns true only when this call actually retired a live session. */
  public async revoke(refreshToken: string): Promise<boolean> {
    const tokenHash = hashToken(refreshToken);
    const session = await this.authRepo.getSessionByTokenHash(tokenHash);
    if (!session || session.isRevoked) {
      return false;
    }

    await this.authRepo.revokeSessionByTokenHash(tokenHash);
    logger.info('Session revoked', { sessionId: session.id, userId: session.userId });
    return true;
  }

  /**
   * Returns the id of the live session a token names, or throws.
   *
   * Access tokens carry the id of the session that minted them, so a bearer request costs
   * one primary-key lookup and dies the moment its session is retired — by rotation,
   * logout, or a burned family. Without this, revoking a chain would leave a 15-minute
   * tail in which the access token it issued still opened routes.
   *
   * A token that names no session was minted before sessions were bound to access tokens;
   * its liveness cannot be checked, so it is refused rather than trusted.
   */
  public async requireLiveSession(sessionId: string | undefined): Promise<string> {
    if (!sessionId) {
      throw new UnauthorizedError('Access token is not bound to a session; sign in again');
    }

    const session = await this.authRepo.getSessionById(sessionId);
    if (!session) {
      throw new UnauthorizedError('Access token does not name a known session');
    }
    if (session.isRevoked) {
      throw new UnauthorizedError('This session was revoked; sign in again');
    }

    return session.id;
  }

  /**
   * A spent refresh token was presented again. Revoking the family also kills the token the
   * legitimate client is holding, which is the point: until the account re-authenticates,
   * neither side can use the chain. The incident is logged and audited.
   */
  private async reportReuse(
    session: AuthSessionRecord,
    user: UserRecord,
    meta: SessionMeta
  ): Promise<TokenReuseError> {
    const familyId = familyRootOf(session);
    const revokedSessions = await this.authRepo.revokeSessionFamily(familyId);

    logger.error('Refresh token reuse detected; session family revoked', undefined, {
      userId: user.id,
      familyId,
      reusedSessionId: session.id,
      replacedBy: session.replacedBy ?? null,
      revokedSessions,
      ipAddress: meta.ipAddress
    });

    await this.auditRepo.log({
      id: `aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
      userId: user.id,
      action: 'REFRESH_TOKEN_REUSE_DETECTED',
      entityType: 'USER',
      entityId: user.id,
      oldValues: JSON.stringify({
        reusedSessionId: session.id,
        replacedBy: session.replacedBy ?? null
      }),
      newValues: JSON.stringify({ familyId, revokedSessions }),
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
      // A refresh is authenticated by the token rather than by a bearer header, but the
      // request does come through a session: the one the presented token belongs to. Naming
      // it here is what makes an incident readable straight from the trail — "this session
      // presented a spent token" — rather than only from the family inside `newValues`.
      sessionId: session.id
    });

    // The owner is told their session was ended, because a family burn signs them out of
    // the device they are holding — a notice they never receive looks exactly like the
    // platform breaking. Two channels, and the order is the point: the durable row in the
    // account's own notice list is written *before* this 401 leaves the process, so the
    // owner finds the warning the next time they sign in — even though a family burn is
    // exactly the moment they lost the handset that would have received the SMS. The SMS
    // itself is attempted afterwards, off the request path, because the 401 must not wait
    // on a gateway (see SecurityNoticeService).
    await this.notices.raise({
      type: 'SESSION_REVOKED',
      userId: user.id,
      phone: user.phone,
      context: { familyId, reusedSessionId: session.id }
    });

    return new TokenReuseError(undefined, { revokedSessions });
  }

  private newSessionId(): string {
    return `sess_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  }

  /**
   * `familyId` and `sessionId` are supplied when rotating: the new session keeps its chain
   * root and reuses the id that was already recorded on the token it replaces.
   */
  private async issue(
    user: UserRecord,
    meta: SessionMeta,
    familyId?: string,
    sessionId?: string
  ): Promise<IssuedSession> {
    // The session id is chosen first so both tokens can name it: an access token is only
    // accepted while the session behind it is alive (see `authenticateRequest`).
    const id = sessionId ?? this.newSessionId();
    const pair = generateTokenPair(
      { id: user.id, role: user.role, email: user.email, phone: user.phone },
      ACCESS_TOKEN_TTL_SECONDS,
      REFRESH_TOKEN_TTL_SECONDS,
      { sessionId: id }
    );

    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();

    await this.authRepo.createSession({
      id,
      userId: user.id,
      tokenHash: hashToken(pair.refreshToken),
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
      expiresAt: refreshExpiresAt,
      isRevoked: false,
      familyId: familyId ?? id,
      replacedBy: null
    });

    logger.info('Session issued', { userId: user.id, sessionId: id, role: user.role, familyId: familyId ?? id });

    return {
      sessionId: id,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      accessExpiresInSeconds: pair.expiresIn,
      refreshExpiresAt,
      tokenType: pair.tokenType
    };
  }
}
