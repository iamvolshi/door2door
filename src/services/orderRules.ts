import { ValidationError, ForbiddenError, ConflictError } from '../core/errors';
import { logger } from '../core/logger';

export type OrderStatus = 
  | 'PENDING_PAYMENT'
  | 'PLACED'
  | 'CONFIRMED_BY_MERCHANT'
  | 'PREPARING'
  | 'READY_FOR_PICKUP'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'REFUNDED';

export type CancellationInitiator = 'CUSTOMER' | 'MERCHANT' | 'DRIVER' | 'SYSTEM_TIMEOUT';

export interface CancellationPolicyResult {
  allowed: boolean;
  reason: string;
  merchantCompensationFee: number;
  driverCompensationFee: number;
  cancellationPenaltyFee: number;
  customerRefundAmount: number;
  refundEligibilityPercent: number;
}

export interface OrderStateRecord {
  orderId: string;
  status: OrderStatus;
  placedAt: Date;
  confirmedAt?: Date;
  preparingAt?: Date;
  dispatchedAt?: Date;
  totalAmount: number;
  deliveryFee: number;
  itemsSubtotal: number;
  merchantId: string;
  driverId?: string;
  customerId: string;
}

export const CANCELLATION_TIME_WINDOWS = {
  GRACE_PERIOD_SECONDS: 120, // 2 minutes full refund window
  MAX_PREPARING_CANCELLATION_SECONDS: 600, // 10 minutes
};

export class OrderRulesEngine {
  public static readonly ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
    PENDING_PAYMENT: ['PLACED', 'CANCELLED'],
    PLACED: ['CONFIRMED_BY_MERCHANT', 'CANCELLED'],
    CONFIRMED_BY_MERCHANT: ['PREPARING', 'CANCELLED'],
    PREPARING: ['READY_FOR_PICKUP', 'CANCELLED'],
    READY_FOR_PICKUP: ['OUT_FOR_DELIVERY', 'CANCELLED'],
    OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
    DELIVERED: ['REFUNDED'],
    CANCELLED: [],
    REFUNDED: [],
  };

  public static validateStateTransition(current: OrderStatus, next: OrderStatus): void {
    if (current === next) {
      return;
    }
    const allowed = this.ALLOWED_TRANSITIONS[current] || [];
    if (!allowed.includes(next)) {
      throw new ConflictError(
        `Illegal order status transition from '${current}' to '${next}'`
      );
    }
  }

  public evaluateCancellation(
    order: OrderStateRecord,
    initiator: CancellationInitiator,
    cancellationTimestamp: Date = new Date(),
    reasonText: string = ''
  ): CancellationPolicyResult {
    if (order.status === 'DELIVERED') {
      throw new ForbiddenError('Delivered orders cannot be cancelled directly. Submit a refund dispute instead.');
    }

    if (order.status === 'CANCELLED' || order.status === 'REFUNDED') {
      throw new ConflictError(`Order is already ${order.status}`);
    }

    const elapsedSincePlacementSec = Math.max(
      0,
      (cancellationTimestamp.getTime() - order.placedAt.getTime()) / 1000
    );

    logger.info('Evaluating order cancellation', {
      orderId: order.orderId,
      initiator,
      status: order.status,
      elapsedSeconds: elapsedSincePlacementSec,
      reason: reasonText,
    });

    switch (initiator) {
      case 'CUSTOMER':
        return this.evaluateCustomerCancellation(order, elapsedSincePlacementSec);
      
      case 'MERCHANT':
        return this.evaluateMerchantCancellation(order);
      
      case 'DRIVER':
        return this.evaluateDriverCancellation(order);

      case 'SYSTEM_TIMEOUT':
        return {
          allowed: true,
          reason: 'System automatic cancellation due to timeout',
          merchantCompensationFee: 0,
          driverCompensationFee: 0,
          cancellationPenaltyFee: 0,
          customerRefundAmount: order.totalAmount,
          refundEligibilityPercent: 100,
        };

      default:
        throw new ValidationError(`Unknown cancellation initiator: ${initiator}`);
    }
  }

  private evaluateCustomerCancellation(order: OrderStateRecord, elapsedSeconds: number): CancellationPolicyResult {
    // Within grace window (2 minutes) before preparation starts
    if (order.status === 'PLACED' && elapsedSeconds <= CANCELLATION_TIME_WINDOWS.GRACE_PERIOD_SECONDS) {
      return {
        allowed: true,
        reason: 'Customer cancelled within 2-minute grace period. 100% refund applied.',
        merchantCompensationFee: 0,
        driverCompensationFee: 0,
        cancellationPenaltyFee: 0,
        customerRefundAmount: order.totalAmount,
        refundEligibilityPercent: 100,
      };
    }

    // Placed but after grace period and before merchant confirmation
    if (order.status === 'PLACED') {
      return {
        allowed: true,
        reason: 'Customer cancelled before restaurant acceptance. 100% refund.',
        merchantCompensationFee: 0,
        driverCompensationFee: 0,
        cancellationPenaltyFee: 0,
        customerRefundAmount: order.totalAmount,
        refundEligibilityPercent: 100,
      };
    }

    // Order is confirmed or preparing
    if (order.status === 'CONFIRMED_BY_MERCHANT' || order.status === 'PREPARING') {
      const merchantComp = Math.round(order.itemsSubtotal * 0.5 * 100) / 100;
      const refundAmount = Math.max(0, order.totalAmount - merchantComp);
      return {
        allowed: true,
        reason: 'Order is under preparation. 50% merchant food cost deducted.',
        merchantCompensationFee: merchantComp,
        driverCompensationFee: 0,
        cancellationPenaltyFee: 0,
        customerRefundAmount: Math.round(refundAmount * 100) / 100,
        refundEligibilityPercent: Math.round((refundAmount / order.totalAmount) * 100),
      };
    }

    // Ready for pickup
    if (order.status === 'READY_FOR_PICKUP') {
      const merchantComp = order.itemsSubtotal;
      const refundAmount = Math.max(0, order.deliveryFee);
      return {
        allowed: true,
        reason: 'Food prepared. Full item value goes to merchant; delivery fee refunded.',
        merchantCompensationFee: merchantComp,
        driverCompensationFee: 0,
        cancellationPenaltyFee: 0,
        customerRefundAmount: Math.round(refundAmount * 100) / 100,
        refundEligibilityPercent: Math.round((refundAmount / order.totalAmount) * 100),
      };
    }

    // Out for delivery
    if (order.status === 'OUT_FOR_DELIVERY') {
      return {
        allowed: false,
        reason: 'Order is currently out for delivery. Rider is in transit; cancellation rejected.',
        merchantCompensationFee: 0,
        driverCompensationFee: 0,
        cancellationPenaltyFee: 0,
        customerRefundAmount: 0,
        refundEligibilityPercent: 0,
      };
    }

    return {
      allowed: true,
      reason: 'Standard customer cancellation',
      merchantCompensationFee: 0,
      driverCompensationFee: 0,
      cancellationPenaltyFee: 0,
      customerRefundAmount: order.totalAmount,
      refundEligibilityPercent: 100,
    };
  }

  private evaluateMerchantCancellation(order: OrderStateRecord): CancellationPolicyResult {
    // Merchant cancelling order after accepting or preparing penalizes merchant
    const merchantPenalty = order.status === 'PREPARING' || order.status === 'READY_FOR_PICKUP' ? 50 : 0;
    return {
      allowed: true,
      reason: 'Merchant cancelled the order. Full customer refund issued.',
      merchantCompensationFee: 0,
      driverCompensationFee: order.driverId ? 25 : 0,
      cancellationPenaltyFee: merchantPenalty,
      customerRefundAmount: order.totalAmount,
      refundEligibilityPercent: 100,
    };
  }

  private evaluateDriverCancellation(order: OrderStateRecord): CancellationPolicyResult {
    if (order.status !== 'OUT_FOR_DELIVERY' && order.status !== 'READY_FOR_PICKUP') {
      throw new ValidationError('Driver cannot cancel order prior to pickup assignment');
    }
    return {
      allowed: true,
      reason: 'Driver emergency or vehicle breakdown. Re-dispatch triggered, full customer protection.',
      merchantCompensationFee: 0,
      driverCompensationFee: 0,
      cancellationPenaltyFee: 20,
      customerRefundAmount: order.totalAmount,
      refundEligibilityPercent: 100,
    };
  }
}

export const orderRulesEngine = new OrderRulesEngine();
