export enum CategoryRolloutPhase {
  INITIAL_LAUNCH = 'INITIAL_LAUNCH',
  PHASE_2 = 'PHASE_2',
  PHASE_3 = 'PHASE_3',
  BETA = 'BETA',
  DEPRECATED = 'DEPRECATED'
}

export enum ServiceCategoryCode {
  FOOD_DELIVERY = 'FOOD_DELIVERY',
  GROCERY_ESSENTIALS = 'GROCERY_ESSENTIALS',
  LOCAL_SHOP = 'LOCAL_SHOP',
  PHARMACY = 'PHARMACY',
  LOCAL_PRODUCT = 'LOCAL_PRODUCT',
  SCHEDULED_DELIVERY = 'SCHEDULED_DELIVERY'
}

export interface RegulatoryPrerequisite {
  code: string;
  name: string;
  description: string;
  isRequired: boolean;
  validationRule: 'DOCUMENT_UPLOAD' | 'AGE_VERIFICATION' | 'SPECIAL_PERMIT' | 'TERMS_ACKNOWLEDGMENT';
}

export interface CategoryOperationalHours {
  openTime: string; // HH:mm 24-hr format
  closeTime: string; // HH:mm 24-hr format
  timezone?: string;
  daysOfWeek?: number[]; // 0-6 (Sunday to Saturday)
}

export interface ServiceCategory {
  id: string;
  code: ServiceCategoryCode | string;
  displayName: string;
  description: string;
  iconUrl?: string;
  rolloutPhase: CategoryRolloutPhase;
  isEnabled: boolean;
  isCustomerVisible: boolean;
  sortOrder: number;
  regulatoryFlags: RegulatoryPrerequisite[];
  allowedDistrictIds?: string[]; // Empty or undefined means all active districts
  maxItemWeightKg?: number;
  requiresSpecialHandling?: boolean;
  operationalHours?: CategoryOperationalHours;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderCategoryValidationContext {
  categoryId: string;
  districtId?: string;
  customerAge?: number;
  uploadedDocuments?: Array<{
    documentType: string;
    documentUrl: string;
    verified?: boolean;
  }>;
  itemWeightsKg?: number[];
  currentTimestamp?: Date;
  acknowledgedTerms?: string[];
}

export interface CategoryValidationResult {
  isEligible: boolean;
  reasons: string[];
  missingPrerequisites: RegulatoryPrerequisite[];
}
