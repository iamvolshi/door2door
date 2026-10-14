import { ValidationError, NotFoundError } from '../core/errors';
import { logger } from '../core/logger';

export type ServiceArea = 
  | 'cox_bazar_sadar'
  | 'ramu'
  | 'chakaria'
  | 'teknaf'
  | 'ukhiya'
  | 'pecharthol'
  | 'inani'
  | 'himchari';

export interface CatalogItem {
  id: string;
  storeId: string;
  name: string;
  basePrice: number;
  taxRate: number;
  isAvailable: boolean;
  maxQuantityPerOrder?: number;
}

export interface OrderItemRequest {
  itemId: string;
  quantity: number;
  claimedUnitPrice?: number;
}

export interface DiscountCoupon {
  code: string;
  type: 'PERCENTAGE' | 'FIXED_AMOUNT';
  value: number;
  minimumOrderAmount: number;
  maxDiscountAmount?: number;
  validUntil: Date;
  applicableStoreIds?: string[];
  isActive: boolean;
}

export interface DeliveryTier {
  area: ServiceArea;
  baseFee: number;
  perKmFee: number;
  freeDeliveryThreshold?: number;
  minimumOrderValue: number;
}

export interface PricingCalculationInput {
  storeId: string;
  serviceArea: ServiceArea;
  distanceKm: number;
  items: OrderItemRequest[];
  couponCode?: string;
  isPriorityDelivery?: boolean;
}

export interface CalculatedOrderItem {
  itemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  subtotal: number;
  itemTax: number;
  total: number;
}

export interface OrderPricingSummary {
  storeId: string;
  serviceArea: ServiceArea;
  items: CalculatedOrderItem[];
  itemsSubtotal: number;
  taxTotal: number;
  deliveryFee: number;
  priorityDeliveryFee: number;
  discountAmount: number;
  appliedCouponCode?: string;
  finalPayableAmount: number;
  calculatedAt: string;
}

export const DELIVERY_TIERS: Record<ServiceArea, DeliveryTier> = {
  cox_bazar_sadar: {
    area: 'cox_bazar_sadar',
    baseFee: 30,
    perKmFee: 10,
    freeDeliveryThreshold: 1000,
    minimumOrderValue: 100,
  },
  ramu: {
    area: 'ramu',
    baseFee: 50,
    perKmFee: 12,
    freeDeliveryThreshold: 1500,
    minimumOrderValue: 200,
  },
  chakaria: {
    area: 'chakaria',
    baseFee: 70,
    perKmFee: 15,
    freeDeliveryThreshold: 2000,
    minimumOrderValue: 250,
  },
  teknaf: {
    area: 'teknaf',
    baseFee: 90,
    perKmFee: 18,
    freeDeliveryThreshold: 2500,
    minimumOrderValue: 300,
  },
  ukhiya: {
    area: 'ukhiya',
    baseFee: 80,
    perKmFee: 16,
    freeDeliveryThreshold: 2200,
    minimumOrderValue: 250,
  },
  pecharthol: {
    area: 'pecharthol',
    baseFee: 60,
    perKmFee: 14,
    freeDeliveryThreshold: 1800,
    minimumOrderValue: 200,
  },
  inani: {
    area: 'inani',
    baseFee: 65,
    perKmFee: 15,
    freeDeliveryThreshold: 2000,
    minimumOrderValue: 250,
  },
  himchari: {
    area: 'himchari',
    baseFee: 55,
    perKmFee: 13,
    freeDeliveryThreshold: 1700,
    minimumOrderValue: 200,
  },
};

export const PRIORITY_SURCHARGE = 40;
export const DEFAULT_VAT_RATE = 0.05;

export class PricingService {
  private catalogStore: Map<string, CatalogItem> = new Map();
  private couponStore: Map<string, DiscountCoupon> = new Map();

  constructor(initialCatalog: CatalogItem[] = [], initialCoupons: DiscountCoupon[] = []) {
    for (const item of initialCatalog) {
      this.catalogStore.set(item.id, item);
    }
    for (const coupon of initialCoupons) {
      this.couponStore.set(coupon.code.toUpperCase(), coupon);
    }
  }

  public registerCatalogItem(item: CatalogItem): void {
    this.catalogStore.set(item.id, item);
  }

  public registerCoupon(coupon: DiscountCoupon): void {
    this.couponStore.set(coupon.code.toUpperCase(), coupon);
  }

  public getCatalogItem(itemId: string): CatalogItem | undefined {
    return this.catalogStore.get(itemId);
  }

  public calculateDeliveryFee(
    serviceArea: ServiceArea,
    distanceKm: number,
    itemsSubtotal: number,
    isPriority: boolean = false
  ): { baseDeliveryFee: number; priorityFee: number; totalDeliveryFee: number } {
    const tier = DELIVERY_TIERS[serviceArea];
    if (!tier) {
      throw new ValidationError(`Unsupported service area: ${serviceArea}`);
    }

    if (distanceKm < 0) {
      throw new ValidationError('Delivery distance cannot be negative');
    }

    let baseDeliveryFee = 0;
    if (tier.freeDeliveryThreshold && itemsSubtotal >= tier.freeDeliveryThreshold) {
      baseDeliveryFee = 0;
    } else {
      baseDeliveryFee = tier.baseFee + Math.max(0, distanceKm) * tier.perKmFee;
    }

    baseDeliveryFee = Math.round(baseDeliveryFee * 100) / 100;
    const priorityFee = isPriority ? PRIORITY_SURCHARGE : 0;
    const totalDeliveryFee = baseDeliveryFee + priorityFee;

    return {
      baseDeliveryFee,
      priorityFee,
      totalDeliveryFee,
    };
  }

  public validateAndApplyCoupon(
    couponCode: string,
    storeId: string,
    subtotal: number
  ): { discountAmount: number; coupon: DiscountCoupon } {
    const coupon = this.couponStore.get(couponCode.toUpperCase());
    if (!coupon || !coupon.isActive) {
      throw new ValidationError(`Coupon '${couponCode}' is invalid or expired`);
    }

    if (new Date() > new Date(coupon.validUntil)) {
      throw new ValidationError(`Coupon '${couponCode}' has expired`);
    }

    if (coupon.applicableStoreIds && !coupon.applicableStoreIds.includes(storeId)) {
      throw new ValidationError(`Coupon '${couponCode}' is not applicable to store ${storeId}`);
    }

    if (subtotal < coupon.minimumOrderAmount) {
      throw new ValidationError(
        `Order subtotal (${subtotal} BDT) does not meet minimum coupon requirement (${coupon.minimumOrderAmount} BDT)`
      );
    }

    let discount = 0;
    if (coupon.type === 'PERCENTAGE') {
      discount = (subtotal * coupon.value) / 100;
      if (coupon.maxDiscountAmount && discount > coupon.maxDiscountAmount) {
        discount = coupon.maxDiscountAmount;
      }
    } else {
      discount = Math.min(coupon.value, subtotal);
    }

    return {
      discountAmount: Math.round(discount * 100) / 100,
      coupon,
    };
  }

  public calculateOrderPricing(input: PricingCalculationInput): OrderPricingSummary {
    const tier = DELIVERY_TIERS[input.serviceArea];
    if (!tier) {
      throw new ValidationError(`Invalid service area: ${input.serviceArea}`);
    }

    if (!input.items || input.items.length === 0) {
      throw new ValidationError('Order must contain at least one item');
    }

    let itemsSubtotal = 0;
    let taxTotal = 0;
    const calculatedItems: CalculatedOrderItem[] = [];

    for (const req of input.items) {
      if (!req.quantity || req.quantity <= 0 || !Number.isInteger(req.quantity)) {
        throw new ValidationError(`Invalid quantity for item ${req.itemId}`);
      }

      const catalogItem = this.catalogStore.get(req.itemId);
      if (!catalogItem) {
        throw new NotFoundError(`Catalog item ${req.itemId} not found`);
      }

      if (catalogItem.storeId !== input.storeId) {
        throw new ValidationError(
          `Item ${req.itemId} belongs to store ${catalogItem.storeId}, not requested store ${input.storeId}`
        );
      }

      if (!catalogItem.isAvailable) {
        throw new ValidationError(`Item ${catalogItem.name} (${catalogItem.id}) is currently out of stock`);
      }

      if (catalogItem.maxQuantityPerOrder && req.quantity > catalogItem.maxQuantityPerOrder) {
        throw new ValidationError(
          `Maximum quantity allowed for item ${catalogItem.name} is ${catalogItem.maxQuantityPerOrder}`
        );
      }

      // Tamper check: If client supplied claimed price, check if it mismatches server price
      const serverUnitPrice = catalogItem.basePrice;
      if (req.claimedUnitPrice !== undefined && Math.abs(req.claimedUnitPrice - serverUnitPrice) > 0.001) {
        logger.warn('Client price mismatch detected', {
          itemId: req.itemId,
          claimedPrice: req.claimedUnitPrice,
          serverPrice: serverUnitPrice,
        });
      }

      const itemSubtotal = serverUnitPrice * req.quantity;
      const effectiveTaxRate = catalogItem.taxRate ?? DEFAULT_VAT_RATE;
      const itemTax = Math.round(itemSubtotal * effectiveTaxRate * 100) / 100;
      const totalItemAmount = itemSubtotal + itemTax;

      itemsSubtotal += itemSubtotal;
      taxTotal += itemTax;

      calculatedItems.push({
        itemId: catalogItem.id,
        name: catalogItem.name,
        unitPrice: serverUnitPrice,
        quantity: req.quantity,
        subtotal: Math.round(itemSubtotal * 100) / 100,
        itemTax,
        total: Math.round(totalItemAmount * 100) / 100,
      });
    }

    if (itemsSubtotal < tier.minimumOrderValue) {
      throw new ValidationError(
        `Order subtotal (${itemsSubtotal} BDT) does not meet area minimum of ${tier.minimumOrderValue} BDT for ${input.serviceArea}`
      );
    }

    const delivery = this.calculateDeliveryFee(
      input.serviceArea,
      input.distanceKm,
      itemsSubtotal,
      input.isPriorityDelivery
    );

    let discountAmount = 0;
    let appliedCouponCode: string | undefined = undefined;

    if (input.couponCode) {
      const couponResult = this.validateAndApplyCoupon(input.couponCode, input.storeId, itemsSubtotal);
      discountAmount = couponResult.discountAmount;
      appliedCouponCode = couponResult.coupon.code;
    }

    const finalPayable = Math.max(0, itemsSubtotal + taxTotal + delivery.totalDeliveryFee - discountAmount);

    return {
      storeId: input.storeId,
      serviceArea: input.serviceArea,
      items: calculatedItems,
      itemsSubtotal: Math.round(itemsSubtotal * 100) / 100,
      taxTotal: Math.round(taxTotal * 100) / 100,
      deliveryFee: delivery.baseDeliveryFee,
      priorityDeliveryFee: delivery.priorityFee,
      discountAmount,
      appliedCouponCode,
      finalPayableAmount: Math.round(finalPayable * 100) / 100,
      calculatedAt: new Date().toISOString(),
    };
  }
}

export const pricingService = new PricingService([
  {
    id: 'item-rice-1',
    storeId: 'store-sadar-1',
    name: 'Kacchi Biryani Half',
    basePrice: 220,
    taxRate: 0.05,
    isAvailable: true,
    maxQuantityPerOrder: 20,
  },
  {
    id: 'item-drink-1',
    storeId: 'store-sadar-1',
    name: 'Borhani 250ml',
    basePrice: 50,
    taxRate: 0.05,
    isAvailable: true,
    maxQuantityPerOrder: 10,
  },
  {
    id: 'item-ramu-special',
    storeId: 'store-ramu-1',
    name: 'Ramu Dried Fish Curry Set',
    basePrice: 350,
    taxRate: 0.05,
    isAvailable: true,
    maxQuantityPerOrder: 10,
  },
], [
  {
    code: 'WELCOME50',
    type: 'FIXED_AMOUNT',
    value: 50,
    minimumOrderAmount: 200,
    validUntil: new Date('2028-12-31'),
    isActive: true,
  },
  {
    code: 'COXSUMMER10',
    type: 'PERCENTAGE',
    value: 10,
    minimumOrderAmount: 300,
    maxDiscountAmount: 100,
    validUntil: new Date('2028-12-31'),
    isActive: true,
  },
]);
