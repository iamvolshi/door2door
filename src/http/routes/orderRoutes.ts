import { randomUUID } from 'node:crypto';
import { ForbiddenError, NotFoundError, ValidationError } from '../../core/errors';
import { hasPermission } from '../../auth/rbac';
import { DurableIdempotencyService } from '../../services/durableIdempotency';
import {
  DEFAULT_VAT_RATE,
  PricingService,
  type OrderPricingSummary,
  type ServiceArea
} from '../../services/pricingService';
import type { DatabaseClient } from '../../db/client';
import type {
  AddressRepository,
  AuditLogRepository,
  CatalogRepository,
  MerchantRepository,
  OrderRepository,
  UserRepository
} from '../../db/repositories';
import type {
  AddressRecord,
  CatalogItemRecord,
  MerchantRecord,
  OrderItemRecord,
  OrderRecord,
  UserRecord
} from '../../db/schema';
import {
  parseDeliveryAddressSnapshot,
  snapshotDeliveryAddress,
  type DeliveryAddressSnapshot
} from '../../services/addressRules';
import { authenticatedUser, requireNumber, requireString, type RequestContext, type Route, type RouteResult } from '../httpUtils';

const API_PREFIX = '/api/v1';

/** Recorded on every stored key, so a row says which endpoint consumed it. */
const PLACE_ORDER_ENDPOINT = 'POST /api/v1/orders';

export interface OrderRouteDeps {
  client: DatabaseClient;
  userRepo: UserRepository;
  addressRepo: AddressRepository;
  merchantRepo: MerchantRepository;
  catalogRepo: CatalogRepository;
  orderRepo: OrderRepository;
  auditRepo: AuditLogRepository;
}

interface ResolvedOrder {
  customer: UserRecord;
  merchant: MerchantRecord;
  address: AddressRecord;
  pricing: OrderPricingSummary;
  specialInstructions: string | null;
  requestHashPayload: Record<string, unknown>;
}

function toPricingCatalogItem(row: CatalogItemRecord) {
  return {
    id: row.id,
    storeId: row.merchantId,
    name: row.name,
    basePrice: row.priceBdt,
    taxRate: DEFAULT_VAT_RATE,
    isAvailable: row.isAvailable
  };
}

function serializeOrder(
  order: OrderRecord,
  items: OrderItemRecord[],
  /** Where it went, for the viewers entitled to it; omitted entirely for everybody else. */
  deliveryAddress?: DeliveryAddressSnapshot | null
): Record<string, unknown> {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    customerId: order.customerId,
    merchantId: order.merchantId,
    driverId: order.driverId ?? null,
    deliveryAddressId: order.deliveryAddressId,
    pricing: {
      subtotalBdt: order.subtotalBdt,
      deliveryFeeBdt: order.deliveryFeeBdt,
      discountBdt: order.discountBdt,
      taxBdt: order.taxBdt,
      totalBdt: order.totalBdt
    },
    specialInstructions: order.specialInstructions ?? null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items: items.map((item) => ({
      itemId: item.catalogItemId,
      name: item.itemName,
      quantity: item.quantity,
      unitPriceBdt: item.unitPriceBdt,
      totalPriceBdt: item.totalPriceBdt
    })),
    ...(deliveryAddress ? { deliveryAddress } : {})
  };
}

export function createOrderRoutes(deps: OrderRouteDeps): Route[] {
  // Database-backed, so a retry is recognised after a restart or by another instance.
  const idempotency = new DurableIdempotencyService(deps.client);

  async function resolveOrderRequest(
    body: Record<string, unknown>,
    customer: UserRecord
  ): Promise<ResolvedOrder> {
    // Identity comes from the access token, never from the payload: a customer may
    // only order for themselves.
    const claimedCustomerId = typeof body.customerId === 'string' ? body.customerId.trim() : '';
    if (claimedCustomerId !== '' && claimedCustomerId !== customer.id) {
      throw new ForbiddenError('customerId does not match the authenticated account');
    }

    const merchantId = requireString(body, 'merchantId');
    const claimedAddressId =
      typeof body.deliveryAddressId === 'string' ? body.deliveryAddressId.trim() : '';
    const serviceArea = requireString(body, 'serviceArea') as ServiceArea;
    const distanceKm = requireNumber(body, 'distanceKm');
    const isPriorityDelivery = body.isPriorityDelivery === true;
    const couponCode = typeof body.couponCode === 'string' ? body.couponCode : undefined;
    const specialInstructions =
      typeof body.specialInstructions === 'string' ? body.specialInstructions : null;

    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new ValidationError("Field 'items' is required and must be a non-empty array", { field: 'items' });
    }

    const items = body.items.map((raw, index) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ValidationError(`items[${index}] must be an object`, { field: `items[${index}]` });
      }
      const entry = raw as Record<string, unknown>;
      const itemId = typeof entry.itemId === 'string' ? entry.itemId.trim() : '';
      if (!itemId) {
        throw new ValidationError(`items[${index}].itemId is required`, { field: `items[${index}].itemId` });
      }
      const quantity = entry.quantity;
      if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
        throw new ValidationError(`items[${index}].quantity must be a positive integer`, {
          field: `items[${index}].quantity`
        });
      }
      return {
        itemId,
        quantity,
        // Server-side price authority: a client-supplied price is only ever compared, never trusted.
        claimedUnitPrice: typeof entry.claimedUnitPrice === 'number' ? entry.claimedUnitPrice : undefined
      };
    });

    if (!customer.isActive) {
      throw new ForbiddenError(`Customer account '${customer.id}' is inactive`);
    }

    const merchant = await deps.merchantRepo.findById(merchantId);
    if (!merchant) throw new NotFoundError('Merchant');
    if (!merchant.isOpen) throw new ValidationError(`Merchant '${merchantId}' is not accepting orders`);

    // A customer who has saved an address does not have to name it: the default one is
    // used, which is what makes a freshly registered customer able to order straight away.
    let address: AddressRecord | null = null;
    if (claimedAddressId !== '') {
      address = await deps.addressRepo.findById(claimedAddressId);
      if (!address) throw new NotFoundError('Delivery address');
      if (address.userId !== customer.id) {
        throw new ForbiddenError('Delivery address does not belong to the authenticated customer');
      }
      // An address the customer has taken off their list is not one to order to, even though the
      // row is still on file for the deliveries that used it. Reported as 404 like any other
      // address that is not on their list, so a detached id is not a thing a client can hold on
      // to and keep sending.
      if (address.removedAt) throw new NotFoundError('Delivery address');
    } else {
      address = await deps.addressRepo.findDefaultByUserId(customer.id);
      if (!address) {
        throw new ValidationError(
          "Field 'deliveryAddressId' is required until the customer has saved a delivery address",
          { field: 'deliveryAddressId' }
        );
      }
    }

    const catalogRows = await deps.catalogRepo.findByMerchantId(merchantId);
    if (catalogRows.length === 0) throw new NotFoundError('Merchant catalog');

    const pricingService = new PricingService(catalogRows.map(toPricingCatalogItem));
    const pricing = pricingService.calculateOrderPricing({
      storeId: merchantId,
      serviceArea,
      distanceKm,
      items,
      couponCode,
      isPriorityDelivery
    });

    return {
      customer,
      merchant,
      address,
      pricing,
      specialInstructions,
      requestHashPayload: {
        customerId: customer.id,
        merchantId,
        // The resolved id, so an order placed by naming the address and one placed by
        // relying on the default are recognised as the same request.
        deliveryAddressId: address.id,
        serviceArea,
        distanceKm,
        isPriorityDelivery,
        couponCode: couponCode ?? null,
        specialInstructions,
        items: items.map((item) => ({ itemId: item.itemId, quantity: item.quantity }))
      }
    };
  }

  async function persistOrder(
    resolved: ResolvedOrder,
    requestId: string,
    /** The session that placed it, so the trail names the device and not only the account. */
    sessionId: string | null
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    const orderId = `ord_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const orderNumber = `CXB-${now.getFullYear()}-${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;

    const itemRecords: Omit<OrderItemRecord, 'createdAt'>[] = resolved.pricing.items.map((item) => ({
      id: `ord_item_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      orderId,
      catalogItemId: item.itemId,
      itemName: item.name,
      quantity: item.quantity,
      unitPriceBdt: item.unitPrice,
      totalPriceBdt: item.subtotal,
      notes: null
    }));

    const orderPayload: Omit<OrderRecord, 'createdAt' | 'updatedAt'> = {
      id: orderId,
      orderNumber,
      customerId: resolved.customer.id,
      merchantId: resolved.merchant.id,
      driverId: null,
      deliveryAddressId: resolved.address.id,
      status: 'PENDING',
      subtotalBdt: resolved.pricing.itemsSubtotal,
      deliveryFeeBdt: resolved.pricing.deliveryFee + resolved.pricing.priorityDeliveryFee,
      discountBdt: resolved.pricing.discountAmount,
      taxBdt: resolved.pricing.taxTotal,
      totalBdt: resolved.pricing.finalPayableAmount,
      specialInstructions: resolved.specialInstructions,
      cancellationReason: null,
      // Taken here, once, from the address this order is being placed against. Later edits to
      // that address — or taking it off the customer's list — leave this order's own record of
      // where it went untouched.
      deliveryAddressSnapshot: JSON.stringify(snapshotDeliveryAddress(resolved.address))
    };

    const created = await deps.client.transaction(async () => {
      const result = await deps.orderRepo.createOrder(orderPayload, itemRecords);
      await deps.auditRepo.log({
        id: `aud_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        userId: resolved.customer.id,
        action: 'ORDER_PLACED',
        entityType: 'ORDER',
        entityId: orderId,
        oldValues: null,
        newValues: JSON.stringify({ orderNumber, totalBdt: orderPayload.totalBdt, status: orderPayload.status }),
        ipAddress: null,
        userAgent: `http-api/${requestId}`,
        sessionId
      });
      return result;
    });

    // The customer who placed it is the one caller who always gets the address back, and they
    // get it straight away rather than having to read the order again to learn where it goes.
    // It is the same snapshot the row now carries, so a replayed response cannot disagree with
    // the order it describes.
    return serializeOrder(created.order, created.items, snapshotDeliveryAddress(resolved.address));
  }

  /**
   * Where an order went, for the callers entitled to know.
   *
   * Two viewers see the address: the customer the order was delivered to, and an operator whose
   * role carries `pii:read:full`. Everybody else who may read the order — the store it was bought
   * from — gets the same order without it, which is what they saw before this field existed: a
   * customer's door is not part of a merchant's order.
   *
   * The snapshot is preferred over the row it names, so an address corrected or retired since
   * can neither rewrite nor erase where this delivery was sent. An order placed before the
   * snapshot existed falls back to the address row, which is exactly what it reported until now.
   */
  async function deliveryAddressForViewer(
    ctx: RequestContext,
    order: OrderRecord
  ): Promise<DeliveryAddressSnapshot | null> {
    const viewer = authenticatedUser(ctx);
    const isCustomer = order.customerId === viewer.id;
    if (!isCustomer && !hasPermission(viewer.role, 'pii:read:full')) return null;

    const recorded = parseDeliveryAddressSnapshot(order.deliveryAddressSnapshot);
    if (recorded) return recorded;

    const address = await deps.addressRepo.findById(order.deliveryAddressId);
    return address ? snapshotDeliveryAddress(address) : null;
  }

  async function assertOrderReadable(ctx: RequestContext, order: OrderRecord): Promise<void> {
    const user = authenticatedUser(ctx);

    if (hasPermission(user.role, 'order:read:all')) return;

    if (order.customerId === user.id && hasPermission(user.role, 'order:read:own')) return;

    if (hasPermission(user.role, 'order:read:merchant')) {
      const merchant = await deps.merchantRepo.findById(order.merchantId);
      if (merchant && merchant.ownerUserId === user.id) return;
    }

    throw new ForbiddenError('Order is not visible to the authenticated account');
  }

  return [
    {
      method: 'GET',
      path: `${API_PREFIX}/merchants`,
      handler: async (): Promise<RouteResult> => {
        const stores = await deps.merchantRepo.listStores();
        return {
          status: 200,
          body: {
            success: true,
            count: stores.length,
            merchants: stores.map((store) => ({
              id: store.id,
              businessName: store.businessName,
              description: store.description ?? null,
              category: store.category,
              rating: store.rating,
              isOpen: store.isOpen
            }))
          }
        };
      }
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/merchants/:merchantId/menu`,
      handler: async (ctx): Promise<RouteResult> => {
        const merchant = await deps.merchantRepo.findById(ctx.params.merchantId);
        if (!merchant) throw new NotFoundError('Merchant');
        const items = await deps.catalogRepo.findByMerchantId(merchant.id);

        return {
          status: 200,
          body: {
            success: true,
            merchant: {
              id: merchant.id,
              businessName: merchant.businessName,
              category: merchant.category,
              rating: merchant.rating,
              isOpen: merchant.isOpen
            },
            items: items.map((item) => ({
              id: item.id,
              name: item.name,
              description: item.description ?? null,
              category: item.category,
              priceBdt: item.priceBdt,
              isAvailable: item.isAvailable,
              imageUrl: item.imageUrl ?? null
            }))
          }
        };
      }
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/orders/quote`,
      requiresAuth: true,
      permission: 'order:create',
      handler: async (ctx): Promise<RouteResult> => {
        const resolved = await resolveOrderRequest(ctx.body, authenticatedUser(ctx));
        return {
          status: 200,
          body: {
            success: true,
            merchantId: resolved.merchant.id,
            deliveryAddressId: resolved.address.id,
            quote: resolved.pricing
          }
        };
      }
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/orders`,
      requiresAuth: true,
      permission: 'order:create',
      handler: async (ctx): Promise<RouteResult> => {
        const rawKey = ctx.headers['idempotency-key'];
        const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
        if (!idempotencyKey || idempotencyKey.trim() === '') {
          throw new ValidationError('Idempotency-Key header is required to place an order', {
            field: 'Idempotency-Key'
          });
        }

        const customer = authenticatedUser(ctx);
        const resolved = await resolveOrderRequest(ctx.body, customer);
        const result = await idempotency.execute(
          {
            key: idempotencyKey,
            userId: customer.id,
            endpoint: PLACE_ORDER_ENDPOINT,
            payload: resolved.requestHashPayload
          },
          async () => ({
            status: 201,
            body: {
              success: true,
              order: await persistOrder(resolved, ctx.requestId, ctx.auth?.sessionId ?? null)
            }
          })
        );

        return { status: result.status, body: result.body };
      }
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/orders/:orderId`,
      requiresAuth: true,
      handler: async (ctx): Promise<RouteResult> => {
        const order = await deps.orderRepo.findById(ctx.params.orderId);
        if (!order) throw new NotFoundError('Order');

        await assertOrderReadable(ctx, order);

        const items = await deps.orderRepo.findItemsByOrderId(order.id);
        const deliveryAddress = await deliveryAddressForViewer(ctx, order);
        return {
          status: 200,
          body: { success: true, order: serializeOrder(order, items, deliveryAddress) }
        };
      }
    }
  ];
}
