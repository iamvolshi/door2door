export interface OrderSettlementInput {
  orderId: string;
  shopId: string;
  driverId?: string;
  orderTotal: number;
  subtotal: number;
  deliveryFee: number;
  serviceFee: number;
  tipAmount?: number;
  paymentMethod: 'COD' | 'DIGITAL';
  platformCommissionRate: number;
  driverBaseFee?: number;
  merchantDiscountShare?: number;
  refundAmount?: number;
  status: 'DELIVERED' | 'CANCELLED' | 'REFUNDED';
  createdAt: string | Date;
  completedAt?: string | Date;
}

export interface SingleOrderSettlementResult {
  orderId: string;
  platformCommission: number;
  merchantPayout: number;
  driverPayout: number;
  codCollectedByDriver: number;
  codCollectedByMerchant: number;
  netPlatformRevenue: number;
}

export interface MerchantSettlementSummary {
  shopId: string;
  orderCount: number;
  deliveredOrderCount: number;
  grossSales: number;
  commissionAmount: number;
  refundDeductions: number;
  merchantDiscountDeductions: number;
  netPayout: number;
  codCollectedByMerchant: number;
  balanceDueToMerchant: number;
  balanceDueToPlatform: number;
}

export interface DriverSettlementSummary {
  driverId: string;
  deliveryCount: number;
  completedDeliveries: number;
  grossDeliveryEarnings: number;
  tips: number;
  totalEarnings: number;
  codCashCollected: number;
  netDriverPayout: number;
  driverOwesPlatform: number;
}

export interface CodDiscrepancy {
  id: string;
  entityType: 'DRIVER' | 'MERCHANT';
  expectedAmount: number;
  reportedAmount: number;
  difference: number;
}

export interface CashOnDeliveryReconciliation {
  totalCodOrders: number;
  totalCodValue: number;
  codCollectedByDrivers: number;
  codCollectedByMerchants: number;
  driverPayoutsOffset: number;
  merchantPayoutsOffset: number;
  netCashDueToPlatform: number;
  discrepancies: CodDiscrepancy[];
}

export function calculateOrderSettlement(order: OrderSettlementInput): SingleOrderSettlementResult {
  if (order.status !== 'DELIVERED') {
    return {
      orderId: order.orderId,
      platformCommission: 0,
      merchantPayout: 0,
      driverPayout: 0,
      codCollectedByDriver: 0,
      codCollectedByMerchant: 0,
      netPlatformRevenue: 0
    };
  }

  const tip = order.tipAmount || 0;
  const refund = order.refundAmount || 0;
  const discount = order.merchantDiscountShare || 0;

  const platformCommission = Math.max(0, order.subtotal * order.platformCommissionRate);
  const merchantPayout = Math.max(0, order.subtotal - platformCommission - refund - discount);

  const driverDeliveryEarnings = order.driverBaseFee !== undefined ? order.driverBaseFee : order.deliveryFee;
  const driverPayout = Math.max(0, driverDeliveryEarnings + tip);

  const codCollectedByDriver = order.paymentMethod === 'COD' && order.driverId ? order.orderTotal : 0;
  const codCollectedByMerchant = order.paymentMethod === 'COD' && !order.driverId ? order.orderTotal : 0;

  const netPlatformRevenue = platformCommission + order.serviceFee + (order.deliveryFee - driverDeliveryEarnings);

  return {
    orderId: order.orderId,
    platformCommission,
    merchantPayout,
    driverPayout,
    codCollectedByDriver,
    codCollectedByMerchant,
    netPlatformRevenue
  };
}

export function calculateMerchantSettlement(shopId: string, orders: OrderSettlementInput[]): MerchantSettlementSummary {
  const shopOrders = orders.filter((o) => o.shopId === shopId);
  const deliveredOrders = shopOrders.filter((o) => o.status === 'DELIVERED');

  let grossSales = 0;
  let commissionAmount = 0;
  let refundDeductions = 0;
  let merchantDiscountDeductions = 0;
  let codCollectedByMerchant = 0;

  for (const order of deliveredOrders) {
    const calc = calculateOrderSettlement(order);
    grossSales += order.subtotal;
    commissionAmount += calc.platformCommission;
    refundDeductions += order.refundAmount || 0;
    merchantDiscountDeductions += order.merchantDiscountShare || 0;
    codCollectedByMerchant += calc.codCollectedByMerchant;
  }

  const netPayout = Math.max(0, grossSales - commissionAmount - refundDeductions - merchantDiscountDeductions);
  const balanceDiff = netPayout - codCollectedByMerchant;
  const balanceDueToMerchant = balanceDiff > 0 ? balanceDiff : 0;
  const balanceDueToPlatform = balanceDiff < 0 ? Math.abs(balanceDiff) : 0;

  return {
    shopId,
    orderCount: shopOrders.length,
    deliveredOrderCount: deliveredOrders.length,
    grossSales,
    commissionAmount,
    refundDeductions,
    merchantDiscountDeductions,
    netPayout,
    codCollectedByMerchant,
    balanceDueToMerchant,
    balanceDueToPlatform
  };
}

export function calculateDriverSettlement(driverId: string, orders: OrderSettlementInput[]): DriverSettlementSummary {
  const driverOrders = orders.filter((o) => o.driverId === driverId);
  const deliveredOrders = driverOrders.filter((o) => o.status === 'DELIVERED');

  let grossDeliveryEarnings = 0;
  let tips = 0;
  let codCashCollected = 0;

  for (const order of deliveredOrders) {
    const calc = calculateOrderSettlement(order);
    const baseFee = order.driverBaseFee !== undefined ? order.driverBaseFee : order.deliveryFee;
    grossDeliveryEarnings += baseFee;
    tips += order.tipAmount || 0;
    codCashCollected += calc.codCollectedByDriver;
  }

  const totalEarnings = grossDeliveryEarnings + tips;
  const netBalance = totalEarnings - codCashCollected;

  return {
    driverId,
    deliveryCount: driverOrders.length,
    completedDeliveries: deliveredOrders.length,
    grossDeliveryEarnings,
    tips,
    totalEarnings,
    codCashCollected,
    netDriverPayout: netBalance > 0 ? netBalance : 0,
    driverOwesPlatform: netBalance < 0 ? Math.abs(netBalance) : 0
  };
}

export function reconcileCashOnDelivery(
  orders: OrderSettlementInput[],
  reportedCollections?: Array<{ entityId: string; entityType: 'DRIVER' | 'MERCHANT'; reportedAmount: number }>
): CashOnDeliveryReconciliation {
  const codOrders = orders.filter((o) => o.paymentMethod === 'COD' && o.status === 'DELIVERED');

  let totalCodValue = 0;
  let codCollectedByDrivers = 0;
  let codCollectedByMerchants = 0;
  let driverPayoutsOffset = 0;
  let merchantPayoutsOffset = 0;

  for (const order of codOrders) {
    totalCodValue += order.orderTotal;
    const calc = calculateOrderSettlement(order);
    codCollectedByDrivers += calc.codCollectedByDriver;
    codCollectedByMerchants += calc.codCollectedByMerchant;
    driverPayoutsOffset += calc.driverPayout;
    merchantPayoutsOffset += calc.merchantPayout;
  }

  const netCashDueToPlatform = totalCodValue - (driverPayoutsOffset + merchantPayoutsOffset);
  const discrepancies: CodDiscrepancy[] = [];

  if (reportedCollections && reportedCollections.length > 0) {
    for (const report of reportedCollections) {
      let expected = 0;
      if (report.entityType === 'DRIVER') {
        expected = orders
          .filter((o) => o.driverId === report.entityId && o.paymentMethod === 'COD' && o.status === 'DELIVERED')
          .reduce((sum, o) => sum + o.orderTotal, 0);
      } else {
        expected = orders
          .filter((o) => o.shopId === report.entityId && !o.driverId && o.paymentMethod === 'COD' && o.status === 'DELIVERED')
          .reduce((sum, o) => sum + o.orderTotal, 0);
      }

      const diff = Math.abs(expected - report.reportedAmount);
      if (diff > 0.01) {
        discrepancies.push({
          id: report.entityId,
          entityType: report.entityType,
          expectedAmount: expected,
          reportedAmount: report.reportedAmount,
          difference: report.reportedAmount - expected
        });
      }
    }
  }

  return {
    totalCodOrders: codOrders.length,
    totalCodValue,
    codCollectedByDrivers,
    codCollectedByMerchants,
    driverPayoutsOffset,
    merchantPayoutsOffset,
    netCashDueToPlatform,
    discrepancies
  };
}
