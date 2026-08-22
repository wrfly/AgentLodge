import clsx from 'clsx';
import { useT } from '../lib/i18n';
import { AGENTS, navigate } from '../lib/route';
import { useAgents } from '../store/agents';
import type { AgentId } from '../lib/protocol';

export function AgentSwitcher({ current }: { current: AgentId }) {
  const t = useT();
  const agents = useAgents((s) => s.agents);
  const loaded = useAgents((s) => s.loaded);
  const enabled = useAgents((s) => s.enabled)();

  const shown = AGENTS.filter((a) => enabled.includes(a.id));

  // Nothing to switch between. A one-item switcher is a button that cannot do
  // anything, and it invites the question "where is the other one?" when the
  // answer is that this deployment does not offer one.
  if (shown.length < 2) return null;

  return (
    <div className="flex gap-0.5 rounded-lg bg-bubble p-0.5">
      {shown.map((a) => {
        const info = agents.find((x) => x.id === a.id);
        // Don't disable before the probe lands, or the control flashes grey
        const available = !loaded || (info?.availability.available ?? false);
        const active = current === a.id;

        return (
          <button
            key={a.id}
            // Still clickable when unavailable — the page explains why; blocking
            // the click just leaves you stuck with no reason given
            onClick={() => navigate(a.id)}
            title={
              available
                ? `${a.label}${info?.availability.version ? ` · ${info.availability.version}` : ''}`
                : (info?.availability.reason ?? t('{agent} is unavailable', { agent: a.label }))
            }
            className={clsx(
              'relative flex-1 rounded-md py-1.5 text-[12px] font-medium transition',
              active && 'bg-surface text-ink shadow-sm',
              !active && 'text-muted hover:text-ink',
              !available && !active && 'text-faint',
            )}
          >
            {a.id}
            {!available && (
              <span
                className="absolute top-1 right-1.5 size-1 rounded-full bg-faint"
                aria-label={t("Not connected")}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
