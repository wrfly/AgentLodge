import { useMemo } from 'react';
import { create } from 'zustand';
import { zh } from '../locales/zh';
import { zhHant } from '../locales/zh-Hant';
import { ja } from '../locales/ja';
import { ru } from '../locales/ru';
import { de } from '../locales/de';
import { fr } from '../locales/fr';
import { es } from '../locales/es';
import { pt } from '../locales/pt';

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
export const LOCALES = ['en', 'zh', 'zh-Hant', 'ja', 'ru', 'de', 'fr', 'es', 'pt'] as const;
export type Locale = (typeof LOCALES)[number];

/** Written in the language itself — a list of endonyms needs no translation */
export const LOCALE_LABEL: Record<Locale, string> = {
  en: 'English',
  zh: '简体中文',
  'zh-Hant': '繁體中文',
  ja: '日本語',
  ru: 'Русский',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
};

/** English is the source, so it needs no table of its own */
const TABLES: Record<Exclude<Locale, 'en'>, Record<string, string>> = {
  zh,
  'zh-Hant': zhHant,
  ja,
  ru,
  de,
  fr,
  es,
  pt,
};

const KEY = 'agentlodge-locale';

function isLocale(v: string | null): v is Locale {
  return v !== null && (LOCALES as readonly string[]).includes(v);
}

/**
 * First run: follow the browser, then fall back to English.
 *
 * Matched on the primary subtag, with one exception. Chinese is the only pair
 * here where the script matters more than the region — `zh-TW`, `zh-HK` and
 * anything marked `Hant` want the traditional table, and everything else
 * Chinese wants the simplified one. `pt-BR` and `pt-PT` differ too, but not
 * enough to carry two tables for.
 */
export function localeOf(tag: string): Locale | null {
  const lower = tag.toLowerCase();
  if (lower.startsWith('zh')) return /hant|_tw|-tw|-hk|-mo/.test(lower) ? 'zh-Hant' : 'zh';
  const base = lower.split('-')[0] ?? '';
  return isLocale(base) ? base : null;
}

function detect(): Locale {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const hit = localeOf(tag);
    if (hit) return hit;
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
  const REGION: Record<Locale, string> = {
    en: 'en-US',
    zh: 'zh-CN',
    'zh-Hant': 'zh-TW',
    ja: 'ja-JP',
    ru: 'ru-RU',
    de: 'de-DE',
    fr: 'fr-FR',
    es: 'es-ES',
    pt: 'pt-PT',
  };
  return REGION[locale];
}
