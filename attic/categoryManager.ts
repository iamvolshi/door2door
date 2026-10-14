import { ValidationError, NotFoundError, AppError } from '../../core/errors';
import { logger } from '../../core/logger';
import {
  CategoryRolloutPhase,
  CategoryValidationResult,
  OrderCategoryValidationContext,
  RegulatoryPrerequisite,
  ServiceCategory,
  ServiceCategoryCode
} from './categoryTypes';

export const INITIAL_SERVICE_CATEGORIES: ServiceCategory[] = [
  {
    id: 'cat_food_001',
    code: ServiceCategoryCode.FOOD_DELIVERY,
    displayName: 'Restaurant Food Delivery',
    description: 'Hot meals and beverages delivered from local restaurants and eateries',
    rolloutPhase: CategoryRolloutPhase.INITIAL_LAUNCH,
    isEnabled: true,
    isCustomerVisible: true,
    sortOrder: 1,
    regulatoryFlags: [],
    maxItemWeightKg: 15,
    requiresSpecialHandling: false,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z')
  },
  {
    id: 'cat_grocery_002',
    code: ServiceCategoryCode.GROCERY_ESSENTIALS,
    displayName: 'Grocery and Daily Essentials',
    description: 'Fresh produce, staples, pantry goods, and household care items',
    rolloutPhase: CategoryRolloutPhase.INITIAL_LAUNCH,
    isEnabled: true,
    isCustomerVisible: true,
    sortOrder: 2,
    regulatoryFlags: [],
    maxItemWeightKg: 30,
    requiresSpecialHandling: false,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z')
  },
  {
    id: 'cat_localshop_003',
    code: ServiceCategoryCode.LOCAL_SHOP,
    displayName: 'Local Shop Delivery',
    description: 'Boutiques, stationeries, hardware, and neighborhood retail deliveries',
    rolloutPhase: CategoryRolloutPhase.INITIAL_LAUNCH,
    isEnabled: true,
    isCustomerVisible: true,
    sortOrder: 3,
    regulatoryFlags: [],
    maxItemWeightKg: 20,
    requiresSpecialHandling: false,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z')
  },
  {
    id: 'cat_pharmacy_004',
    code: ServiceCategoryCode.PHARMACY,
    displayName: 'Pharmacy & Wellness Orders',
    description: 'Prescription and over-the-counter health and personal care items',
    rolloutPhase: CategoryRolloutPhase.PHASE_2,
    isEnabled: false,
    isCustomerVisible: false,
    sortOrder: 4,
    regulatoryFlags: [
      {
        code: 'PRESCRIPTION_UPLOAD',
        name: 'Valid Doctor Prescription',
        description: 'Mandatory uploaded medical prescription for scheduled pharmaceutical items',
        isRequired: true,
        validationRule: 'DOCUMENT_UPLOAD'
      },
      {
        code: 'AGE_VERIFICATION',
        name: 'Adult Customer Verification',
        description: 'Recipient must be at least 18 years of age to accept pharmacy orders',
        isRequired: true,
        validationRule: 'AGE_VERIFICATION'
      }
    ],
    maxItemWeightKg: 10,
    requiresSpecialHandling: true,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z')
  },
  {
    id: 'cat_localprod_005',
    code: ServiceCategoryCode.LOCAL_PRODUCT,
    displayName: 'Local Product Delivery',
    description: 'Artisanal crafts, regional specialties, and specialty maker goods',
    rolloutPhase: CategoryRolloutPhase.PHASE_2,
    isEnabled: false,
    isCustomerVisible: false,
    sortOrder: 5,
    regulatoryFlags: [],
    maxItemWeightKg: 25,
    requiresSpecialHandling: false,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z')
  },
  {
    id: 'cat_scheduled_006',
    code: ServiceCategoryCode.SCHEDULED_DELIVERY,
    displayName: 'Scheduled & Recurring Deliveries',
    description: 'Pre-booked custom slot delivery for recurring household and commercial orders',
    rolloutPhase: CategoryRolloutPhase.PHASE_3,
    isEnabled: false,
    isCustomerVisible: false,
    sortOrder: 6,
    regulatoryFlags: [
      {
        code: 'SCHEDULE_SLOT_CONFIRMATION',
        name: 'Delivery Slot Acknowledgment',
        description: 'Customer confirmation of recurring delivery window terms',
        isRequired: true,
        validationRule: 'TERMS_ACKNOWLEDGMENT'
      }
    ],
    maxItemWeightKg: 40,
    requiresSpecialHandling: false,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z')
  }
];

export class CategoryManager {
  private categories: Map<string, ServiceCategory> = new Map();

  constructor(initialData?: ServiceCategory[]) {
    const seed = initialData ?? INITIAL_SERVICE_CATEGORIES;
    for (const cat of seed) {
      this.categories.set(cat.id, { ...cat });
    }
  }

  public getAllCategories(): ServiceCategory[] {
    return Array.from(this.categories.values()).sort((a, b) => a.sortOrder - b.sortOrder);
  }

  public getCategoryById(categoryId: string): ServiceCategory | undefined {
    const cat = this.categories.get(categoryId);
    return cat ? { ...cat } : undefined;
  }

  public getCategoryByCode(code: string): ServiceCategory | undefined {
    for (const cat of this.categories.values()) {
      if (cat.code === code) {
        return { ...cat };
      }
    }
    return undefined;
  }

  public getActiveCustomerCategories(districtId?: string): ServiceCategory[] {
    return Array.from(this.categories.values())
      .filter((cat) => {
        if (!cat.isEnabled || !cat.isCustomerVisible) return false;
        if (districtId && cat.allowedDistrictIds && cat.allowedDistrictIds.length > 0) {
          return cat.allowedDistrictIds.includes(districtId);
        }
        return true;
      })
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((cat) => ({ ...cat }));
  }

  public toggleCategoryStatus(categoryId: string, isEnabled: boolean, isCustomerVisible?: boolean): ServiceCategory {
    const existing = this.categories.get(categoryId);
    if (!existing) {
      throw new NotFoundError(`Service category '${categoryId}' not found.`);
    }

    const updated: ServiceCategory = {
      ...existing,
      isEnabled,
      isCustomerVisible: isCustomerVisible !== undefined ? isCustomerVisible : isEnabled,
      updatedAt: new Date()
    };

    this.categories.set(categoryId, updated);
    logger.info(`Category status toggled`, { categoryId, isEnabled, isCustomerVisible: updated.isCustomerVisible });
    return { ...updated };
  }

  public updateRolloutPhase(categoryId: string, phase: CategoryRolloutPhase): ServiceCategory {
    const existing = this.categories.get(categoryId);
    if (!existing) {
      throw new NotFoundError(`Service category '${categoryId}' not found.`);
    }

    const updated: ServiceCategory = {
      ...existing,
      rolloutPhase: phase,
      updatedAt: new Date()
    };

    this.categories.set(categoryId, updated);
    logger.info(`Category rollout phase updated`, { categoryId, phase });
    return { ...updated };
  }

  public setRegulatoryPrerequisites(categoryId: string, prerequisites: RegulatoryPrerequisite[]): ServiceCategory {
    const existing = this.categories.get(categoryId);
    if (!existing) {
      throw new NotFoundError(`Service category '${categoryId}' not found.`);
    }

    const updated: ServiceCategory = {
      ...existing,
      regulatoryFlags: [...prerequisites],
      updatedAt: new Date()
    };

    this.categories.set(categoryId, updated);
    return { ...updated };
  }

  public checkOrderCategoryEligibility(context: OrderCategoryValidationContext): CategoryValidationResult {
    const category = this.categories.get(context.categoryId);
    if (!category) {
      return {
        isEligible: false,
        reasons: [`Service category '${context.categoryId}' does not exist.`],
        missingPrerequisites: []
      };
    }

    const reasons: string[] = [];
    const missingPrerequisites: RegulatoryPrerequisite[] = [];

    if (!category.isEnabled) {
      reasons.push(`Category '${category.displayName}' is currently disabled.`);
    }

    if (context.districtId && category.allowedDistrictIds && category.allowedDistrictIds.length > 0) {
      if (!category.allowedDistrictIds.includes(context.districtId)) {
        reasons.push(`Category '${category.displayName}' is not available in district '${context.districtId}'.`);
      }
    }

    if (category.maxItemWeightKg && context.itemWeightsKg && context.itemWeightsKg.length > 0) {
      const totalWeight = context.itemWeightsKg.reduce((acc, w) => acc + w, 0);
      if (totalWeight > category.maxItemWeightKg) {
        reasons.push(`Total order weight (${totalWeight}kg) exceeds max limit of ${category.maxItemWeightKg}kg for ${category.displayName}.`);
      }
    }

    for (const flag of category.regulatoryFlags) {
      if (!flag.isRequired) continue;

      switch (flag.validationRule) {
        case 'DOCUMENT_UPLOAD': {
          const hasDoc = context.uploadedDocuments?.some(
            (doc) => doc.documentType.toUpperCase() === flag.code.toUpperCase() || doc.documentType.length > 0
          );
          if (!hasDoc) {
            reasons.push(`Missing mandatory regulatory document for prerequisite '${flag.name}'.`);
            missingPrerequisites.push(flag);
          }
          break;
        }
        case 'AGE_VERIFICATION': {
          if (context.customerAge === undefined || context.customerAge < 18) {
            reasons.push(`Prerequisite '${flag.name}' failed: Customer must be 18+ years of age.`);
            missingPrerequisites.push(flag);
          }
          break;
        }
        case 'TERMS_ACKNOWLEDGMENT': {
          const hasAck = context.acknowledgedTerms?.includes(flag.code);
          if (!hasAck) {
            reasons.push(`Customer must accept terms for prerequisite '${flag.name}'.`);
            missingPrerequisites.push(flag);
          }
          break;
        }
        case 'SPECIAL_PERMIT': {
          const hasPermit = context.uploadedDocuments?.some((doc) => doc.documentType === 'SPECIAL_PERMIT');
          if (!hasPermit) {
            reasons.push(`Special permit prerequisite '${flag.name}' is not satisfied.`);
            missingPrerequisites.push(flag);
          }
          break;
        }
      }
    }

    return {
      isEligible: reasons.length === 0,
      reasons,
      missingPrerequisites
    };
  }

  public registerCategory(category: Omit<ServiceCategory, 'createdAt' | 'updatedAt'>): ServiceCategory {
    if (this.categories.has(category.id)) {
      throw new ValidationError(`Category with id '${category.id}' already exists.`);
    }
    for (const cat of this.categories.values()) {
      if (cat.code === category.code) {
        throw new ValidationError(`Category code '${category.code}' is already registered.`);
      }
    }

    const newCategory: ServiceCategory = {
      ...category,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.categories.set(newCategory.id, newCategory);
    logger.info(`New category registered: ${newCategory.displayName} (${newCategory.code})`);
    return { ...newCategory };
  }
}
