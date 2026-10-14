import { describe, it, expect } from 'vitest';
import {
  calculateOrderSettlement,
  calculateMerchantSettlement,
  calculateDriverSettlement,
  reconcileCashOnDelivery,
  OrderSettlementInput
} from '../src/admin/settlementEngine';
import {
  aggregateOperationalMetrics,
  aggregateSalesBreakdown,
  aggregateDeliveryPerformance,
  generateOperationalReport,
  generateSettlementStatement,
  generateDriverStatement,
  toBengaliDigits,
  formatBdtCurrency,
  formatPercentage
} from '../src/admin/analyticsReports';

describe('Settlement Engine and Commission Math', () => {
  const sampleOrders: OrderSettlementInput[] = [
    {
      orderId: 'ORD-001',
      shopId: 'SHOP-COX-1',
      driverId: 'DRV-101',
      orderTotal: 1000,
      subtotal: 850,
      deliveryFee: 100,
      serviceFee: 50,
      tipAmount: 20,
      paymentMethod: 'COD',
      platformCommissionRate: 0.10,
      driverBaseFee: 80,
      status: 'DELIVERED',
      createdAt: new Date('2025-05-01T10:00:00Z'),
      completedAt: new Date('2025-05-01T10:30:00Z')
    },
    {
      orderId: 'ORD-002',
      shopId: 'SHOP-COX-1',
      driverId: 'DRV-101',
      orderTotal: 500,
      subtotal: 400,
      deliveryFee: 80,
      serviceFee: 20,
      tipAmount: 0,
      paymentMethod: 'DIGITAL',
      platformCommissionRate: 0.10,
      driverBaseFee: 60,
      status: 'DELIVERED',
      createdAt: new Date('2025-05-01T11:00:00Z'),
      completedAt: new Date('2025-05-01T11:40:00Z')
    },
    {
      orderId: 'ORD-003',
      shopId: 'SHOP-COX-2',
      driverId: 'DRV-102',
      orderTotal: 300,
      subtotal: 250,
      deliveryFee: 50,
      serviceFee: 0,
      paymentMethod: 'COD',
      platformCommissionRate: 0.15,
      status: 'CANCELLED',
      createdAt: new Date('2025-05-01T12:00:00Z')
    }
  ];

  it('calculates single order settlement correctly', () => {
    const res = calculateOrderSettlement(sampleOrders[0]);
    expect(res.platformCommission).toBe(85); // 10% of 850
    expect(res.merchantPayout).toBe(765); // 850 - 85
    expect(res.driverPayout).toBe(100); // 80 base + 20 tip
    expect(res.codCollectedByDriver).toBe(1000);
    expect(res.netPlatformRevenue).toBe(85 + 50 + (100 - 80)); // commission + service fee + delivery margin = 155
  });

  it('calculates merchant settlement aggregation', () => {
    const summary = calculateMerchantSettlement('SHOP-COX-1', sampleOrders);
    expect(summary.orderCount).toBe(2);
    expect(summary.deliveredOrderCount).toBe(2);
    expect(summary.grossSales).toBe(1250); // 850 + 400
    expect(summary.commissionAmount).toBe(125); // 85 + 40
    expect(summary.netPayout).toBe(1125);
    expect(summary.balanceDueToMerchant).toBe(1125);
  });

  it('calculates driver settlement and COD balance owed', () => {
    const driverSum = calculateDriverSettlement('DRV-101', sampleOrders);
    expect(driverSum.completedDeliveries).toBe(2);
    expect(driverSum.grossDeliveryEarnings).toBe(140); // 80 + 60
    expect(driverSum.tips).toBe(20);
    expect(driverSum.totalEarnings).toBe(160);
    expect(driverSum.codCashCollected).toBe(1000);
    expect(driverSum.netDriverPayout).toBe(0);
    expect(driverSum.driverOwesPlatform).toBe(840); // 1000 - 160
  });

  it('reconciles Cash on Delivery and detects discrepancy', () => {
    const recon = reconcileCashOnDelivery(sampleOrders, [
      { entityId: 'DRV-101', entityType: 'DRIVER', reportedAmount: 900 } // expected 1000
    ]);
    expect(recon.totalCodOrders).toBe(1);
    expect(recon.totalCodValue).toBe(1000);
    expect(recon.codCollectedByDrivers).toBe(1000);
    expect(recon.discrepancies.length).toBe(1);
    expect(recon.discrepancies[0].difference).toBe(-100);
  });
});

describe('Operational Analytics & Bengali Localized Reports', () => {
  it('converts digits to Bengali correctly', () => {
    expect(toBengaliDigits('1234567890')).toBe('১২৩৪৫৬৭৮৯০');
    expect(toBengaliDigits(450.5)).toBe('৪৫০.৫');
  });

  it('formats currency and percentages in Bengali', () => {
    expect(formatBdtCurrency(1500, 'bn')).toBe('১৫০০.০০ ৳');
    expect(formatPercentage(95.5, 'bn')).toBe('৯৫.৫%');
    expect(formatBdtCurrency(1500, 'en')).toBe('BDT 1500.00');
  });

  it('aggregates operational metrics and generates bilingual reports', () => {
    const orders = [
      {
        orderId: 'O-1',
        shopId: 'S-1',
        driverId: 'D-1',
        orderTotal: 1000,
        subtotal: 800,
        serviceFee: 50,
        status: 'DELIVERED',
        createdAt: '2025-05-01T08:00:00Z',
        completedAt: '2025-05-01T08:30:00Z',
        estimatedDeliveryMinutes: 40
      },
      {
        orderId: 'O-2',
        shopId: 'S-2',
        status: 'CANCELLED',
        createdAt: '2025-05-01T09:00:00Z'
      }
    ];

    const metrics = aggregateOperationalMetrics(orders);
    expect(metrics.totalOrders).toBe(2);
    expect(metrics.completedOrders).toBe(1);
    expect(metrics.cancelledOrders).toBe(1);
    expect(metrics.fulfillmentRate).toBe(50);
    expect(metrics.onTimeDeliveryRate).toBe(100);

    const bnReport = generateOperationalReport(metrics, 'bn');
    expect(bnReport).toContain('কক্সবাজার পাইলট পরিচালন রিপোর্ট');
    expect(bnReport).toContain('মোট অর্ডার: ২ টি');
    expect(bnReport).toContain('সফলতার হার: ৫০.০%');

    const enReport = generateOperationalReport(metrics, 'en');
    expect(enReport).toContain('Cox\'s Bazar Pilot Operational Report');
    expect(enReport).toContain('Total Orders: 2');
  });

  it('generates merchant and driver statements in Bengali', () => {
    const merchantSummary = {
      shopId: 'SHOP-007',
      orderCount: 10,
      deliveredOrderCount: 9,
      grossSales: 15000,
      commissionAmount: 1500,
      refundDeductions: 200,
      merchantDiscountDeductions: 0,
      netPayout: 13300,
      codCollectedByMerchant: 0,
      balanceDueToMerchant: 13300,
      balanceDueToPlatform: 0
    };

    const stmtBn = generateSettlementStatement(merchantSummary, 'bn');
    expect(stmtBn).toContain('মার্চেন্ট সেটেলমেন্ট স্টেটমেন্ট');
    expect(stmtBn).toContain('দোকান আইডি: SHOP-007');
    expect(stmtBn).toContain('নিট প্রদেয়: ১৩৩০০.০০ ৳');

    const driverSummary = {
      driverId: 'DRV-500',
      deliveryCount: 5,
      completedDeliveries: 5,
      grossDeliveryEarnings: 600,
      tips: 100,
      totalEarnings: 700,
      codCashCollected: 3000,
      netDriverPayout: 0,
      driverOwesPlatform: 2300
    };

    const driverBn = generateDriverStatement(driverSummary, 'bn');
    expect(driverBn).toContain('ডেলিভারি কর্মী সেটেলমেন্ট হিসাব');
    expect(driverBn).toContain('কর্মী আইডি: DRV-500');
    expect(driverBn).toContain('প্ল্যাটফর্মে জমাযোগ্য ক্যাশ: ২৩০০.০০ ৳');
  });
});
