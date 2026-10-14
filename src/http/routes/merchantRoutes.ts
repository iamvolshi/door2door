import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../../core/errors';
import { logger } from '../../core/logger';
import {
  DEFAULT_MERCHANT_CATEGORY,
  SHOP_ADDRESS_LABEL
} from '../../auth/registrationService';
import type { DatabaseClient } from '../../db/client';
import {
  AddressRepository,
  AuditLogRepository,
  MerchantRepository
} from '../../db/repositories';
import type { AddressRecord, MerchantRecord } from '../../db/schema';
import {
  parseMerchantProfileChanges,
  parseNewMerchantProfile
} from '../../services/merchantProfileRules';
import { authenticatedUser, sessionMetaFromRequest, type Route, type RouteResult } from '../httpUtils';
import { serializeAddress } from './addressRoutes';

const API_PREFIX = '/api/v1';

export interface MerchantRouteDeps {
  client: DatabaseClient;
  merchantRepo: MerchantRepository;
  addressRepo: AddressRepository;
}

/**
 * A store as its owner sees it: the shopfront they can change, and the facts they cannot.
 *
 * The read-only fields are shown rather than hidden — a merchant has to be able to see the
 * licence it trades under and the rating it has earned — and `editable` names what a `PATCH`
 * will accept, so a client does not have to discover the boundary by being refused.
 */
export function serializeMerchantProfile(
  merchant: MerchantRecord,
  address: AddressRecord | null
): Record<string, unknown> {
  return {
    id: merchant.id,
    businessName: merchant.businessName,
    description: merchant.description ?? null,
    category: merchant.category,
    isOpen: merchant.isOpen,
    createdAt: merchant.createdAt,
    updatedAt: merchant.updatedAt,
    // Not editable here; each is refused by name if a request tries to change it.
    tradeLicenseNumber: merchant.tradeLicenseNumber,
    phone: merchant.phone,
    rating: merchant.rating,
    addressId: merchant.addressId,
    address: address ? serializeAddress(address) : null,
    editable: ['businessName', 'description', 'category', 'isOpen', 'address']
  };
}

/** The profile's own fields, plus the shop's location, as the audit row records them. */
function describeProfile(
  merchant: MerchantRecord,
  address: AddressRecord | null
): Record<string, unknown> {
  return {
    businessName: merchant.businessName,
    description: merchant.description ?? null,
    category: merchant.category,
    isOpen: merchant.isOpen,
    address: address
      ? {
          streetAddress: address.streetAddress,
          area: address.area,
          district: address.district,
          postalCode: address.postalCode || null
        }
      : null
  };
}

/** Which parts of the profile this request actually moved, for the audit row and the reply. */
function describeChanges(
  merchant: MerchantRecord,
  updated: MerchantRecord,
  before: AddressRecord | null,
  after: AddressRecord | null
): string[] {
  const changed: string[] = [];
  if (merchant.businessName !== updated.businessName) changed.push('businessName');
  if ((merchant.description ?? null) !== (updated.description ?? null)) changed.push('description');
  if (merchant.category !== updated.category) changed.push('category');
  if (merchant.isOpen !== updated.isOpen) changed.push('isOpen');
  if (before !== after) changed.push('address');
  return changed;
}

/**
 * The business profile of the store the caller owns.
 *
 * Ownership is the query rather than a check: the store is found by `ownerUserId`, so there is
 * no id in the path for a merchant to guess and nothing to authorise beyond being the owner. A
 * merchant whose store is missing answers `404` from the read — approval is what creates one, so
 * that is "approved with no store", never "not a merchant" — and `POST` on this same path is how
 * that merchant opens one; a customer or rider is refused by the permission before any handler
 * runs.
 */
export function createMerchantRoutes(deps: MerchantRouteDeps): Route[] {
  const { client } = deps;

  return [
    {
      method: 'POST',
      path: `${API_PREFIX}/merchant/profile`,
      requiresAuth: true,
      permission: 'merchant:manage:own',
      handler: async (ctx): Promise<RouteResult> => {
        const owner = authenticatedUser(ctx);
        const input = parseNewMerchantProfile(ctx.body);
        const meta = sessionMetaFromRequest(ctx);

        // The store, the shop address it points at and the trail row are one unit of work: a
        // store whose `addressId` names a row that was never written is a shop nobody can find,
        // and a licence checked outside the write is a licence another store can take in the
        // window between the check and the insert. `BEGIN IMMEDIATE` is what makes the two
        // statements atomic *and* serialised against a second caller.
        const created = await client.transaction(async (tx) => {
          const merchants = new MerchantRepository(tx);
          const addresses = new AddressRepository(tx);
          const audits = new AuditLogRepository(tx);

          // One store per account, and the read that says so is inside the transaction rather
          // than a check the next caller can race.
          const existing = await merchants.findByOwnerUserId(owner.id);
          if (existing) {
            throw new ConflictError(
              `This account already has a store (${existing.id}): edit it rather than opening a second one`
            );
          }

          // Unique platform-wide, so a store already holding it is a conflict rather than a
          // crash on the constraint — the same answer approval gives for the same reason.
          const holder = await merchants.findByTradeLicenseNumber(input.tradeLicenseNumber);
          if (holder) {
            throw new ConflictError(
              `Trade licence ${input.tradeLicenseNumber} is already held by another store`
            );
          }

          // The shop address the check above cannot exist without. Its label and its
          // `isPiiRestricted = false` are the platform's, taken from the approval path rather
          // than restated: a shop is a public place, and the label is how the platform
          // recognises the row riders collect from.
          const address = await addresses.create({
            id: `addr_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            userId: owner.id,
            label: SHOP_ADDRESS_LABEL,
            streetAddress: input.address.streetAddress,
            area: input.address.area,
            district: input.address.district,
            postalCode: input.address.postalCode,
            latitude: input.address.latitude,
            longitude: input.address.longitude,
            isDefault: true,
            isPiiRestricted: false
          });

          const merchant = await merchants.create({
            id: `merch_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            ownerUserId: owner.id,
            businessName: input.businessName,
            tradeLicenseNumber: input.tradeLicenseNumber,
            description: input.description ?? null,
            // Both defaulted the way approval defaults them, so a store opened here and one
            // built by an approval are the same store as far as everything downstream knows.
            category: input.category ?? DEFAULT_MERCHANT_CATEGORY,
            addressId: address.id,
            // The number the account signs in with, never one from the body: a store whose
            // phone was settable could point delivery at a stranger.
            phone: owner.phone,
            isOpen: input.isOpen ?? true,
            rating: 5.0
          });

          await audits.log({
            id: `aud_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            userId: owner.id,
            action: 'MERCHANT_PROFILE_CREATE',
            entityType: 'MERCHANT',
            entityId: merchant.id,
            // Nothing existed before this, so there is no old row to record; what the store
            // became is what an investigator reads.
            oldValues: null,
            newValues: JSON.stringify(describeProfile(merchant, address)),
            ipAddress: meta.ipAddress ?? null,
            userAgent: meta.userAgent ?? null,
            sessionId: meta.sessionId ?? null
          });

          return { merchant, address };
        });

        logger.info('Merchant store opened', {
          merchantId: created.merchant.id,
          ownerUserId: owner.id,
          tradeLicenseNumber: created.merchant.tradeLicenseNumber
        });

        return {
          status: 201,
          body: {
            success: true,
            merchant: serializeMerchantProfile(created.merchant, created.address)
          }
        };
      }
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/merchant/profile`,
      requiresAuth: true,
      permission: 'merchant:manage:own',
      handler: async (ctx): Promise<RouteResult> => {
        const owner = authenticatedUser(ctx);
        const merchant = await deps.merchantRepo.findByOwnerUserId(owner.id);
        if (!merchant) throw new NotFoundError('Merchant profile');

        const address = await deps.addressRepo.findById(merchant.addressId);
        return {
          status: 200,
          body: { success: true, merchant: serializeMerchantProfile(merchant, address) }
        };
      }
    },
    {
      method: 'PATCH',
      path: `${API_PREFIX}/merchant/profile`,
      requiresAuth: true,
      permission: 'merchant:manage:own',
      handler: async (ctx): Promise<RouteResult> => {
        const owner = authenticatedUser(ctx);
        const changes = parseMerchantProfileChanges(ctx.body);
        const meta = sessionMetaFromRequest(ctx);

        const outcome = await client.transaction(async (tx) => {
          const merchants = new MerchantRepository(tx);
          const addresses = new AddressRepository(tx);
          const audits = new AuditLogRepository(tx);

          const merchant = await merchants.findByOwnerUserId(owner.id);
          if (!merchant) throw new NotFoundError('Merchant profile');

          const before = await addresses.findById(merchant.addressId);

          // The shop address is edited in place: `addressId` stays the row riders and orders
          // already point at, so a shop that moves does not orphan the deliveries that named
          // it. Ownership is in the update statement, so a merchant can only ever move its own.
          let after = before;
          if (changes.address) {
            if (!before) throw new NotFoundError('Shop address');
            after = await addresses.updateOwned(merchant.addressId, owner.id, {
              streetAddress: changes.address.streetAddress,
              area: changes.address.area,
              district: changes.address.district,
              postalCode: changes.address.postalCode,
              latitude: changes.address.latitude,
              longitude: changes.address.longitude
            });
            if (!after) throw new NotFoundError('Shop address');
          }

          // One unit of work with the address: a profile that says it moved while its address
          // row still points at the old place is the half-state this transaction prevents.
          const updated = await merchants.updateProfile(merchant.id, {
            businessName: changes.businessName,
            description: changes.description,
            category: changes.category,
            isOpen: changes.isOpen
          });
          if (!updated) throw new NotFoundError('Merchant profile');

          const changed = describeChanges(merchant, updated, before, after);
          await audits.log({
            id: `aud_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            userId: owner.id,
            action: 'MERCHANT_PROFILE_UPDATE',
            entityType: 'MERCHANT',
            entityId: merchant.id,
            // A shop is a public place, so its address is not PII and belongs in the record:
            // "where was this store when this order was placed?" is a question this answers.
            oldValues: JSON.stringify(describeProfile(merchant, before)),
            newValues: JSON.stringify({ ...describeProfile(updated, after), changed }),
            ipAddress: meta.ipAddress ?? null,
            userAgent: meta.userAgent ?? null,
            sessionId: meta.sessionId ?? null
          });

          return { merchant: updated, address: after, changed };
        });

        logger.info('Merchant profile updated', {
          merchantId: outcome.merchant.id,
          ownerUserId: owner.id,
          changed: outcome.changed
        });

        return {
          status: 200,
          body: {
            success: true,
            // What actually changed, so a client that sent a whole form learns which parts of
            // it were already true.
            changed: outcome.changed,
            merchant: serializeMerchantProfile(outcome.merchant, outcome.address)
          }
        };
      }
    }
  ];
}
