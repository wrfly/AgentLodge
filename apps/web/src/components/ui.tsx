import { Loader2 } from 'lucide-react';
import clsx from 'clsx';

/** Page shell: settings, usage, memory and the admin console all share this layout */
export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-5 py-8 pb-20">
        <header className="mb-7 flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
            {subtitle && <p className="mt-1 text-[13.5px] text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
        {children}
      </div>
    </div>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx('mb-4 rounded-xl border border-line bg-surface', className)}>
      {(title || actions) && (
        <div className="flex items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-[14.5px] font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-[12.5px] text-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

type ButtonVariant = 'primary' | 'default' | 'danger' | 'ghost';

export function Button({
  variant = 'default',
  loading,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
}) {
  const styles: Record<ButtonVariant, string> = {
    primary: 'bg-accent text-white hover:opacity-90 disabled:opacity-40',
    default:
      'border border-line bg-surface hover:border-line-strong hover:bg-elevated disabled:opacity-40',
    danger: 'border border-danger/40 text-danger hover:bg-danger/8 disabled:opacity-40',
    ghost: 'text-muted hover:bg-bubble hover:text-ink disabled:opacity-40',
  };
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition disabled:cursor-not-allowed',
        styles[variant],
        className,
      )}
    >
      {loading && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-3.5 block last:mb-0">
      <span className="mb-1.5 block text-[13px] font-medium text-muted">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-[11.5px] text-danger">{error}</span>
      ) : (
        hint && <span className="mt-1 block text-[11.5px] text-faint">{hint}</span>
      )}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={clsx(
        'w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] outline-none transition placeholder:text-faint focus:border-accent/60 disabled:opacity-50',
        props.className,
      )}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={clsx(
        'w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] outline-none transition focus:border-accent/60 disabled:opacity-50',
        props.className,
      )}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  /** Renders and behaves as unavailable — the caller explains why nearby */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx('flex items-center gap-2.5', disabled && 'cursor-not-allowed opacity-50')}
    >
      <span
        className={clsx(
          'relative h-[18px] w-8 rounded-full transition',
          checked ? 'bg-accent' : 'bg-line-strong',
        )}
      >
        <span
          className={clsx(
            'absolute top-0.5 size-3.5 rounded-full bg-white shadow-sm transition-all',
            checked ? 'left-[17px]' : 'left-0.5',
          )}
        />
      </span>
      {label && <span className="text-[13.5px]">{label}</span>}
    </button>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'accent' | 'danger';
}) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <div className="text-[11.5px] tracking-wide text-faint">{label}</div>
      <div
        className={clsx(
          'mt-1 font-mono text-[19px] font-semibold tracking-tight tabular-nums',
          tone === 'accent' && 'text-accent',
          tone === 'danger' && 'text-danger',
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11.5px] text-faint">{sub}</div>}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="py-6 text-center text-[13px] text-faint">{text}</p>;
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center py-14 text-faint">
      <Loader2 size={18} className="animate-spin" />
    </div>
  );
}

export function Banner({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'error' | 'success' | 'warn';
  children: React.ReactNode;
}) {
  const styles = {
    info: 'border-line bg-elevated text-muted',
    error: 'border-danger/30 bg-danger/8 text-danger',
    success: 'border-emerald-500/30 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300',
    warn: 'border-amber-500/30 bg-amber-500/8 text-amber-700 dark:text-amber-300',
  };
  return (
    <div className={clsx('mb-4 rounded-lg border px-3 py-2 text-[13px]', styles[tone])}>
      {children}
    </div>
  );
}

/** Token counts turn up all over the interface, so they are formatted in one place */
export function fmtTokens(n: number): string {
  // Trailing zeros dropped: a context window is 200k and a round million is 1M, and the
  // second decimal is only ever noise on a number that happens to be round. Everything
  // that shows a token count goes through here, so one screen cannot render 1.00M in one
  // column and 1M in the next.
  const trim = (s: string): string => String(Number(s));
  if (n >= 1_000_000) return `${trim((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1_000) return `${trim((n / 1_000).toFixed(1))}k`;
  return String(n);
}

/**
 * Tokens as millions, and back.
 *
 * Usage is counted in tokens and an allowance is typed in millions: an administrator sizing
 * a quota thinks in millions, and a misplaced zero in `5000000` is invisible in a way that
 * one in `5` is not. Only the fields convert — everything stored, billed and compared stays
 * in tokens.
 */
export function tokensToM(tokens: number): string {
  // Number() again to drop the trailing zeros toFixed leaves behind
  return String(Number((tokens / 1_000_000).toFixed(6)));
}

export function mToTokens(m: string): number {
  return Math.round(Number(m) * 1_000_000);
}

export function fmtDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Pad sparse daily usage out to N consecutive days.
 *
 * Without it, a single day of data renders as one flat bar across the whole chart, which
 * reads as anything but a trend.
 */
export function fillDays<T extends { day: string; billableTokens: number; turns: number }>(
  data: T[],
  days = 30,
): Array<{ day: string; billableTokens: number; turns: number }> {
  const map = new Map(data.map((d) => [d.day, d]));
  const out: Array<{ day: string; billableTokens: number; turns: number }> = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400_000);
    const key = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    const hit = map.get(key);
    out.push({ day: key, billableTokens: hit?.billableTokens ?? 0, turns: hit?.turns ?? 0 });
  }
  return out;
}
