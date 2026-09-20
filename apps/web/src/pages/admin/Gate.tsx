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
  const [draft, setDraft] = useState({ max: '', perUser: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /**
   * Which boxes hold a number somebody is part-way through typing.
   *
   * The poll below refills them from the gate, and it used to do that unconditionally — every
   * five seconds, which is less time than it takes to type a limit and reach for the button.
   * So a typed 12 was overwritten by the limit already in force, and because the button is
   * disabled while the box and the gate agree, it went grey at the same moment: the page read
   * as "the limit turns itself back into 3", and the stored setting behind it was never even
   * asked to hold anything.
   *
   * Tracked per box rather than for the pair, so editing one limit does not also freeze the
   * other at whatever it said when the typing started. A ref rather than state because the
   * poll has to read the current value without being torn down and restarted for it, and
   * nothing renders differently.
   */
  const editing = useRef({ max: false, perUser: false });
  /**
   * Bumped by every write, so a poll that was already in flight when one landed is discarded.
   *
   * The poll runs every five seconds and a save takes a round trip, so the overlap is
   * ordinary rather than rare: the older response carries the pre-save numbers, and applying
   * it put the previous limit back in the box and the pre-save status behind it — which, with
   * the button greyed out because the two now agreed, read exactly like a save that had been
   * silently reverted.
   */
  const writes = useRef(0);

  const load = () => {
    const seen = writes.current;
    return admin
      .gate()
      .then((g) => {
        if (writes.current !== seen) return;
        setGate(g);
        // A change made from another console still lands in the boxes; only a half-typed one
        // is left alone. Both fields are absent when the gateway container cannot be reached,
        // and `String(undefined)` in a numeric field is worse than leaving it as it was.
        setDraft((d) => ({
          max: !editing.current.max && typeof g.max === 'number' ? String(g.max) : d.max,
          perUser:
            !editing.current.perUser && typeof g.perUser === 'number' ? String(g.perUser) : d.perUser,
        }));
      })
      .catch(() => {});
  };

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

  /**
   * What each box would write, or undefined where it still holds what the gate says.
   *
   * An empty box is not a limit either: without that guard the button offers to save NaN,
   * which the route refuses and `save()` would drop on the floor.
   */
  const pending = {
    maxConcurrency: draft.max && draft.max !== String(gate.max) ? Number(draft.max) : undefined,
    perUserInflightMax:
      draft.perUser && draft.perUser !== String(gate.perUser) ? Number(draft.perUser) : undefined,
  };
  const changed =
    pending.maxConcurrency !== undefined || pending.perUserInflightMax !== undefined;

  /**
   * A write, and then the full status again.
   *
   * The answer to a PATCH is the gateway's own — `{max, perUser, pinned, pools}` — and not
   * what `GET /api/admin/gate` assembles: no `containers` block, and pools by raw id rather
   * than by provider name. Installed as the whole status it made the card announce that
   * container isolation was off, which is a false claim about a security feature, until the
   * next poll five seconds later. So the reply is only checked, and the card is refilled by
   * the reload.
   *
   * `writes` is bumped first so a poll already in flight cannot land on top of the result.
   */
  const write = async (call: () => Promise<GateStatus>) => {
    setBusy(true);
    setErr(null);
    writes.current += 1;
    try {
      const next = await call();
      /*
       * A gateway that answered something other than 2xx comes back through `callGateway` as
       * a 200 carrying `{ error }`, so the promise resolves and this would otherwise read as
       * a saved limit. The row was still written — the route stores before it forwards — but
       * saying so while the gate cannot confirm it is how "it did not persist" starts.
       */
      if (next.error) throw new Error(next.error);
      /*
       * Saved, so what is in the boxes is the gate's own answer again and the poll may refill
       * them. Only on success: a refused write has to leave the numbers where the
       * administrator typed them, or the page throws away the thing it is asking them to
       * correct.
       */
      editing.current = { max: false, perUser: false };
      await load();
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

  const save = () =>
    // Only what moved. Sending both would file an audit entry claiming a limit was changed to
    // the value it already had, and one of the two is often deliberately left alone.
    // `JSON.stringify` drops the undefined half, so `pending` is already that body.
    changed ? write(() => admin.setGateLimits(pending)) : Promise.resolve();

  const setPinned = (v: boolean) => write(() => admin.setGatePinned(v));

  /** One of the two limits: its name over a narrow numeric box, with its own hint under it */
  const limitBox = (key: 'max' | 'perUser', label: string, hint: string) => (
    <label className="block max-w-[15rem]">
      <span className="mb-1 block text-[12px] font-medium text-muted">{label}</span>
      <div className="w-16">
        <Input
          value={draft[key]}
          onChange={(e) => {
            editing.current[key] = true;
            const v = e.target.value.replace(/[^\d]/g, '');
            setDraft((d) => ({ ...d, [key]: v }));
          }}
          /*
           * Leaving the box empty hands it back to the poll.
           *
           * Typing is what marks a box as being edited, and only a save cleared that — so a
           * box somebody emptied and then thought better of was frozen out of the refresh
           * with nothing in it, and could not be saved either, because an empty box is not a
           * limit and the button stays disabled. Nothing could reach the line that clears the
           * flag, so the real number was off the screen until the page was reloaded.
           */
          onBlur={() => {
            if (draft[key]) return;
            editing.current[key] = false;
            const live = key === 'max' ? gate.max : gate.perUser;
            if (typeof live === 'number') setDraft((d) => ({ ...d, [key]: String(live) }));
          }}
          inputMode="numeric"
        />
      </div>
      <span className="mt-1 block text-[11.5px] text-faint">{hint}</span>
    </label>
  );

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
    >
      {err && <Banner tone="error">{err}</Banner>}
      {/*
        * The gate's two limits, together and above the counters they explain.
        *
        * The per-user cap used to live on the System settings page, behind that page's
        * batched "N unsaved changes" save, while the ceiling had a box of its own up in this
        * card's header. One gate, two numbers, two pages and two save models — and the one
        * that is usually binding was the one a tab away from the in-flight and queued counts
        * that are the only way to watch it bind. A pool of twenty with two in flight and
        * eight queued is not a broken gate, it is one user at their own cap of two, and that
        * is only legible with both numbers in view.
        */}
      {/* Each hint under the box it describes, and taken from the setting that box writes —
          so the wording is the wording that was on the settings page, rather than a second
          description of the same numbers. Under rather than beside, because the row wraps on
          a narrow viewport and a shared line of hints would stop lining up with anything */}
      <div className="mb-3 flex flex-wrap items-start gap-x-5 gap-y-3 rounded-lg border border-line px-2.5 py-2">
        {limitBox(
          'max',
          t('Slots per upstream'),
          t('How many requests may be in flight to one upstream at once.'),
        )}
        {limitBox(
          'perUser',
          t('Slots one user may hold'),
          t('Per upstream, so a busy conversation cannot take the whole pool.'),
        )}
        <div>
          {/* An empty label in the same shape as the real ones, so the button lines up with
              the boxes rather than with their names — and stays lined up if those change */}
          <span className="mb-1 block text-[12px] font-medium" aria-hidden>
            &nbsp;
          </span>
          <Button onClick={() => void save()} loading={busy} disabled={!changed}>
            {t('Save')}
          </Button>
        </div>
      </div>
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
