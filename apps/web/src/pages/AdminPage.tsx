import clsx from 'clsx';
import { navigate, type AdminTab } from '../lib/route';
import { Page } from '../components/ui';
import { useT } from '../lib/i18n';
import { Overview } from './admin/Overview';
import { Users } from './admin/Users';
import { Invites } from './admin/Invites';
import { TraceLogs } from './admin/Traces';
import { SettingsTab } from './admin/Settings';
import { Audit } from './admin/Audit';

const TABS: Array<{ id: AdminTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'users', label: 'Users' },
  { id: 'invites', label: 'Invite codes' },
  { id: 'settings', label: 'System settings' },
  { id: 'trace_logs', label: 'Egress traces' },
  { id: 'audit', label: 'Audit log' },
];

/* ---------------- Shell ---------------- */

export function AdminPage({ tab }: { tab: AdminTab }) {
  const t = useT();
  return (
    <Page title={t('Admin console')}>
      <div className="mb-5 flex gap-1 border-b border-line">
        {/* Not `t` for the loop variable — that is the translator, and shadowing
            it here is exactly how these labels ended up untranslated. */}
        {TABS.map((item) => (
          <button
            key={item.id}
            onClick={() => navigate(`/admin/${item.id}`)}
            className={clsx(
              '-mb-px border-b-2 px-3 py-2 text-[13.5px] transition',
              tab === item.id
                ? 'border-accent font-medium text-ink'
                : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {t(item.label)}
          </button>
        ))}
      </div>

      {tab === 'overview' && <Overview />}
      {tab === 'users' && <Users />}
      {tab === 'invites' && <Invites />}
      {tab === 'settings' && <SettingsTab />}
      {tab === 'trace_logs' && <TraceLogs />}
      {tab === 'audit' && <Audit />}
    </Page>
  );
}
