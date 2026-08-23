import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { useT } from '../lib/i18n';
import type { ModelGroup } from '../lib/protocol';

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
  /**
   * The same options, arranged by family. When given, each family shows its newest and
   * folds the rest away — a dozen names, most of them older versions of four things, is not
   * a list anybody reads. Ignored when nothing has more than one version, so a list that
   * needs no folding is not given any.
   */
  groups?: Array<ModelGroup<PickerOption>>;
}

function Row({
  option,
  value,
  onPick,
}: {
  option: PickerOption;
  value: string;
  onPick: (id: string) => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => onPick(option.id)}
      className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-elevated"
    >
      <Check
        size={13}
        className={clsx('mt-0.5 shrink-0', option.id === value ? 'text-accent' : 'opacity-0')}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[13px]">{t(option.label)}</span>
        {option.hint && <span className="block text-[11px] text-faint">{t(option.hint)}</span>}
      </span>
    </button>
  );
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
  groups,
}: PickerProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [shown, setShown] = useState<string[]>([]);
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

  // Folding only earns its place when something is folded
  const folded = useMemo(() => (groups?.some((g) => g.models.length > 1) ? groups : null), [groups]);

  /**
   * A group is open when it was clicked open, or when the current value is one of the older
   * versions inside it — otherwise the tick would be behind a fold and the picker would look
   * as though nothing were selected.
   */
  const isOpen = (g: ModelGroup<PickerOption>): boolean =>
    shown.includes(g.label) || g.models.slice(1).some((o) => o.id === value);

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
            {folded
              ? folded.map((g) => (
                  <div key={g.label || '__plain__'}>
                    {g.label && (
                      <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-faint">
                        {g.label}
                      </div>
                    )}
                    {(isOpen(g) ? g.models : g.models.slice(0, 1)).map((o) => (
                      <Row key={o.id || '__default__'} option={o} value={value} onPick={pick} />
                    ))}
                    {g.models.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setShown((prev) =>
                            prev.includes(g.label)
                              ? prev.filter((l) => l !== g.label)
                              : [...prev, g.label],
                          )
                        }
                        className="flex w-full items-center gap-1 px-3 py-1 pl-[30px] text-left text-[11px] text-faint hover:bg-elevated hover:text-muted"
                      >
                        <ChevronRight
                          size={11}
                          className={clsx('transition-transform', isOpen(g) && 'rotate-90')}
                        />
                        {isOpen(g)
                          ? t('Fewer')
                          : t('{n} older', { n: g.models.length - 1 })}
                      </button>
                    )}
                  </div>
                ))
              : options.map((o) => (
                  <Row key={o.id || '__default__'} option={o} value={value} onPick={pick} />
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
