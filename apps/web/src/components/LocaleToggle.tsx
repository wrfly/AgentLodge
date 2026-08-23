import { Languages } from 'lucide-react';
import clsx from 'clsx';
import { LOCALES, LOCALE_LABEL, useI18n } from '../lib/i18n';

/**
 * Language picker.
 *
 * Sits in the account menu next to the theme switch, because both are personal
 * display preferences rather than account data — and both are stored the same
 * way, in localStorage on this device. Nothing about the language belongs on
 * the server: it changes nothing the server computes, and putting it in the
 * database would mean a schema change plus a round trip to render the first
 * frame in the right language.
 *
 * Buttons rather than a dropdown: the whole point of a language switch is that
 * you can find it when the interface is in a language you cannot read, and a
 * collapsed control hides the one label you are looking for. Enough of them now
 * that they wrap into a grid, which keeps every name on screen.
 */
export function LocaleToggle() {
  const locale = useI18n((s) => s.locale);
  const setLocale = useI18n((s) => s.setLocale);

  return (
    <div className="flex items-start gap-1.5">
      <Languages size={13} className="mt-1.5 shrink-0 text-faint" aria-hidden />
      <div className="grid flex-1 grid-cols-3 gap-0.5 rounded-lg bg-bubble p-0.5">
        {LOCALES.map((value) => (
          <button
            key={value}
            onClick={() => setLocale(value)}
            // The label is the language's own name, so it stays legible whatever
            // the current locale is — no need for a translated title here
            title={LOCALE_LABEL[value]}
            aria-pressed={locale === value}
            className={clsx(
              'flex items-center justify-center rounded-md px-1 py-1 text-[11.5px] transition',
              locale === value ? 'bg-surface text-ink shadow-sm' : 'text-faint hover:text-muted',
            )}
          >
            {LOCALE_LABEL[value]}
          </button>
        ))}
      </div>
    </div>
  );
}
