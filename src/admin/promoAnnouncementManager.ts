export type DiscountType = 'PERCENTAGE' | 'FIXED_AMOUNT';
export type AudienceTarget = 'ALL' | 'NEW_USERS' | 'LOYAL_USERS' | 'MERCHANTS' | 'RIDERS' | 'ZONE_SPECIFIC';
export type AnnouncementPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export interface PromoCode {
  code: string;
  description: string;
  discountType: DiscountType;
  discountValue: number;
  minOrderAmount: number;
  maxDiscountAmount?: number;
  validFrom: number;
  validTo: number;
  usageLimit: number;
  usageCount: number;
  perUserLimit: number;
  userUsageMap: Record<string, number>;
  targetAudience: AudienceTarget;
  allowedZones?: string[];
  active: boolean;
  createdBy: string;
  createdAt: number;
}

export interface Announcement {
  id: string;
  title: string;
  bengaliTitle?: string;
  body: string;
  bengaliBody?: string;
  targetAudience: AudienceTarget;
  targetZoneId?: string;
  priority: AnnouncementPriority;
  active: boolean;
  expiresAt?: number;
  createdAt: number;
  createdBy: string;
}

export interface PromoValidationResult {
  valid: boolean;
  discountAmount: number;
  message?: string;
  errorCode?: 'INVALID_CODE' | 'EXPIRED' | 'NOT_STARTED' | 'INACTIVE' | 'USAGE_EXCEEDED' | 'USER_LIMIT_REACHED' | 'MIN_ORDER_UNMET' | 'ZONE_RESTRICTED';
}

export class PromoAnnouncementManager {
  private promoCodes: Map<string, PromoCode> = new Map();
  private announcements: Map<string, Announcement> = new Map();

  public createPromoCode(adminId: string, promo: Omit<PromoCode, 'usageCount' | 'userUsageMap' | 'createdBy' | 'createdAt'>): PromoCode {
    const upperCode = promo.code.toUpperCase().trim();
    if (this.promoCodes.has(upperCode)) {
      throw new Error(`Promo code ${upperCode} already exists.`);
    }
    if (promo.discountValue <= 0) {
      throw new Error('Discount value must be greater than zero.');
    }
    if (promo.discountType === 'PERCENTAGE' && promo.discountValue > 100) {
      throw new Error('Percentage discount cannot exceed 100%.');
    }

    const newPromo: PromoCode = {
      ...promo,
      code: upperCode,
      usageCount: 0,
      userUsageMap: {},
      createdBy: adminId,
      createdAt: Date.now()
    };

    this.promoCodes.set(upperCode, newPromo);
    return { ...newPromo };
  }

  public updatePromoStatus(code: string, active: boolean): PromoCode {
    const promo = this.promoCodes.get(code.toUpperCase().trim());
    if (!promo) {
      throw new Error(`Promo code ${code} not found.`);
    }
    promo.active = active;
    return { ...promo };
  }

  public validatePromo(
    code: string,
    orderAmount: number,
    userId: string,
    zoneId?: string
  ): PromoValidationResult {
    const promo = this.promoCodes.get(code.toUpperCase().trim());
    const now = Date.now();

    if (!promo) {
      return { valid: false, discountAmount: 0, errorCode: 'INVALID_CODE', message: 'Promo code does not exist.' };
    }
    if (!promo.active) {
      return { valid: false, discountAmount: 0, errorCode: 'INACTIVE', message: 'Promo code is deactivated.' };
    }
    if (now < promo.validFrom) {
      return { valid: false, discountAmount: 0, errorCode: 'NOT_STARTED', message: 'Promo code is not yet active.' };
    }
    if (now > promo.validTo) {
      return { valid: false, discountAmount: 0, errorCode: 'EXPIRED', message: 'Promo code has expired.' };
    }
    if (promo.usageCount >= promo.usageLimit) {
      return { valid: false, discountAmount: 0, errorCode: 'USAGE_EXCEEDED', message: 'Promo code total usage limit reached.' };
    }
    const userUses = promo.userUsageMap[userId] || 0;
    if (userUses >= promo.perUserLimit) {
      return { valid: false, discountAmount: 0, errorCode: 'USER_LIMIT_REACHED', message: 'You have reached the maximum redemption limit for this code.' };
    }
    if (orderAmount < promo.minOrderAmount) {
      return { valid: false, discountAmount: 0, errorCode: 'MIN_ORDER_UNMET', message: `Order amount ${orderAmount} is less than minimum ${promo.minOrderAmount}.` };
    }
    if (promo.allowedZones && promo.allowedZones.length > 0 && zoneId) {
      if (!promo.allowedZones.includes(zoneId)) {
        return { valid: false, discountAmount: 0, errorCode: 'ZONE_RESTRICTED', message: 'Promo code is not applicable in this delivery zone.' };
      }
    }

    let discount = 0;
    if (promo.discountType === 'PERCENTAGE') {
      discount = (orderAmount * promo.discountValue) / 100;
      if (promo.maxDiscountAmount && discount > promo.maxDiscountAmount) {
        discount = promo.maxDiscountAmount;
      }
    } else {
      discount = Math.min(promo.discountValue, orderAmount);
    }

    return {
      valid: true,
      discountAmount: Number(discount.toFixed(2))
    };
  }

  public recordPromoRedemption(code: string, userId: string): void {
    const promo = this.promoCodes.get(code.toUpperCase().trim());
    if (!promo) {
      throw new Error(`Promo code ${code} not found.`);
    }
    promo.usageCount += 1;
    promo.userUsageMap[userId] = (promo.userUsageMap[userId] || 0) + 1;
  }

  public getPromo(code: string): PromoCode | undefined {
    const promo = this.promoCodes.get(code.toUpperCase().trim());
    return promo ? { ...promo } : undefined;
  }

  public listPromos(): PromoCode[] {
    return Array.from(this.promoCodes.values()).map(p => ({ ...p }));
  }

  public createAnnouncement(adminId: string, data: Omit<Announcement, 'id' | 'createdAt' | 'createdBy'>): Announcement {
    const id = `ann_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const announcement: Announcement = {
      ...data,
      id,
      createdAt: Date.now(),
      createdBy: adminId
    };
    this.announcements.set(id, announcement);
    return { ...announcement };
  }

  public deactivateAnnouncement(id: string): boolean {
    const item = this.announcements.get(id);
    if (!item) return false;
    item.active = false;
    return true;
  }

  public getActiveAnnouncements(audience?: AudienceTarget, zoneId?: string): Announcement[] {
    const now = Date.now();
    return Array.from(this.announcements.values()).filter(a => {
      if (!a.active) return false;
      if (a.expiresAt && a.expiresAt < now) return false;
      if (audience && a.targetAudience !== 'ALL' && a.targetAudience !== audience) return false;
      if (zoneId && a.targetZoneId && a.targetZoneId !== zoneId) return false;
      return true;
    });
  }
}
