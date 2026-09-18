/**
 * The user usage tab: who spent it, over which period, and on what.
 *
 * Split from account management, which is a different job done at a different moment. Managing
 * an account is an edit — a ceiling, a role, a top-up — and looking at usage is a read, often
 * of everybody at once. Sharing a screen made the read hunt through forms and the edit scroll
 * past figures.
 *
 * It is also where the overview's top-ten list went. Ten rows is a leaderboard, and a
 * leaderboard cannot answer "what did this person spend": you have to hope they are in it.
 * Every account that spent anything is here, and the rows add up to the total above them.
 *
 * The shape mirrors the overview's upstream card on purpose — same periods, same columns, one
 * level of expansion. There it is upstream → model ("where did the money go"); here it is
 * user → model ("who spent it, and on what"). The two are the same table asked from two sides,
 * and an operator moving between them should not have to learn a second interface.
 */
import { Fragment, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import {
  admin,
  fmtCost,
  type PlatformPreset,
  type UserAgentUsage,
  type UsersUsage,
} from '../../lib/api';
import { Banner, Button, Card, Empty, Spinner, fmtTokens } from '../../components/ui';
import { AgentModelTable } from '../../components/AgentModelTable';
import { useT } from '../../lib/i18n';
import { PLATFORM_PRESETS } from './shared';

/**
 * One account's models, fetched when its row is opened.
 *
 * Not sent with the list, unlike the overview's models-per-upstream: upstreams are a handful
 * on any deployment, and users are not bounded that way. An operator opens a row at a time.
 */
function UserModels({ userId, preset }: { userId: string; preset: PlatformPreset }) {
  const t = useT();
  const [data, setData] = useState<UserAgentUsage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Closed again, or the period switched, before the answer lands: the request is
    // abandoned, not just its result
    const ac = new AbortController();
    setErr(null);
    admin
      .userAgentUsage(userId, preset, ac.signal)
      .then(setData)
      .catch((e) => {
        if (!ac.signal.aborted) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, [userId, preset, attempt]);

  if (err)
    return (
      // Recoverable, because the usual cause is that the server was restarting. Without a
      // retry the banner is terminal and the only way out is to guess that closing the row
      // and reopening it starts over.
      <Banner tone="error">
        <span className="flex flex-wrap items-center gap-2">
          <span className="flex-1">{err}</span>
          <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
            {t('Retry')}
          </Button>
        </span>
      </Banner>
    );
  if (!data) return <Spinner />;
  return <AgentModelTable rows={data.rows} totals={data.total} currency={data.currency} />;
}

export function UserUsage() {
  const t = useT();
  /*
   * The same default as the overview's platform card. The reason these two tabs share a
   * preset list is that an operator moves between them to compare, and two different starting
   * periods would make the first comparison anybody draws a false one.
   */
  const [preset, setPreset] = useState<PlatformPreset>('today');
  /** Which rows are open. Several at once, because the point is comparing them. */
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [data, setData] = useState<UsersUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    void admin
      .usageByUser(preset)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [preset]);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <Card title={t('Usage by user')}>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {PLATFORM_PRESETS.map((p) => (
          <Button
            key={p.id}
            variant={preset === p.id ? 'primary' : 'ghost'}
            onClick={() => setPreset(p.id)}
          >
            {t(p.label)}
          </Button>
        ))}
      </div>

      {error ? (
        <Banner tone="error">{error}</Banner>
      ) : !data ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-[17px] tabular-nums">
              {data.totals.billableTokens.toLocaleString()}
            </span>
            <span className="font-mono text-[13px] text-muted tabular-nums">
              {fmtCost(data.totals.cost, data.currency)}
            </span>
            <span className="text-[12px] text-faint">
              {t('{n} turns', { n: data.totals.turns })} · {t(data.range.label)}
            </span>
          </div>

          {data.rows.length === 0 ? (
            <Empty text={t('No usage in this period')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[460px] text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-faint">
                    <th className="pb-1.5 font-medium">{t('User')}</th>
                    <th className="pb-1.5 text-right font-medium">{t('Turns')}</th>
                    <th className="pb-1.5 text-right font-medium">{t('Billable tokens')}</th>
                    <th className="pb-1.5 text-right font-medium">{t('Cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((u) => {
                    const shown = open.has(u.userId);
                    return (
                      <Fragment key={u.userId}>
                        <tr
                          onClick={() => toggle(u.userId)}
                          className={clsx(
                            'cursor-pointer border-b border-line hover:bg-bubble',
                            shown && 'bg-bubble',
                          )}
                        >
                          <td className="py-1.5">
                            <ChevronRight
                              size={12}
                              className={clsx(
                                'mr-1 inline shrink-0 text-faint transition-transform',
                                shown && 'rotate-90',
                              )}
                            />
                            {/* Spend outlives the account: nothing cascades from `users` to
                                `usage_records`, so a deleted account leaves rows the total
                                above still counts. Named rather than left blank, for the same
                                reason the upstream table names what never went through the
                                gateway — it is the difference between the rows and the total. */}
                            {u.username || t('Deleted account')}
                            <span className="ml-2 text-[11.5px] text-faint">{u.email}</span>
                          </td>
                          <td className="py-1.5 text-right tabular-nums">{u.turns}</td>
                          <td className="py-1.5 text-right font-mono tabular-nums">
                            {fmtTokens(u.billableTokens)}
                          </td>
                          {/* Tokens and money both: two models differ by a factor of ten per
                              token, so a column of counts on its own does not say where the
                              budget went */}
                          <td className="py-1.5 text-right font-mono tabular-nums text-muted">
                            {fmtCost(u.cost, data.currency)}
                          </td>
                        </tr>
                        {shown && (
                          <tr className="border-b border-line bg-bubble/40">
                            <td colSpan={4} className="px-3 py-2">
                              <UserModels userId={u.userId} preset={preset} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-1.5 text-[11.5px] text-faint">
                {t('Click a user to see which models their spend went on.')}
              </p>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
