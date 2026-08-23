import clsx from 'clsx';
import { useQuota } from '../store/quota';
import { navigate } from '../lib/route';
import { useT } from '../lib/i18n';
import { fmtTokens } from './ui';
import { fmtMoney } from '../lib/api';
import type { QuotaWindow } from '../lib/protocol';

/**
 * Quota bar at the foot of the sidebar; click through for the breakdown.
 *
 * Three windows, one line: the one closest to refusing is the one worth a glance, and the
 * other two are a click away. `tightest` is the server's own answer to which that is.
 */
export function QuotaBar() {
  const t = useT();
  const quota = useQuota((s) => s.quota);
  if (!quota) return null;

  const byCost = quota.limitKind === 'cost';
  const show = (v: number) => (byCost ? fmtMoney(v, quota.currency) : fmtTokens(v));
  const scopeName: Record<QuotaWindow['scope'], string> = {
    window: t('5 h'),
    week: t('week'),
    month: t('month'),
  };

  const w = quota.tightest ? quota.windows[quota.tightest] : null;
  if (!w || w.limit === null) {
    return (
      <button
        onClick={() => navigate('/usage')}
        className="mb-2 w-full px-1 text-left text-[11px] text-faint hover:text-muted"
      >
        {t('Used {used} · no limit', { used: show(quota.windows.month.used) })}
      </button>
    );
  }

  const pct = Math.round(w.ratio * 100);
  return (
    <button
      onClick={() => navigate('/usage')}
      title={[
        t('{scope} window', { scope: scopeName[w.scope] }),
        w.remaining !== null ? t('{amount} left', { amount: show(w.remaining) }) : '',
      ]
        .filter(Boolean)
        .join(' · ')}
      className="group mb-2 block w-full px-1 text-left"
    >
      <div className="mb-1 flex items-baseline justify-between text-[11px]">
        <span className="font-mono text-muted tabular-nums">
          {show(w.used)}
          <span className="text-faint"> / {show(w.limit)}</span>
        </span>
        <span
          className={clsx(
            'tabular-nums',
            quota.exceeded ? 'text-danger' : quota.warning ? 'text-amber-600' : 'text-faint',
          )}
        >
          {scopeName[w.scope]} {pct}%
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-bubble">
        <div
          className={clsx(
            'h-full rounded-full transition-all',
            quota.exceeded ? 'bg-danger' : quota.warning ? 'bg-amber-500' : 'bg-accent',
          )}
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>
    </button>
  );
}
