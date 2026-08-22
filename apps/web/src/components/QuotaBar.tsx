import clsx from 'clsx';
import { useQuota } from '../store/quota';
import { navigate } from '../lib/route';
import { useT } from '../lib/i18n';
import { fmtTokens } from './ui';
import { fmtMoney } from '../lib/api';

/** Quota bar at the foot of the sidebar; click through for the breakdown */
export function QuotaBar() {
  const t = useT();
  const quota = useQuota((s) => s.quota);
  if (!quota) return null;

  const byCost = quota.limitKind === 'cost';
  const used = byCost ? quota.usedMicro : quota.used;
  const cap = byCost ? quota.costLimitMicro : quota.limit;
  const show = (v: number) => (byCost ? fmtMoney(v, quota.currency) : fmtTokens(v));

  if (quota.expired) {
    return (
      <div className="mb-2 px-1 text-[11px] text-danger">
        {t('Quota has expired — ask an administrator to top it up')}
      </div>
    );
  }

  if (cap === null) {
    return (
      <button
        onClick={() => navigate('/usage')}
        className="mb-2 w-full px-1 text-left text-[11px] text-faint hover:text-muted"
      >
        {t('Used {used} · no limit', { used: fmtTokens(quota.used) })}
      </button>
    );
  }

  const pct = Math.round(quota.ratio * 100);
  return (
    <button
      onClick={() => navigate('/usage')}
      title={[
        quota.anchorLabel,
        byCost
          ? t('{amount} left', { amount: fmtMoney(quota.remainingMicro, quota.currency) })
          : quota.remaining !== null
            ? t('{amount} left', { amount: quota.remaining.toLocaleString() })
            : '',
      ]
        .filter(Boolean)
        .join(' · ')}
      className="group mb-2 block w-full px-1 text-left"
    >
      <div className="mb-1 flex items-baseline justify-between text-[11px]">
        <span className="font-mono text-muted tabular-nums">
          {show(used)}
          <span className="text-faint"> / {show(cap)}</span>
        </span>
        <span
          className={clsx(
            'tabular-nums',
            quota.exceeded ? 'text-danger' : quota.warning ? 'text-amber-600' : 'text-faint',
          )}
        >
          {pct}%
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
