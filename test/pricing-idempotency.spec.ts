import { PricingService, DELIVERY_TIERS } from '../src/services/pricingService';
import { OrderRulesEngine, OrderStateRecord } from '../src/services/orderRules';
import { IdempotencyService } from '../src/services/idempotencyService';
import { ReconciliationService } from '../src/services/reconciliationService';
import { ValidationError, ConflictError, ForbiddenError } from '../src/core/errors';

describe('PricingService - Strict Server-Side Calculation', () => {
  let pricing: PricingService;

  beforeEach(() => {
    pricing = new PricingService([
      {
        id: 'item-101',
        storeId: 'store-cox-1',
        name: 'Cox Special Fried Pomfret',
        basePrice: 300,
        taxRate: 0.05,
        isAvailable: true,
        maxQuantityPerOrder: 5,
      },
      {
        id: 'item-102',
        storeId: 'store-cox-1',
        name: 'Steamed Rice Plate',
        basePrice: 50,
        taxRate: 0.05,
        isAvailable: true,
      },
      {
        id: 'item-out-of-stock',
        storeId: 'store-cox-1',
        name: 'Lobster Platter',
        basePrice: 1200,
        taxRate: 0.05,
        isAvailable: false,
      },
    ], [
      {
        code: 'SEAFOOD20',
        type: 'PERCENTAGE',
        value: 20,
        minimumOrderAmount: 300,
        maxDiscountAmount: 100,
        validUntil: new Date('2028-12-31'),
        isActive: true,
      },
      {
        code: 'FLAT50',
        type: 'FIXED_AMOUNT',
        value: 50,
        minimumOrderAmount: 200,
        validUntil: new Date('2028-12-31'),
        isActive: true,
      }
    ]);
  });

  it('should accurately calculate items subtotal, tax, and delivery fee for Cox Sadar', () => {
    const result = pricing.calculateOrderPricing({
      storeId: 'store-cox-1',
      serviceArea: 'cox_bazar_sadar',
      distanceKm: 4,
      items: [
        { itemId: 'item-101', quantity: 2 }, // 600
        { itemId: 'item-102', quantity: 1 }, // 50
      ],
    });

    expect(result.itemsSubtotal).toBe(650);
    // 5% tax on 650 = 32.5
    expect(result.taxTotal).toBe(32.5);
    // Sadar baseFee (30) + 4km * 10 = 70
    expect(result.deliveryFee).toBe(70);
    // 650 + 32.5 + 70 = 752.5
    expect(result.finalPayableAmount).toBe(752.5);
  });

  it('should ignore client-side price tampering and use true catalog prices', () => {
    const result = pricing.calculateOrderPricing({
      storeId: 'store-cox-1',
      serviceArea: 'cox_bazar_sadar',
      distanceKm: 2,
      items: [
        // Attacker claims item-101 is 1 BDT instead of 300 BDT
        { itemId: 'item-101', quantity: 1, claimedUnitPrice: 1 },
      ],
    });

    expect(result.items[0].unitPrice).toBe(300);
    expect(result.itemsSubtotal).toBe(300);
  });

  it('should apply percentage coupon with max discount cap', () => {
    const result = pricing.calculateOrderPricing({
      storeId: 'store-cox-1',
      serviceArea: 'ramu',
      distanceKm: 5,
      items: [{ itemId: 'item-101', quantity: 3 }], // 900 BDT
      couponCode: 'SEAFOOD20', // 20% of 900 = 180, capped at 100
    });

    expect(result.discountAmount).toBe(100);
    expect(result.appliedCouponCode).toBe('SEAFOOD20');
  });

  it('should reject out-of-stock items and quantity exceeding maximum', () => {
    expect(() => {
      pricing.calculateOrderPricing({
        storeId: 'store-cox-1',
        serviceArea: 'cox_bazar_sadar',
        distanceKm: 1,
        items: [{ itemId: 'item-out-of-stock', quantity: 1 }],
      });
    }).toThrow(ValidationError);

    expect(() => {
      pricing.calculateOrderPricing({
        storeId: 'store-cox-1',
        serviceArea: 'cox_bazar_sadar',
        distanceKm: 1,
        items: [{ itemId: 'item-101', quantity: 10 }], // max is 5
      });
    }).toThrow(ValidationError);
  });
});

describe('OrderRulesEngine - Cancellation and State Transitions', () => {
  const engine = new OrderRulesEngine();
  const baseOrder: OrderStateRecord = {
    orderId: 'ord-999',
    status: 'PLACED',
    placedAt: new Date(Date.now() - 60 * 1000), // 1 min ago
    totalAmount: 500,
    deliveryFee: 50,
    itemsSubtotal: 450,
    merchantId: 'merch-1',
    customerId: 'cust-1',
  };

  it('should enforce state machine valid and invalid transitions', () => {
    expect(() => OrderRulesEngine.validateStateTransition('PLACED', 'CONFIRMED_BY_MERCHANT')).not.toThrow();
    expect(() => OrderRulesEngine.validateStateTransition('PLACED', 'DELIVERED')).toThrow(ConflictError);
    expect(() => OrderRulesEngine.validateStateTransition('DELIVERED', 'CANCELLED')).toThrow(ConflictError);
  });

  it('should allow customer full refund within 2-minute grace period', () => {
    const res = engine.evaluateCancellation(baseOrder, 'CUSTOMER', new Date());
    expect(res.allowed).toBe(true);
    expect(res.customerRefundAmount).toBe(500);
    expect(res.refundEligibilityPercent).toBe(100);
  });

  it('should deduct merchant food preparation compensation when cancelling during PREPARING', () => {
    const preparingOrder: OrderStateRecord = {
      ...baseOrder,
      status: 'PREPARING',
      placedAt: new Date(Date.now() - 300 * 1000), // 5 min ago
    };

    const res = engine.evaluateCancellation(preparingOrder, 'CUSTOMER', new Date());
    expect(res.allowed).toBe(true);
    // 50% of 450 itemsSubtotal = 225
    expect(res.merchantCompensationFee).toBe(225);
    expect(res.customerRefundAmount).toBe(275);
  });

  it('should reject customer cancellation when order is OUT_FOR_DELIVERY', () => {
    const outOrder: OrderStateRecord = {
      ...baseOrder,
      status: 'OUT_FOR_DELIVERY',
    };

    const res = engine.evaluateCancellation(outOrder, 'CUSTOMER', new Date());
    expect(res.allowed).toBe(false);
    expect(res.customerRefundAmount).toBe(0);
  });
});

describe('IdempotencyService - Duplicate Prevention', () => {
  let idempotency: IdempotencyService;

  beforeEach(() => {
    idempotency = new IdempotencyService(60);
  });

  it('should return cached result on identical duplicate requests', async () => {
    let executionCount = 0;
    const run = async () => {
      return idempotency.executeIdempotent('idemp-key-1', 'user-1', 'CREATE_ORDER', { items: ['a'] }, async () => {
        executionCount++;
        return { status: 201, body: { orderId: 'ord-123' } };
      });
    };

    const res1 = await run();
    expect(res1.fromCache).toBe(false);
    expect(res1.body.orderId).toBe('ord-123');
    expect(executionCount).toBe(1);

    const res2 = await run();
    expect(res2.fromCache).toBe(true);
    expect(res2.body.orderId).toBe('ord-123');
    expect(executionCount).toBe(1); // Not executed again
  });

  it('should reject request when payload differs for the same idempotency key', async () => {
    await idempotency.executeIdempotent('idemp-key-conflict', 'user-1', 'CREATE_ORDER', { amount: 100 }, async () => {
      return { status: 200, body: { ok: true } };
    });

    await expect(
      idempotency.executeIdempotent('idemp-key-conflict', 'user-1', 'CREATE_ORDER', { amount: 200 }, async () => {
        return { status: 200, body: { ok: true } };
      })
    ).rejects.toThrow(ConflictError);
  });
});

describe('ReconciliationService - Financial Ledger and Settlement Audit', () => {
  let recon: ReconciliationService;

  beforeEach(() => {
    recon = new ReconciliationService();
  });

  it('should record order settlement and verify zero discrepancy balance', () => {
    recon.recordOrderSettlement(
      'ord-recon-1',
      'tx-bkash-9988',
      'BKASH',
      500, // Total paid
      400, // Merchant payout
      60,  // Driver commission
      40,  // Platform fee
      'cust-1',
      'merch-1',
      'driver-1'
    );

    const audit = recon.reconcileOrder('ord-recon-1', 500);
    expect(audit.status).toBe('BALANCED');
    expect(audit.totalDebits).toBe(500);
    expect(audit.totalCredits).toBe(500);
    expect(audit.discrepancyAmount).toBe(0);
  });

  it('should reject settlement when payout breakdown does not sum to total', () => {
    expect(() => {
      recon.recordOrderSettlement(
        'ord-recon-err',
        'tx-bkash-000',
        'BKASH',
        500,
        400,
        50,
        20, // Sum = 470 != 500
        'cust-1',
        'merch-1',
        'driver-1'
      );
    }).toThrow(ValidationError);
  });
});
