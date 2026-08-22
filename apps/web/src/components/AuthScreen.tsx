import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { publicApi } from '../lib/api';
import { useAuth } from '../store/auth';
import { navigate } from '../lib/route';
import { AuthField, AuthShell, ErrorBox, SubmitButton } from '../pages/PublicPages';
import { useT } from '../lib/i18n';

type Mode = 'login' | 'forgot';

function ForgotForm({ onBack }: { onBack: () => void }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await publicApi.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <AuthShell title={t('Email sent')}>
        <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/8 px-3 py-2.5 text-[13px] leading-relaxed text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 size={13} className="mr-1 inline" />
          {t('If {email} is registered, a reset link is on its way. It is valid for 30 minutes.', { email })}
        </div>
        <button
          onClick={onBack}
          className="w-full rounded-lg border border-line py-2.5 text-[14px] hover:bg-bubble"
        >
          {t('Back to sign in')}
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('Reset your password')}
      subtitle={t('Enter the email you registered with and we will send a reset link')}
      footer={
        <button onClick={onBack} className="text-accent hover:underline">
          {t('Back to sign in')}
        </button>
      }
    >
      {error && <ErrorBox text={error} />}
      <form onSubmit={submit}>
        <AuthField
          label={t('Email')}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
        />
        <SubmitButton disabled={!email.trim()} loading={busy}>
          {t('Send reset link')}
        </SubmitButton>
      </form>
    </AuthShell>
  );
}

export function AuthScreen() {
  const t = useT();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useAuth((s) => s.login);
  const busy = useAuth((s) => s.busy);
  const error = useAuth((s) => s.error);
  const clearError = useAuth((s) => s.clearError);

  if (mode === 'forgot')
    return (
      <ForgotForm
        onBack={() => {
          clearError();
          setMode('login');
        }}
      />
    );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    void login(email, password);
  };

  return (
    <AuthShell
      title={t('Sign in')}
      subtitle={t('Sign in to continue')}
      footer={
        <>
          {t('No account yet?')}
          <button
            onClick={() => navigate('/register')}
            className="ml-1 text-accent hover:underline"
          >
            {t('Sign up with an invite code')}
          </button>
        </>
      }
    >
      {error && <ErrorBox text={error} />}
      <form onSubmit={submit}>
        <AuthField
          label={t('Email')}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
        />
        <AuthField
          label={t('Password')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <div className="mb-3.5 -mt-1 text-right">
          <button
            type="button"
            onClick={() => {
              clearError();
              setMode('forgot');
            }}
            className="text-[12.5px] text-muted hover:text-accent"
          >
            {t('Forgot your password?')}
          </button>
        </div>
        <SubmitButton disabled={!email.trim() || !password} loading={busy}>
          {t('Sign in')}
        </SubmitButton>
      </form>
    </AuthShell>
  );
}
