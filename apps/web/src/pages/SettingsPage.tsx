import { useEffect, useState } from 'react';
import { KeyRound, Laptop, LogOut, Smartphone } from 'lucide-react';
import { auth, me, type DeviceSession } from '../lib/api';
import { useAuth } from '../store/auth';
import { Banner, Button, Card, Field, Input, Page, Spinner, fmtDate } from '../components/ui';
import { useT } from '../lib/i18n';
import { ThemeToggle } from '../components/ThemeToggle';
import { LocaleToggle } from '../components/LocaleToggle';

function ChangePassword() {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current && next.length >= 8 && next === confirm && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await me.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setMsg({
        tone: 'success',
        text:
          res.revokedSessions > 0
            ? t('Password updated, and {n} other device(s) were signed out', { n: res.revokedSessions })
            : t('Password updated'),
      });
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('Change password')} description={t('Your other devices are signed out; this one stays signed in')}>
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      <form onSubmit={submit}>
        <Field label={t('Current password')}>
          <Input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label={t('New password')} hint={t('At least 8 characters, not all digits')}>
          <Input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label={t('Confirm new password')} error={mismatch ? t('The two entries do not match') : undefined}>
          <Input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!canSubmit}>
          <KeyRound size={13} />
          {t('Update password')}
        </Button>
      </form>
    </Card>
  );
}

function Devices() {
  const t = useT();
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setSessions(await auth.sessions());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const revoke = async (id: string) => {
    await auth.revokeSession(id).catch(() => {});
    void load();
  };

  return (
    <Card title={t('Signed-in devices')} description={t('See one you do not recognise? Sign it out')}>
      {error && <Banner tone="error">{error}</Banner>}
      {!sessions ? (
        <Spinner />
      ) : (
        <div className="space-y-1">
          {sessions.map((s) => {
            const Icon = s.platform === 'mobile' ? Smartphone : Laptop;
            return (
              <div
                key={s.id}
                className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5"
              >
                <Icon size={15} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px]">
                    <span>{t(s.platform === 'mobile' ? 'Mobile device' : 'Desktop browser')}</span>
                    {s.current && (
                      <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10.5px] text-accent">
                        {t('This device')}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[11.5px] text-faint">
                    {s.ip} · {t('last seen {when}', { when: fmtDate(s.lastSeenAt) })}
                  </div>
                </div>
                {!s.current && (
                  <Button variant="ghost" onClick={() => void revoke(s.id)}>
                    <LogOut size={12} />
                    {t('Sign out')}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function SettingsPage() {
  const t = useT();
  const user = useAuth((s) => s.user);
  if (!user) return null;

  return (
    <Page title={t('Account settings')}>
      <Card title={t('Profile')}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-[13.5px]">
          <dt className="text-muted">{t('Username')}</dt>
          <dd>{user.username}</dd>
          <dt className="text-muted">{t('Email')}</dt>
          <dd>{user.email}</dd>
          <dt className="text-muted">{t('Role')}</dt>
          <dd>{t(user.role === 'admin' ? 'Administrator' : 'Standard user')}</dd>
          <dt className="text-muted">{t('Signed up')}</dt>
          <dd>{fmtDate(user.createdAt)}</dd>
        </dl>
      </Card>

      <Card
        title={t('Preferences')}
        description={t('Stored on this device — they change nothing on the server')}
      >
        <div className="max-w-xs space-y-3">
          <Field label={t('Theme')}>
            <ThemeToggle />
          </Field>
          <Field label={t('Language')}>
            <LocaleToggle />
          </Field>
        </div>
      </Card>

      <ChangePassword />
      <Devices />
    </Page>
  );
}
