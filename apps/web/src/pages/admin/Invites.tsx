/**
 * Invite codes and targeted invitations.
 *
 * Split out of AdminPage.tsx, which had grown to 2700 lines; one file per tab now.
 */
import { useEffect, useState } from 'react';
import { Check, Copy, Mail, Plus, Send, Trash2 } from 'lucide-react';
import { admin, type InviteCode } from '../../lib/api';
import {
  Banner,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Select,
  Spinner,
  fmtTokens,
  mToTokens,
} from '../../components/ui';
import { useT } from '../../lib/i18n';
import { WithUnit } from './shared';

/* ---------------- Invite codes ---------------- */

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </Button>
  );
}

export function Invites() {
  const t = useT();
  const [invites, setInvites] = useState<InviteCode[] | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [limit, setLimit] = useState('');
  const [days, setDays] = useState('7');
  const [role, setRole] = useState<'user' | 'admin'>('user');

  const load = () => admin.invites().then(setInvites).catch(() => {});

  useEffect(() => {
    void load();
  }, []);

  const sendEmail = async () => {
    if (!email.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await admin.emailInvite({
        email: email.trim(),
        presetTokenLimit: limit ? mToTokens(limit) : null,
        expiresInDays: Number(days) || 7,
        presetRole: role,
      });
      setEmail('');
      if (res.mail.sent) {
        setMsg({ tone: 'success', text: t('Invite email sent to {email}', { email: res.invite.email ?? '' }) });
      } else {
        setMsg({
          tone: 'warn',
          text: t('The email did not go out ({error}). Invite code {code} was created; you can forward the link yourself: {link}', {
            error: res.mail.error ?? '',
            code: res.invite.code,
            link: res.link ?? '',
          }),
        });
      }
      void load();
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const createPlain = async () => {
    setBusy(true);
    try {
      await admin.createInvites({
        count: 1,
        presetTokenLimit: limit ? mToTokens(limit) : null,
        expiresInDays: Number(days) || undefined,
        presetRole: role,
      });
      void load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <Card title={t('Send an invite')} description={t('With an address it emails the invite; without one it just creates a general-purpose code')}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <Field label={t('Email')}>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="someone@example.com"
              />
            </Field>
          </div>
          <div className="w-32">
            <Field label={t('Quota')}>
              <WithUnit
                className="block"
                unit="M"
                value={limit}
                onChange={(v) => setLimit(v.replace(/[^\d.]/g, ''))}
              />
            </Field>
          </div>
          <div className="w-24">
            <Field label={t('Valid for (days)')}>
              <Input
                value={days}
                onChange={(e) => setDays(e.target.value.replace(/[^\d]/g, ''))}
                inputMode="numeric"
              />
            </Field>
          </div>
          <div className="w-28">
            <Field label={t('Role')}>
              <Select value={role} onChange={(e) => setRole(e.target.value as 'user' | 'admin')}>
                <option value="user">{t('Standard user')}</option>
                <option value="admin">{t('Administrator')}</option>
              </Select>
            </Field>
          </div>
          <div className="flex gap-2 pb-3.5">
            <Button variant="primary" onClick={() => void sendEmail()} loading={busy} disabled={!email.trim()}>
              <Send size={13} />
              {t('Send email')}
            </Button>
            <Button onClick={() => void createPlain()} disabled={busy}>
              <Plus size={13} />
              {t('Just create a code')}
            </Button>
          </div>
        </div>
      </Card>

      <Card title={t('Invite codes')}>
        {!invites ? (
          <Spinner />
        ) : invites.length === 0 ? (
          <Empty text={t('No invite codes yet')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-faint">
                  <th className="pb-2 font-medium">{t('Code')}</th>
                  <th className="pb-2 font-medium">{t('Bound to')}</th>
                  <th className="pb-2 font-medium">{t('Quota')}</th>
                  <th className="pb-2 font-medium">{t('Used')}</th>
                  <th className="pb-2 font-medium">{t('Status')}</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {invites.map((i) => {
                  const expired = i.expiresAt && new Date(i.expiresAt) < new Date();
                  const exhausted = i.usedCount >= i.maxUses;
                  return (
                    <tr key={i.id} className="border-b border-line last:border-0">
                      <td className="py-2 font-mono text-[12.5px]">{i.code}</td>
                      <td className="py-2 text-muted">
                        {i.email ? (
                          <span className="flex items-center gap-1">
                            <Mail size={11} className="text-faint" />
                            {i.email}
                            {i.sentAt && <Check size={11} className="text-emerald-500" />}
                          </span>
                        ) : (
                          <span className="text-faint">{t('general')}</span>
                        )}
                      </td>
                      <td className="py-2 font-mono text-[12px] tabular-nums">
                        {i.presetTokenLimit ? fmtTokens(i.presetTokenLimit) : t('unlimited')}
                      </td>
                      <td className="py-2 tabular-nums">
                        {i.usedCount}/{i.maxUses}
                      </td>
                      <td className="py-2">
                        {i.disabled ? (
                          <span className="text-faint">{t('disabled')}</span>
                        ) : exhausted ? (
                          <span className="text-faint">{t('used up')}</span>
                        ) : expired ? (
                          <span className="text-faint">{t('expired')}</span>
                        ) : (
                          <span className="text-emerald-600 dark:text-emerald-400">{t('available')}</span>
                        )}
                      </td>
                      <td className="py-2">
                        <div className="flex justify-end gap-1">
                          <CopyButton text={i.code} />
                          {!i.disabled && (
                            <Button
                              variant="ghost"
                              onClick={() => void admin.disableInvite(i.id).then(load)}
                            >
                              <Trash2 size={12} />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
