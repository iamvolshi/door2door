import { ConflictError, NotFoundError, ValidationError } from '../core/errors';
import { logger } from '../core/logger';
import type { DatabaseClient } from '../db/client';
import { RiderProfileRepository, type RiderRosterRow } from '../db/repositories';
import type { RiderDutyStatus, RiderProfileRecord, UserRecord } from '../db/schema';

/**
 * A rider's working state, and who is on the roster.
 *
 * A rider profile is created by approval and starts `OFF_DUTY`, and until this existed nothing
 * could move it: the state dispatch depends on was only reachable by editing the database. The
 * vocabulary is the schema's own — `OFF_DUTY`, `AVAILABLE`, `ON_DELIVERY`, `ON_BREAK` — and the
 * rider owns exactly three of the four. `ON_DELIVERY` is not theirs to claim: it is set while
 * an order is in their hands, so a rider who could set it could take themselves off the roster
 * with a delivery still on the way, or appear to be carrying one they are not.
 */

/** The duty states a rider may set on themselves, in the order the platform talks about them. */
export const RIDER_SETTABLE_DUTY_STATUSES: readonly RiderDutyStatus[] = [
  'AVAILABLE',
  'ON_BREAK',
  'OFF_DUTY'
];

/**
 * What each state means, in the words a client can show. Kept beside the states themselves so
 * a rider-facing screen and an operator reading the code cannot describe the same state
 * differently.
 */
export const DUTY_STATUS_MEANINGS: Record<RiderDutyStatus, string> = {
  AVAILABLE: 'On duty and ready to be given work.',
  ON_BREAK: 'On duty but not taking new work.',
  ON_DELIVERY: 'Carrying a delivery, which dispatch sets and clears.',
  OFF_DUTY: 'Not on the roster.'
};

/** A rider's duty state as the API reports it, including what a dispatcher would ask next. */
export interface RiderDuty {
  userId: string;
  dutyStatus: RiderDutyStatus;
  /** True only while the rider can be handed new work right now. */
  available: boolean;
  vehicleType: RiderProfileRecord['vehicleType'];
  zoneId: string | null;
  /** The last duty change, which is what an operator reads as "since when?". */
  updatedAt: string;
}

export interface RiderRosterEntry extends RiderRosterRow {
  /** True only while the rider can be handed new work right now. */
  available: boolean;
}

export interface DutyChange {
  rider: RiderDuty;
  /** False when the rider asked for the state they were already in. */
  changed: boolean;
}

export interface RosterQuery {
  zoneId?: string;
  includeOffDuty?: boolean;
  limit?: number;
}

function toDuty(profile: RiderProfileRecord): RiderDuty {
  return {
    userId: profile.userId,
    dutyStatus: profile.dutyStatus,
    available: profile.dutyStatus === 'AVAILABLE',
    vehicleType: profile.vehicleType,
    zoneId: profile.zoneId ?? null,
    updatedAt: profile.updatedAt
  };
}

/**
 * Reads a rider's own duty state, or explains why there is none to read.
 *
 * A missing profile is a not-found rather than a forbidden: the account is a rider and holds
 * the grant, it simply has no rider record — which is the state an approved rider can only be
 * in if something went wrong between approval and profile creation.
 */
export class RiderDutyService {
  private readonly profiles: RiderProfileRepository;

  constructor(client: DatabaseClient) {
    this.profiles = new RiderProfileRepository(client);
  }

  /** The caller's own duty state. `404` when the account has no rider profile. */
  public async readOwnDuty(user: UserRecord): Promise<RiderDuty> {
    const profile = await this.profiles.findByUserId(user.id);
    if (!profile) {
      throw new NotFoundError(
        'Rider profile: this account has none, so it has no duty state to read or change'
      );
    }
    return toDuty(profile);
  }

  /**
   * Puts a rider on or off duty.
   *
   * Asking for the state you are already in is answered rather than refused — the reply says
   * what actually changed, which is nothing — because a client on a flaky connection retrying
   * "go available" is not making an error. That is the same choice the notice list makes for a
   * second acknowledgement: report the no-op instead of failing it.
   *
   * The one refusal that is about state rather than input is leaving `ON_DELIVERY`, which the
   * rider cannot do until the delivery is handed over or taken back by dispatch.
   */
  public async setDuty(user: UserRecord, rawStatus: unknown): Promise<DutyChange> {
    const requested = parseDutyStatus(rawStatus);

    const profile = await this.profiles.findByUserId(user.id);
    if (!profile) {
      throw new NotFoundError(
        'Rider profile: this account has none, so it has no duty state to read or change'
      );
    }

    if (profile.dutyStatus === 'ON_DELIVERY') {
      throw new ConflictError(
        'A rider carrying a delivery stays on the roster until it is handed over; dispatch is what clears ON_DELIVERY'
      );
    }

    if (profile.dutyStatus === requested) {
      logger.info('Rider duty unchanged', { userId: user.id, dutyStatus: requested });
      return { rider: toDuty(profile), changed: false };
    }

    // The guard against a delivery landing mid-request is in the statement itself, so this
    // cannot turn a dispatch assignment into a rider who is simply gone.
    const updated = await this.profiles.setDutyStatusUnlessDelivering(user.id, requested);
    if (!updated) {
      const after = await this.profiles.findByUserId(user.id);
      if (!after) {
        throw new NotFoundError('Rider profile: this account has none, so it has no duty state');
      }
      throw new ConflictError(
        `Duty could not be changed: this rider is ${after.dutyStatus}, which dispatch clears`
      );
    }

    logger.info('Rider duty changed', {
      userId: user.id,
      from: profile.dutyStatus,
      to: updated.dutyStatus
    });
    return { rider: toDuty(updated), changed: true };
  }

  /**
   * The roster a dispatcher works from: who is on duty, what they ride and where.
   *
   * Read-only by design. Nothing here changes a rider's state, and suspension is what removes
   * somebody from it — an account the platform has closed is not a rider who can be sent
   * somewhere.
   */
  public async roster(query: RosterQuery = {}): Promise<RiderRosterEntry[]> {
    const rows = await this.profiles.listRoster(query);
    return rows.map((row) => ({ ...row, available: row.dutyStatus === 'AVAILABLE' }));
  }
}

/**
 * Reads the requested duty state, and refuses the ones a rider does not own.
 *
 * The message names `AVAILABLE` explicitly because "on duty" is how the states are talked
 * about, and a caller who sends `ON_DUTY` should be told what the platform actually calls it
 * rather than being left to guess from a list.
 */
function parseDutyStatus(raw: unknown): RiderDutyStatus {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationError(
      `Field 'status' is required and must be one of ${RIDER_SETTABLE_DUTY_STATUSES.join(', ')}`,
      { field: 'status' }
    );
  }

  const value = raw.trim().toUpperCase();
  if (value === 'ON_DELIVERY') {
    throw new ValidationError(
      "Field 'status' cannot be ON_DELIVERY: dispatch sets and clears it while an order is in the rider's hands",
      { field: 'status' }
    );
  }
  if (!(RIDER_SETTABLE_DUTY_STATUSES as readonly string[]).includes(value)) {
    throw new ValidationError(
      `Field 'status' must be one of ${RIDER_SETTABLE_DUTY_STATUSES.join(', ')} (on duty is AVAILABLE)`,
      { field: 'status' }
    );
  }

  return value as RiderDutyStatus;
}
