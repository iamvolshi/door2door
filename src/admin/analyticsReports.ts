import { MerchantSettlementSummary, DriverSettlementSummary } from './settlementEngine';

export interface DateWindow {
  startDate: string | Date;
  endDate: string | Date;
}

export interface OperationalMetrics {
  totalOrders: number;
  completedOrders: number;
  cancelledOrders: number;
  activeVendors: number;
  activeDrivers: number;
  grossMerchandiseValue: number;
  totalPlatformRevenue: number;
  averageOrderValue: number;
  averageDeliveryTimeMinutes: number;
  fulfillmentRate: number;
  onTimeDeliveryRate: number;
}

export interface SalesBreakdown {
  totalSales: number;
  orderCount: number;
  paymentMethodBreakdown: {
    cod: number;
    digital: number;
  };
  categorySales: Record<string, number>;
}

export interface DeliveryPerformanceSummary {
  totalDeliveries: number;
  completedDeliveries: number;
  averageCompletionTimeMinutes: number;
  lateDeliveries: number;
  totalDriverEarnings: number;
  driverPerformance: Array<{
    driverId: string;
    completedCount: number;
    lateCount: number;
  }>;
}

export type ReportLanguage = 'en' | 'bn';

const BENGALI_DIGITS: Record<string, string> = {
  '0': '০',
  '1': '১',
  '2': '২',
  '3': '৩',
  '4': '৪',
  '5': '৫',
  '6': '৬',
  '7': '৭',
  '8': '৮',
  '9': '৯'
};

export function toBengaliDigits(input: number | string): string {
  const str = String(input);
  return str.replace(/[0-9]/g, (digit) => BENGALI_DIGITS[digit] || digit);
}

export function formatBdtCurrency(amount: number, lang: ReportLanguage = 'en'): string {
  const fixed = amount.toFixed(2);
  if (lang === 'bn') {
    return `${toBengaliDigits(fixed)} ৳`;
  }
  return `BDT ${fixed}`;
}

export function formatPercentage(rate: number, lang: ReportLanguage = 'en'): string {
  const fixed = rate.toFixed(1);
  if (lang === 'bn') {
    return `${toBengaliDigits(fixed)}%`;
  }
  return `${fixed}%`;
}

export function aggregateOperationalMetrics(
  orders: any[],
  drivers: any[] = [],
  shops: any[] = [],
  window?: DateWindow
): OperationalMetrics {
  let filteredOrders = orders;
  if (window) {
    const start = new Date(window.startDate).getTime();
    const end = new Date(window.endDate).getTime();
    filteredOrders = orders.filter((o) => {
      const created = new Date(o.createdAt).getTime();
      return created >= start && created <= end;
    });
  }

  const totalOrders = filteredOrders.length;
  const completedOrders = filteredOrders.filter((o) => o.status === 'DELIVERED').length;
  const cancelledOrders = filteredOrders.filter((o) => o.status === 'CANCELLED').length;

  let grossMerchandiseValue = 0;
  let totalPlatformRevenue = 0;
  let totalDeliveryMinutes = 0;
  let timedOrdersCount = 0;
  let onTimeCount = 0;

  for (const o of filteredOrders) {
    if (o.status === 'DELIVERED') {
      grossMerchandiseValue += o.orderTotal || o.subtotal || 0;
      const comm = (o.subtotal || 0) * (o.platformCommissionRate || 0.1);
      const service = o.serviceFee || 0;
      totalPlatformRevenue += comm + service;

      if (o.createdAt && o.completedAt) {
        const start = new Date(o.createdAt).getTime();
        const end = new Date(o.completedAt).getTime();
        const diffMins = Math.max(0, (end - start) / (1000 * 60));
        totalDeliveryMinutes += diffMins;
        timedOrdersCount += 1;

        const expectedMins = o.estimatedDeliveryMinutes || 45;
        if (diffMins <= expectedMins) {
          onTimeCount += 1;
        }
      }
    }
  }

  const averageOrderValue = completedOrders > 0 ? grossMerchandiseValue / completedOrders : 0;
  const averageDeliveryTimeMinutes = timedOrdersCount > 0 ? totalDeliveryMinutes / timedOrdersCount : 0;
  const fulfillmentRate = totalOrders > 0 ? (completedOrders / totalOrders) * 100 : 0;
  const onTimeDeliveryRate = timedOrdersCount > 0 ? (onTimeCount / timedOrdersCount) * 100 : 100;

  const activeVendors = shops.length > 0 ? shops.filter((s) => s.isActive !== false).length : new Set(filteredOrders.map((o) => o.shopId)).size;
  const activeDrivers = drivers.length > 0 ? drivers.filter((d) => d.status === 'ACTIVE' || d.dutyStatus === 'ON_DUTY').length : new Set(filteredOrders.filter((o) => o.driverId).map((o) => o.driverId)).size;

  return {
    totalOrders,
    completedOrders,
    cancelledOrders,
    activeVendors,
    activeDrivers,
    grossMerchandiseValue,
    totalPlatformRevenue,
    averageOrderValue,
    averageDeliveryTimeMinutes,
    fulfillmentRate,
    onTimeDeliveryRate
  };
}

export function aggregateSalesBreakdown(orders: any[], window?: DateWindow): SalesBreakdown {
  let filtered = orders;
  if (window) {
    const start = new Date(window.startDate).getTime();
    const end = new Date(window.endDate).getTime();
    filtered = orders.filter((o) => {
      const created = new Date(o.createdAt).getTime();
      return created >= start && created <= end;
    });
  }

  let totalSales = 0;
  let codTotal = 0;
  let digitalTotal = 0;
  const categorySales: Record<string, number> = {};

  for (const o of filtered) {
    if (o.status === 'DELIVERED') {
      const amount = o.orderTotal || o.subtotal || 0;
      totalSales += amount;
      if (o.paymentMethod === 'COD') {
        codTotal += amount;
      } else {
        digitalTotal += amount;
      }

      if (o.category) {
        categorySales[o.category] = (categorySales[o.category] || 0) + amount;
      } else if (Array.isArray(o.items)) {
        for (const item of o.items) {
          const cat = item.category || 'general';
          categorySales[cat] = (categorySales[cat] || 0) + (item.price * (item.quantity || 1));
        }
      }
    }
  }

  return {
    totalSales,
    orderCount: filtered.filter((o) => o.status === 'DELIVERED').length,
    paymentMethodBreakdown: {
      cod: codTotal,
      digital: digitalTotal
    },
    categorySales
  };
}

export function aggregateDeliveryPerformance(orders: any[]): DeliveryPerformanceSummary {
  const deliveredOrders = orders.filter((o) => o.status === 'DELIVERED');
  let totalMins = 0;
  let lateDeliveries = 0;
  let totalDriverEarnings = 0;
  const driverMap = new Map<string, { completedCount: number; lateCount: number }>();

  for (const o of deliveredOrders) {
    const dId = o.driverId || 'unassigned';
    const baseFee = o.driverBaseFee !== undefined ? o.driverBaseFee : (o.deliveryFee || 0);
    const tip = o.tipAmount || 0;
    totalDriverEarnings += baseFee + tip;

    let isLate = false;
    if (o.createdAt && o.completedAt) {
      const diff = (new Date(o.completedAt).getTime() - new Date(o.createdAt).getTime()) / (1000 * 60);
      totalMins += diff;
      const est = o.estimatedDeliveryMinutes || 45;
      if (diff > est) {
        isLate = true;
        lateDeliveries += 1;
      }
    }

    const rec = driverMap.get(dId) || { completedCount: 0, lateCount: 0 };
    rec.completedCount += 1;
    if (isLate) {
      rec.lateCount += 1;
    }
    driverMap.set(dId, rec);
  }

  const driverPerformance = Array.from(driverMap.entries()).map(([driverId, val]) => ({
    driverId,
    completedCount: val.completedCount,
    lateCount: val.lateCount
  }));

  return {
    totalDeliveries: orders.length,
    completedDeliveries: deliveredOrders.length,
    averageCompletionTimeMinutes: deliveredOrders.length > 0 ? totalMins / deliveredOrders.length : 0,
    lateDeliveries,
    totalDriverEarnings,
    driverPerformance
  };
}

export function generateOperationalReport(metrics: OperationalMetrics, lang: ReportLanguage = 'en'): string {
  if (lang === 'bn') {
    return [
      '=== কক্সবাজার পাইলট পরিচালন রিপোর্ট ===',
      `মোট অর্ডার: ${toBengaliDigits(metrics.totalOrders)} টি`,
      `সম্পন্ন অর্ডার: ${toBengaliDigits(metrics.completedOrders)} টি`,
      `বাতিল অর্ডার: ${toBengaliDigits(metrics.cancelledOrders)} টি`,
      `সক্রিয় মার্চেন্ট: ${toBengaliDigits(metrics.activeVendors)} জন`,
      `সক্রিয় ড্রাইভার: ${toBengaliDigits(metrics.activeDrivers)} জন`,
      `মোট বিক্রয়মূল্য (GMV): ${formatBdtCurrency(metrics.grossMerchandiseValue, 'bn')}`,
      `প্ল্যাটফর্ম রেভিনিউ: ${formatBdtCurrency(metrics.totalPlatformRevenue, 'bn')}`,
      `গড় অর্ডার মূল্য: ${formatBdtCurrency(metrics.averageOrderValue, 'bn')}`,
      `গড় ডেলিভারি সময়: ${toBengaliDigits(metrics.averageDeliveryTimeMinutes.toFixed(1))} মিনিট`,
      `সফলতার হার: ${formatPercentage(metrics.fulfillmentRate, 'bn')}`,
      `সময়মতো ডেলিভারি হার: ${formatPercentage(metrics.onTimeDeliveryRate, 'bn')}`
    ].join('\n');
  }

  return [
    '=== Cox\'s Bazar Pilot Operational Report ===',
    `Total Orders: ${metrics.totalOrders}`,
    `Completed Orders: ${metrics.completedOrders}`,
    `Cancelled Orders: ${metrics.cancelledOrders}`,
    `Active Vendors: ${metrics.activeVendors}`,
    `Active Drivers: ${metrics.activeDrivers}`,
    `Gross Merchandise Value: ${formatBdtCurrency(metrics.grossMerchandiseValue, 'en')}`,
    `Total Platform Revenue: ${formatBdtCurrency(metrics.totalPlatformRevenue, 'en')}`,
    `Average Order Value: ${formatBdtCurrency(metrics.averageOrderValue, 'en')}`,
    `Average Delivery Time: ${metrics.averageDeliveryTimeMinutes.toFixed(1)} mins`,
    `Fulfillment Rate: ${formatPercentage(metrics.fulfillmentRate, 'en')}`,
    `On-Time Delivery Rate: ${formatPercentage(metrics.onTimeDeliveryRate, 'en')}`
  ].join('\n');
}

export function generateSettlementStatement(statement: MerchantSettlementSummary, lang: ReportLanguage = 'en'): string {
  if (lang === 'bn') {
    return [
      '=== মার্চেন্ট সেটেলমেন্ট স্টেটমেন্ট ===',
      `দোকান আইডি: ${statement.shopId}`,
      `সম্পন্ন অর্ডার: ${toBengaliDigits(statement.deliveredOrderCount)} টি`,
      `মোট বিক্রয়: ${formatBdtCurrency(statement.grossSales, 'bn')}`,
      `কমিশন কর্তন: ${formatBdtCurrency(statement.commissionAmount, 'bn')}`,
      `রিফান্ড সমন্বয়: ${formatBdtCurrency(statement.refundDeductions, 'bn')}`,
      `নিট প্রদেয়: ${formatBdtCurrency(statement.netPayout, 'bn')}`,
      `মার্চেন্ট কর্তৃক সংগৃহীত ক্যাশ: ${formatBdtCurrency(statement.codCollectedByMerchant, 'bn')}`,
      statement.balanceDueToMerchant > 0
        ? `মার্চেন্টের প্রাপ্য অবশিষ্ট: ${formatBdtCurrency(statement.balanceDueToMerchant, 'bn')}`
        : `প্ল্যাটফর্মের প্রাপ্য বকেয়া: ${formatBdtCurrency(statement.balanceDueToPlatform, 'bn')}`
    ].join('\n');
  }

  return [
    '=== Merchant Settlement Statement ===',
    `Shop ID: ${statement.shopId}`,
    `Delivered Orders: ${statement.deliveredOrderCount}`,
    `Gross Sales: ${formatBdtCurrency(statement.grossSales, 'en')}`,
    `Platform Commission: ${formatBdtCurrency(statement.commissionAmount, 'en')}`,
    `Refund Deductions: ${formatBdtCurrency(statement.refundDeductions, 'en')}`,
    `Net Payout: ${formatBdtCurrency(statement.netPayout, 'en')}`,
    `COD Collected by Merchant: ${formatBdtCurrency(statement.codCollectedByMerchant, 'en')}`,
    statement.balanceDueToMerchant > 0
      ? `Balance Due to Merchant: ${formatBdtCurrency(statement.balanceDueToMerchant, 'en')}`
      : `Balance Due to Platform: ${formatBdtCurrency(statement.balanceDueToPlatform, 'en')}`
  ].join('\n');
}

export function generateDriverStatement(driverSummary: DriverSettlementSummary, lang: ReportLanguage = 'en'): string {
  if (lang === 'bn') {
    return [
      '=== ডেলিভারি কর্মী সেটেলমেন্ট হিসাব ===',
      `কর্মী আইডি: ${driverSummary.driverId}`,
      `সম্পন্ন ডেলিভারি: ${toBengaliDigits(driverSummary.completedDeliveries)} টি`,
      `ডেলিভারি ফি আয়: ${formatBdtCurrency(driverSummary.grossDeliveryEarnings, 'bn')}`,
      `টিপস: ${formatBdtCurrency(driverSummary.tips, 'bn')}`,
      `মোট আয়: ${formatBdtCurrency(driverSummary.totalEarnings, 'bn')}`,
      `সংগৃহীত সিওডি ক্যাশ: ${formatBdtCurrency(driverSummary.codCashCollected, 'bn')}`,
      driverSummary.netDriverPayout > 0
        ? `কর্মীর প্রদেয় নিট পাওনা: ${formatBdtCurrency(driverSummary.netDriverPayout, 'bn')}`
        : `প্ল্যাটফর্মে জমাযোগ্য ক্যাশ: ${formatBdtCurrency(driverSummary.driverOwesPlatform, 'bn')}`
    ].join('\n');
  }

  return [
    '=== Driver Settlement Statement ===',
    `Driver ID: ${driverSummary.driverId}`,
    `Completed Deliveries: ${driverSummary.completedDeliveries}`,
    `Gross Delivery Earnings: ${formatBdtCurrency(driverSummary.grossDeliveryEarnings, 'en')}`,
    `Tips: ${formatBdtCurrency(driverSummary.tips, 'en')}`,
    `Total Earnings: ${formatBdtCurrency(driverSummary.totalEarnings, 'en')}`,
    `COD Cash Collected: ${formatBdtCurrency(driverSummary.codCashCollected, 'en')}`,
    driverSummary.netDriverPayout > 0
      ? `Net Payout to Driver: ${formatBdtCurrency(driverSummary.netDriverPayout, 'en')}`
      : `Cash Owed to Platform: ${formatBdtCurrency(driverSummary.driverOwesPlatform, 'en')}`
  ].join('\n');
}
