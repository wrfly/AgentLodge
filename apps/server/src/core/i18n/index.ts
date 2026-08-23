import { zh } from './zh.js';
import { zhHant } from './zh-Hant.js';
import { ja } from './ja.js';
import { ru } from './ru.js';
import { de } from './de.js';
import { fr } from './fr.js';
import { es } from './es.js';
import { pt } from './pt.js';

/**
 * Server-side translation, for text that reaches a person.
 *
 * Kept separate from the frontend's tables (apps/web/src/lib/i18n.ts) on purpose. These
 * are different strings — API errors rather than interface chrome — and the server cannot
 * import from the web workspace anyway. The mechanism is deliberately identical: the key
 * is the English source string, and a missing entry falls back to English rather than
 * leaking a key.
 *
 * **Why the server translates at all, rather than returning a code.** The gateway answers
 * `claude` and `codex` directly, and those print whatever the server says. A code would be
 * meaningless there, and an English-only message is wrong for someone whose interface is
 * in Japanese. Accept-Language is the mechanism designed for exactly this, so that is what
 * is used.
 *
 * Only messages that reach a person go through here. An Error thrown for a log stays in
 * English: nobody reads a stack trace in four languages.
 */
export const LOCALES = ['en', 'zh', 'zh-Hant', 'ja', 'ru', 'de', 'fr', 'es', 'pt'] as const;
export type Locale = (typeof LOCALES)[number];

/** English is the source, so it needs no table */
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

function isLocale(v: string): v is Locale {
  return (LOCALES as readonly string[]).includes(v);
}

/**
 * Choose a locale from an Accept-Language header.
 *
 * Quality values are honoured, and matching is on the primary subtag, with one exception:
 * Chinese is split by script, so `zh-TW`, `zh-HK` and anything marked `Hant` get the
 * traditional table and the rest get the simplified one. Anything unrecognised, absent or
 * malformed gives English.
 */
export function pickLocale(header?: string | string[]): Locale {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return 'en';

  const ranked = raw
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      const weight = q ? Number.parseFloat(q.split('=')[1] ?? '') : 1;
      // The tag needs its own trim: splitting `ja ; q=0.3` on ';' leaves the space on the
      // tag, and trimming only the whole part does not reach it
      return {
        base: normalise((tag ?? '').trim()),
        q: Number.isFinite(weight) ? weight : 0,
      };
    })
    // A q of 0 means "explicitly not this one", so it is dropped rather than ranked last
    .filter((x) => x.base && x.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { base } of ranked) if (isLocale(base)) return base;
  return 'en';
}

/** The one tag that does not reduce to its primary subtag; see pickLocale */
function normalise(tag: string): string {
  const lower = tag.toLowerCase();
  if (lower.startsWith('zh')) return /hant|-tw|-hk|-mo/.test(lower) ? 'zh-Hant' : 'zh';
  return lower.split('-')[0] ?? '';
}

/** Interpolates `{name}` placeholders. Unknown names are left alone, not blanked. */
function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export function t(
  locale: Locale,
  source: string,
  vars?: Record<string, string | number>,
): string {
  const table = locale === 'en' ? undefined : TABLES[locale];
  return fill(table?.[source] ?? source, vars);
}
