import { RevenueConfigManager } from './revenueConfig';
import {
  PricingEngineInput,
  CalculatedPricingResult,
  CustomerPriceBreakdown,
  MerchantSettlementBreakdown,
  CommissionScheme,
  PromotionRule
} from './revenueTypes';

export class PricingEngine {
  private configManager: RevenueConfigManager;

  constructor(configManager?: RevenueConfigManager) {
    this.configManager = configManager ?? RevenueConfigManager.getInstance();
  }

  private roundCurrency(val: number): number {
    return Math.round((val + Number.EPSILON) * 100) / 100;
  }

  public calculatePricing(input: PricingEngineInput): CalculatedPricingResult {
    // 1. Calculate item subtotal
    const itemizedItems = input.items.map(item => ({
      itemId: item.itemId,
      name: item.name,
      unitPrice: this.roundCurrency(item.price),
      quantity: item.quantity,
      lineTotal: this.roundCurrency(item.price * item.quantity),
    }));

    const itemSubtotal = this.roundCurrency(
      itemizedItems.reduce((acc, curr) => acc + curr.lineTotal, 0)
    );

    // 2. Determine delivery parameters
    const platformConfig = this.configManager.getPlatformDeliveryConfig();
    const areaRule = this.configManager.getAreaDeliveryRule(input.areaId);

    const baseFee = areaRule ? areaRule.baseFee : platformConfig.defaultBaseFee;
    const perKmRate = areaRule ? areaRule.perKmRate : platformConfig.defaultPerKmRate;
    const distanceCharge = Math.max(0, input.deliveryDistanceKm) * perKmRate;

    let areaSurcharges = 0;
    if (areaRule) {
      areaSurcharges += areaRule.areaSurcharge || 0;
      if (input.isHighCongestion && areaRule.congestionSurcharge) {
        areaSurcharges += areaRule.congestionSurcharge;
      }
      if (input.isNightTime && areaRule.nightSurcharge) {
        areaSurcharges += areaRule.nightSurcharge;
      }
    }

    let rawDeliveryFee = this.roundCurrency(baseFee + distanceCharge + areaSurcharges);
    const minDelivery = areaRule?.minimumDeliveryFee ?? platformConfig.minimumDeliveryFee;
    const maxDelivery = areaRule?.maximumDeliveryFee ?? platformConfig.maximumDeliveryFee;

    if (rawDeliveryFee < minDelivery) rawDeliveryFee = minDelivery;
    if (maxDelivery !== undefined && rawDeliveryFee > maxDelivery) rawDeliveryFee = maxDelivery;
    rawDeliveryFee = this.roundCurrency(rawDeliveryFee);

    // 3. Free delivery thresholds
    const freeDeliveryThreshold = areaRule?.freeDeliveryThreshold ?? platformConfig.defaultFreeDeliveryThreshold;
    let freeDeliveryApplied = false;
    let deliveryDiscount = 0;

    if (freeDeliveryThreshold !== null && itemSubtotal >= freeDeliveryThreshold) {
      freeDeliveryApplied = true;
      deliveryDiscount = rawDeliveryFee;
    }

    // 4. Subscription benefits
    let platformServiceFee = this.roundCurrency(
      platformConfig.customerPlatformServiceFee + (itemSubtotal * (platformConfig.customerPlatformServiceFeeRate / 100))
    );

    if (input.subscription && input.subscription.isActive) {
      if (!freeDeliveryApplied && itemSubtotal >= input.subscription.freeDeliveryThreshold) {
        const subDeliveryDiscount = this.roundCurrency(
          rawDeliveryFee * (input.subscription.deliveryFeeDiscountPercentage / 100)
        );
        deliveryDiscount = Math.max(deliveryDiscount, subDeliveryDiscount);
        if (input.subscription.deliveryFeeDiscountPercentage >= 100) {
          freeDeliveryApplied = true;
        }
      }

      if (input.subscription.serviceFeeDiscountPercentage > 0) {
        const serviceFeeReduction = platformServiceFee * (input.subscription.serviceFeeDiscountPercentage / 100);
        platformServiceFee = this.roundCurrency(Math.max(0, platformServiceFee - serviceFeeReduction));
      }
    }

    // 5. Promotional discounts
    let itemDiscounts = 0;
    let promo: PromotionRule | null = null;
    let merchantSponsoredDiscount = 0;

    if (input.promoCode) {
      promo = this.configManager.getPromotion(input.promoCode);
      if (promo) {
        if (!promo.minOrderSubtotal || itemSubtotal >= promo.minOrderSubtotal) {
          if (promo.appliesToItems) {
            if (promo.type === 'PERCENTAGE_DISCOUNT' || promo.type === 'CAPPED_PERCENTAGE') {
              let discount = itemSubtotal * (promo.value / 100);
              if (promo.maxDiscountAmount && discount > promo.maxDiscountAmount) {
                discount = promo.maxDiscountAmount;
              }
              itemDiscounts += this.roundCurrency(discount);
            } else if (promo.type === 'FIXED_DISCOUNT') {
              itemDiscounts += this.roundCurrency(Math.min(itemSubtotal, promo.value));
            }
          }

          if (promo.appliesToDeliveryFee || promo.type === 'FREE_DELIVERY') {
            if (promo.type === 'FREE_DELIVERY') {
              deliveryDiscount = rawDeliveryFee;
              freeDeliveryApplied = true;
            } else if (promo.type === 'PERCENTAGE_DISCOUNT') {
              const extraDeliveryDiscount = this.roundCurrency(rawDeliveryFee * (promo.value / 100));
              deliveryDiscount = Math.min(rawDeliveryFee, deliveryDiscount + extraDeliveryDiscount);
            } else if (promo.type === 'FIXED_DISCOUNT') {
              deliveryDiscount = Math.min(rawDeliveryFee, deliveryDiscount + promo.value);
            }
          }

          // Calculate sponsor split
          if (promo.sponsoredBy === 'MERCHANT') {
            merchantSponsoredDiscount = itemDiscounts;
          } else if (promo.sponsoredBy === 'SHARED' && promo.merchantSplitPercentage) {
            merchantSponsoredDiscount = this.roundCurrency(
              itemDiscounts * (promo.merchantSplitPercentage / 100)
            );
          }
        }
      }
    }

    itemDiscounts = Math.min(itemSubtotal, this.roundCurrency(itemDiscounts));
    deliveryDiscount = Math.min(rawDeliveryFee, this.roundCurrency(deliveryDiscount));
    const finalDeliveryFee = this.roundCurrency(Math.max(0, rawDeliveryFee - deliveryDiscount));
    const totalDiscounts = this.roundCurrency(itemDiscounts + deliveryDiscount);

    const grandTotal = this.roundCurrency(
      Math.max(0, itemSubtotal - itemDiscounts + finalDeliveryFee + platformServiceFee)
    );

    const customerBreakdown: CustomerPriceBreakdown = {
      itemSubtotal,
      rawDeliveryFee,
      deliveryDistanceKm: input.deliveryDistanceKm,
      areaSurcharges,
      deliveryDiscount,
      finalDeliveryFee,
      platformServiceFee,
      itemDiscounts,
      totalDiscounts,
      grandTotal,
      currency: 'EUR',
      appliedPromoCode: promo ? promo.code : undefined,
      freeDeliveryApplied,
      itemizedItems,
    };

    // 6. Merchant Settlement & Platform Commission
    const commissionScheme: CommissionScheme = input.merchantCommissionOverride
      ? input.merchantCommissionOverride
      : this.configManager.getMerchantCommission(input.merchantId, input.categoryId);

    let commissionRate = commissionScheme.percentageRate;
    let fixedCommission = commissionScheme.fixedFee;

    if (commissionScheme.type === 'TIERED' && commissionScheme.tieredRates) {
      const matchedTier = commissionScheme.tieredRates.find(
        tier => itemSubtotal >= tier.minOrderAmount && (!tier.maxOrderAmount || itemSubtotal < tier.maxOrderAmount)
      );
      if (matchedTier) {
        commissionRate = matchedTier.percentageRate;
        fixedCommission = matchedTier.fixedFee;
      }
    }

    const percentageCommissionAmount = this.roundCurrency(itemSubtotal * (commissionRate / 100));
    const platformCommissionTotal = this.roundCurrency(percentageCommissionAmount + fixedCommission);

    const netMerchantPayout = this.roundCurrency(
      Math.max(0, itemSubtotal - platformCommissionTotal - merchantSponsoredDiscount)
    );

    const reconciliationNotes: string[] = [
      `Commission applied: ${commissionScheme.name} (${commissionRate}% + ${fixedCommission})`,
    ];
    if (merchantSponsoredDiscount > 0) {
      reconciliationNotes.push(`Merchant-sponsored promotional deduction: ${merchantSponsoredDiscount}`);
    }

    const merchantBreakdown: MerchantSettlementBreakdown = {
      itemSubtotal,
      commissionType: commissionScheme.type,
      commissionPercentageRate: commissionRate,
      commissionFixedFee: fixedCommission,
      platformCommissionTotal,
      merchantSponsoredDiscounts: merchantSponsoredDiscount,
      netMerchantPayout,
      currency: 'EUR',
      reconciliationNotes,
    };

    const platformGrossRevenue = this.roundCurrency(
      platformCommissionTotal + platformServiceFee + (finalDeliveryFee - rawDeliveryFee <= 0 ? 0 : 0)
    );

    return {
      customerBreakdown,
      merchantBreakdown,
      platformGrossRevenue,
      calculatedAt: new Date().toISOString(),
    };
  }
}
