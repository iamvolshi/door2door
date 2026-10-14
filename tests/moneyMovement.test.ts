import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SEEDED,
  createTempDatabaseDir,
  getJson,
  login,
  postJson,
  removeTempDatabaseDir,
  startServer,
  type ApiResponse,
  type LoggedInAccount,
  type RunningServer
} from './apiTestClient';

/**
 * Money that moves exactly once.
 *
 * Three routes can send money or take it: recording a payment, the customer cancelling
 * their own order (which refunds what the policy says they are owed), and an
 * administrator refunding after that window has closed. Each is guarded by the same
 * durable idempotency service as placing an order, so the cases here are the two ways a
 * duplicate becomes a loss:
 *
 *  - **a retry** — a dropped connection, a deploy, a second instance — must return the
 *    stored answer rather than repeating the work;
 *  - **two different keys** asking for the same money must not both succeed, which the
 *    key guard cannot help with and the write transaction has to.
 *
 * The amounts are never taken from the body: a client that could name the amount could pay
 * one taka for a delivered meal, so every expectation below is computed from the order.
 */
let tempDir: string;
let app: RunningServer;
let customer: LoggedInAccount;
let admin: LoggedInAccount;

function key(label: string): string {
  return `${label}-${randomUUID()}`;
}

/** A new order for the seeded customer, priced by the server. */
async function placeOrder(): Promise<{ orderId: string; total: number; subtotal: number }> {
  const placed = await postJson(
    app,
    '/api/v1/orders',
    {
      customerId: SEEDED.customer.id,
      merchantId: SEEDED.merchantId,
      deliveryAddressId: SEEDED.addressId,
      serviceArea: 'cox_bazar_sadar',
      distanceKm: 3,
      items: [{ itemId: SEEDED.coralId, quantity: 1 }]
    },
    { token: customer.accessToken, headers: { 'idempotency-key': key('place') } }
  );
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  return {
    orderId: placed.body.order.id,
    total: placed.body.order.pricing.totalBdt,
    subtotal: placed.body.order.pricing.subtotalBdt
  };
}

function pay(
  orderId: string,
  idempotencyKey: string,
  options: { token?: string; method?: string; reference?: string; amountBdt?: number } = {}
): Promise<ApiResponse> {
  return postJson(
    app,
    `/api/v1/orders/${orderId}/payments`,
    {
      method: options.method ?? 'BKASH',
      ...(options.reference === undefined ? {} : { reference: options.reference }),
      // Sent deliberately by some cases: the server must ignore it.
      ...(options.amountBdt === undefined ? {} : { amountBdt: options.amountBdt })
    },
    { token: options.token ?? customer.accessToken, headers: { 'idempotency-key': idempotencyKey } }
  );
}

function cancel(
  orderId: string,
  idempotencyKey: string,
  options: { token?: string; reason?: string } = {}
): Promise<ApiResponse> {
  return postJson(
    app,
    `/api/v1/orders/${orderId}/cancel`,
    options.reason === undefined ? {} : { reason: options.reason },
    { token: options.token ?? customer.accessToken, headers: { 'idempotency-key': idempotencyKey } }
  );
}

function refund(
  orderId: string,
  idempotencyKey: string,
  options: { token?: string; amountBdt?: number; reason?: string } = {}
): Promise<ApiResponse> {
  return postJson(
    app,
    `/api/v1/orders/${orderId}/refunds`,
    {
      ...(options.amountBdt === undefined ? {} : { amountBdt: options.amountBdt }),
      ...(options.reason === undefined ? {} : { reason: options.reason })
    },
    { token: options.token ?? admin.accessToken, headers: { 'idempotency-key': idempotencyKey } }
  );
}

async function paymentsFor(orderId: string): Promise<{ id: string; status: string; amountBdt: number }[]> {
  const res = await app.client.query<{ id: string; status: string; amountBdt: number }>(
    'SELECT id, status, amountBdt FROM payments WHERE orderId = ?',
    [orderId]
  );
  return res.rows;
}

async function refundsFor(orderId: string): Promise<{ id: string; amountBdt: number; initiatorRole: string }[]> {
  const res = await app.client.query<{ id: string; amountBdt: number; initiatorRole: string }>(
    'SELECT id, amountBdt, initiatorRole FROM refunds WHERE orderId = ?',
    [orderId]
  );
  return res.rows;
}

async function orderStatus(orderId: string): Promise<string> {
  const res = await app.client.query<{ status: string }>('SELECT status FROM orders WHERE id = ?', [orderId]);
  return String(res.rows[0]?.status);
}

/** Moves an order through the states the money rules depend on, and ages it if asked. */
async function setOrderState(orderId: string, status: string, ageSeconds = 0): Promise<void> {
  await app.client.query('UPDATE orders SET status = ?, createdAt = ? WHERE id = ?', [
    status,
    new Date(Date.now() - ageSeconds * 1000).toISOString(),
    orderId
  ]);
}

beforeAll(async () => {
  tempDir = createTempDatabaseDir();
  app = await startServer({
    port: 0,
    host: '127.0.0.1',
    databaseFile: `${tempDir}/money.sqlite`,
    rateLimit: { max: 5000, windowMs: 60000 }
  });
  customer = await login(app, SEEDED.customer.phone);
  admin = await login(app, SEEDED.admin.phone);
});

afterAll(async () => {
  await app?.close();
  removeTempDatabaseDir(tempDir);
});

describe('Recording a payment against an order', () => {
  it('records the amount the order says, not the amount the body claims', async () => {
    const order = await placeOrder();
    const paid = await pay(order.orderId, key('pay'), {
      reference: 'BKASH-TRX-1',
      amountBdt: 1
    });

    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.payment.amountBdt).toBe(order.total);
    expect(paid.body.payment.status).toBe('COMPLETED');
    expect(paid.body.payment.reference).toEqual({ reference: 'BKASH-TRX-1' });

    const rows = await paymentsFor(order.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountBdt).toBe(order.total);
  });

  it('answers a retry with the stored payment instead of taking the money again', async () => {
    const order = await placeOrder();
    const idempotencyKey = key('pay-retry');

    const first = await pay(order.orderId, idempotencyKey);
    const retry = await pay(order.orderId, idempotencyKey);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(await paymentsFor(order.orderId)).toHaveLength(1);
  });

  it('refuses the same key used for a different payment', async () => {
    const order = await placeOrder();
    const idempotencyKey = key('pay-different');

    expect((await pay(order.orderId, idempotencyKey, { method: 'BKASH' })).status).toBe(201);

    const reused = await pay(order.orderId, idempotencyKey, { method: 'CASH_ON_DELIVERY' });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('CONFLICT');
    expect(reused.body.error.message).toMatch(/different request payload/);
    expect(await paymentsFor(order.orderId)).toHaveLength(1);
  });

  it('refuses a second completed payment for one order under a new key', async () => {
    // The retry guard cannot see this one: the keys differ, so only the order's own rule
    // that at most one payment completes can refuse it.
    const order = await placeOrder();
    expect((await pay(order.orderId, key('charge-a'))).status).toBe(201);

    const second = await pay(order.orderId, key('charge-b'));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
    expect(second.body.error.message).toMatch(/already been paid/);
    expect(await paymentsFor(order.orderId)).toHaveLength(1);
  });

  it('refuses a second completed payment even when both are asked for at once', async () => {
    const order = await placeOrder();
    const [a, b] = await Promise.all([
      pay(order.orderId, key('charge-race-a')),
      pay(order.orderId, key('charge-race-b'))
    ]);

    // Different keys, so only the order's own rule can refuse one of them — and whichever
    // loses must be told why rather than answered with a server error.
    expect([a.status, b.status].filter((status) => status === 201)).toHaveLength(1);
    const refused = [a, b].find((response) => response.status !== 201);
    expect(refused?.status, JSON.stringify(refused?.body)).toBe(409);
    expect(refused?.body.error.message).toMatch(/already been paid/);
    expect(await paymentsFor(order.orderId)).toHaveLength(1);
  });

  it('is refused by the database itself, not only by the handler', async () => {
    // Bypasses the route completely: a second completed payment for one order must be
    // impossible for anything writing to this database, not just for this handler.
    const order = await placeOrder();
    await pay(order.orderId, key('charge-for-index'));

    await expect(
      app.client.query(
        `INSERT INTO payments (id, orderId, transactionId, provider, method, amountBdt, status, rawGatewayResponse, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'pay_sneaky',
          order.orderId,
          'TXN_SNEAKY',
          'BKASH',
          'BKASH',
          order.total,
          'COMPLETED',
          null,
          new Date().toISOString(),
          new Date().toISOString()
        ]
      )
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect(await paymentsFor(order.orderId)).toHaveLength(1);
  });

  it('refuses a payment for an order that is not the caller’s own', async () => {
    const order = await placeOrder();
    // The administrator holds order:create, so what refuses this is ownership.
    const asAdmin = await pay(order.orderId, key('pay-foreign'), { token: admin.accessToken });
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body.error.message).toMatch(/does not belong to the authenticated account/);
    expect(await paymentsFor(order.orderId)).toHaveLength(0);
  });

  it('requires an Idempotency-Key, because a charge without one can be repeated', async () => {
    const order = await placeOrder();
    const noKey = await postJson(app, `/api/v1/orders/${order.orderId}/payments`, { method: 'BKASH' }, {
      token: customer.accessToken
    });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.message).toMatch(/Idempotency-Key/);
    expect(await paymentsFor(order.orderId)).toHaveLength(0);
  });

  it('suits the schema’s method list and nothing else', async () => {
    const order = await placeOrder();
    const bogus = await pay(order.orderId, key('pay-method'), { method: 'GOLD_COINS' });
    expect(bogus.status).toBe(400);
    expect(bogus.body.error.message).toMatch(/method/);
  });
});

describe('The customer cancelling their own order', () => {
  it('cancels an unpaid order without inventing a refund', async () => {
    const order = await placeOrder();
    const cancelled = await cancel(order.orderId, key('cancel-unpaid'), { reason: 'Changed my mind' });

    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.order.status).toBe('CANCELLED');
    // Nothing was ever paid, so there is nothing to give back — the cancellation is the
    // record, and no refund row is written.
    expect(cancelled.body.refundAmount).toBe(0);
    expect(cancelled.body.refund).toBeNull();
    expect(await refundsFor(order.orderId)).toHaveLength(0);
  });

  it('refunds the whole amount it took when the order is cancelled inside the window', async () => {
    const order = await placeOrder();
    expect((await pay(order.orderId, key('pay-then-cancel'))).status).toBe(201);

    const cancelled = await cancel(order.orderId, key('cancel-paid'));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.refundAmount).toBe(order.total);
    expect(cancelled.body.policy.refundEligibilityPercent).toBe(100);
    expect(cancelled.body.refund.amountBdt).toBe(order.total);
    expect(cancelled.body.refund.initiatorRole).toBe('CUSTOMER');

    const refunds = await refundsFor(order.orderId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amountBdt).toBe(order.total);
    // The whole payment went back, so the payment row says so.
    expect((await paymentsFor(order.orderId))[0].status).toBe('REFUNDED');
    expect(await orderStatus(order.orderId)).toBe('CANCELLED');
  });

  it('answers a retry of the cancellation with the stored answer and pays back once', async () => {
    const order = await placeOrder();
    await pay(order.orderId, key('pay-retry-cancel'));
    const idempotencyKey = key('cancel-retry');

    const first = await cancel(order.orderId, idempotencyKey);
    const retry = await cancel(order.orderId, idempotencyKey);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(await refundsFor(order.orderId)).toHaveLength(1);
  });

  it('refuses a second cancellation under a new key, leaving one refund', async () => {
    const order = await placeOrder();
    await pay(order.orderId, key('pay-double-cancel'));
    expect((await cancel(order.orderId, key('cancel-first'))).status).toBe(200);

    const again = await cancel(order.orderId, key('cancel-second'));
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/already cancelled/);
    expect(await refundsFor(order.orderId)).toHaveLength(1);
  });

  it('gives back less when the merchant has already started cooking', async () => {
    const order = await placeOrder();
    await pay(order.orderId, key('pay-preparing'));
    // Past the grace period, and the merchant has accepted and started: the policy keeps
    // half of the food cost for the merchant.
    await setOrderState(order.orderId, 'PREPARING', 600);

    const cancelled = await cancel(order.orderId, key('cancel-preparing'));
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const merchantCompensation = Math.round(order.subtotal * 0.5 * 100) / 100;
    const expected = Math.round((order.total - merchantCompensation) * 100) / 100;
    expect(cancelled.body.refundAmount).toBe(expected);
    expect(cancelled.body.policy.merchantCompensationFee).toBe(merchantCompensation);
    expect(cancelled.body.refundAmount).toBeLessThan(order.total);

    // Part of the money is still held, so the payment is not marked refunded.
    expect((await paymentsFor(order.orderId))[0].status).toBe('COMPLETED');
  });

  it('refuses to cancel an order that is already out for delivery', async () => {
    const order = await placeOrder();
    await pay(order.orderId, key('pay-in-transit'));
    await setOrderState(order.orderId, 'OUT_FOR_DELIVERY', 700);

    const refused = await cancel(order.orderId, key('cancel-in-transit'));
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/out for delivery/i);
    expect(await orderStatus(order.orderId)).toBe('OUT_FOR_DELIVERY');
    expect(await refundsFor(order.orderId)).toHaveLength(0);
  });

  it('refuses to cancel a delivered order and names the endpoint that can refund it', async () => {
    const order = await placeOrder();
    await pay(order.orderId, key('pay-delivered'));
    await setOrderState(order.orderId, 'DELIVERED', 3600);

    const refused = await cancel(order.orderId, key('cancel-delivered'));
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/refund endpoint/);
    expect(await refundsFor(order.orderId)).toHaveLength(0);
  });

  it('refuses a cancellation from an account that did not place the order', async () => {
    const order = await placeOrder();
    const asAdmin = await cancel(order.orderId, key('cancel-foreign'), { token: admin.accessToken });
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body.error.message).toMatch(/Only the customer/);
  });
});

describe('An administrator refunding after the window', () => {
  it('refunds a delivered order and records who authorised it', async () => {
    const order = await placeOrder();
    await pay(order.orderId, key('pay-admin-refund'));
    await setOrderState(order.orderId, 'DELIVERED', 3600);

    const refunded = await refund(order.orderId, key('refund-admin'), { reason: 'Missing item' });
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(201);
    expect(refunded.body.refund.amountBdt).toBe(order.total);
    expect(refunded.body.refund.initiatorRole).toBe('ADMIN');
    expect(refunded.body.refund.reason).toBe('Missing item');
    expect((await paymentsFor(order.orderId))[0].status).toBe('REFUNDED');
  });

  it('answers a retry with the stored refund', async () => {
    const order = await placeOrder();
    await pay(order.orderId, key('pay-admin-retry'));
    const idempotencyKey = key('refund-retry');

    const first = await refund(order.orderId, idempotencyKey);
    const retry = await refund(order.orderId, idempotencyKey);

    expect(first.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(await refundsFor(order.orderId)).toHaveLength(1);
  });

  it('refuses to send back more than is still held, and allows the remainder', async () => {
    const order = await placeOrder();
    await pay(order.orderId, key('pay-partial'));

    const partial = await refund(order.orderId, key('refund-partial'), { amountBdt: 30 });
    expect(partial.status).toBe(201);
    expect(partial.body.refund.amountBdt).toBe(30);

    // More than remains is refused rather than silently capped.
    const tooMuch = await refund(order.orderId, key('refund-too-much'), {
      amountBdt: order.total
    });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.message).toMatch(/exceeds/);

    // The remainder is exactly what is left, and completing it flips the payment.
    const remaining = Math.round((order.total - 30) * 100) / 100;
    const rest = await refund(order.orderId, key('refund-rest'), { amountBdt: remaining });
    expect(rest.status).toBe(201);
    expect((await paymentsFor(order.orderId))[0].status).toBe('REFUNDED');

    const refunds = await refundsFor(order.orderId);
    expect(refunds).toHaveLength(2);
    expect(refunds.reduce((sum, row) => sum + row.amountBdt, 0)).toBeCloseTo(order.total, 2);

    // And now the money is all back, so a third refund is a conflict rather than a loss.
    const beyond = await refund(order.orderId, key('refund-beyond'));
    expect(beyond.status).toBe(409);
    expect(beyond.body.error.message).toMatch(/already been refunded in full/);
  });

  it('refuses a refund for an order nothing was ever paid for', async () => {
    const order = await placeOrder();
    const nothing = await refund(order.orderId, key('refund-unpaid'));
    expect(nothing.status).toBe(409);
    expect(nothing.body.error.message).toMatch(/no completed payment/);
    expect(await refundsFor(order.orderId)).toHaveLength(0);
  });

  it('refuses a customer’s token, since this is not the customer’s decision', async () => {
    const order = await placeOrder();
    await pay(order.orderId, key('pay-customer-refund'));
    const asCustomer = await refund(order.orderId, key('refund-customer'), { token: customer.accessToken });
    expect(asCustomer.status).toBe(403);
    expect(asCustomer.body.error.message).toMatch(/lacks permission 'order:manage:all'/);
    expect(await refundsFor(order.orderId)).toHaveLength(0);
  });
});

describe('Two requests at once', () => {
  it('records one payment when the same charge arrives twice simultaneously', async () => {
    const order = await placeOrder();
    const idempotencyKey = key('pay-concurrent');

    const [a, b] = await Promise.all([
      pay(order.orderId, idempotencyKey),
      pay(order.orderId, idempotencyKey)
    ]);

    for (const response of [a, b]) {
      expect([201, 409]).toContain(response.status);
    }
    expect(await paymentsFor(order.orderId)).toHaveLength(1);
  });

  it('never refunds more than was paid when two different keys race', async () => {
    const order = await placeOrder();
    await pay(order.orderId, key('pay-race-refund'));

    // Same amount, two keys, fired together: whichever order they land in, the money that
    // goes back cannot exceed the money that came in.
    const [a, b] = await Promise.all([
      refund(order.orderId, key('refund-race-a')),
      refund(order.orderId, key('refund-race-b'))
    ]);

    const succeeded = [a, b].filter((response) => response.status === 201);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    const refunds = await refundsFor(order.orderId);
    const total = refunds.reduce((sum, row) => sum + row.amountBdt, 0);
    expect(total).toBeLessThanOrEqual(order.total);
    expect(total).toBeCloseTo(succeeded.length === 2 ? order.total : order.total, 2);
    // Two successful refunds of the full amount would be a double refund, and the second
    // one is refused instead.
    if (succeeded.length === 2) {
      expect(refunds).toHaveLength(2);
    } else {
      expect(refunds).toHaveLength(1);
      expect([409, 400]).toContain([a, b].find((response) => response.status !== 201)?.status);
    }
  });

  it('cancels once and refunds once when the cancellation races', async () => {
    const order = await placeOrder();
    await pay(order.orderId, key('pay-race-cancel'));
    const idempotencyKey = key('cancel-race');

    const [a, b] = await Promise.all([
      cancel(order.orderId, idempotencyKey),
      cancel(order.orderId, idempotencyKey)
    ]);

    for (const response of [a, b]) {
      expect([200, 409]).toContain(response.status);
    }
    expect(await refundsFor(order.orderId)).toHaveLength(1);
    expect(await orderStatus(order.orderId)).toBe('CANCELLED');
  });
});

describe('What the money endpoints say about an order', () => {
  it('leaves the order readable with its payment and refund visible to the owner', async () => {
    const order = await placeOrder();
    await pay(order.orderId, key('pay-readable'));
    await refund(order.orderId, key('refund-readable'), { amountBdt: 10 });

    const fetched = await getJson(app, `/api/v1/orders/${order.orderId}`, { token: customer.accessToken });
    expect(fetched.status).toBe(200);
    // The order endpoint is about fulfilment, not money: the refund is a separate ledger
    // row, and the order keeps its status.
    expect(fetched.body.order.status).toBe('PENDING');
    expect(fetched.body.order.pricing.totalBdt).toBe(order.total);
  });
});
