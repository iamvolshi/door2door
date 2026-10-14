import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  isUniqueViolationError
} from '../../core/errors';
import { orderRulesEngine, type OrderStateRecord, type OrderStatus as EngineStatus } from '../../services/orderRules';
import { DurableIdempotencyService } from '../../services/durableIdempotency';
import type { DatabaseClient } from '../../db/client';
import type {
  AuditLogRepository,
  OrderRepository,
  PaymentRepository,
  RefundRepository
} from '../../db/repositories';
import type {
  OrderRecord,
  PaymentMethod,
  PaymentRecord,
  RefundRecord,
  UserRecord
} from '../../db/schema';
import { authenticatedUser, type RequestContext, type Route, type RouteResult } from '../httpUtils';

const API_PREFIX = '/api/v1';

/** What the platform is willing to record a payment as; the set the schema allows. */
const PAYMENT_METHODS: readonly PaymentMethod[] = ['CASH_ON_DELIVERY', 'BKASH', 'NAGAD', 'CREDIT_CARD'];

export interface PaymentRouteDeps {
  client: DatabaseClient;
  orderRepo: OrderRepository;
  paymentRepo: PaymentRepository;
  refundRepo: RefundRepository;
  auditRepo: AuditLogRepository;
}

/**
 * The money-moving routes: taking a payment for an order, the customer cancelling and
 * being refunded, and an administrator refunding after that window has closed.
 *
 * All three are **guarded by the same durable idempotency service as placing an order**,
 * for the same reason: a retry is normal (a dropped connection, a deploy, a second
 * instance) and it must not charge or refund twice. Each route therefore requires an
 * `Idempotency-Key` header, and a repeat of the same request is answered from the stored
 * answer rather than by repeating the work.
 *
 * Two ordering rules make that hold, and they are the subtle part of this file:
 *
 * 1. **Nothing that the request itself changes may be checked before the guard.** An
 *    already-cancelled order or an already-recorded payment is not a reason to refuse a
 *    retry; it is the *result* of the first attempt. Those checks live inside the guarded
 *    action, so a retry replays the stored answer instead of failing with a conflict.
 * 2. **Money invariants are checked inside the write transaction.** The refunds against an
 *    order may never exceed what was paid for it, and each order may hold at most one
 *    completed payment. `BEGIN IMMEDIATE` serialises the writers, so two different keys
 *    asking for the same money back cannot both succeed — the key guard alone would not
 *    stop that, which is exactly the double-refund it must not be possible to cause.
 *
 * No payment gateway is called: there is none in this codebase, and the durable guard
 * cannot roll an external call back with the transaction it belongs to. The platform
 * records what it knows about money in its own ledger (`payments`, `refunds`).
 */
export function createPaymentRoutes(deps: PaymentRouteDeps): Route[] {
  // Database-backed like the order path: the key, the claim and the stored answer are rows,
  // so a retry is answered the same way by any process serving the same database.
  const idempotency = new DurableIdempotencyService(deps.client);

  /** The guard is only as good as the key: without one, every retry is a new request. */
  function requireIdempotencyKey(ctx: Pick<RequestContext, 'headers'>): string {
    const raw = ctx.headers['idempotency-key'];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (typeof key !== 'string' || key.trim() === '') {
      throw new ValidationError('Idempotency-Key header is required for a money-moving request', {
        field: 'Idempotency-Key'
      });
    }
    return key.trim();
  }

  async function requireOrder(orderId: string): Promise<OrderRecord> {
    const order = await deps.orderRepo.findById(orderId);
    if (!order) throw new NotFoundError('Order');
    return order;
  }

  /** The order's identity is the caller's, not the body's, so this is ownership, not policy. */
  function assertOwnsOrder(order: OrderRecord, caller: UserRecord, action: string): void {
    if (order.customerId !== caller.id) {
      throw new ForbiddenError(`Order does not belong to the authenticated account: ${action}`);
    }
  }

  /**
   * The rules engine speaks a design vocabulary (`PLACED`, `CONFIRMED_BY_MERCHANT`, …)
   * that is richer than the statuses stored on an order. The mapping is explicit so a
   * stored status this code has not thought about cannot silently become "cancellable":
   * anything unmapped is refused.
   */
  const ENGINE_STATUS: Partial<Record<OrderRecord['status'], EngineStatus>> = {
    PENDING: 'PLACED',
    CONFIRMED: 'CONFIRMED_BY_MERCHANT',
    PREPARING: 'PREPARING',
    OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
    DELIVERED: 'DELIVERED'
  };

  function toEngineOrder(order: OrderRecord): OrderStateRecord {
    const status = ENGINE_STATUS[order.status];
    if (!status) {
      throw new ConflictError(`Order '${order.id}' is ${order.status} and has no cancellation policy`);
    }
    return {
      orderId: order.id,
      status,
      placedAt: new Date(order.createdAt),
      totalAmount: order.totalBdt,
      deliveryFee: order.deliveryFeeBdt,
      itemsSubtotal: order.subtotalBdt,
      merchantId: order.merchantId,
      ...(order.driverId ? { driverId: order.driverId } : {}),
      customerId: order.customerId
    };
  }

  function parsePaymentMethod(body: Record<string, unknown>): PaymentMethod {
    const raw = typeof body.method === 'string' ? body.method.trim().toUpperCase() : '';
    if (!(PAYMENT_METHODS as readonly string[]).includes(raw)) {
      throw new ValidationError(`Field 'method' must be one of ${PAYMENT_METHODS.join(', ')}`, {
        field: 'method'
      });
    }
    return raw as PaymentMethod;
  }

  async function audit(
    action: string,
    entityType: string,
    entityId: string,
    userId: string,
    values: Record<string, unknown>,
    /** The session that acted, so a payment trail names the device that made it. */
    sessionId: string | null
  ): Promise<void> {
    await deps.auditRepo.log({
      id: `aud_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      userId,
      action,
      entityType,
      entityId,
      oldValues: null,
      newValues: JSON.stringify(values),
      ipAddress: null,
      userAgent: null,
      sessionId
    });
  }

  function serializePayment(payment: PaymentRecord): Record<string, unknown> {
    return {
      id: payment.id,
      orderId: payment.orderId,
      transactionId: payment.transactionId,
      provider: payment.provider,
      method: payment.method,
      amountBdt: payment.amountBdt,
      status: payment.status,
      reference: payment.rawGatewayResponse ? JSON.parse(payment.rawGatewayResponse) : null,
      createdAt: payment.createdAt
    };
  }

  function serializeRefund(refund: RefundRecord): Record<string, unknown> {
    return {
      id: refund.id,
      orderId: refund.orderId,
      paymentId: refund.paymentId ?? null,
      amountBdt: refund.amountBdt,
      status: refund.status,
      reason: refund.reason ?? null,
      notes: refund.notes ?? null,
      initiatedBy: refund.initiatedBy,
      initiatorRole: refund.initiatorRole,
      createdAt: refund.createdAt
    };
  }

  return [
    {
      method: 'POST',
      path: `${API_PREFIX}/orders/:orderId/payments`,
      requiresAuth: true,
      permission: 'order:create',
      handler: async (ctx): Promise<RouteResult> => {
        const caller = authenticatedUser(ctx);
        const order = await requireOrder(ctx.params.orderId);
        assertOwnsOrder(order, caller, `a payment may only be recorded by its customer`);

        const idempotencyKey = requireIdempotencyKey(ctx);
        const method = parsePaymentMethod(ctx.body);
        const reference = typeof ctx.body.reference === 'string' ? ctx.body.reference.trim() : '';
        // The price is the order's, never the body's: a client that could name the amount
        // could pay one taka for a delivered meal.
        const amountBdt = order.totalBdt;

        const outcome = await idempotency.execute<Record<string, unknown>>(
          {
            key: idempotencyKey,
            userId: caller.id,
            // The order is part of the endpoint, so the same key on two orders is two
            // requests rather than a payload conflict.
            endpoint: `POST ${API_PREFIX}/orders/${order.id}/payments`,
            payload: { orderId: order.id, method, reference }
          },
          async () => {
            // Re-read under the write lock: the state a retry must not mistake for a
            // refusal is re-checked here, and only here.
            const current = await requireOrder(order.id);
            if (current.status === 'CANCELLED') {
              throw new ConflictError(`Order '${current.id}' is cancelled and cannot be paid`);
            }
            const already = await deps.paymentRepo.findCompletedByOrderId(current.id);
            if (already) {
              throw new ConflictError(
                `Order '${current.id}' has already been paid (payment ${already.id}); a second charge was refused`
              );
            }

            const payment = await deps.client.transaction(async () => {
              // The partial unique index on `payments` refuses a second completed payment
              // for one order. Translating that into the same conflict the pre-check
              // throws means a race between two different keys is answered the same way
              // whether the handler or the database noticed first — never as a 500.
              const created = await deps.paymentRepo
                .create({
                  id: `pay_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
                  orderId: current.id,
                  transactionId: `TXN_${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`,
                  provider: method,
                  method,
                  amountBdt: current.totalBdt,
                  status: 'COMPLETED',
                  rawGatewayResponse: reference === '' ? null : JSON.stringify({ reference })
                })
                .catch((error: unknown) => {
                  // Recognised for both engines: the partial unique index is the invariant, and
                  // SQLite reports it as a message while PostgreSQL reports a SQLSTATE.
                  if (isUniqueViolationError(error)) {
                    throw new ConflictError(
                      `Order '${current.id}' has already been paid; a second charge was refused`
                    );
                  }
                  throw error;
                });
              await audit(
                'ORDER_PAYMENT_RECORDED',
                'ORDER',
                current.id,
                caller.id,
                {
                  paymentId: created.id,
                  amountBdt: created.amountBdt,
                  method: created.method
                },
                ctx.auth?.sessionId ?? null
              );
              return created;
            });

            return {
              status: 201,
              body: { success: true, payment: serializePayment(payment) }
            };
          }
        );

        return { status: outcome.status, body: outcome.body };
      }
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/orders/:orderId/cancel`,
      requiresAuth: true,
      permission: 'order:cancel:own',
      handler: async (ctx): Promise<RouteResult> => {
        const caller = authenticatedUser(ctx);
        const order = await requireOrder(ctx.params.orderId);

        // The customer's own order, cancelled by the customer. An administrator ending
        // somebody else's order is a different act with a different policy, and is not
        // this route.
        if (order.customerId !== caller.id) {
          throw new ForbiddenError('Only the customer who placed an order can cancel it');
        }
        if (order.status === 'DELIVERED') {
          throw new ForbiddenError(
            'A delivered order cannot be cancelled; an administrator refunds it through the refund endpoint'
          );
        }

        const idempotencyKey = requireIdempotencyKey(ctx);
        const reason = typeof ctx.body.reason === 'string' ? ctx.body.reason.trim() : '';

        const outcome = await idempotency.execute<Record<string, unknown>>(
          {
            key: idempotencyKey,
            userId: caller.id,
            endpoint: `POST ${API_PREFIX}/orders/${order.id}/cancel`,
            payload: { orderId: order.id, reason }
          },
          async () => {
            const current = await requireOrder(order.id);
            if (current.status === 'CANCELLED') {
              throw new ConflictError(`Order '${current.id}' is already cancelled`);
            }

            // What the customer is owed for ending the order where it stands.
            const policy = orderRulesEngine.evaluateCancellation(
              toEngineOrder(current),
              'CUSTOMER',
              new Date(),
              reason
            );
            if (!policy.allowed) {
              throw new ForbiddenError(policy.reason);
            }

            const recorded = await deps.client.transaction(async () => {
              const paid = await deps.paymentRepo.findCompletedByOrderId(current.id);
              // Only money that actually arrived can go back, so the policy amount is
              // capped by what was paid: an unpaid cash order is cancelled without a refund
              // rather than inventing one.
              const refundAmount =
                paid === null ? 0 : Math.round(Math.min(policy.customerRefundAmount, paid.amountBdt) * 100) / 100;

              const updated = await deps.orderRepo.updateStatus(
                current.id,
                'CANCELLED',
                reason === '' ? policy.reason : reason
              );

              const refund =
                refundAmount > 0 && paid !== null
                  ? await deps.refundRepo.create({
                      id: `ref_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
                      orderId: current.id,
                      paymentId: paid.id,
                      amountBdt: refundAmount,
                      status: 'COMPLETED',
                      reason: policy.reason,
                      notes: reason === '' ? null : reason,
                      initiatedBy: caller.id,
                      initiatorRole: caller.role
                    })
                  : null;

              // The payment is only marked refunded when all of it went back; a partial
              // refund leaves the payment completed, because part of it is still held.
              if (refund !== null && paid !== null && refundAmount >= paid.amountBdt) {
                await deps.paymentRepo.updateStatus(paid.id, 'REFUNDED');
              }

              await audit(
                'ORDER_CANCELLED',
                'ORDER',
                current.id,
                caller.id,
                {
                  policyReason: policy.reason,
                  refundAmount,
                  refundId: refund?.id ?? null,
                  merchantCompensationFee: policy.merchantCompensationFee
                },
                ctx.auth?.sessionId ?? null
              );

              return { updated, refund, refundAmount, policy };
            });

            return {
              status: 200,
              body: {
                success: true,
                order: { id: recorded.updated.id, status: recorded.updated.status },
                refundAmount: recorded.refundAmount,
                policy: {
                  reason: recorded.policy.reason,
                  refundEligibilityPercent: recorded.policy.refundEligibilityPercent,
                  merchantCompensationFee: recorded.policy.merchantCompensationFee
                },
                refund: recorded.refund ? serializeRefund(recorded.refund) : null
              }
            };
          }
        );

        return { status: outcome.status, body: outcome.body };
      }
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/orders/:orderId/refunds`,
      requiresAuth: true,
      permission: 'order:manage:all',
      handler: async (ctx): Promise<RouteResult> => {
        const caller = authenticatedUser(ctx);
        const order = await requireOrder(ctx.params.orderId);
        const idempotencyKey = requireIdempotencyKey(ctx);
        const requestedAmount =
          ctx.body.amountBdt === undefined ? undefined : Number(ctx.body.amountBdt);
        const reason = typeof ctx.body.reason === 'string' ? ctx.body.reason.trim() : '';

        if (requestedAmount !== undefined && (!Number.isFinite(requestedAmount) || requestedAmount <= 0)) {
          throw new ValidationError("Field 'amountBdt' must be a positive number", { field: 'amountBdt' });
        }

        const outcome = await idempotency.execute<Record<string, unknown>>(
          {
            key: idempotencyKey,
            userId: caller.id,
            endpoint: `POST ${API_PREFIX}/orders/${order.id}/refunds`,
            payload: { orderId: order.id, amountBdt: requestedAmount ?? null, reason }
          },
          async () => {
            const recorded = await deps.client.transaction(async () => {
              // Inside the write lock: the money taken and the money returned are read
              // and written together, so two administrators (or two processes) cannot each
              // see "nothing refunded yet" and both send money back.
              //
              // The payment is looked up whatever its status, because a payment this
              // endpoint already refunded in full reads as `REFUNDED`: "nothing was paid"
              // and "all of it is already back" are different answers, and a caller that
              // had been paid back needs the second one.
              const payments = await deps.paymentRepo.findByOrderId(order.id);
              const paid =
                payments.find((payment) => payment.status === 'COMPLETED') ??
                payments.find((payment) => payment.status === 'REFUNDED') ??
                null;
              if (!paid) {
                throw new ConflictError(`Order '${order.id}' has no completed payment to refund`);
              }

              const alreadyRefunded = await deps.refundRepo.totalRefundedBdt(order.id);
              const remaining = Math.round((paid.amountBdt - alreadyRefunded) * 100) / 100;
              if (remaining <= 0) {
                throw new ConflictError(
                  `Order '${order.id}' has already been refunded in full (${paid.amountBdt} BDT)`
                );
              }

              const amountBdt = requestedAmount ?? remaining;
              if (amountBdt > remaining) {
                throw new ValidationError(
                  `Refund of ${amountBdt} BDT exceeds the ${remaining} BDT still held for order '${order.id}'`,
                  { field: 'amountBdt', remainingBdt: remaining }
                );
              }

              const refund = await deps.refundRepo.create({
                id: `ref_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
                orderId: order.id,
                paymentId: paid.id,
                amountBdt,
                status: 'COMPLETED',
                reason: reason === '' ? 'Administrator refund' : reason,
                notes: null,
                initiatedBy: caller.id,
                initiatorRole: caller.role
              });

              if (amountBdt >= remaining) {
                await deps.paymentRepo.updateStatus(paid.id, 'REFUNDED');
              }

              await audit(
                'ORDER_REFUNDED',
                'ORDER',
                order.id,
                caller.id,
                {
                  refundId: refund.id,
                  amountBdt,
                  paidAmountBdt: paid.amountBdt,
                  previouslyRefundedBdt: alreadyRefunded
                },
                ctx.auth?.sessionId ?? null
              );

              return { refund, paid, alreadyRefunded };
            });

            return {
              status: 201,
              body: {
                success: true,
                refund: serializeRefund(recorded.refund),
                paidAmountBdt: recorded.paid.amountBdt,
                previouslyRefundedBdt: recorded.alreadyRefunded
              }
            };
          }
        );

        return { status: outcome.status, body: outcome.body };
      }
    }
  ];
}
