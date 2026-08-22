import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { useT } from '../lib/i18n';

export interface PickerOption {
  id: string;
  label: string;
  hint?: string;
}

interface PickerProps {
  icon: LucideIcon;
  /** Placeholder shown when the value is empty */
  placeholder: string;
  value: string;
  options: PickerOption[];
  onChange: (id: string) => void;
  title: string;
  /** Allow typing a value that is not in the list */
  allowCustom?: boolean;
  customPlaceholder?: string;
  disabled?: boolean;
}

export function Picker({
  icon: Icon,
  placeholder,
  value,
  options,
  onChange,
  title,
  allowCustom = false,
  customPlaceholder = 'Custom — press Enter',
  disabled = false,
}: PickerProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const known = options.find((o) => o.id === value);
  const label = known?.label ?? (value || placeholder);
  const isDefault = !value;

  const pick = (id: string) => {
    setOpen(false);
    onChange(id);
  };

  const commitCustom = () => {
    const v = custom.trim();
    if (!v) return;
    setCustom('');
    pick(v);
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title={title}
        className={clsx(
          'flex max-w-[180px] items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px] transition',
          disabled
            ? 'cursor-not-allowed border-line text-faint'
            : 'border-line hover:border-line-strong hover:bg-bubble',
          isDefault ? 'text-muted' : 'text-ink',
        )}
      >
        <Icon size={12} className={clsx('shrink-0', !isDefault && 'text-accent')} />
        <span className="truncate font-mono">{label}</span>
        <ChevronDown
          size={11}
          className={clsx('shrink-0 text-faint transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-1.5 w-56 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-lg">
          <div className="max-h-64 overflow-y-auto">
            {options.map((o) => (
              <button
                key={o.id || '__default__'}
                type="button"
                onClick={() => pick(o.id)}
                className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-elevated"
              >
                <Check
                  size={13}
                  className={clsx('mt-0.5 shrink-0', o.id === value ? 'text-accent' : 'opacity-0')}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[13px]">{t(o.label)}</span>
                  {o.hint && <span className="block text-[11px] text-faint">{t(o.hint)}</span>}
                </span>
              </button>
            ))}

            {value && !known && (
              <div className="flex items-start gap-2 px-3 py-1.5">
                <Check size={13} className="mt-0.5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{value}</span>
              </div>
            )}
          </div>

          {allowCustom && (
            <div className="mt-1 border-t border-line px-2 pt-2 pb-1">
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitCustom();
                  }
                }}
                onBlur={commitCustom}
                placeholder={t(customPlaceholder)}
                spellCheck={false}
                className="w-full rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[12px] outline-none placeholder:font-sans placeholder:text-faint focus:border-accent/50"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
