export type NumberFormatPreference = 'auto' | 'en-US' | 'de-DE';

let activeLocale = 'en-US';

export function configureNumberLocale(languageLocale: string, preference: NumberFormatPreference): void {
  activeLocale = preference === 'auto' ? languageLocale : preference;
}

export function numberLocale(): string {
  return activeLocale;
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(activeLocale, options);
}
