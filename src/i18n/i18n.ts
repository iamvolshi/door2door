import { SupportedLocale, TranslationDictionary, TranslationNamespace } from './types';
import { enDictionary } from './dictionaries/en';
import { bnDictionary } from './dictionaries/bn';

export class I18nManager {
  private currentLocale: SupportedLocale = 'bn';
  private dictionaries: Record<SupportedLocale, TranslationDictionary> = {
    bn: bnDictionary,
    en: enDictionary
  };

  constructor(initialLocale: SupportedLocale = 'bn') {
    this.currentLocale = initialLocale;
  }

  /**
   * Get the active language code.
   */
  public getLocale(): SupportedLocale {
    return this.currentLocale;
  }

  /**
   * Switch current active locale.
   */
  public setLocale(locale: SupportedLocale): void {
    if (locale === 'bn' || locale === 'en') {
      this.currentLocale = locale;
    }
  }

  /**
   * Retrieve full dictionary for a specific locale.
   */
  public getDictionary(locale: SupportedLocale = this.currentLocale): TranslationDictionary {
    return this.dictionaries[locale] ?? this.dictionaries.en;
  }

  /**
   * Translates a key path (e.g. 'checkout.placeOrder' or 'common.appName') with optional parameter substitution.
   */
  public t(keyPath: string, params?: Record<string, string | number>): string {
    const parts = keyPath.split('.');
    if (parts.length < 2) {
      return keyPath;
    }

    const namespace = parts[0] as TranslationNamespace;
    const key = parts[1] as string;

    const activeDict = this.dictionaries[this.currentLocale] ?? this.dictionaries.en;
    const nsDict = (activeDict as unknown as Record<string, Record<string, string>>)[namespace];
    
    let template: string | undefined = nsDict ? nsDict[key] : undefined;

    // Fallback to English dictionary if key not found
    if (template === undefined) {
      const fallbackNs = (this.dictionaries.en as unknown as Record<string, Record<string, string>>)[namespace];
      template = fallbackNs ? fallbackNs[key] : undefined;
    }

    if (template === undefined) {
      return keyPath;
    }

    if (params) {
      let resolved = template;
      for (const [paramKey, val] of Object.entries(params)) {
        const regex = new RegExp(`{{\\s*${paramKey}\\s*}}`, 'g');
        resolved = resolved.replace(regex, String(val));
      }
      return resolved;
    }

    return template;
  }

  /**
   * Returns a lightweight, tree-shaken payload bundle for low-bandwidth mobile clients.
   */
  public getMinimalPayloadBundle(locale: SupportedLocale, namespaces: TranslationNamespace[]): Partial<TranslationDictionary> {
    const dict = this.getDictionary(locale);
    const bundle: Partial<TranslationDictionary> = {};
    for (const ns of namespaces) {
      if (dict[ns]) {
        (bundle as unknown as Record<string, unknown>)[ns] = dict[ns];
      }
    }
    return bundle;
  }
}

export const i18n = new I18nManager('bn');
