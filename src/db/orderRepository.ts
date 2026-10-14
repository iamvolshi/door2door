import type { DatabaseClient } from './client.js';
import type {
  OrderRecord,
  OrderItemRecord,
  OrderStatus,
} from './schema.js';
import { NotFoundError } from '../core/errors.js';
import { nowISO } from './repositoryUtils.js';

/** Repository for order records and items. */
export class OrderRepository {
  constructor(protected client: DatabaseClient) {}

  async createOrder(
    order: Omit<OrderRecord, 'createdAt' | 'updatedAt'>,
    items: Omit<OrderItemRecord, 'createdAt'>[],
  ): Promise<{ order: OrderRecord; items: OrderItemRecord[] }> {
    const now = nowISO();
    const orderRecord: OrderRecord = {
      ...order,
      createdAt: now,
      updatedAt: now,
    };
    const sql = `INSERT INTO orders (id, orderNumber, customerId, merchantId, driverId, deliveryAddressId, deliveryAddressSnapshot, status, subtotalBdt, deliveryFeeBdt, discountBdt, taxBdt, totalBdt, specialInstructions, cancellationReason, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.client.query(sql, [
      orderRecord.id,
      orderRecord.orderNumber,
      orderRecord.customerId,
      orderRecord.merchantId,
      orderRecord.driverId || null,
      orderRecord.deliveryAddressId,
      orderRecord.deliveryAddressSnapshot ?? null,
      orderRecord.status,
      orderRecord.subtotalBdt,
      orderRecord.deliveryFeeBdt,
      orderRecord.discountBdt,
      orderRecord.taxBdt,
      orderRecord.totalBdt,
      orderRecord.specialInstructions || null,
      orderRecord.cancellationReason || null,
      orderRecord.createdAt,
      orderRecord.updatedAt,
    ]);

    const orderItems: OrderItemRecord[] = [];
    for (const item of items) {
      const itemRecord: OrderItemRecord = {
        ...item,
        createdAt: now,
      };
      const itemSql = `INSERT INTO order_items (id, orderId, catalogItemId, itemName, quantity, unitPriceBdt, totalPriceBdt, notes, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      await this.client.query(itemSql, [
        itemRecord.id,
        itemRecord.orderId,
        itemRecord.catalogItemId,
        itemRecord.itemName,
        itemRecord.quantity,
        itemRecord.unitPriceBdt,
        itemRecord.totalPriceBdt,
        itemRecord.notes || null,
        itemRecord.createdAt,
      ]);
      orderItems.push(itemRecord);
    }

    return { order: orderRecord, items: orderItems };
  }

  /**
   * Moves an order to a new status.
   *
   * Reads before writing so the returned record is the order as it stands, and so an unknown
   * id is `NotFoundError` even on drivers that report zero affected rows indistinguishably
   * from success. A cancellation reason travels with the row when one is given, and is left
   * alone otherwise — a re-dispatch must not inherit the reason its earlier attempt died by.
   */
  async updateStatus(id: string, status: OrderStatus, cancellationReason?: string): Promise<OrderRecord> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundError('Order not found');
    }
    const now = nowISO();
    const updated: OrderRecord = {
      ...existing,
      status,
      cancellationReason: cancellationReason !== undefined ? cancellationReason : existing.cancellationReason,
      updatedAt: now,
    };
    await this.client.query(`UPDATE orders SET status = ?, cancellationReason = ?, updatedAt = ? WHERE id = ?`, [
      status,
      updated.cancellationReason ?? null,
      now,
      id,
    ]);
    return updated;
  }

  async findById(id: string): Promise<OrderRecord | null> {
    const result = await this.client.query<OrderRecord>(
      `SELECT * FROM orders WHERE id = ?`,
      [id],
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async findItemsByOrderId(orderId: string): Promise<OrderItemRecord[]> {
    const result = await this.client.query<OrderItemRecord>(
      `SELECT * FROM order_items WHERE orderId = ?`,
      [orderId],
    );
    return result.rows;
  }

  /**
   * How many order lines name a catalogue item. Used to refuse deleting an item a customer
   * has already ordered: the line keeps pointing at what was bought, so the row cannot go.
   */
  async countByCatalogItemId(catalogItemId: string): Promise<number> {
    const result = await this.client.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM order_items WHERE catalogItemId = ?`,
      [catalogItemId]
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  /**
   * How many orders were delivered to an address. An address with any is kept for the delivery
   * history of those orders rather than deleted, so this answers "may this row still go?".
   */
  async countByDeliveryAddressId(addressId: string): Promise<number> {
    const result = await this.client.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM orders WHERE deliveryAddressId = ?`,
      [addressId]
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  async findByDriverId(
    driverId: string,
    options: { status?: OrderStatus; limit?: number } = {},
  ): Promise<DriverOrderRow[]> {
    const params: unknown[] = [driverId];
    let sql =
      `SELECT o.*, a.id AS addressId, a.label AS addressLabel, a.streetAddress, ` +
      `a.area AS addressArea, a.district AS addressDistrict, a.postalCode, a.latitude, ` +
      `a.longitude, m.businessName AS merchantName ` +
      `FROM orders o ` +
      `LEFT JOIN addresses a ON a.id = o.deliveryAddressId ` +
      `LEFT JOIN merchants m ON m.id = o.merchantId ` +
      `WHERE o.driverId = ?`;
    if (options.status) {
      sql += ` AND o.status = ?`;
      params.push(options.status);
    }
    // Newest first: the delivery a rider is about to make is the one at the top, not the one
    // from last week that a limit would have kept.
    sql += ` ORDER BY o.createdAt DESC LIMIT ?`;
    params.push(options.limit ?? DEFAULT_DRIVER_ORDER_LIMIT);
    const result = await this.client.query<DriverOrderRow>(sql, params);
    return result.rows;
  }
}

/**
 * One order as its rider reads it: the order itself plus the door it goes to and the store
 * it is collected from. The address columns arrive through this single join — see
 * `findByDriverId` — and never because a driver may read somebody else's address.
 */
export interface DriverOrderRow extends OrderRecord {
  addressId: string | null;
  addressLabel: string | null;
  streetAddress: string | null;
  addressArea: string | null;
  addressDistrict: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  /** The store's trading name, so a rider knows where to collect; null if that row has gone. */
  merchantName: string | null;
}

/**
 * The page of deliveries a rider reads. Bounded like every other list here, so one request
 * cannot ask the database for every order a rider has ever carried.
 */
export const DEFAULT_DRIVER_ORDER_LIMIT = 100;
export const MAX_DRIVER_ORDER_LIMIT = 200;

export const MAX_ROSTER_LIMIT = 200;
