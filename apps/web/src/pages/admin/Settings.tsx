/**
 * System settings and the agents card.
 *
 * Split out of AdminPage.tsx, which had grown to 2700 lines; one file per tab now.
 */
import { useEffect, useState } from 'react';
import { Mail, ShieldCheck } from 'lucide-react';
import { admin, type SettingView, api, type AgentInfo } from '../../lib/api';
import type { AgentId } from '../../lib/protocol';
import {
  Banner,
  Button,
  Card,
  Field,
  Input,
  Select,
  Spinner,
  Toggle,
  tokensToM
} from '../../components/ui';
import { useT } from '../../lib/i18n';
import { CredentialsCard } from './Credentials';
import { ProvidersCard } from './Providers';
import { ModelsCard } from './Models';
import { AuditProxyCard } from './AuditProxy';
import { WithUnit } from './shared';
import { GateCard } from './Gate';

/* ---------------- System settings ---------------- */

/*
 * Tailwind needs the class in the source, so the spans are a map rather than a template.
 * Six columns, and a field that declares none takes the row.
 */
const SPAN: Record<NonNullable<SettingView['span']>, string> = {
  1: 'sm:col-span-1',
  2: 'sm:col-span-2',
  3: 'sm:col-span-3',
  4: 'sm:col-span-4',
  6: 'sm:col-span-6'
};

/**
 * Whether a field belongs to the choice that is currently made.
 *
 * The draft is read before the stored value, so the mail card follows the dropdown as it
 * moves rather than waiting for a save.
 */
function shownBy(settings: SettingView[], draft: Record<string, string>, s: SettingView): boolean {
  if (!s.showWhen) return true;
  const on = settings.find((x) => x.key === s.showWhen!.key);
  return s.showWhen.is.includes(draft[s.showWhen.key] ?? on?.value ?? '');
}

const GROUP_LABELS: Record<SettingView['group'], string> = {
  // The site address belongs in this group: all three of its uses build links in emails
  mail: 'Email and site address',
  quota: 'Quota',
  // Never rendered from here — the agents setting is hidden and has its own
  // card. The entry exists so the map stays total over the group union.
  agents: 'Agents'
};

/**
 * Which agents this deployment offers.
 *
 * Deliberately not a row in the generic settings list. That list renders a
 * setting as a text box, and this value is a set of ids where a typo makes an
 * agent silently vanish. It also needs to show, beside each toggle, whether
 * that agent's CLI is actually installed — the two questions get asked
 * together, and answering only one leaves an admin guessing.
 *
 * "Offered" and "installed" stay separate on purpose: a missing CLI is a fault
 * and says so; a disabled agent is a decision and simply does not appear.
 */
function AgentsCard() {
  const t = useT();
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.agents().then(setAgents).catch(() => {});

  useEffect(() => {
    void load();
  }, []);

  if (!agents) return null;

  const enabled = agents.filter((a) => a.enabled).map((a) => a.id);

  const toggle = async (id: AgentId, on: boolean) => {
    const next = on ? [...enabled, id] : enabled.filter((x) => x !== id);
    setBusy(true);
    setErr(null);
    try {
      // The server refuses an empty list. Surfacing its message beats inventing
      // our own — it is the side that decides.
      await admin.saveSettings({ 'agents.enabled': next.join(',') });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={t('Agents')}
      description={t('Which agents this deployment offers. Turning one off hides it everywhere; conversations already on it are kept but become unreachable.')}
    >
      {err && <Banner tone="error">{err}</Banner>}
      <div className="divide-y divide-line">
        {agents.map((a) => (
          /* Name, state and switch on one line: the state is a few words and had a line
             of its own under a name that was already short */
          <div key={a.id} className="flex items-center gap-2 py-1.5">
            <span className="shrink-0 text-[13.5px]">{a.displayName}</span>
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-faint">
              {a.enabled
                ? a.availability.available
                  ? (a.availability.version ?? t('CLI found'))
                  : (a.availability.reason ?? t('CLI not found'))
                : t('Off — not offered to users')}
            </span>
            <Toggle
              checked={a.enabled}
              disabled={busy || (a.enabled && enabled.length < 2)}
              onChange={(v) => void toggle(a.id, v)}
            />
          </div>
        ))}
      </div>
      {/* The switch on the last enabled agent is disabled. Without this line it just does
          not respond, which reads as a bug rather than a rule. */}
      <p className="mt-2 text-[11.5px] text-faint">
        {t('At least one has to stay on, so the last one cannot be switched off.')}
      </p>
    </Card>
  );
}

export function SettingsTab() {
  const t = useT();
  const [settings, setSettings] = useState<SettingView[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const load = () => admin.settings().then(setSettings).catch(() => {});

  useEffect(() => {
    void load();
  }, []);

  /*
   * A field the dropdown has moved away from is gone from the card, and its unsaved edit
   * goes with it. Hiding it while keeping the draft entry meant an edit nobody could see
   * was counted in "N unsaved changes", Discard threw it out along with the visible one
   * with no way to separate them, and Save wrote a value for a provider that is no longer
   * chosen — a Resend key stored while the card says smtp.
   */
  useEffect(() => {
    if (!settings) return;
    const stale = settings.filter((s) => draft[s.key] !== undefined && !shownBy(settings, draft, s));
    if (stale.length === 0) return;
    setDraft((d) => {
      const next = { ...d };
      for (const s of stale) delete next[s.key];
      return next;
    });
  }, [settings, draft]);

  if (!settings) return <Spinner />;

  const dirty = Object.keys(draft).length > 0;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      /*
       * A scaled field is typed in its own unit; the server stores and validates the other
       * one. Converting here rather than in the field keeps the draft as what was typed, so
       * a half-finished "1." does not become 1000000 while it is still being typed.
       */
      const patch = Object.fromEntries(
        Object.entries(draft).map(([key, value]) => {
          const scale = settings.find((s) => s.key === key)?.scale;
          if (!scale || value.trim() === '') return [key, value];
          return [key, String(Math.round(Number(value) * scale))];
        }),
      );
      setSettings(await admin.saveSettings(patch));
      setDraft({});
      setMsg({ tone: 'success', text: t('Saved') });
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const testMail = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await admin.testMail();
      setMsg({ tone: 'success', text: t('Test email sent to {to}', { to: res.to }) });
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const groups = [...new Set(settings.map((s) => s.group))];

  return (
    <>
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      {dirty && (
        <div className="sticky top-0 z-10 mb-4 flex items-center justify-between rounded-lg border border-accent/40 bg-accent-soft px-3 py-2">
          <span className="text-[13px]">{t('{n} unsaved changes', { n: Object.keys(draft).length })}</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setDraft({})}>
              {t('Discard')}
            </Button>
            <Button variant="primary" onClick={() => void save()} loading={busy}>
              {t('Save')}
            </Button>
          </div>
        </div>
      )}

      {/* Upstreams, the audit proxy and the gate used to live under Overview.
          Overview should be statistics only, so everything editable moved here. */}
      <AgentsCard />
      <CredentialsCard />
      <ProvidersCard />
      <ModelsCard />
      <AuditProxyCard />
      <GateCard />

      {groups.map((g) => (
        <Card
          key={g}
          title={t(GROUP_LABELS[g])}
          actions={
            g === 'mail' ? (
              <Button onClick={() => void testMail()} loading={busy}>
                <Mail size={13} />
                {t('Send a test email')}
              </Button>
            ) : undefined
          }
        >
          <div className="grid grid-cols-1 gap-x-3 gap-y-3.5 sm:grid-cols-6">
            {settings
            .filter((s) => s.group === g)
            /*
             * A field that belongs to another choice is not there at all, rather than
             * greyed out or annotated: the mail card asks for an API key or for a relay,
             * and which one follows the dropdown as it moves — the draft is read first,
             * so it follows before the page is even saved.
             */
            .filter((s) => shownBy(settings, draft, s))
            .map((s) => {
              const value = draft[s.key] ?? s.value;
              return (
                /* The label is the only child here, so its own bottom margin collapses
                   and the grid's gap is what separates the rows */
                <div key={s.key} className={SPAN[s.span ?? 6]}>
                <Field
                  label={t(s.label)}
                  hint={
                    s.hint
                      ? `${t(s.hint)}${s.source === 'env' ? ` ${t('(current value comes from an environment variable)')}` : ''}`
                      : s.source === 'env'
                        ? t('(current value comes from an environment variable)')
                        : undefined
                  }
                >
                  {s.type === 'boolean' ? (
                    <Toggle
                      checked={value === 'true'}
                      onChange={(v) => setDraft((d) => ({ ...d, [s.key]: String(v) }))}
                    />
                  ) : s.type === 'select' ? (
                    <Select
                      value={value}
                      onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}
                    >
                      {/* Written as they are stored: these are product names */}
                      {(s.options ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </Select>
                  ) : s.scale ? (
                    /* Typed in its own unit; what leaves here is still the stored one */
                    <WithUnit
                      className="block"
                      unit={s.unit ?? ''}
                      value={draft[s.key] ?? (s.value ? tokensToM(Number(s.value)) : '')}
                      onChange={(v) => setDraft((d) => ({ ...d, [s.key]: v }))}
                    />
                  ) : (
                    <Input
                      type={s.type === 'secret' ? 'password' : 'text'}
                      value={draft[s.key] ?? (s.type === 'secret' ? '' : s.value)}
                      placeholder={
                        s.type === 'secret' && s.isSet
                          ? t('Configured ({masked}); leave empty to keep it', { masked: s.value })
                          : ''
                      }
                      inputMode={s.type === 'number' ? 'decimal' : undefined}
                      onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}
                    />
                  )}
                </Field>
                </div>
              );
            })}
          </div>
        </Card>
      ))}

      <Card title={t('Note')}>
        <p className="text-[13px] leading-relaxed text-muted">
          <ShieldCheck size={13} className="mr-1 inline text-accent" />
          {t('API keys are stored AES-256-GCM encrypted, with the key derived from JWT_SECRET. Changing JWT_SECRET makes the stored keys undecryptable and they have to be entered again.')}
        </p>
      </Card>
    </>
  );
}
