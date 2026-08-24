import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { useT } from '../lib/i18n';
import type { ModelVendor } from '../lib/protocol';

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
  disabled?: boolean;
  /**
   * The same options, arranged vendor → family → version. When given, the menu walks that
   * tree instead of listing everything: two upstreams' worth of names is not a list anybody
   * reads. Levels with a single child are skipped, so a vendor offering one model, or a
   * family with one version, is picked where it is shown.
   */
  vendors?: Array<ModelVendor<PickerOption>>;
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

/** A row that opens the next level rather than choosing anything */
function Branch({
  label,
  sub,
  ticked,
  onOpen,
}: {
  label: string;
  sub: string;
  ticked: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-elevated"
    >
      <Check size={13} className={clsx('shrink-0', ticked ? 'text-accent' : 'opacity-0')} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[13px]">{label}</span>
        <span className="block truncate text-[11px] text-faint">{sub}</span>
      </span>
      <ChevronRight size={12} className="shrink-0 text-faint" />
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
  disabled = false,
  vendors,
}: PickerProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  /** Where in the tree the menu is: [] vendors, [vendor] families, [vendor, family] versions */
  const [path, setPath] = useState<string[]>([]);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close();
    };
    const onEsc = (e: KeyboardEvent) => {
      // Escape steps back one level first, then closes: a submenu is a place to leave
      if (e.key === 'Escape') {
        if (path.length) setPath((p) => p.slice(0, -1));
        else close();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open, path]);

  // Walking the tree only earns its place when there is more than one thing at the top
  const tree = useMemo(
    () => (vendors && vendors.length > 1 ? vendors : null),
    [vendors],
  );

  const vendor = tree?.find((v) => v.label === path[0]) ?? null;
  const family = vendor?.families.find((f) => f.label === path[1]) ?? null;

  /** Whether the current value is somewhere under this vendor or family */
  const holds = (node: { models: PickerOption[] }): boolean =>
    Boolean(value) && node.models.some((o) => o.id === value);

  const known = options.find((o) => o.id === value);
  const label = known?.label ?? (value || placeholder);
  const isDefault = !value;

  const close = (): void => {
    setOpen(false);
    setPath([]);
  };

  const pick = (id: string) => {
    close();
    onChange(id);
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => !disabled && (open ? close() : setOpen(true))}
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
            {tree ? (
              <>
                {path.length > 0 && (
                  /* The way back up, showing where the menu is */
                  <button
                    type="button"
                    onClick={() => setPath((p) => p.slice(0, -1))}
                    className="flex w-full items-center gap-1.5 border-b border-line px-3 py-1.5 text-left text-[11px] text-faint hover:bg-elevated hover:text-muted"
                  >
                    <ChevronLeft size={12} className="shrink-0" />
                    <span className="truncate font-mono">{path.join(' / ')}</span>
                  </button>
                )}

                {family
                  ? family.models.map((o) => (
                      <Row key={o.id || '__default__'} option={o} value={value} onPick={pick} />
                    ))
                  : vendor
                    ? vendor.families.map((f) =>
                        // A family with one version has nothing below it
                        f.models.length === 1 || !f.label ? (
                          f.models.map((o) => (
                            <Row key={o.id || '__default__'} option={o} value={value} onPick={pick} />
                          ))
                        ) : (
                          <Branch
                            key={f.label}
                            label={f.label}
                            sub={holds(f) ? value : t('{n} versions', { n: f.models.length })}
                            ticked={holds(f)}
                            onOpen={() => setPath([vendor.label, f.label])}
                          />
                        ),
                      )
                    : tree.map((v) =>
                        // A vendor offering one model is picked from here, and the unnamed
                        // group — the "Default" row — is never a level of its own
                        v.models.length === 1 || !v.label ? (
                          v.models.map((o) => (
                            <Row key={o.id || '__default__'} option={o} value={value} onPick={pick} />
                          ))
                        ) : (
                          <Branch
                            key={v.label}
                            label={v.label}
                            sub={holds(v) ? value : t('{n} models', { n: v.models.length })}
                            ticked={holds(v)}
                            onOpen={() => setPath([v.label])}
                          />
                        ),
                      )}
              </>
            ) : (
              options.map((o) => (
                <Row key={o.id || '__default__'} option={o} value={value} onPick={pick} />
              ))
            )}

            {/*
              A conversation can carry a name the catalogue no longer has — an administrator
              removed it, or it was set before it went away. Showing it is the only way the
              picker can be honest about what this conversation is actually on.
            */}
            {value && !known && (
              <div className="flex items-start gap-2 border-t border-line px-3 py-1.5">
                <Check size={13} className="mt-0.5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[13px]">{value}</span>
                  <span className="block text-[11px] text-faint">{t('no longer offered')}</span>
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
