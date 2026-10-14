import {
  AreaStatus,
  AreaZoneCode,
  DeliveryRestriction,
  GeoCoordinates,
  LocationQuery,
  ServiceArea,
  AreaAvailabilityCheckResult
} from './areaTypes';
import { NotFoundError, ValidationError } from '../../core/errors';
import { logger } from '../../core/logger';

export const DEFAULT_COXS_BAZAR_AREAS: Omit<ServiceArea, 'createdAt' | 'updatedAt'>[] = [
  {
    id: 'area-cxb-sadar',
    code: AreaZoneCode.CXB_SADAR,
    name: "Cox's Bazar Sadar",
    bengaliName: 'কক্সবাজার সদর',
    district: "Cox's Bazar",
    division: 'Chattogram',
    status: 'ACTIVE',
    postalCodes: ['4700', '4701', '4702'],
    subDistricts: ['Kolatoli', 'Sugandha', 'Laboni', 'Jhawtola', 'Laldighir Par', 'Baharchara'],
    centerCoordinates: { latitude: 21.4272, longitude: 92.0058 },
    boundingBox: {
      minLat: 21.3800,
      maxLat: 21.4800,
      minLng: 91.9500,
      maxLng: 92.0500
    },
    isIslandOrRemote: false,
    restrictions: [],
    specialNotes: 'Main tourist zone and commercial core district with standard coverage.',
    baseDeliveryFeeMultiplier: 1.0,
    estimatedDeliveryWindowMinutes: { min: 25, max: 45 }
  },
  {
    id: 'area-ramu',
    code: AreaZoneCode.RAMU,
    name: 'Ramu',
    bengaliName: 'রামু',
    district: "Cox's Bazar",
    division: 'Chattogram',
    status: 'ACTIVE',
    postalCodes: ['4730'],
    subDistricts: ['Ramu Sadar', 'Fatekharkul', 'Kauwarkhop', 'Chakmarkul'],
    centerCoordinates: { latitude: 21.4422, longitude: 92.1008 },
    boundingBox: {
      minLat: 21.3500,
      maxLat: 21.5200,
      minLng: 92.0500,
      maxLng: 92.1800
    },
    isIslandOrRemote: false,
    restrictions: [],
    specialNotes: 'Heritage craft and monastery corridor with regular courier support.',
    baseDeliveryFeeMultiplier: 1.15,
    estimatedDeliveryWindowMinutes: { min: 40, max: 65 }
  },
  {
    id: 'area-chakaria',
    code: AreaZoneCode.CHAKARIA,
    name: 'Chakaria',
    bengaliName: 'চকোরিয়া',
    district: "Cox's Bazar",
    division: 'Chattogram',
    status: 'ACTIVE',
    postalCodes: ['4740', '4741'],
    subDistricts: ['Chakaria Sadar', 'Dulahazara', 'Harbang', 'Badarkhali', 'Khuta Khali'],
    centerCoordinates: { latitude: 21.7867, longitude: 92.0778 },
    boundingBox: {
      minLat: 21.6500,
      maxLat: 21.9000,
      minLng: 91.9500,
      maxLng: 92.2000
    },
    isIslandOrRemote: false,
    restrictions: [],
    specialNotes: 'Highway transit hub; includes Dulahazara safari park zone.',
    baseDeliveryFeeMultiplier: 1.2,
    estimatedDeliveryWindowMinutes: { min: 45, max: 75 }
  },
  {
    id: 'area-eidgaon',
    code: AreaZoneCode.EIDGAON,
    name: 'Eidgaon',
    bengaliName: 'ঈদগাঁও',
    district: "Cox's Bazar",
    division: 'Chattogram',
    status: 'ACTIVE',
    postalCodes: ['4702', '4703'],
    subDistricts: ['Eidgaon Bazar', 'Islamabad', 'Jalalabad', 'Pokhali', 'Vashantek'],
    centerCoordinates: { latitude: 21.5721, longitude: 92.0538 },
    boundingBox: {
      minLat: 21.5000,
      maxLat: 21.6400,
      minLng: 91.9800,
      maxLng: 92.1200
    },
    isIslandOrRemote: false,
    restrictions: [],
    specialNotes: 'Upgraded sub-district trade corridor.',
    baseDeliveryFeeMultiplier: 1.1,
    estimatedDeliveryWindowMinutes: { min: 35, max: 55 }
  },
  {
    id: 'area-ukhiya',
    code: AreaZoneCode.UKHIYA,
    name: 'Ukhiya',
    bengaliName: 'উখিয়া',
    district: "Cox's Bazar",
    division: 'Chattogram',
    status: 'ACTIVE',
    postalCodes: ['4750'],
    subDistricts: ['Ukhiya Sadar', 'Inani', 'Court Bazar', 'Jaliapalong', 'Palongkhali', 'Balukhali'],
    centerCoordinates: { latitude: 21.2858, longitude: 92.1436 },
    boundingBox: {
      minLat: 21.1500,
      maxLat: 21.3800,
      minLng: 92.0200,
      maxLng: 92.2200
    },
    isIslandOrRemote: false,
    restrictions: [
      {
        id: 'restr-ukhiya-security',
        code: 'SECURITY_CHECKPOINT',
        description: 'Vehicular transit passes and security check gates active along highway checkpoints.',
        isSeasonal: false
      }
    ],
    specialNotes: 'Marine drive coastal hotels and relief corridor logistics.',
    baseDeliveryFeeMultiplier: 1.3,
    estimatedDeliveryWindowMinutes: { min: 50, max: 80 }
  },
  {
    id: 'area-teknaf',
    code: AreaZoneCode.TEKNAF,
    name: 'Teknaf',
    bengaliName: 'টেকনাফ',
    district: "Cox's Bazar",
    division: 'Chattogram',
    status: 'ACTIVE',
    postalCodes: ['4760', '4761'],
    subDistricts: ['Teknaf Sadar', 'Shah Porir Dwip', 'Sabrang', 'Baharchhara', 'Whykong', 'Hnila'],
    centerCoordinates: { latitude: 20.8647, longitude: 92.2981 },
    boundingBox: {
      minLat: 20.7000,
      maxLat: 21.1500,
      minLng: 92.1500,
      maxLng: 92.3500
    },
    isIslandOrRemote: false,
    restrictions: [
      {
        id: 'restr-teknaf-border',
        code: 'BORDER_SECURITY_HOURS',
        description: 'Deliveries restricted after 18:00 due to border surveillance protocol.',
        isSeasonal: false,
        curfewActive: true,
        customMessage: 'Night deliveries to border zones are paused.'
      }
    ],
    specialNotes: 'Southernmost border town along Naf River.',
    baseDeliveryFeeMultiplier: 1.45,
    estimatedDeliveryWindowMinutes: { min: 60, max: 100 }
  },
  {
    id: 'area-pekua',
    code: AreaZoneCode.PEKUA,
    name: 'Pekua',
    bengaliName: 'পেকুয়া',
    district: "Cox's Bazar",
    division: 'Chattogram',
    status: 'ACTIVE',
    postalCodes: ['4742'],
    subDistricts: ['Pekua Sadar', 'Barabakia', 'Magnama', 'Ujantia', 'Shilkhali', 'Tetoong'],
    centerCoordinates: { latitude: 21.8028, longitude: 91.9542 },
    boundingBox: {
      minLat: 21.7000,
      maxLat: 21.9000,
      minLng: 91.8800,
      maxLng: 92.0400
    },
    isIslandOrRemote: false,
    restrictions: [],
    specialNotes: 'Coastal agricultural and aquaculture trade zone.',
    baseDeliveryFeeMultiplier: 1.25,
    estimatedDeliveryWindowMinutes: { min: 50, max: 80 }
  },
  {
    id: 'area-maheshkhali',
    code: AreaZoneCode.MAHESHKHALI,
    name: 'Maheshkhali',
    bengaliName: 'মহেশখালী',
    district: "Cox's Bazar",
    division: 'Chattogram',
    status: 'ACTIVE',
    postalCodes: ['4710', '4711'],
    subDistricts: ['Gorakghata', 'Chhota Moheshkhali', 'Matarbari', 'Dhalghata', 'Kalarmarchhara', 'Hoanak'],
    centerCoordinates: { latitude: 21.5542, longitude: 91.9514 },
    boundingBox: {
      minLat: 21.4500,
      maxLat: 21.7200,
      minLng: 91.8600,
      maxLng: 92.0100
    },
    isIslandOrRemote: true,
    restrictions: [
      {
        id: 'restr-mhk-channel',
        code: 'CHANNEL_WATERWAY_DEPENDENT',
        description: 'Tidal waterway or jetty channel dependency for freight logistics.',
        isSeasonal: false,
        seaCrossingRequired: true
      }
    ],
    specialNotes: 'Deep sea port & island zone; speed boat / bridge corridor.',
    baseDeliveryFeeMultiplier: 1.5,
    estimatedDeliveryWindowMinutes: { min: 70, max: 120 }
  },
  {
    id: 'area-kutubdia',
    code: AreaZoneCode.KUTUBDIA,
    name: 'Kutubdia',
    bengaliName: 'কুতুবদিয়া',
    district: "Cox's Bazar",
    division: 'Chattogram',
    status: 'ACTIVE',
    postalCodes: ['4720'],
    subDistricts: ['Boroghop', 'Ali Akbar Deil', 'Dakshin Dhurung', 'Uttar Dhurung', 'Kaiyarbil', 'Lemsikhali'],
    centerCoordinates: { latitude: 21.8167, longitude: 91.8583 },
    boundingBox: {
      minLat: 21.7200,
      maxLat: 21.9200,
      minLng: 91.8000,
      maxLng: 91.9200
    },
    isIslandOrRemote: true,
    restrictions: [
      {
        id: 'restr-kut-ferry',
        code: 'ISLAND_TRAWLER_TRANSIT',
        description: 'Dependent on sea trawler and weather conditions.',
        isSeasonal: true,
        weatherDependent: true,
        seaCrossingRequired: true
      }
    ],
    specialNotes: 'Offshore wind farm & island lighthouse territory.',
    baseDeliveryFeeMultiplier: 1.75,
    estimatedDeliveryWindowMinutes: { min: 90, max: 150 }
  },
  {
    id: 'area-saint-martins',
    code: AreaZoneCode.SAINT_MARTINS,
    name: "Saint Martin's Island",
    bengaliName: 'সেন্ট মার্টিন দ্বীপ',
    district: "Cox's Bazar",
    division: 'Chattogram',
    status: 'RESTRICTED',
    postalCodes: ['4762'],
    subDistricts: ['Uttar Para', 'Dakshin Para', 'Madhya Para', 'Deil Para', 'Chhera Dwip'],
    centerCoordinates: { latitude: 20.6272, longitude: 92.3225 },
    boundingBox: {
      minLat: 20.5900,
      maxLat: 20.6500,
      minLng: 92.3000,
      maxLng: 92.3500
    },
    isIslandOrRemote: true,
    restrictions: [
      {
        id: 'restr-stm-ecological',
        code: 'ECO_TOURISM_REGULATION',
        description: 'Strict ecological conservation protocol and daily cargo tonnage limitations.',
        isSeasonal: true,
        weatherDependent: true,
        seaCrossingRequired: true,
        restrictedCategories: ['heavy_industrial', 'non_biodegradable_packaging'],
        customMessage: 'Service available exclusively via scheduled maritime courier during authorized sea-voyage windows.'
      },
      {
        id: 'restr-stm-monsoon',
        code: 'MONSOON_MARITIME_SHUTDOWN',
        description: 'No maritime cargo transit permissible during monsoon signals (June-September).',
        isSeasonal: true,
        weatherDependent: true,
        seaCrossingRequired: true
      }
    ],
    specialNotes: 'Coral island special zone requiring scheduled sea vessel coordination.',
    baseDeliveryFeeMultiplier: 2.5,
    estimatedDeliveryWindowMinutes: { min: 180, max: 360 }
  }
];

export class ServiceAreaManager {
  private areas: Map<string, ServiceArea> = new Map();

  constructor(seedOnInit: boolean = true) {
    if (seedOnInit) {
      this.seedDefaultAreas();
    }
  }

  public seedDefaultAreas(): void {
    const now = new Date();
    for (const rawArea of DEFAULT_COXS_BAZAR_AREAS) {
      this.areas.set(rawArea.id, {
        ...rawArea,
        createdAt: now,
        updatedAt: now
      });
    }
    logger.info('ServiceAreaManager: Seeded Cox\'s Bazar sub-districts', {
      totalAreas: this.areas.size
    });
  }

  public getAllAreas(): ServiceArea[] {
    return Array.from(this.areas.values());
  }

  public getActiveAreas(): ServiceArea[] {
    return Array.from(this.areas.values()).filter((a) => a.status === 'ACTIVE');
  }

  public getInactiveAreas(): ServiceArea[] {
    return Array.from(this.areas.values()).filter((a) => a.status === 'INACTIVE');
  }

  public getRestrictedAreas(): ServiceArea[] {
    return Array.from(this.areas.values()).filter((a) => a.status === 'RESTRICTED');
  }

  public getAreaById(id: string): ServiceArea {
    const area = this.areas.get(id);
    if (!area) {
      throw new NotFoundError(`Service area with ID '${id}' not found`);
    }
    return area;
  }

  public getAreaByCode(code: AreaZoneCode | string): ServiceArea {
    const area = Array.from(this.areas.values()).find(
      (a) => a.code.toLowerCase() === code.toLowerCase()
    );
    if (!area) {
      throw new NotFoundError(`Service area with code '${code}' not found`);
    }
    return area;
  }

  public setAreaStatus(id: string, status: AreaStatus, reasonNotes?: string): ServiceArea {
    const area = this.getAreaById(id);
    area.status = status;
    if (reasonNotes) {
      area.specialNotes = area.specialNotes
        ? `${area.specialNotes} | Status change (${status}): ${reasonNotes}`
        : `Status change (${status}): ${reasonNotes}`;
    }
    area.updatedAt = new Date();
    this.areas.set(id, area);
    logger.info(`Service area '${area.name}' status updated to ${status}`, {
      areaId: id,
      status
    });
    return area;
  }

  public activateArea(id: string): ServiceArea {
    return this.setAreaStatus(id, 'ACTIVE');
  }

  public deactivateArea(id: string, reason?: string): ServiceArea {
    return this.setAreaStatus(id, 'INACTIVE', reason);
  }

  public restrictArea(id: string, reason?: string): ServiceArea {
    return this.setAreaStatus(id, 'RESTRICTED', reason);
  }

  public addRestriction(areaId: string, restriction: Omit<DeliveryRestriction, 'id'>): ServiceArea {
    const area = this.getAreaById(areaId);
    const id = `restr-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    const newRestriction: DeliveryRestriction = { id, ...restriction };
    area.restrictions.push(newRestriction);
    area.updatedAt = new Date();
    this.areas.set(areaId, area);
    return area;
  }

  public removeRestriction(areaId: string, restrictionId: string): ServiceArea {
    const area = this.getAreaById(areaId);
    area.restrictions = area.restrictions.filter((r) => r.id !== restrictionId);
    area.updatedAt = new Date();
    this.areas.set(areaId, area);
    return area;
  }

  public updateSpecialNotes(areaId: string, notes: string): ServiceArea {
    const area = this.getAreaById(areaId);
    area.specialNotes = notes;
    area.updatedAt = new Date();
    this.areas.set(areaId, area);
    return area;
  }

  public updateBaseFeeMultiplier(areaId: string, multiplier: number): ServiceArea {
    if (multiplier < 0.5 || multiplier > 10.0) {
      throw new ValidationError('Delivery fee multiplier must be between 0.5 and 10.0');
    }
    const area = this.getAreaById(areaId);
    area.baseDeliveryFeeMultiplier = multiplier;
    area.updatedAt = new Date();
    this.areas.set(areaId, area);
    return area;
  }

  public findAreaByLocation(query: LocationQuery): ServiceArea | null {
    if (query.areaId) {
      return this.areas.get(query.areaId) || null;
    }

    if (query.code) {
      const found = Array.from(this.areas.values()).find(
        (a) => a.code.toLowerCase() === query.code!.toLowerCase()
      );
      if (found) return found;
    }

    if (query.postalCode) {
      const found = Array.from(this.areas.values()).find((a) =>
        a.postalCodes.includes(query.postalCode!.trim())
      );
      if (found) return found;
    }

    if (query.subDistrictName) {
      const normalized = query.subDistrictName.trim().toLowerCase();
      const found = Array.from(this.areas.values()).find((a) => {
        if (a.name.toLowerCase() === normalized || a.bengaliName === query.subDistrictName) {
          return true;
        }
        return a.subDistricts.some(
          (sub) => sub.toLowerCase().includes(normalized) || normalized.includes(sub.toLowerCase())
        );
      });
      if (found) return found;
    }

    if (query.coordinates) {
      const { latitude, longitude } = query.coordinates;
      for (const area of this.areas.values()) {
        if (area.boundingBox) {
          const { minLat, maxLat, minLng, maxLng } = area.boundingBox;
          if (
            latitude >= minLat &&
            latitude <= maxLat &&
            longitude >= minLng &&
            longitude <= maxLng
          )
            return area;
        }
      }
      // Closest fallback if within 25km radius
      let closestArea: ServiceArea | null = null;
      let minDistance = Number.MAX_VALUE;
      for (const area of this.areas.values()) {
        const dist = this.calculateDistanceKm(query.coordinates, area.centerCoordinates);
        if (dist < minDistance && dist <= 25) {
          minDistance = dist;
          closestArea = area;
        }
      }
      return closestArea;
    }

    return null;
  }

  public verifyDeliveryAvailability(query: LocationQuery): AreaAvailabilityCheckResult {
    const area = this.findAreaByLocation(query);
    if (!area) {
      return {
        isDeliverable: false,
        status: 'INACTIVE',
        reasons: ['Location is outside the registered Cox\'s Bazar coverage zones.'],
        applicableRestrictions: [],
        feeMultiplier: 1.0
      };
    }

    if (area.status === 'INACTIVE') {
      return {
        isDeliverable: false,
        status: 'INACTIVE',
        area,
        reasons: [`Service in ${area.name} is currently suspended.`],
        applicableRestrictions: area.restrictions,
        feeMultiplier: area.baseDeliveryFeeMultiplier
      };
    }

    const reasons: string[] = [];
    if (area.status === 'RESTRICTED') {
      reasons.push(`Service in ${area.name} operates with special maritime/regulatory restrictions.`);
      for (const r of area.restrictions) {
        reasons.push(`${r.code}: ${r.description}`);
      }
    }

    return {
      isDeliverable: true,
      status: area.status,
      area,
      reasons,
      applicableRestrictions: area.restrictions,
      estimatedDeliveryWindow: area.estimatedDeliveryWindowMinutes,
      feeMultiplier: area.baseDeliveryFeeMultiplier
    };
  }

  private calculateDistanceKm(c1: GeoCoordinates, c2: GeoCoordinates): number {
    const R = 6371; // Earth radius in km
    const dLat = this.deg2rad(c2.latitude - c1.latitude);
    const dLng = this.deg2rad(c2.longitude - c1.longitude);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.deg2rad(c1.latitude)) *
        Math.cos(this.deg2rad(c2.latitude)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private deg2rad(deg: number): number {
    return deg * (Math.PI / 180);
  }
}

export const serviceAreaManager = new ServiceAreaManager();
