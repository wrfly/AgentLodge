/**
 * The models table: what users may pick, and which upstream serves each.
 *
 * Split out of AdminPage.tsx, which had grown to 2700 lines; one file per tab now.
 */
import { Fragment, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { factsFor, price } from '../../lib/model-facts';
import { admin, type Model, type ModelInput } from '../../lib/api';
import {
  Banner,
  Button,
  Card,
  Field,
  Input,
  Select,
  Toggle,
  fmtTokens
} from '../../components/ui';
import { useT } from '../../lib/i18n';

/**
 * The hourly model refresh, at the foot of the models card.
 *
 * It is one global setting rather than a field on each provider: the picker is the union of
 * every upstream, so the hourly pass asks all of them. It lives here rather than in the
 * generic settings list so it sits next to the list it fills, and next to the button that
 * does the same thing by hand.
 */
function AutoRefreshModels() {
  const t = useT();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    admin.providers().then((d) => setOn(d.autoRefreshModels)).catch(() => {});
  }, []);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await admin.saveSettings({ 'agents.autoRefreshModels': String(next) });
      setOn(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 border-t border-line pt-3">
      {err && <Banner tone="error">{err}</Banner>}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px]">{t('Refresh the model list hourly')}</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-faint">
            {t('Asks every upstream what models it has, once an hour, and adds the names that are missing. Nothing is removed or reordered, and a model turned off stays off. Either way the "Pull from all upstreams" button still works.')}
          </div>
        </div>
        <Toggle checked={on} disabled={busy} onChange={(v) => void toggle(v)} />
      </div>
    </div>
  );
}


/* ---------------- Models ---------------- */

/**
 * The model catalogue.
 *
 * This is the routing table users see. A row makes a name pickable, and the upstream on
 * that row is where a request carrying the name goes. The same name can appear more than
 * once — one model offered by two upstreams, at two prices — and the lowest priority is
 * the one that gets used; the rest are what a failover would reach for.
 */
export function ModelsCard() {
  const t = useT();
  const [rows, setRows] = useState<Model[] | null>(null);
  const [providers, setProviders] = useState<Array<{ id: string; name: string; kind: string }>>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModelInput>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = () =>
    admin.models().then((d) => { setRows(d.models); setProviders(d.providers); }).catch(() => {});

  useEffect(() => { void load(); }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await load();
      setEditing(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pullable = providers.filter((p) => p.kind !== 'mock' && p.kind !== 'local-agent');

  const pull = async () => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const r = await admin.pullModels();
      setRows(r.models);
      const failed = (r.providers ?? []).filter((p) => p.error);
      const bits = [
        r.added > 0
          ? t('{n} added', { n: r.added })
          : failed.length === 0
            ? t('nothing new')
            : null,
        ...failed.map((p) => t('{name}: {error}', { name: p.name, error: p.error ?? '' })),
      ].filter(Boolean);
      setNote(bits.join(' · '));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!rows) return null;

  const providerName = (id: string): string => providers.find((p) => p.id === id)?.name ?? id;
  /** A name with more than one row is served by more than one upstream */
  const shared = new Set(
    rows.map((m) => m.name).filter((name, i, all) => all.indexOf(name) !== i),
  );

  const startEdit = (m?: Model) => {
    setEditing(m?.id ?? 'new');
    setDraft(
      m
        ? { name: m.name, providerId: m.providerId, upstreamName: m.upstreamName, priority: m.priority, note: m.note }
        : { name: '', providerId: providers[0]?.id ?? '', upstreamName: '', priority: 0 },
    );
  };

  return (
    <Card
      title={t('Models')}
      description={t('What users can pick. One name on two upstreams is two rows, lowest priority first.')}
      actions={
        pullable.length > 0 ? (
          <Button disabled={busy} onClick={() => void pull()}>
            <RefreshCw size={13} className={clsx(busy && 'animate-spin')} />
            {t('Pull from all upstreams')}
          </Button>
        ) : undefined
      }
    >
      {err && <Banner tone="error">{err}</Banner>}

      {providers.length === 0 ? (
        <div className="text-[12px] text-faint">{t('Add an upstream first — a model has to name one.')}</div>
      ) : (
        <>
          {rows.length === 0 ? (
            <div className="text-[12px] text-faint">
              {pullable.length
                ? t('Nothing here yet. Pull from all upstreams to fill the list.')
                : t('Nothing here yet.')}
            </div>
          ) : (
            /* A table, because every column but the first is a number to compare down the
               column. What the vendor publishes about a name is in lib/model-facts. */
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] font-normal text-faint">
                    <th className="py-1.5 pr-3 font-normal">{t('Model')}</th>
                    <th className="py-1.5 pr-3 font-normal">{t('Upstream')}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{t('Context')}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{t('Max output')}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{t('In / out per MTok')}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{t('SWE-bench')}</th>
                    <th className="py-1.5 font-normal" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((m) => {
                    const f = factsFor(m.name);
                    return (
                      <Fragment key={m.id}>
                        <tr>
                          <td className="py-1.5 pr-3">
                            <span className={clsx(m.enabled ? 'font-medium' : 'text-faint line-through')}>
                              {m.name}
                            </span>
                            {shared.has(m.name) && (
                              <span className="ml-1.5 text-[11px] text-faint">
                                {t('priority {n}', { n: m.priority })}
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 pr-3 text-faint">
                            {providerName(m.providerId)}
                            {m.upstreamName && ` · ${t('sent as {name}', { name: m.upstreamName })}`}
                            {m.note && ` · ${m.note}`}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-faint">
                            {f ? fmtTokens(f.context) : '—'}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-faint">
                            {f?.maxOutput ? fmtTokens(f.maxOutput) : '—'}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-faint">
                            {f?.inPrice !== undefined && f.outPrice !== undefined ? (
                              <span title={f.note}>
                                {`${price(f.inPrice, f.currency)} / ${price(f.outPrice, f.currency)}`}
                                {f.note && <span className="ml-1 text-[10px]">*</span>}
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-faint">
                            {f?.swe !== undefined ? `${f.swe}%` : '—'}
                          </td>
                          <td className="py-1.5">
                            <div className="flex items-center justify-end gap-1">
                              <Toggle
                                checked={m.enabled}
                                disabled={busy}
                                onChange={(v) => void run(() => admin.updateModel(m.id, { enabled: v }))}
                              />
                              <Button variant="ghost" onClick={() => startEdit(m)}>{t('Edit')}</Button>
                              <Button variant="ghost" disabled={busy} onClick={() => void run(() => admin.deleteModel(m.id))}>
                                {t('Delete')}
                              </Button>
                            </div>
                          </td>
                        </tr>
                        {editing === m.id && (
                          <tr>
                            <td colSpan={7} className="pb-2">
                              <ModelForm
                                draft={draft}
                                setDraft={setDraft}
                                providers={providers}
                                busy={busy}
                                onSave={() => void run(() => admin.updateModel(m.id, draft))}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-1.5 text-[11px] text-faint">
                {t('Vendor figures, not what this deployment bills.')}
              </p>
            </div>
          )}

          {editing === 'new' ? (
            <div className="mt-2 rounded-lg border border-line p-2.5">
              <ModelForm
                draft={draft}
                setDraft={setDraft}
                providers={providers}
                busy={busy}
                onSave={() => void run(() => admin.createModel(draft))}
              />
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button variant="ghost" onClick={() => startEdit()}>{t('+ Add model')}</Button>
              {note && <span className="text-[11.5px] text-muted">{note}</span>}
            </div>
          )}
          <AutoRefreshModels />
        </>
      )}
    </Card>
  );
}

function ModelForm({
  draft, setDraft, providers, busy, onSave
}: {
  draft: ModelInput;
  setDraft: (d: ModelInput) => void;
  providers: Array<{ id: string; name: string; kind: string }>;
  busy: boolean;
  onSave: () => void;
}) {
  const t = useT();
  return (
    <div className="mt-2.5 space-y-2 border-t border-line pt-2.5">
      <Field label={t('Name')} hint={t('What users pick, and what the price table and every report are keyed by.')}>
        <Input
          value={draft.name ?? ''}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="deepseek-v4-pro"
          spellCheck={false}
        />
      </Field>
      <Field label={t('Upstream')}>
        <Select value={draft.providerId ?? ''} onChange={(e) => setDraft({ ...draft, providerId: e.target.value })}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </Field>
      <Field label={t('Name upstream')} hint={t('Only when the upstream calls it something else. Empty means the two match.')}>
        <Input
          value={draft.upstreamName ?? ''}
          onChange={(e) => setDraft({ ...draft, upstreamName: e.target.value })}
          placeholder={draft.name ?? ''}
          spellCheck={false}
        />
      </Field>
      <Field label={t('Priority')} hint={t('Lowest first among the upstreams offering this name.')}>
        <Input
          value={String(draft.priority ?? 0)}
          onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value.replace(/[^\d]/g, '')) || 0 })}
          inputMode="numeric"
          className="w-24"
        />
      </Field>
      <Field label={t('Note')}>
        <Input value={draft.note ?? ''} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder={t('optional')} />
      </Field>
      <div className="flex gap-2">
        <Button onClick={onSave} disabled={busy || !draft.name?.trim() || !draft.providerId}>{t('Save')}</Button>
      </div>
    </div>
  );
}
