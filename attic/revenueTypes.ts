export type CommissionType = 'PERCENTAGE' | 'FIXED' | 'TIERED';

export interface TieredRate {
  minOrderAmount: number;
  maxOrderAmount?: number;
  percentageRate: number;
  fixedFee: number;
}

export interface CommissionScheme {
  id: string;
  name: string;
  type: CommissionType;
  percentageRate: number; // e.g., 15 for 15%
  fixedFee: number; // Fixed fee in minor currency units or standard currency
  tieredRates?: TieredRate[];
  description?: string;
  effectiveFrom?: Date;
  effectiveTo?: Date;
}

export interface AreaDeliveryRule {
  areaId: string;
  areaName: string;
  baseFee: number;
  perKmRate: number;
  minimumDeliveryFee: number;
  maximumDeliveryFee?: number;
  areaSurcharge: number;
  congestionSurcharge?: number;
  nightSurcharge?: number;
  freeDeliveryThreshold?: number;
  isActive: boolean;
}

export interface PlatformDeliveryConfig {
  defaultBaseFee: number;
  defaultPerKmRate: number;
  minimumDeliveryFee: number;
  maximumDeliveryFee?: number;
  defaultFreeDeliveryThreshold: number | null;
  customerPlatformServiceFee: number; // Flat fee or small operational contribution
  customerPlatformServiceFeeRate: number; // Percentage fee (e.g. 1.5%)
}

export type PromotionType = 'PERCENTAGE_DISCOUNT' | 'FIXED_DISCOUNT' | 'FREE_DELIVERY' | 'CAPPED_PERCENTAGE';

export interface PromotionRule {
  id: string;
  code: string;
  type: PromotionType;
  value: number; // e.g., 20 for 20% or 5 for $5 off
  maxDiscountAmount?: number;
  minOrderSubtotal?: number;
  appliesToDeliveryFee: boolean;
  appliesToItems: boolean;
  sponsoredBy: 'PLATFORM' | 'MERCHANT' | 'SHARED';
  merchantSplitPercentage?: number; // e.g., 50 for 50/50 split
  usageLimit?: number;
  usageCount: number;
  isActive: boolean;
  validFrom?: Date;
  validUntil?: Date;
}

export interface SubscriptionBenefit {
  id: string;
  planName: string;
  freeDeliveryThreshold: number; // Lower threshold or 0 for unlimited free delivery
  deliveryFeeDiscountPercentage: number; // 100 for free delivery
  serviceFeeDiscountPercentage: number;
  itemDiscountPercentage?: number;
  isActive: boolean;
}

export interface PricingEngineInput {
  merchantId: string;
  categoryId?: string;
  areaId?: string;
  items: Array<{
    itemId: string;
    name: string;
    price: number;
    quantity: number;
  }>;
  deliveryDistanceKm: number;
  isNightTime?: boolean;
  isHighCongestion?: boolean;
  promoCode?: string;
  subscription?: SubscriptionBenefit;
  merchantCommissionOverride?: CommissionScheme;
}

export interface CustomerPriceBreakdown {
  itemSubtotal: number;
  rawDeliveryFee: number;
  deliveryDistanceKm: number;
  areaSurcharges: number;
  deliveryDiscount: number;
  finalDeliveryFee: number;
  platformServiceFee: number;
  itemDiscounts: number;
  totalDiscounts: number;
  grandTotal: number;
  currency: string;
  appliedPromoCode?: string;
  freeDeliveryApplied: boolean;
  itemizedItems: Array<{
    itemId: string;
    name: string;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
  }>;
}

export interface MerchantSettlementBreakdown {
  itemSubtotal: number;
  commissionType: CommissionType;
  commissionPercentageRate: number;
  commissionFixedFee: number;
  platformCommissionTotal: number;
  merchantSponsoredDiscounts: number;
  netMerchantPayout: number;
  currency: string;
  reconciliationNotes: string[];
}

export interface CalculatedPricingResult {
  customerBreakdown: CustomerPriceBreakdown;
  merchantBreakdown: MerchantSettlementBreakdown;
  platformGrossRevenue: number;
  calculatedAt: string;
}
