/**
 * The concurrency gate, per upstream, and the live limit.
 *
 * Split out of AdminPage.tsx, which had grown to 2700 lines; one file per tab now.
 */
import { useEffect, useRef, useState } from 'react';
import { Gauge, ShieldCheck } from 'lucide-react';
import { admin, type GateStatus } from '../../lib/api';
import { Banner, Button, Card, Input, Stat, Toggle } from '../../components/ui';
import { useT } from '../../lib/i18n';

/** Live state of the concurrency gate. The upstream's rate limit is a black box; this shows where AIMD has settled */
export function GateCard() {
  const t = useT();
  const [gate, setGate] = useState<GateStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /**
   * Whether the box holds a number somebody is part-way through typing.
   *
   * The poll below refills it from the gate, and it used to do that unconditionally — every
   * five seconds, which is less time than it takes to type a limit and reach for the button.
   * So a typed 12 was overwritten by the limit already in force, and because the button is
   * disabled while the box and the gate agree, it went grey at the same moment: the page read
   * as "the limit turns itself back into 3", and the stored setting behind it was never even
   * asked to hold anything.
   *
   * A ref rather than state because the poll has to read the current value without being torn
   * down and restarted for it, and nothing renders differently.
   */
  const editing = useRef(false);

  const load = () =>
    admin
      .gate()
      .then((g) => {
        setGate(g);
        // A change made from another console still lands in the box; only a half-typed one is
        // left alone. `max` is absent when the gateway container cannot be reached, and
        // `String(undefined)` in a numeric field is worse than leaving it as it was.
        if (!editing.current && typeof g.max === 'number') setDraft(String(g.max));
      })
      .catch(() => {});

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  if (!gate) return null;

  // Split across processes, the gate lives in the gateway container. Say so when
  // it is unreachable, or the UI reads as "concurrency 0"
  if (gate.unreachable) {
    return (
      <Card title={t('Concurrency gate')}>
        <p className="text-[13px] text-danger">{gate.error ?? t('cannot reach the gateway')}</p>
        <p className="mt-1 text-[12px] text-faint">
          {t('This is what it looks like when the gateway container is not up. Rate limiting still applies on that side; only the status is unreadable here.')}
        </p>
      </Card>
    );
  }

  const save = async () => {
    const n = Number(draft);
    if (!Number.isFinite(n)) return;
    setBusy(true);
    setErr(null);
    try {
      const next = await admin.setGateConcurrency(n);
      setGate(next);
      /*
       * Saved, so what is in the box is the gate's own answer again and the poll may refill
       * it. Only on success: a refused write has to leave the number where the administrator
       * typed it, or the page throws away the thing it is asking them to correct.
       */
      editing.current = false;
      if (typeof next.max === 'number') setDraft(String(next.max));
    } catch (e) {
      /*
       * Said out loud rather than swallowed. A rejected PATCH used to do nothing visible at
       * all — the box simply went back to the old limit on the next poll — which is
       * indistinguishable from a limit that does not persist, and is the first thing anybody
       * chasing that would want to see.
       */
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setPinned = async (v: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      setGate(await admin.setGatePinned(v));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // One pool per upstream, so a busy one cannot make the others queue. The totals are the
  // sum across them, which is what "how loaded is this deployment" means.
  const pools = gate.pools ?? [];
  const active = pools.reduce((n, p) => n + p.active, 0);
  const queued = pools.reduce((n, p) => n + p.queued, 0);
  const granted = pools.reduce((n, p) => n + p.totalGranted, 0);
  const throttledCount = pools.reduce((n, p) => n + p.totalThrottled, 0);
  const narrowed = pools.filter((p) => p.effectiveMax < p.max);
  const waitP95 = pools.length ? Math.max(...pools.map((p) => p.waitMsP95)) : 0;
  const waitP50 = pools.length ? Math.max(...pools.map((p) => p.waitMsP50)) : 0;

  return (
    <Card
      title={t('Metering gateway')}
      description={
        gate.enabled
          ? t('Every agent request upstream goes through it: per-call accounting, a hard quota gate, and a rate limit per upstream')
          : t('No model is configured, so conversations cannot start. Add an upstream and pull its models — the host CLI login is not used.')
      }
      actions={
        <div className="flex items-center gap-1.5">
          <div className="w-16">
            <Input
              value={draft}
              onChange={(e) => {
                editing.current = true;
                setDraft(e.target.value.replace(/[^\d]/g, ''));
              }}
              inputMode="numeric"
            />
          </div>
          {/* An empty box is not a limit: without this the button offers to save NaN, which
              the route refuses and save() drops on the floor */}
          <Button
            onClick={() => void save()}
            loading={busy}
            disabled={!draft || draft === String(gate.max)}
          >
            {t('Change limit')}
          </Button>
        </div>
      }
    >
      {err && <Banner tone="error">{err}</Banner>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('In flight')} value={String(active)} tone="accent" />
        <Stat label={t('Queued')} value={String(queued)} tone={queued > 0 ? 'danger' : undefined} />
        <Stat
          label={t('Upstreams in use')}
          value={String(pools.length)}
          sub={t('limit {n} each', { n: gate.max })}
          tone={narrowed.length ? 'danger' : undefined}
        />
        <Stat
          label={t('Wait p95')}
          value={waitP95 > 0 ? `${(waitP95 / 1000).toFixed(1)}s` : '0'}
          sub={`p50 ${(waitP50 / 1000).toFixed(1)}s`}
        />
      </div>

      {pools.length > 0 && (
        <div className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line">
          {pools.map((p) => (
            <div key={p.providerId} className="flex items-baseline gap-2 px-2.5 py-1.5 text-[11.5px]">
              <span className="truncate">{p.name ?? p.providerId}</span>
              <span className="ml-auto shrink-0 text-faint">
                {t('{active} in flight · {queued} queued', { active: p.active, queued: p.queued })}
                {p.effectiveMax < p.max
                  ? ` · ${t('throttled upstream — reduced from {n}', { n: p.max })}`
                  : ` · ${t('limit {n}', { n: p.effectiveMax })}`}
              </span>
            </div>
          ))}
        </div>
      )}
      {/*
        * The other half of "how many at once": whether the number in the box is a ceiling
        * the gate adapts under, or the number it runs at. Next to the box rather than on the
        * settings page, because on its own the box does not answer the question an operator
        * is actually asking when the gate says 12 and the rows say 2.
        */}
      <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <Toggle
          checked={!gate.pinned}
          onChange={(v) => void setPinned(!v)}
          disabled={busy}
          label={t('Adapt to the upstream')}
        />
        <span className="text-[12px] text-faint">
          {gate.pinned
            ? t('Pinned to the limit above; a rate-limited upstream is waited out, not answered by narrowing the gate')
            : t('A rate-limited upstream halves this gate; it climbs back after 20 clean responses')}
        </span>
      </div>

      <div className="mt-3 space-y-1.5 text-[12px] text-faint">
        <div className="flex items-center gap-1.5">
          <Gauge size={12} />
          {t('{granted} admitted in total · throttled upstream {throttled} times', {
            granted: granted.toLocaleString(),
            throttled: throttledCount,
          })}
          {narrowed.length > 0 && ` · ${t('recovers automatically after 20 consecutive successes')}`}
        </div>
        <div className="flex items-center gap-1.5">
          <ShieldCheck size={12} className={gate.containers?.ok ? 'text-emerald-500' : ''} />
          {t('Container isolation:')} {gate.containers?.enabled ? gate.containers.detail : t('off — agents run directly on the host')}
          {gate.containers?.enabled && gate.containers.ok
            ? ` · ${t('{n} containers running', { n: gate.containers.running })}`
            : ''}
        </div>
      </div>
    </Card>
  );
}
