import { describe, it, expect, beforeEach } from 'vitest';
import { I18nManager, i18n } from '../src/i18n/i18n';
import { enDictionary } from '../src/i18n/dictionaries/en';
import { bnDictionary } from '../src/i18n/dictionaries/bn';
import { formatBDT, toBengaliNumerals, toEnglishNumerals, formatPriceCompact } from '../src/i18n/currency';
import { getBrandingConfig, updateBrandingConfig, resetBrandingConfig, DEFAULT_BRANDING_CONFIG } from '../src/branding/config';

describe('Localization and i18n Tests', () => {
  beforeEach(() => {
    i18n.setLocale('bn');
  });

  it('should maintain 100% dictionary key parity between English and Bengali', () => {
    const enNamespaces = Object.keys(enDictionary) as (keyof typeof enDictionary)[];
    const bnNamespaces = Object.keys(bnDictionary) as (keyof typeof bnDictionary)[];

    expect(bnNamespaces.sort()).toEqual(enNamespaces.sort());

    for (const ns of enNamespaces) {
      const enKeys = Object.keys(enDictionary[ns]).sort();
      const bnKeys = Object.keys(bnDictionary[ns]).sort();
      expect(bnKeys).toEqual(enKeys);

      // Verify no empty string values
      for (const key of enKeys) {
        const enVal = (enDictionary[ns] as unknown as Record<string, string>)[key];
        const bnVal = (bnDictionary[ns] as unknown as Record<string, string>)[key];
        expect(enVal?.length).toBeGreaterThan(0);
        expect(bnVal?.length).toBeGreaterThan(0);
      }
    }
  });

  it('should switch between Bengali and English dynamically', () => {
    const manager = new I18nManager('bn');
    expect(manager.getLocale()).toBe('bn');
    expect(manager.t('catalog.addToCart')).toBe('কার্টে যোগ করুন');

    manager.setLocale('en');
    expect(manager.getLocale()).toBe('en');
    expect(manager.t('catalog.addToCart')).toBe('Add to Cart');
  });

  it('should interpolate parameters correctly in both languages', () => {
    const manager = new I18nManager('en');
    expect(manager.t('catalog.estimatedDeliveryTime', { min: 25, max: 40 })).toBe('25-40 mins');
    expect(manager.t('checkout.minimumOrderNotice', { minAmount: '300' })).toBe('Minimum order requirement is ৳300');

    manager.setLocale('bn');
    expect(manager.t('catalog.estimatedDeliveryTime', { min: '২৫', max: '৪০' })).toBe('২৫-৪০ মিনিট');
    expect(manager.t('orderTracking.orderId', { id: 'CB-9988' })).toBe('অর্ডার নং #CB-9988');
  });

  it('should fallback gracefully on missing key paths', () => {
    const manager = new I18nManager('en');
    expect(manager.t('unknown.invalidKey')).toBe('unknown.invalidKey');
    expect(manager.t('singleWordKey')).toBe('singleWordKey');
  });

  it('should produce lightweight minimal payload bundles for low-bandwidth mobile clients', () => {
    const manager = new I18nManager('bn');
    const bundle = manager.getMinimalPayloadBundle('bn', ['checkout', 'common']);
    
    expect(bundle.checkout).toBeDefined();
    expect(bundle.common).toBeDefined();
    expect(bundle.catalog).toBeUndefined();
    expect(bundle.checkout?.placeOrder).toBe('অর্ডার নিশ্চিত করুন');
  });
});

describe('BDT Currency and Numerals', () => {
  it('should convert between English and Bengali numeral glyphs', () => {
    expect(toBengaliNumerals(123450)).toBe('১২৩৪৫০');
    expect(toBengaliNumerals('৳550.00')).toBe('৳৫৫০.০০');
    expect(toEnglishNumerals('১২৩৪৫০')).toBe('123450');
    expect(toEnglishNumerals('৳৫৫০.৫০')).toBe('৳550.50');
  });

  it('should format BDT prices according to Subcontinental formatting rules', () => {
    // Standard English grouping: 1,00,000
    expect(formatBDT(100000, { locale: 'en' })).toBe('৳1,00,000.00');
    expect(formatBDT(1500, { locale: 'en', decimalPlaces: 0 })).toBe('৳1,500');
    expect(formatBDT(75.5, { locale: 'en', includeSymbol: false })).toBe('75.50');

    // Bengali formatting with ৳ and Bengali digits
    expect(formatBDT(100000, { locale: 'bn' })).toBe('৳১,০০,০০০.০০');
    expect(formatBDT(250, { locale: 'bn', decimalPlaces: 0 })).toBe('৳২৫০');
  });

  it('should handle formatPriceCompact correctly', () => {
    expect(formatPriceCompact(500, 'en')).toBe('৳500');
    expect(formatPriceCompact(500.75, 'en')).toBe('৳500.75');
    expect(formatPriceCompact(500, 'bn')).toBe('৳৫০০');
    expect(formatPriceCompact(1250.5, 'bn')).toBe('৳১,২৫০.৫০');
  });
});

describe('Branding Configuration Tests', () => {
  beforeEach(() => {
    resetBrandingConfig();
  });

  it('should have default brand metadata set to Cox\'s Bazar Door2Door', () => {
    const config = getBrandingConfig();
    expect(config.metadata.brandName).toBe("Cox's Bazar Door2Door");
    expect(config.metadata.shortName).toBe('CBD2D');
    expect(config.metadata.currency).toBe('BDT');
    expect(config.metadata.currencySymbol).toBe('৳');
    expect(config.typography.bengaliFontFamily).toContain('Hind Siliguri');
    expect(config.typography.englishFontFamily).toContain('Inter');
  });

  it('should allow runtime brand overrides without mutating original base defaults', () => {
    const customized = updateBrandingConfig({
      metadata: {
        ...DEFAULT_BRANDING_CONFIG.metadata,
        brandName: 'Inani Beach Express'
      }
    });

    expect(customized.metadata.brandName).toBe('Inani Beach Express');
    expect(getBrandingConfig().metadata.brandName).toBe('Inani Beach Express');

    resetBrandingConfig();
    expect(getBrandingConfig().metadata.brandName).toBe("Cox's Bazar Door2Door");
  });
});
