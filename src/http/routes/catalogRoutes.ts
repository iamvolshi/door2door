import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../../core/errors';
import { logger } from '../../core/logger';
import type { DatabaseClient } from '../../db/client';
import {
  AuditLogRepository,
  CatalogRepository,
  MerchantRepository,
  OrderRepository
} from '../../db/repositories';
import type { CatalogItemRecord, MerchantRecord } from '../../db/schema';
import { MAX_CATALOG_ITEMS_PER_MERCHANT, parseCatalogItemChanges, parseNewCatalogItem } from '../../services/catalogRules';
import { authenticatedUser, sessionMetaFromRequest, type Route, type RouteResult } from '../httpUtils';

const API_PREFIX = '/api/v1';

export interface CatalogRouteDeps {
  client: DatabaseClient;
  merchantRepo: MerchantRepository;
  catalogRepo: CatalogRepository;
  orderRepo: OrderRepository;
}

export function newCatalogItemId(): string {
  return `cat_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/**
 * The platform's key for an item, not the merchant's.
 *
 * `catalog_items.sku` is `UNIQUE` across every store, so the value has to be one no other store
 * can be holding; a merchant-supplied one would let the first store to type it keep every other
 * store out of that string (see services/catalogRules.ts for why the field is refused).
 */
function newSku(): string {
  return `CXB-${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

/**
 * A catalogue item as its owner sees it: everything customers see, plus the store's own record
 * of it, plus `editable` naming what a `PATCH` will accept — the same shape the business
 * profile answers with, so a client learns the boundary the same way in both places.
 */
export function serializeCatalogItem(item: CatalogItemRecord): Record<string, unknown> {
  return {
    id: item.id,
    merchantId: item.merchantId,
    name: item.name,
    description: item.description ?? null,
    category: item.category,
    priceBdt: item.priceBdt,
    isAvailable: item.isAvailable,
    sku: item.sku,
    imageUrl: item.imageUrl ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    editable: ['name', 'description', 'category', 'priceBdt', 'isAvailable', 'imageUrl']
  };
}

/** The item's own fields, as the audit row records them. */
function describeItem(item: CatalogItemRecord): Record<string, unknown> {
  return {
    name: item.name,
    description: item.description ?? null,
    category: item.category,
    priceBdt: item.priceBdt,
    isAvailable: item.isAvailable,
    imageUrl: item.imageUrl ?? null,
    sku: item.sku,
    merchantId: item.merchantId
  };
}

/** Which parts of the item this request actually moved, for the audit row and the reply. */
function describeChanges(before: CatalogItemRecord, after: CatalogItemRecord): string[] {
  const changed: string[] = [];
  if (before.name !== after.name) changed.push('name');
  if ((before.description ?? null) !== (after.description ?? null)) changed.push('description');
  if (before.category !== after.category) changed.push('category');
  if (before.priceBdt !== after.priceBdt) changed.push('priceBdt');
  if (before.isAvailable !== after.isAvailable) changed.push('isAvailable');
  if ((before.imageUrl ?? null) !== (after.imageUrl ?? null)) changed.push('imageUrl');
  return changed;
}

function auditId(): string {
  return `aud_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/**
 * A merchant's own menu.
 *
 * The store is the query rather than a check: it is found by `ownerUserId`, and every statement
 * that touches an item carries that store's id in its `WHERE`, so there is no id in the path for
 * a merchant to point at somebody else's shelf and nothing to authorise beyond being the owner.
 * The grant is `catalog:manage:merchant` — declared for exactly this and, until now, held by
 * nobody's reachable route.
 *
 * A merchant whose store is missing answers `404`: approval is what creates one, so that is
 * "approved with no store" rather than "not a merchant". An item of another store's is `404`
 * too, not `403`, so item ids cannot be used to discover what another store sells.
 */
export function createCatalogRoutes(deps: CatalogRouteDeps): Route[] {
  const { client } = deps;

  async function requireOwnStore(ownerUserId: string): Promise<MerchantRecord> {
    const merchant = await deps.merchantRepo.findByOwnerUserId(ownerUserId);
    if (!merchant) throw new NotFoundError('Merchant store');
    return merchant;
  }

  /** One of the store's own items, or 404. */
  async function requireOwnItem(itemId: string, merchantId: string): Promise<CatalogItemRecord> {
    const item = await deps.catalogRepo.findById(itemId);
    if (!item || item.merchantId !== merchantId) throw new NotFoundError('Catalogue item');
    return item;
  }

  return [
    {
      method: 'GET',
      path: `${API_PREFIX}/merchant/catalog`,
      requiresAuth: true,
      permission: 'catalog:manage:merchant',
      handler: async (ctx): Promise<RouteResult> => {
        const merchant = await requireOwnStore(authenticatedUser(ctx).id);
        const items = await deps.catalogRepo.findByMerchantId(merchant.id);

        return {
          status: 200,
          body: {
            success: true,
            count: items.length,
            // The merchant sees what a customer would, plus what the customer would not: the
            // rows nobody can order yet are exactly the ones a merchant opens this list to find.
            store: { id: merchant.id, businessName: merchant.businessName, isOpen: merchant.isOpen },
            items: items.map(serializeCatalogItem)
          }
        };
      }
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/merchant/catalog`,
      requiresAuth: true,
      permission: 'catalog:manage:merchant',
      handler: async (ctx): Promise<RouteResult> => {
        const owner = authenticatedUser(ctx);
        const meta = sessionMetaFromRequest(ctx);

        const created = await client.transaction(async (tx) => {
          const merchants = new MerchantRepository(tx);
          const catalog = new CatalogRepository(tx);
          const audits = new AuditLogRepository(tx);

          const merchant = await merchants.findByOwnerUserId(owner.id);
          if (!merchant) throw new NotFoundError('Merchant store');

          // The store's own category is the default for its items, so the first item can be
          // added with a name and a price alone.
          const input = parseNewCatalogItem(ctx.body, merchant.category);

          const existing = await catalog.countByMerchantId(merchant.id);
          if (existing >= MAX_CATALOG_ITEMS_PER_MERCHANT) {
            throw new ConflictError(
              `A store can list at most ${MAX_CATALOG_ITEMS_PER_MERCHANT} items`
            );
          }

          const item = await catalog.create({
            id: newCatalogItemId(),
            merchantId: merchant.id,
            name: input.name,
            description: input.description,
            category: input.category,
            priceBdt: input.priceBdt,
            isAvailable: input.isAvailable,
            sku: newSku(),
            imageUrl: input.imageUrl
          });

          await audits.log({
            id: auditId(),
            userId: owner.id,
            action: 'CATALOG_ITEM_CREATE',
            entityType: 'CATALOG_ITEM',
            entityId: item.id,
            oldValues: null,
            newValues: JSON.stringify(describeItem(item)),
            ipAddress: meta.ipAddress ?? null,
            userAgent: meta.userAgent ?? null,
            sessionId: meta.sessionId ?? null
          });

          return item;
        });

        logger.info('Catalogue item created', {
          merchantId: created.merchantId,
          itemId: created.id,
          ownerUserId: owner.id
        });

        return { status: 201, body: { success: true, item: serializeCatalogItem(created) } };
      }
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/merchant/catalog/:itemId`,
      requiresAuth: true,
      permission: 'catalog:manage:merchant',
      handler: async (ctx): Promise<RouteResult> => {
        const merchant = await requireOwnStore(authenticatedUser(ctx).id);
        const item = await requireOwnItem(ctx.params.itemId, merchant.id);
        return { status: 200, body: { success: true, item: serializeCatalogItem(item) } };
      }
    },
    {
      method: 'PATCH',
      path: `${API_PREFIX}/merchant/catalog/:itemId`,
      requiresAuth: true,
      permission: 'catalog:manage:merchant',
      handler: async (ctx): Promise<RouteResult> => {
        const owner = authenticatedUser(ctx);
        const changes = parseCatalogItemChanges(ctx.body);
        const meta = sessionMetaFromRequest(ctx);

        const outcome = await client.transaction(async (tx) => {
          const merchants = new MerchantRepository(tx);
          const catalog = new CatalogRepository(tx);
          const audits = new AuditLogRepository(tx);

          const merchant = await merchants.findByOwnerUserId(owner.id);
          if (!merchant) throw new NotFoundError('Merchant store');

          const before = await catalog.findById(ctx.params.itemId);
          if (!before || before.merchantId !== merchant.id) throw new NotFoundError('Catalogue item');

          // Ownership is in the statement as well as the read above, so a concurrent change of
          // hands cannot be raced between them.
          const item = await catalog.updateOwned(before.id, merchant.id, {
            name: changes.name,
            description: changes.description,
            category: changes.category,
            priceBdt: changes.priceBdt,
            isAvailable: changes.isAvailable,
            imageUrl: changes.imageUrl
          });
          if (!item) throw new NotFoundError('Catalogue item');

          const changed = describeChanges(before, item);
          await audits.log({
            id: auditId(),
            userId: owner.id,
            action: 'CATALOG_ITEM_UPDATE',
            entityType: 'CATALOG_ITEM',
            entityId: item.id,
            oldValues: JSON.stringify(describeItem(before)),
            newValues: JSON.stringify({ ...describeItem(item), changed }),
            ipAddress: meta.ipAddress ?? null,
            userAgent: meta.userAgent ?? null,
            sessionId: meta.sessionId ?? null
          });

          return { item, changed };
        });

        logger.info('Catalogue item updated', {
          itemId: outcome.item.id,
          ownerUserId: owner.id,
          changed: outcome.changed
        });

        return {
          status: 200,
          body: {
            success: true,
            // What actually changed, so a client that sent a whole form learns which parts of it
            // were already true.
            changed: outcome.changed,
            item: serializeCatalogItem(outcome.item)
          }
        };
      }
    },
    {
      method: 'DELETE',
      path: `${API_PREFIX}/merchant/catalog/:itemId`,
      requiresAuth: true,
      permission: 'catalog:manage:merchant',
      handler: async (ctx): Promise<RouteResult> => {
        const owner = authenticatedUser(ctx);
        const meta = sessionMetaFromRequest(ctx);

        const deleted = await client.transaction(async (tx) => {
          const merchants = new MerchantRepository(tx);
          const catalog = new CatalogRepository(tx);
          const orders = new OrderRepository(tx);
          const audits = new AuditLogRepository(tx);

          const merchant = await merchants.findByOwnerUserId(owner.id);
          if (!merchant) throw new NotFoundError('Merchant store');

          const item = await catalog.findById(ctx.params.itemId);
          if (!item || item.merchantId !== merchant.id) throw new NotFoundError('Catalogue item');

          // An order line names what was bought, and the foreign key stops the delete anyway.
          // Refusing with an alternative beats a 500 the merchant cannot act on — and the
          // alternative is the switch they already have: an unavailable item leaves the menu
          // without changing what past orders say.
          const orderedTimes = await orders.countByCatalogItemId(item.id);
          if (orderedTimes > 0) {
            throw new ConflictError(
              `This item has been ordered ${orderedTimes} time(s) and is kept for order history. Mark it unavailable instead so it leaves the menu, or change its price.`
            );
          }

          const removed = await catalog.removeOwned(item.id, merchant.id);
          if (!removed) throw new NotFoundError('Catalogue item');

          await audits.log({
            id: auditId(),
            userId: owner.id,
            action: 'CATALOG_ITEM_DELETE',
            entityType: 'CATALOG_ITEM',
            entityId: item.id,
            oldValues: JSON.stringify(describeItem(item)),
            newValues: null,
            ipAddress: meta.ipAddress ?? null,
            sessionId: meta.sessionId ?? null,
            userAgent: meta.userAgent ?? null
          });

          return { id: item.id, merchantId: merchant.id };
        });

        logger.info('Catalogue item deleted', {
          itemId: deleted.id,
          merchantId: deleted.merchantId,
          ownerUserId: owner.id
        });

        return { status: 200, body: { success: true, deletedItemId: deleted.id } };
      }
    }
  ];
}
