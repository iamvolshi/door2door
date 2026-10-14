export type AreaStatus = 'ACTIVE' | 'INACTIVE' | 'RESTRICTED';

export enum AreaZoneCode {
  CXB_SADAR = 'CXB_SADAR',
  RAMU = 'RAMU',
  CHAKARIA = 'CHAKARIA',
  EIDGAON = 'EIDGAON',
  UKHIYA = 'UKHIYA',
  TEKNAF = 'TEKNAF',
  PEKUA = 'PEKUA',
  MAHESHKHALI = 'MAHESHKHALI',
  KUTUBDIA = 'KUTUBDIA',
  SAINT_MARTINS = 'SAINT_MARTINS'
}

export interface GeoCoordinates {
  latitude: number;
  longitude: number;
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface DeliveryRestriction {
  id: string;
  code: string;
  description: string;
  isSeasonal: boolean;
  curfewActive?: boolean;
  weatherDependent?: boolean;
  seaCrossingRequired?: boolean;
  restrictedCategories?: string[];
  customMessage?: string;
}

export interface ServiceArea {
  id: string;
  code: AreaZoneCode | string;
  name: string;
  bengaliName: string;
  district: 'Cox\'s Bazar';
  division: 'Chattogram';
  status: AreaStatus;
  postalCodes: string[];
  subDistricts: string[];
  centerCoordinates: GeoCoordinates;
  boundingBox?: BoundingBox;
  isIslandOrRemote: boolean;
  restrictions: DeliveryRestriction[];
  specialNotes?: string;
  baseDeliveryFeeMultiplier: number;
  estimatedDeliveryWindowMinutes: {
    min: number;
    max: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface AreaAvailabilityCheckResult {
  isDeliverable: boolean;
  status: AreaStatus;
  area?: ServiceArea;
  reasons: string[];
  applicableRestrictions: DeliveryRestriction[];
  estimatedDeliveryWindow?: {
    min: number;
    max: number;
  };
  feeMultiplier: number;
}

export interface LocationQuery {
  areaId?: string;
  code?: AreaZoneCode | string;
  subDistrictName?: string;
  postalCode?: string;
  coordinates?: GeoCoordinates;
}
