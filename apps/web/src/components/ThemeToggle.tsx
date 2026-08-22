import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import clsx from 'clsx';
import { applyTheme, getTheme, type Theme } from '../lib/theme';
import { useT } from '../lib/i18n';

const OPTIONS: Array<{ value: Theme; icon: typeof Sun; label: string }> = [
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
  { value: 'system', icon: Monitor, label: 'Follow system' },
];

export function ThemeToggle() {
  const t = useT();
  const [theme, setTheme] = useState<Theme>(getTheme);

  // When set to follow the system, react to the system flipping
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  return (
    <div className="flex gap-0.5 rounded-lg bg-bubble p-0.5">
      {OPTIONS.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          onClick={() => {
            setTheme(value);
            applyTheme(value);
          }}
          title={t(label)}
          aria-label={t(label)}
          aria-pressed={theme === value}
          className={clsx(
            'flex flex-1 items-center justify-center rounded-md py-1.5 transition',
            theme === value ? 'bg-surface text-ink shadow-sm' : 'text-faint hover:text-muted',
          )}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}
