export interface BrandColorPalette {
  primary: string;
  primaryDark: string;
  primaryLight: string;
  accent: string;
  background: string;
  surface: string;
  textPrimary: string;
  textSecondary: string;
  border: string;
  success: string;
  warning: string;
  error: string;
}

export interface BrandTypography {
  englishFontFamily: string;
  bengaliFontFamily: string;
  fontSizeBase: string;
  fontSizeHeading: string;
  fontSizeSmall: string;
}

export interface BrandMetadata {
  brandName: string;
  shortName: string;
  taglineEn: string;
  taglineBn: string;
  logoUrl: string;
  faviconUrl: string;
  supportPhone: string;
  supportEmail: string;
  serviceRegion: string;
  beachDeskLocation: string;
  operatingHours: string;
  currency: string;
  currencySymbol: string;
}

export interface BrandingConfig {
  metadata: BrandMetadata;
  colors: BrandColorPalette;
  typography: BrandTypography;
}

export const DEFAULT_BRANDING_CONFIG: BrandingConfig = {
  metadata: {
    brandName: "Cox's Bazar Door2Door",
    shortName: 'CBD2D',
    taglineEn: 'Fast, reliable beachside delivery at your doorstep',
    taglineBn: 'সমুদ্রতীরের দ্রুত এবং নির্ভরযোগ্য ডেলিভারি সেবা',
    logoUrl: '/assets/branding/cbd2d-logo.svg',
    faviconUrl: '/assets/branding/favicon.ico',
    supportPhone: '+8801800000000',
    supportEmail: 'support@coxsbazardoor2door.com',
    serviceRegion: "Cox's Bazar Municipal & Beach Belt, Bangladesh",
    beachDeskLocation: 'Hotel Motel Zone, Kolatoli Main Road, Cox\'s Bazar',
    operatingHours: '07:00 AM - 11:30 PM BST',
    currency: 'BDT',
    currencySymbol: '৳'
  },
  colors: {
    primary: '#0D9488', // Teal representing the Bay of Bengal
    primaryDark: '#0F766E',
    primaryLight: '#CCFBF1',
    accent: '#F59E0B', // Golden sand
    background: '#F8FAFC',
    surface: '#FFFFFF',
    textPrimary: '#0F172A',
    textSecondary: '#64748B',
    border: '#E2E8F0',
    success: '#10B981',
    warning: '#F59E0B',
    error: '#EF4444'
  },
  typography: {
    englishFontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    bengaliFontFamily: '"Hind Siliguri", "SolaimanLipi", "Noto Sans Bengali", sans-serif',
    fontSizeBase: '15px',
    fontSizeHeading: '22px',
    fontSizeSmall: '12px'
  }
};

let activeBranding: BrandingConfig = { ...DEFAULT_BRANDING_CONFIG };

/**
 * Retrieves the active branding configuration.
 */
export function getBrandingConfig(): BrandingConfig {
  return JSON.parse(JSON.stringify(activeBranding));
}

/**
 * Allows dynamic white-labeling or brand customization.
 */
export function updateBrandingConfig(override: Partial<BrandingConfig>): BrandingConfig {
  activeBranding = {
    ...activeBranding,
    ...override,
    metadata: {
      ...activeBranding.metadata,
      ...(override.metadata ?? {})
    },
    colors: {
      ...activeBranding.colors,
      ...(override.colors ?? {})
    },
    typography: {
      ...activeBranding.typography,
      ...(override.typography ?? {})
    }
  };
  return getBrandingConfig();
}

/**
 * Resets branding config to default.
 */
export function resetBrandingConfig(): void {
  activeBranding = { ...DEFAULT_BRANDING_CONFIG };
}
