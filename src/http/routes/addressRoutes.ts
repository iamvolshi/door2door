import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../../core/errors';
import { authenticatedUser, type Route, type RouteResult } from '../httpUtils';
import type { DatabaseClient } from '../../db/client';
import type { AddressRepository, OrderRepository } from '../../db/repositories';
import type { AddressRecord } from '../../db/schema';
import {
  MAX_ADDRESSES_PER_CUSTOMER,
  parseAddressChanges,
  parseNewAddress
} from '../../services/addressRules';
import { assertDeliverableCoordinates } from '../../services/serviceAreaRules';

const API_PREFIX = '/api/v1';

export interface AddressRouteDeps {
  client: DatabaseClient;
  addressRepo: AddressRepository;
  orderRepo: OrderRepository;
}

/** The owner sees their own address in full; `isPiiRestricted` governs other viewers. */
export function serializeAddress(address: AddressRecord): Record<string, unknown> {
  return {
    id: address.id,
    label: address.label,
    streetAddress: address.streetAddress,
    area: address.area,
    district: address.district,
    postalCode: address.postalCode || null,
    latitude: address.latitude ?? null,
    longitude: address.longitude ?? null,
    isDefault: address.isDefault,
    isPiiRestricted: address.isPiiRestricted,
    createdAt: address.createdAt,
    updatedAt: address.updatedAt
  };
}

/**
 * Delivery addresses for the signed-in customer.
 *
 * Every statement that touches a row carries `userId = <token owner>` in its `WHERE`, so
 * ownership is enforced by the database rather than by a check the next caller might forget.
 * A row that exists but belongs to somebody else is reported as 404, not 403, so address ids
 * that are guessable cannot be used to discover that another customer's address exists.
 */
export function createAddressRoutes(deps: AddressRouteDeps): Route[] {
  const { addressRepo, orderRepo, client } = deps;

  /**
   * One of the customer's own addresses, or 404.
   *
   * An address that has been taken off the customer's list answers 404 like a stranger's does:
   * it is no longer something they can read, edit or order to by id, whatever it still means to
   * the orders that were delivered there.
   */
  async function requireOwnAddress(id: string, userId: string): Promise<AddressRecord> {
    const address = await addressRepo.findById(id);
    if (!address || address.userId !== userId || address.removedAt) {
      throw new NotFoundError('Address');
    }
    return address;
  }

  return [
    {
      method: 'GET',
      path: `${API_PREFIX}/addresses`,
      requiresAuth: true,
      permission: 'address:manage:own',
      handler: async (ctx): Promise<RouteResult> => {
        const customer = authenticatedUser(ctx);
        const addresses = await addressRepo.findByUserId(customer.id);
        return {
          status: 200,
          body: {
            success: true,
            count: addresses.length,
            defaultAddressId: addresses.find((address) => address.isDefault)?.id ?? null,
            addresses: addresses.map(serializeAddress)
          }
        };
      }
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/addresses`,
      requiresAuth: true,
      permission: 'address:manage:own',
      handler: async (ctx): Promise<RouteResult> => {
        const customer = authenticatedUser(ctx);
        const input = parseNewAddress(ctx.body);

        // Coordinates are optional — plenty of the pilot's addresses have none — but a pair
        // that *is* given has to be somewhere the fleet goes. Checked before the transaction,
        // so a refused address writes nothing: no row, and no default taken off the one it
        // would have replaced.
        if (input.latitude !== null && input.longitude !== null) {
          assertDeliverableCoordinates(input.latitude, input.longitude);
        }

        const address = await client.transaction(async () => {
          const existing = await addressRepo.countByUserId(customer.id);
          if (existing >= MAX_ADDRESSES_PER_CUSTOMER) {
            throw new ConflictError(
              `A customer can keep at most ${MAX_ADDRESSES_PER_CUSTOMER} delivery addresses`
            );
          }

          // The first address is the default whatever the request says, so a customer who
          // has saved one address can already place an order without naming it.
          const isFirst = existing === 0;
          const makeDefault = isFirst || input.wantsDefault;
          if (makeDefault && !isFirst) {
            await addressRepo.clearDefaults(customer.id);
          }

          return addressRepo.create({
            id: `addr_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            userId: customer.id,
            label: input.label,
            streetAddress: input.streetAddress,
            area: input.area,
            district: input.district,
            postalCode: input.postalCode,
            latitude: input.latitude,
            longitude: input.longitude,
            isDefault: makeDefault,
            // Starting restricted is the safe default: it is a policy flag, not user input.
            isPiiRestricted: true
          });
        });

        return { status: 201, body: { success: true, address: serializeAddress(address) } };
      }
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/addresses/:addressId`,
      requiresAuth: true,
      permission: 'address:manage:own',
      handler: async (ctx): Promise<RouteResult> => {
        const customer = authenticatedUser(ctx);
        const address = await requireOwnAddress(ctx.params.addressId, customer.id);
        return { status: 200, body: { success: true, address: serializeAddress(address) } };
      }
    },
    {
      method: 'PATCH',
      path: `${API_PREFIX}/addresses/:addressId`,
      requiresAuth: true,
      permission: 'address:manage:own',
      handler: async (ctx): Promise<RouteResult> => {
        const customer = authenticatedUser(ctx);
        const changes = parseAddressChanges(ctx.body);

        // Only a pair this request supplies is judged. A saved row keeps the coordinates it was
        // accepted with until somebody moves it — including a row saved before this rule
        // existed — and an edit that changes nothing else does not become a coordinate change
        // by being sent again.
        if (changes.latitude !== undefined && changes.longitude !== undefined) {
          assertDeliverableCoordinates(changes.latitude, changes.longitude);
        }

        const updated = await client.transaction(async () => {
          // Confirms ownership (and existence) before anything is written.
          await requireOwnAddress(ctx.params.addressId, customer.id);

          const promote = changes.wantsDefault === true;
          if (promote) {
            await addressRepo.clearDefaults(customer.id);
          }

          return addressRepo.updateOwned(
            ctx.params.addressId,
            customer.id,
            {
              label: changes.label,
              streetAddress: changes.streetAddress,
              area: changes.area,
              district: changes.district,
              postalCode: changes.postalCode,
              latitude: changes.latitude,
              longitude: changes.longitude
            },
            changes.wantsDefault === undefined ? {} : { asDefault: changes.wantsDefault }
          );
        });

        if (!updated) throw new NotFoundError('Address');
        return { status: 200, body: { success: true, address: serializeAddress(updated) } };
      }
    },
    {
      method: 'DELETE',
      path: `${API_PREFIX}/addresses/:addressId`,
      requiresAuth: true,
      permission: 'address:manage:own',
      handler: async (ctx): Promise<RouteResult> => {
        const customer = authenticatedUser(ctx);

        const outcome = await client.transaction(async () => {
          const existing = await requireOwnAddress(ctx.params.addressId, customer.id);

          // An order keeps naming where it was delivered, and the foreign key stops the delete
          // anyway — but the customer asked for this address off their list, and they can have
          // that without losing the deliveries: the row is detached, not deleted. It leaves
          // every listing and stops answering to its id, and survives only as the address those
          // orders were sent to, which the order itself now also carries a copy of. An address
          // no order names is still deleted outright, because nothing needs it any more.
          const usedByOrders = await orderRepo.countByDeliveryAddressId(existing.id);
          if (usedByOrders > 0) {
            const detached = await addressRepo.markRemoved(
              existing.id,
              customer.id,
              new Date().toISOString()
            );
            if (!detached) throw new NotFoundError('Address');
          } else {
            const removed = await addressRepo.removeOwned(existing.id, customer.id);
            if (!removed) throw new NotFoundError('Address');
          }

          // Losing the default silently would make a later order-without-address fail for
          // no visible reason, so the next newest address takes over — including when the
          // default is the one that just left the list.
          let promoted: AddressRecord | null = null;
          if (existing.isDefault) {
            const remaining = await addressRepo.findByUserId(customer.id);
            if (remaining.length > 0) {
              promoted = await addressRepo.markDefault(remaining[0].id, customer.id);
            }
          }
          return {
            removedId: existing.id,
            outcome: usedByOrders > 0 ? ('DETACHED' as const) : ('DELETED' as const),
            ordersKeepingIt: usedByOrders,
            promoted
          };
        });

        return {
          status: 200,
          body: {
            success: true,
            deletedAddressId: outcome.removedId,
            // Named rather than left to be discovered: `DETACHED` tells a client that orders
            // still name this address, so the screen can say so instead of the address simply
            // reappearing in the history it was removed from.
            outcome: outcome.outcome,
            ordersKeepingIt: outcome.ordersKeepingIt,
            defaultAddressId: outcome.promoted?.id ?? null
          }
        };
      }
    }
  ];
}
