/**
 * Pieces more than one admin tab uses.
 *
 * Split out of AdminPage.tsx, which had grown to 2700 lines; one file per tab now.
 */
import clsx from 'clsx';
import { Input } from '../../components/ui';

/**
 * A number with its unit inside the box.
 *
 * Three of these plus a button used to be three fixed-width fields, three separate unit
 * labels and a wrapping row — which came out as three lines, and as more lines still in a
 * language whose word for "records" is longer. Sharing the width equally keeps it on one
 * line whatever the unit says, and the unit is only ever read next to its own field.
 */
export function WithUnit({
  value,
  onChange,
  unit,
  className = 'min-w-0 flex-1',
}: {
  value: string;
  onChange: (v: string) => void;
  unit: string;
  /** The wrapper's width. A row of them shares the space; one on its own fills it. */
  className?: string;
}) {
  return (
    <span className={clsx('relative', className)}>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="numeric"
        // Room for the unit, which sits on top of the input's right end
        className="pr-[4.5rem] text-[13px]"
      />
      {/* Capped and truncating: a longer word in some other language would otherwise sit on
          top of the number rather than beside it */}
      <span className="pointer-events-none absolute inset-y-0 right-2.5 flex max-w-[3.5rem] items-center truncate text-[11px] text-faint">
        {unit}
      </span>
    </span>
  );
}
