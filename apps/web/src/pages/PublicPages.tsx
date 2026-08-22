import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { publicApi } from '../lib/api';
import { useAuth } from '../store/auth';
import { navigate } from '../lib/route';
import { useT } from '../lib/i18n';

/** Narrow column shared by sign-in, sign-up and reset */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-accent-soft">
            <Sparkles size={20} className="text-accent" />
          </div>
          <h1 className="text-[21px] font-semibold tracking-tight">AgentLodge</h1>
          {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
        </div>
        <h2 className="mb-4 text-center text-[15px] font-medium">{title}</h2>
        {children}
        {footer && <div className="mt-5 text-center text-[13px] text-muted">{footer}</div>}
      </div>
    </div>
  );
}

export function AuthField({
  label,
  hint,
  error,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  return (
    <label className="mb-3.5 block">
      <span className="mb-1.5 block text-[13px] font-medium text-muted">{label}</span>
      <input
        {...props}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] outline-none transition placeholder:text-faint focus:border-accent/60 disabled:opacity-60"
      />
      {error ? (
        <span className="mt-1 block text-[11.5px] text-danger">{error}</span>
      ) : (
        hint && <span className="mt-1 block text-[11.5px] text-faint">{hint}</span>
      )}
    </label>
  );
}

export function SubmitButton({
  children,
  disabled,
  loading,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      type="submit"
      disabled={disabled || loading}
      className={clsx(
        'flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-[14.5px] font-medium transition',
        !disabled && !loading
          ? 'bg-accent text-white hover:opacity-90'
          : 'cursor-not-allowed bg-bubble text-faint',
      )}
    >
      {loading && <Loader2 size={15} className="animate-spin" />}
      {children}
    </button>
  );
}

export function ErrorBox({ text }: { text: string }) {
  return (
    <div className="mb-3.5 rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[13px] text-danger">
      {text}
    </div>
  );
}

/* ---------------- Sign-up by invite ---------------- */

export function RegisterPage({ code, email: presetEmail }: { code?: string; email?: string }) {
  const t = useT();
  const [email, setEmail] = useState(presetEmail ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState(code ?? '');
  const [checking, setChecking] = useState(Boolean(code));
  const [inviteInfo, setInviteInfo] = useState<{
    valid: boolean;
    reason?: string;
    email?: string;
    tokenLimit?: number | null;
  } | null>(null);

  const register = useAuth((s) => s.register);
  const busy = useAuth((s) => s.busy);
  const error = useAuth((s) => s.error);

  // The emailed link carries the code; check it once on arrival so an invalid
  // one is reported early rather than at submit
  useEffect(() => {
    if (!code) return;
    void publicApi
      .checkInvite(code)
      .then((info) => {
        setInviteInfo(info);
        if (info.email) setEmail(info.email);
      })
      .catch(() => setInviteInfo({ valid: false, reason: t('Invalid invite code') }))
      .finally(() => setChecking(false));
  }, [code]);

  const canSubmit =
    email.trim() && username.trim().length >= 2 && password.length >= 8 && inviteCode.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    const ok = await register({ email, username, password, inviteCode });
    if (ok) navigate('/claude', true);
  };

  if (checking) {
    return (
      <AuthShell title={t('Checking the invite…')}>
        <div className="flex justify-center py-6 text-faint">
          <Loader2 size={20} className="animate-spin" />
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('Create an account')}
      subtitle={t('Sign up with an invite code')}
      footer={
        <>
          {t('Already have an account?')}
          <button onClick={() => navigate('/claude')} className="ml-1 text-accent hover:underline">
            {t('Sign in')}
          </button>
        </>
      }
    >
      {inviteInfo && !inviteInfo.valid && <ErrorBox text={inviteInfo.reason ?? t('Invalid invite code')} />}
      {inviteInfo?.valid && (
        <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/8 px-3 py-2 text-[13px] text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 size={13} className="mr-1 inline" />
          {t('Invite is valid')}
          {inviteInfo.tokenLimit != null &&
            ` · ${t('quota {n} tokens/month', { n: inviteInfo.tokenLimit.toLocaleString() })}`}
        </div>
      )}
      {error && <ErrorBox text={error} />}

      <form onSubmit={submit}>
        <AuthField
          label={t('Email')}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={Boolean(inviteInfo?.email)}
          hint={inviteInfo?.email ? t('This invite code is bound to that address') : undefined}
          required
        />
        <AuthField
          label={t('Username')}
          value={username}
          autoComplete="nickname"
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t('2–24 characters')}
          required
        />
        <AuthField
          label={t('Password')}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={t('At least 8 characters, not all digits')}
          required
        />
        <AuthField
          label={t('Invite code')}
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
          placeholder="XXXX-XXXX-XXXX"
          autoCapitalize="characters"
          spellCheck={false}
          required
        />
        <SubmitButton disabled={!canSubmit} loading={busy}>
          {t('Sign up')}
        </SubmitButton>
      </form>
    </AuthShell>
  );
}

/* ---------------- Password reset ---------------- */

export function ResetPasswordPage({ token }: { token?: string }) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = Boolean(token) && password.length >= 8 && password === confirm;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      await publicApi.resetPassword(token!, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthShell title={t('Invalid link')}>
        <ErrorBox text={t('The reset link is missing a parameter — request a new one.')} />
        <SubmitButton>
          <span onClick={() => navigate('/claude')}>{t('Back to sign in')}</span>
        </SubmitButton>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell title={t('Password reset')}>
        <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/8 px-3 py-2.5 text-[13px] text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 size={13} className="mr-1 inline" />
          {t('Every device has been signed out. Sign in again with the new password.')}
        </div>
        <button
          onClick={() => navigate('/claude')}
          className="w-full rounded-lg bg-accent py-2.5 text-[14.5px] font-medium text-white hover:opacity-90"
        >
          {t('Sign in')}
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t('Set a new password')}>
      {error && <ErrorBox text={error} />}
      <form onSubmit={submit}>
        <AuthField
          label={t('New password')}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={t('At least 8 characters, not all digits')}
          required
        />
        <AuthField
          label={t('Confirm new password')}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={mismatch ? t('The two entries do not match') : undefined}
          required
        />
        <SubmitButton disabled={!canSubmit} loading={busy}>
          {t('Reset password')}
        </SubmitButton>
      </form>
    </AuthShell>
  );
}
