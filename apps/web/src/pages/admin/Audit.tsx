/**
 * The console's own audit log.
 *
 * Split out of AdminPage.tsx, which had grown to 2700 lines; one file per tab now.
 */
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { admin, type AuditEntry } from '../../lib/api';
import { Button, Card, Empty, Spinner, fmtDate } from '../../components/ui';
import { useT } from '../../lib/i18n';

/* ---------------- Audit ---------------- */

export function Audit() {
  const t = useT();
  const [logs, setLogs] = useState<AuditEntry[] | null>(null);

  const load = () => admin.auditLogs(200).then(setLogs).catch(() => {});
  useEffect(() => {
    void load();
  }, []);

  if (!logs) return <Spinner />;

  return (
    <Card
      title={t('Audit log')}
      description={t('Most recent 200 entries')}
      actions={
        <Button onClick={() => void load()}>
          <RefreshCw size={13} />
          {t('Refresh')}
        </Button>
      }
    >
      {logs.length === 0 ? (
        <Empty text={t('Nothing recorded yet')} />
      ) : (
        <div className="space-y-0.5">
          {logs.map((l) => (
            <div key={l.id} className="flex gap-3 border-b border-line px-1 py-1.5 text-[12.5px] last:border-0">
              <span className="w-32 shrink-0 text-faint tabular-nums">{fmtDate(l.createdAt)}</span>
              <span className="w-44 shrink-0 font-mono">{l.action}</span>
              <span className="min-w-0 flex-1 truncate text-muted">
                {l.detail ? JSON.stringify(l.detail) : ''}
              </span>
              <span className="shrink-0 text-faint">{l.ip}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
