import {
  CommissionScheme,
  AreaDeliveryRule,
  PlatformDeliveryConfig,
  PromotionRule,
  SubscriptionBenefit
} from './revenueTypes';

export interface RevenueConfigurationState {
  platformDelivery: PlatformDeliveryConfig;
  defaultCommission: CommissionScheme;
  categoryCommissions: Map<string, CommissionScheme>;
  merchantCommissionOverrides: Map<string, CommissionScheme>;
  areaDeliveryRules: Map<string, AreaDeliveryRule>;
  promotions: Map<string, PromotionRule>;
  subscriptionPlans: Map<string, SubscriptionBenefit>;
}

export class RevenueConfigManager {
  private static instance: RevenueConfigManager;

  private state: RevenueConfigurationState;

  constructor(initialState?: Partial<RevenueConfigurationState>) {
    this.state = {
      platformDelivery: initialState?.platformDelivery ?? {
        defaultBaseFee: 3.50,
        defaultPerKmRate: 1.25,
        minimumDeliveryFee: 2.50,
        maximumDeliveryFee: 25.00,
        defaultFreeDeliveryThreshold: 50.00,
        customerPlatformServiceFee: 0.99,
        customerPlatformServiceFeeRate: 0.0,
      },
      defaultCommission: initialState?.defaultCommission ?? {
        id: 'comm-default',
        name: 'Default Standard Commission',
        type: 'PERCENTAGE',
        percentageRate: 15.0,
        fixedFee: 0.50,
        description: 'Standard baseline platform commission rate',
      },
      categoryCommissions: initialState?.categoryCommissions ?? new Map([
        ['food', { id: 'comm-food', name: 'Food Category Commission', type: 'PERCENTAGE', percentageRate: 18.0, fixedFee: 0.30 }],
        ['groceries', { id: 'comm-groceries', name: 'Grocery Category Commission', type: 'PERCENTAGE', percentageRate: 10.0, fixedFee: 0.20 }],
        ['local_shops', { id: 'comm-local', name: 'Local Shops Commission', type: 'PERCENTAGE', percentageRate: 12.0, fixedFee: 0.25 }],
      ]),
      merchantCommissionOverrides: initialState?.merchantCommissionOverrides ?? new Map(),
      areaDeliveryRules: initialState?.areaDeliveryRules ?? new Map([
        ['central-district', {
          areaId: 'central-district',
          areaName: 'Central District Zone',
          baseFee: 3.00,
          perKmRate: 1.10,
          minimumDeliveryFee: 2.50,
          maximumDeliveryFee: 20.00,
          areaSurcharge: 0.50,
          congestionSurcharge: 1.00,
          nightSurcharge: 1.50,
          freeDeliveryThreshold: 45.00,
          isActive: true,
        }],
      ]),
      promotions: initialState?.promotions ?? new Map(),
      subscriptionPlans: initialState?.subscriptionPlans ?? new Map([
        ['plus-tier', {
          id: 'plus-tier',
          planName: 'Plus Premium Member',
          freeDeliveryThreshold: 20.00,
          deliveryFeeDiscountPercentage: 100,
          serviceFeeDiscountPercentage: 50,
          isActive: true,
        }],
      ]),
    };
  }

  public static getInstance(): RevenueConfigManager {
    if (!RevenueConfigManager.instance) {
      RevenueConfigManager.instance = new RevenueConfigManager();
    }
    return RevenueConfigManager.instance;
  }

  public getPlatformDeliveryConfig(): PlatformDeliveryConfig {
    return { ...this.state.platformDelivery };
  }

  public updatePlatformDeliveryConfig(config: Partial<PlatformDeliveryConfig>): PlatformDeliveryConfig {
    this.state.platformDelivery = { ...this.state.platformDelivery, ...config };
    return this.getPlatformDeliveryConfig();
  }

  public getDefaultCommission(): CommissionScheme {
    return { ...this.state.defaultCommission };
  }

  public updateDefaultCommission(scheme: Partial<CommissionScheme>): CommissionScheme {
    this.state.defaultCommission = { ...this.state.defaultCommission, ...scheme };
    return this.getDefaultCommission();
  }

  public setCategoryCommission(categoryId: string, scheme: CommissionScheme): void {
    this.state.categoryCommissions.set(categoryId.toLowerCase(), scheme);
  }

  public getCategoryCommission(categoryId?: string): CommissionScheme {
    if (categoryId && this.state.categoryCommissions.has(categoryId.toLowerCase())) {
      return { ...this.state.categoryCommissions.get(categoryId.toLowerCase())! };
    }
    return this.getDefaultCommission();
  }

  public removeCategoryCommission(categoryId: string): boolean {
    return this.state.categoryCommissions.delete(categoryId.toLowerCase());
  }

  public setMerchantCommissionOverride(merchantId: string, scheme: CommissionScheme): void {
    this.state.merchantCommissionOverrides.set(merchantId, scheme);
  }

  public getMerchantCommission(merchantId: string, categoryId?: string): CommissionScheme {
    if (this.state.merchantCommissionOverrides.has(merchantId)) {
      return { ...this.state.merchantCommissionOverrides.get(merchantId)! };
    }
    return this.getCategoryCommission(categoryId);
  }

  public removeMerchantCommissionOverride(merchantId: string): boolean {
    return this.state.merchantCommissionOverrides.delete(merchantId);
  }

  public setAreaDeliveryRule(rule: AreaDeliveryRule): void {
    this.state.areaDeliveryRules.set(rule.areaId, rule);
  }

  public getAreaDeliveryRule(areaId?: string): AreaDeliveryRule | null {
    if (!areaId) return null;
    const rule = this.state.areaDeliveryRules.get(areaId);
    return rule && rule.isActive ? { ...rule } : null;
  }

  public removeAreaDeliveryRule(areaId: string): boolean {
    return this.state.areaDeliveryRules.delete(areaId);
  }

  public setPromotion(promo: PromotionRule): void {
    this.state.promotions.set(promo.code.toUpperCase(), promo);
  }

  public getPromotion(code?: string): PromotionRule | null {
    if (!code) return null;
    const promo = this.state.promotions.get(code.toUpperCase());
    if (!promo || !promo.isActive) return null;

    const now = new Date();
    if (promo.validFrom && promo.validFrom > now) return null;
    if (promo.validUntil && promo.validUntil < now) return null;
    if (promo.usageLimit !== undefined && promo.usageCount >= promo.usageLimit) return null;

    return { ...promo };
  }

  public incrementPromotionUsage(code: string): void {
    const promo = this.state.promotions.get(code.toUpperCase());
    if (promo) {
      promo.usageCount += 1;
    }
  }

  public getSubscriptionPlan(planId: string): SubscriptionBenefit | null {
    const plan = this.state.subscriptionPlans.get(planId);
    return plan && plan.isActive ? { ...plan } : null;
  }

  public setSubscriptionPlan(plan: SubscriptionBenefit): void {
    this.state.subscriptionPlans.set(plan.id, plan);
  }

  public resetToDefaults(): void {
    this.state.merchantCommissionOverrides.clear();
    this.state.categoryCommissions.clear();
    this.state.areaDeliveryRules.clear();
    this.state.promotions.clear();
    this.state.subscriptionPlans.clear();
  }
}
