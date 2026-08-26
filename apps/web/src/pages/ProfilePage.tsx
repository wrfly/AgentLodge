import { useEffect, useState } from 'react';
import { BookmarkPlus, Sparkle } from 'lucide-react';
import { me, type Profile } from '../lib/api';
import { Banner, Button, Card, Page, Spinner, Stat, fmtDate } from '../components/ui';
import { useT } from '../lib/i18n';

/**
 * What the record already says about how somebody works.
 *
 * Counted, not inferred: every number here comes from a query over their own conversations
 * and usage rows, so it is exact and costs nothing to produce.
 */
export function ProfilePage() {
  const t = useT();
  const [p, setP] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kept, setKept] = useState<string[]>([]);

  const load = () =>
    me
      .profile()
      .then(setP)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void load();
  }, []);

  const recap = async () => {
    setBusy(true);
    setError(null);
    try {
      await me.recap();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const keep = async (line: string) => {
    try {
      await me.saveMemory({ title: line.slice(0, 40), body: line });
      setKept((k) => [...k, line]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!p && !error) return <Spinner />;

  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—');
  const { byHour, byWeekday } = local(p?.hourOfWeek ?? []);

  return (
    <Page
      title={t('How you work')}
      subtitle={t('Counted from your own conversations, and read back to you. Nobody else sees this.')}
      actions={
        p && (
          <Button variant={p.portrait ? undefined : 'primary'} onClick={() => void recap()} loading={busy}>
            <Sparkle size={13} />
            {p.portrait ? t('Write it again') : t('Read my conversations')}
          </Button>
        )
      }
    >
      {error && <Banner tone="error">{error}</Banner>}

      {p?.portrait && (
        <Card
          title={t('What your conversations say')}
          description={t('From {n} conversations · {when}', {
            n: p.portrait.conversations,
            when: fmtDate(p.portrait.createdAt),
          })}
        >
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{p.portrait.text}</p>
          {p.portrait.candidates.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <div className="mb-2 text-[11.5px] text-faint">{t('Worth remembering?')}</div>
              {p.portrait.candidates.map((c) => (
                <div key={c} className="mb-1.5 flex items-center gap-2 text-[13px]">
                  <span className="min-w-0 flex-1 text-muted">{c}</span>
                  <Button onClick={() => void keep(c)} disabled={kept.includes(c)}>
                    <BookmarkPlus size={13} />
                    {kept.includes(c) ? t('In memory') : t('Keep')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {p && p.messages === 0 && <Card title={t('Nothing to count yet')} />}

      {p && p.messages > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t('Conversations')} value={String(p.conversations)} />
            <Stat label={t('Messages')} value={String(p.messages)} />
            <Stat label={t('Days used')} value={String(p.activeDays)} />
            <Stat label={t('Since')} value={p.since ? fmtDate(p.since).split(' ')[0]! : '—'} />
          </div>

          <Card title={t('When you work')} description={t('Your own time zone')}>
            <Bars
              values={byHour}
              labelOf={(i) => (i % 6 === 0 ? `${i}:00` : '')}
              titleOf={(i, v) => `${i}:00 · ${v}`}
            />
            <div className="mt-4">
              <Bars
                values={byWeekday}
                labelOf={(i) => t(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i]!)}
                titleOf={(_i, v) => String(v)}
              />
            </div>
          </Card>

          <Card title={t('How you use it')}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat
                label={t('Turns that used tools')}
                value={pct(p.withTools, p.turns)}
                sub={t('the rest were answered outright')}
              />
              <Stat
                label={t('Turns you interrupted')}
                value={pct(p.aborted, p.turns)}
                tone={p.aborted / Math.max(1, p.turns) > 0.2 ? 'danger' : undefined}
              />
              <Stat label={t('Turns that failed')} value={pct(p.failed, p.turns)} />
              <Stat label={t('Messages per conversation')} value={String(p.turnsPerConversation)} sub={t('median')} />
              <Stat label={t('Seconds per turn')} value={String(p.secondsPerTurn)} sub={t('{p90}s at the 90th', { p90: p.secondsPerTurnP90 })} />
              <Stat label={t('From your own CLI')} value={pct(p.viaOwnCli, p.billedTurns)} />
            </div>
          </Card>

          <Card title={t('How you ask')} description={t('From your {n} most recent messages', { n: p.sampled })}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label={t('Characters per message')} value={String(p.askLength)} sub={t('median')} />
              <Stat label={t('Your longer ones')} value={String(p.askLengthP90)} sub={t('90th percentile')} />
              <Stat label={t('Written in CJK')} value={`${Math.round(p.cjkShare * 100)}%`} />
            </div>
          </Card>

          <Card title={t('What you reach for')}>
            <Split label={t('Agent')} rows={p.agents} />
            <Split label={t('Model')} rows={p.models} />
            {p.efforts.length > 0 && <Split label={t('Effort')} rows={p.efforts} />}
          </Card>

          {p.summaries.length > 0 && (
            <Card
              title={t('Your conversations, in a line each')}
              description={
                p.pending > 0
                  ? t('{n} more have no summary yet. Writing it again picks up where this left off.', {
                      n: p.pending,
                    })
                  : undefined
              }
            >
              <ul className="space-y-2.5">
                {p.summaries.map((c) => (
                  <li key={c.id}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-[13px]">{c.title}</span>
                      <span className="shrink-0 text-[11.5px] text-faint">{fmtDate(c.at)}</span>
                    </div>
                    <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{c.summary}</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </Page>
  );
}

/**
 * Rotate the server's UTC buckets into the reader's own time.
 *
 * Whole-hour offsets land exactly; the handful of zones offset by thirty or forty-five
 * minutes are rounded to the nearest hour, which is closer than not rotating at all.
 */
function local(hourOfWeek: number[]): { byHour: number[]; byWeekday: number[] } {
  const byHour = new Array<number>(24).fill(0);
  const byWeekday = new Array<number>(7).fill(0);
  if (hourOfWeek.length !== 168) return { byHour, byWeekday };

  const shift = Math.round(-new Date().getTimezoneOffset() / 60);
  for (let i = 0; i < 168; i++) {
    const n = hourOfWeek[i] ?? 0;
    if (!n) continue;
    const j = (i + shift + 168) % 168;
    byHour[j % 24]! += n;
    byWeekday[Math.floor(j / 24)]! += n;
  }
  return { byHour, byWeekday };
}

/** A bar per bucket — not worth a charting library, same as the usage page */
function Bars({
  values,
  labelOf,
  titleOf,
}: {
  values: number[];
  labelOf: (i: number) => string;
  titleOf: (i: number, v: number) => string;
}) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex items-end gap-[3px]" style={{ height: 88 }}>
      {values.map((v, i) => (
        <div key={i} className="flex h-full flex-1 flex-col justify-end" title={titleOf(i, v)}>
          <div
            className="rounded-sm bg-accent/70"
            style={{ height: `${Math.max(v ? 3 : 0, (v / max) * 74)}px` }}
          />
          <div className="mt-1 h-3 truncate text-center text-[9.5px] text-faint">{labelOf(i)}</div>
        </div>
      ))}
    </div>
  );
}

function Split({ label, rows }: { label: string; rows: Array<{ key: string; n: number }> }) {
  const total = rows.reduce((a, r) => a + r.n, 0);
  if (!total) return null;
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 text-[11.5px] text-faint">{label}</div>
      {rows.map((r) => (
        <div key={r.key} className="mb-1 flex items-center gap-2 text-[12.5px]">
          <span className="w-40 shrink-0 truncate font-mono text-muted">{r.key}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-bubble">
            <div className="h-full rounded-full bg-accent/70" style={{ width: `${(r.n / total) * 100}%` }} />
          </div>
          <span className="w-11 shrink-0 text-right tabular-nums text-faint">
            {Math.round((r.n / total) * 100)}%
          </span>
        </div>
      ))}
    </div>
  );
}
