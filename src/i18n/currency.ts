export const BENGALI_DIGITS: readonly string[] = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
export const BDT_SYMBOL = '৳';

/**
 * Converts standard ASCII digits to Bengali numeral glyphs.
 */
export function toBengaliNumerals(value: number | string): string {
  const str = String(value);
  return str.replace(/\d/g, (digit) => BENGALI_DIGITS[parseInt(digit, 10)] ?? digit);
}

/**
 * Converts Bengali numeral glyphs back to standard ASCII digits.
 */
export function toEnglishNumerals(value: string): string {
  let result = value;
  for (let i = 0; i < BENGALI_DIGITS.length; i++) {
    const bnDigit = BENGALI_DIGITS[i];
    if (bnDigit) {
      result = result.split(bnDigit).join(String(i));
    }
  }
  return result;
}

export interface FormatBDTOptions {
  locale?: 'bn' | 'en';
  includeSymbol?: boolean;
  decimalPlaces?: number;
  useGrouping?: boolean;
}

/**
 * Formats a monetary amount in Bangladeshi Taka (BDT) conforming to Subcontinental numbering norms.
 * For standard formatting, group formatting handles standard comma separators.
 */
export function formatBDT(amount: number, options?: FormatBDTOptions): string {
  const locale = options?.locale ?? 'en';
  const includeSymbol = options?.includeSymbol ?? true;
  const decimalPlaces = options?.decimalPlaces ?? 2;
  const useGrouping = options?.useGrouping ?? true;

  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const fixed = safeAmount.toFixed(decimalPlaces);
  const [integerPart, fractionalPart] = fixed.split('.');

  let formattedInteger = integerPart ?? '0';

  if (useGrouping && formattedInteger.length > 3) {
    // Subcontinental Indian/Bangladeshi comma separation format: last 3 digits, then groups of 2 digits (e.g. 1,00,000)
    const lastThree = formattedInteger.slice(-3);
    const remaining = formattedInteger.slice(0, -3);
    const groupedRemaining = remaining.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    formattedInteger = `${groupedRemaining},${lastThree}`;
  }

  let numericOutput = decimalPlaces > 0 && fractionalPart
    ? `${formattedInteger}.${fractionalPart}`
    : formattedInteger;

  if (locale === 'bn') {
    numericOutput = toBengaliNumerals(numericOutput);
  }

  if (includeSymbol) {
    return `${BDT_SYMBOL}${numericOutput}`;
  }
  return numericOutput;
}

/**
 * Convenience price formatting for catalog items.
 */
export function formatPriceCompact(amount: number, locale: 'bn' | 'en' = 'en'): string {
  return formatBDT(amount, {
    locale,
    includeSymbol: true,
    decimalPlaces: Number.isInteger(amount) ? 0 : 2,
    useGrouping: true
  });
}
