import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { german } from './de';
import { spanish } from './es';
import { configureNumberLocale, type NumberFormatPreference } from './number-format';

const localePacks = {
  en: { label: 'English', numberLocale: 'en-US', messages: {} as Record<string, string> },
  de: { label: 'Deutsch', numberLocale: 'de-DE', messages: german },
  es: { label: 'Español', numberLocale: 'es-ES', messages: spanish },
};
export type Language = keyof typeof localePacks;
export const languageOptions = Object.entries(localePacks).map(([code, pack]) => ({ code: code as Language, label: pack.label }));
const englishSources = new Set(Object.keys(german));
// Normalize messages from existing snapshots at the UI boundary. All new copy
// and backend responses use English source strings.
const legacyGermanSources = Object.fromEntries(Object.entries(german).map(([english, germanText]) => [germanText, english]));
type Context = { language: Language; setLanguage: (language: Language) => void; numberFormat: NumberFormatPreference; setNumberFormat: (format: NumberFormatPreference) => void; t: (source: string, values?: Record<string, string | number>) => string };
const LocaleContext = createContext<Context | null>(null);

// Device names are data, not translation keys. Only localize backend placeholders
// when rendering; keep their original values in filters and saved corrections.
export function displayDeviceName(name: string, translate: Context['t']): string {
  if (name === 'Unknown device' || name === 'Unbekanntes Gerät') return translate('Unknown device');
  if (name === 'Unknown manufacturer' || name === 'Unbekannt') return translate('Unknown manufacturer');
  return name;
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => { try { const saved = localStorage.getItem('immich-insights-language'); return saved && saved in localePacks ? saved as Language : 'en'; } catch { return 'en'; } });
  const [numberFormat, setNumberFormat] = useState<NumberFormatPreference>(() => { try { const saved = localStorage.getItem('immich-insights-number-format'); return saved === 'de-DE' || saved === 'en-US' ? saved : 'auto'; } catch { return 'auto'; } });
  configureNumberLocale(localePacks[language].numberLocale, numberFormat);
  useEffect(() => { try { localStorage.setItem('immich-insights-language', language); } catch { /* Local preference is optional. */ } document.documentElement.lang = language; }, [language]);
  useEffect(() => { try { localStorage.setItem('immich-insights-number-format', numberFormat); } catch { /* Local preference is optional. */ } }, [numberFormat]);
  const value = useMemo<Context>(() => ({ language, setLanguage, numberFormat, setNumberFormat, t: (source, values) => {
    const httpError = source.match(/^Immich returned HTTP (\d+)\. Check the URL, API key, and permissions\.$/);
    const permissionError = source.match(/^Immich denied (\S+) \((\w+)\)\.$/);
    const key = httpError ? 'Immich returned HTTP {status}. Check the URL, API key, and permissions.' : permissionError ? 'Immich denied {permission} ({operation}).' : englishSources.has(source) ? source : legacyGermanSources[source] ?? source;
    const template = localePacks[language].messages[key] ?? key;
    const parameters = httpError ? { status: httpError[1] } : permissionError ? { permission: permissionError[1], operation: permissionError[2] } : values;
    return parameters ? template.replace(/\{(\w+)\}/g, (match, key: string) => String((parameters as Record<string, string | number>)[key] ?? match)) : template;
  } }), [language, numberFormat]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Context {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('LocaleProvider is missing');
  return value;
}
