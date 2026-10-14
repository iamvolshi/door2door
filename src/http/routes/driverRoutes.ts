import { ValidationError } from '../../core/errors';
import { maskAddress } from '../../auth/pii';
import {
  DUTY_STATUS_MEANINGS,
  RIDER_SETTABLE_DUTY_STATUSES,
  type RiderDuty,
  type RiderDutyService,
  type RiderRosterEntry
} from '../../auth/riderDutyService';
import {
  DEFAULT_DRIVER_ORDER_LIMIT,
  MAX_DRIVER_ORDER_LIMIT,
  MAX_ROSTER_LIMIT,
  type DriverOrderRow,
  type OrderRepository
} from '../../db/repositories';
import { ORDER_STATUSES, type OrderStatus, type UserRecord } from '../../db/schema';
import { authenticatedUser, type Route, type RouteResult } from '../httpUtils';

const API_PREFIX = '/api/v1';

/**
 * The duty states a roster read can be narrowed to, plus `ALL`.
 *
 * `OFF_DUTY` is a value here rather than a separate flag: an operator asking "who is off duty"
 * and one asking "who is on duty" are asking the same question with different answers, and the
 * roster already knows the difference.
 */
const ROSTER_DUTY_FILTERS = ['AVAILABLE', 'ON_DELIVERY', 'ON_BREAK', 'OFF_DUTY'] as const;
type RosterDutyFilter = (typeof ROSTER_DUTY_FILTERS)[number];

export interface DriverRouteDeps {
  /** Duty state and the roster; see src/auth/riderDutyService.ts. */
  riderDuty: RiderDutyService;
  /** The deliveries assigned to the caller; see OrderRepository.findByDriverId. */
  orderRepo: OrderRepository;
}

/** What a rider sees of their own state, including what each state means. */
export function serializeDuty(duty: RiderDuty): Record<string, unknown> {
  return {
    userId: duty.userId,
    dutyStatus: duty.dutyStatus,
    meaning: DUTY_STATUS_MEANINGS[duty.dutyStatus],
    available: duty.available,
    vehicleType: duty.vehicleType,
    zoneId: duty.zoneId,
    updatedAt: duty.updatedAt,
    settable: RIDER_SETTABLE_DUTY_STATUSES
  };
}

/** One rider as the roster shows them: who they are, what they ride, and whether to call them. */
export function serializeRosterEntry(entry: RiderRosterEntry): Record<string, unknown> {
  return {
    userId: entry.userId,
    fullName: entry.fullName,
    phone: entry.phone,
    vehicleType: entry.vehicleType,
    zoneId: entry.zoneId ?? null,
    dutyStatus: entry.dutyStatus,
    meaning: DUTY_STATUS_MEANINGS[entry.dutyStatus],
    available: entry.available,
    // When the rider last changed state, which is the closest thing to "on duty since" until
    // shifts are recorded as their own history.
    since: entry.updatedAt
  };
}

/**
 * One assigned order as its rider reads it.
 *
 * The delivery address is not assembled here: it goes through `maskAddress` — the platform's one
 * rule for who may read a client's door — carrying the viewer's role and the fact that this order
 * is assigned to them, which is the branch that rule already defines as full. The rule is asked,
 * not reimplemented, so the day the branch changes is the day every consumer changes with it.
 * What confines a rider to their own deliveries is not this function but the query that produced
 * the row (`driverId = <the token owner>`); the `isAssignedToCaller` flag is read out of the row
 * rather than assumed, so an operator's view of somebody else's order answers the way the rule
 * says it should.
 *
 * The customer's account id is never handed to the masking rule, and so cannot appear in the
 * reply: an address does not include whose account it belongs to, and an internal user id is not
 * something a rider has any use for.
 *
 * The customer's own note travels as the address's `deliveryInstructions`, through the same rule.
 * That is deliberate: the note is about getting to the door, so it is exactly as visible as the
 * door is, and a masked address cannot leak a note standing beside it.
 */
export function serializeDriverOrder(
  row: DriverOrderRow,
  viewer: UserRecord
): Record<string, unknown> {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    merchant: {
      id: row.merchantId,
      businessName: row.merchantName ?? null
    },
    deliveryAddress: row.addressId
      ? maskAddress(
          {
            id: row.addressId,
            label: row.addressLabel ?? undefined,
            streetAddress: row.streetAddress ?? undefined,
            area: row.addressArea ?? undefined,
            // The `addresses` table calls its city-level column `district`; the masking rule
            // speaks of `city`. One fact with two names, mapped rather than reinvented.
            city: row.addressDistrict ?? undefined,
            latitude: row.latitude ?? undefined,
            longitude: row.longitude ?? undefined,
            deliveryInstructions: row.specialInstructions ?? undefined
          },
          viewer.role,
          row.driverId === viewer.id
        )
      : null,
    totalBdt: row.totalBdt,
    deliveryFeeBdt: row.deliveryFeeBdt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/**
 * Narrows the list to one order state, or refuses a state the platform does not have.
 *
 * Validated against the schema's own list rather than passed through to the query, because
 * `?status=PREPARING_BURNT` would otherwise come back as an empty list — an answer that reads as
 * "you have no deliveries" when it means "that is not a thing".
 */
function parseOrderStatusFilter(raw: string | null): OrderStatus | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const value = raw.trim().toUpperCase();
  if (!(ORDER_STATUSES as readonly string[]).includes(value)) {
    throw new ValidationError(
      `Query 'status' must be one of ${ORDER_STATUSES.join(', ')}`,
      { field: 'status' }
    );
  }
  return value as OrderStatus;
}

/**
 * The page size, defaulted to the rider's working list rather than to everything they have ever
 * carried, and bounded so one request cannot ask for the whole history.
 */
function parseOrderLimit(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_DRIVER_ORDER_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_DRIVER_ORDER_LIMIT) {
    throw new ValidationError(
      `Query 'limit' must be an integer between 1 and ${MAX_DRIVER_ORDER_LIMIT}`,
      { field: 'limit' }
    );
  }
  return value;
}

/**
 * Accepts one of the four states, or `ALL`; absent means the working roster.
 *
 * `ALL` and "absent" are deliberately different answers: absent is "who can be given work",
 * which is what a dispatcher opens the roster for, while `ALL` is "everybody registered",
 * which is what an administrator auditing the fleet asks for.
 */
function parseRosterDutyFilter(raw: string | null): RosterDutyFilter | 'ALL' | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const value = raw.trim().toUpperCase();
  if (value === 'ALL') return 'ALL';
  if (!(ROSTER_DUTY_FILTERS as readonly string[]).includes(value)) {
    throw new ValidationError(
      `Query 'dutyStatus' must be one of ${ROSTER_DUTY_FILTERS.join(', ')}, ALL`,
      { field: 'dutyStatus' }
    );
  }
  return value as RosterDutyFilter;
}

function parseZoneFilter(raw: string | null): string | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const value = raw.trim();
  if (value.length > 60) {
    throw new ValidationError("Query 'zoneId' must be 60 characters or fewer", { field: 'zoneId' });
  }
  return value;
}

function parseRosterLimit(raw: string | null): number {
  if (raw === null || raw.trim() === '') return MAX_ROSTER_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_ROSTER_LIMIT) {
    throw new ValidationError(
      `Query 'limit' must be an integer between 1 and ${MAX_ROSTER_LIMIT}`,
      { field: 'limit' }
    );
  }
  return value;
}

export function createDriverRoutes(deps: DriverRouteDeps): Route[] {
  return [
    {
      method: 'GET',
      path: `${API_PREFIX}/drivers/me/duty`,
      requiresAuth: true,
      // Putting oneself on and off the roster is the rider's own decision, so the grant names
      // that rather than the profile they cannot edit.
      permission: 'rider:duty:own',
      handler: async (ctx): Promise<RouteResult> => {
        const duty = await deps.riderDuty.readOwnDuty(authenticatedUser(ctx));
        return { status: 200, body: { success: true, duty: serializeDuty(duty) } };
      }
    },
    {
      method: 'PATCH',
      path: `${API_PREFIX}/drivers/me/duty`,
      requiresAuth: true,
      permission: 'rider:duty:own',
      handler: async (ctx): Promise<RouteResult> => {
        // A status the rider sends, not a transition: "be AVAILABLE" is answered the same way
        // whether they already were or not, and the reply says which happened.
        const { rider, changed } = await deps.riderDuty.setDuty(
          authenticatedUser(ctx),
          ctx.body.status
        );

        return { status: 200, body: { success: true, changed, duty: serializeDuty(rider) } };
      }
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/drivers/roster`,
      requiresAuth: true,
      // Across every rider, which is why it is the platform-side grant and not the rider's own.
      permission: 'rider:read:all',
      handler: async (ctx): Promise<RouteResult> => {
        const zoneId = parseZoneFilter(ctx.query.get('zoneId'));
        const dutyStatus = parseRosterDutyFilter(ctx.query.get('dutyStatus'));
        const limit = parseRosterLimit(ctx.query.get('limit'));

        // Off duty is included only when it is asked for, one way or the other: a dispatcher
        // reading "who can take work" is not served by a list of everybody who cannot.
        const roster = await deps.riderDuty.roster({
          ...(zoneId ? { zoneId } : {}),
          includeOffDuty: dutyStatus === 'OFF_DUTY' || dutyStatus === 'ALL',
          limit
        });
        const entries =
          dutyStatus && dutyStatus !== 'ALL'
            ? roster.filter((entry) => entry.dutyStatus === dutyStatus)
            : roster;

        return {
          status: 200,
          body: {
            success: true,
            // Ordered by who can be given work first, so the head of this list is the answer
            // to the question a dispatcher is actually asking. Echoed back, because "nobody
            // is available" and "everybody is off duty and was not asked for" differ only by
            // what the caller asked for.
            count: entries.length,
            query: {
              zoneId: zoneId ?? null,
              dutyStatus: dutyStatus ?? null,
              includeOffDuty: dutyStatus === 'OFF_DUTY' || dutyStatus === 'ALL'
            },
            riders: entries.map(serializeRosterEntry)
          }
        };
      }
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/drivers/me/orders`,
      requiresAuth: true,
      // The deliveries that are the caller's to make. `order:read:driver` names exactly that,
      // and it is held by the rider role and by administrators.
      permission: 'order:read:driver',
      handler: async (ctx): Promise<RouteResult> => {
        const rider = authenticatedUser(ctx);
        const status = parseOrderStatusFilter(ctx.query.get('status'));
        const limit = parseOrderLimit(ctx.query.get('limit'));

        // Scoped by the token owner inside the statement, so there is no id here to guess and
        // nothing to authorise beyond being the rider the order was assigned to.
        const rows = await deps.orderRepo.findByDriverId(rider.id, {
          ...(status ? { status } : {}),
          limit
        });

        return {
          status: 200,
          body: {
            success: true,
            count: rows.length,
            // Echoed back, because "nothing is assigned to you" and "none of yours is PREPARING"
            // are different answers that an empty list tells apart by nothing at all.
            query: { status: status ?? null, limit },
            orders: rows.map((row) => serializeDriverOrder(row, rider))
          }
        };
      }
    }
  ];
}
