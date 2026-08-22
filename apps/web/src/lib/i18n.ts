import { useMemo } from 'react';
import { create } from 'zustand';
import { zh } from '../locales/zh';
import { ja } from '../locales/ja';
import { ru } from '../locales/ru';

/**
 * Translation.
 *
 * The lookup key is the English string itself, not an invented identifier.
 * Two reasons. Call sites stay readable — `t('Revoke')` says what it renders,
 * where `t('apiKeys.revoke')` sends you to a table to find out. And a missing
 * entry degrades to English rather than to a raw key leaking into the UI, so a
 * half-translated locale is merely partly English instead of visibly broken.
 *
 * The cost is that editing an English string orphans its translations. That is
 * the right trade here: the strings are short, and a stale translation is worse
 * than an English one.
 */
export const LOCALES = ['en', 'zh', 'ja', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];

/** Written in the language itself — a list of endonyms needs no translation */
export const LOCALE_LABEL: Record<Locale, string> = {
  en: 'English',
  zh: '中文',
  ja: '日本語',
  ru: 'Русский',
};

/** English is the source, so it needs no table of its own */
const TABLES: Record<Exclude<Locale, 'en'>, Record<string, string>> = { zh, ja, ru };

const KEY = 'agentlodge-locale';

function isLocale(v: string | null): v is Locale {
  return v !== null && (LOCALES as readonly string[]).includes(v);
}

/**
 * First run: follow the browser, then fall back to English.
 *
 * Matched on the primary subtag only — `zh-Hans-CN`, `zh-TW` and `zh` all want
 * the Chinese table, and we do not ship regional variants to tell apart.
 */
function detect(): Locale {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLocale(base ?? null)) return base as Locale;
  }
  return 'en';
}

export function getLocale(): Locale {
  const stored = localStorage.getItem(KEY);
  return isLocale(stored) ? stored : detect();
}

interface I18nState {
  locale: Locale;
  setLocale: (l: Locale) => void;
}

export const useI18n = create<I18nState>((set) => ({
  locale: getLocale(),
  setLocale(locale) {
    localStorage.setItem(KEY, locale);
    // Screen readers and `:lang()` rules both read this; keep it in step
    document.documentElement.lang = locale;
    set({ locale });
  },
}));

/** Interpolates `{name}` placeholders. Unknown names are left alone, not blanked */
function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export function translate(locale: Locale, source: string, vars?: Record<string, string | number>): string {
  const table = locale === 'en' ? undefined : TABLES[locale];
  return fill(table?.[source] ?? source, vars);
}

/**
 * The translator for the current locale.
 *
 * A hook rather than a bare function so that switching language re-renders the
 * components that use it — reading the store outside React would change the
 * value without telling anyone.
 */
export function useT(): (source: string, vars?: Record<string, string | number>) => string {
  const locale = useI18n((s) => s.locale);
  return useMemo(() => (source, vars) => translate(locale, source, vars), [locale]);
}

/** For the rare caller outside a component (formatters, one-off handlers) */
export function t(source: string, vars?: Record<string, string | number>): string {
  return translate(useI18n.getState().locale, source, vars);
}

/** Locale tag for Intl APIs — dates and numbers should follow the UI language */
export function intlLocale(locale: Locale = useI18n.getState().locale): string {
  return { en: 'en-US', zh: 'zh-CN', ja: 'ja-JP', ru: 'ru-RU' }[locale];
}
