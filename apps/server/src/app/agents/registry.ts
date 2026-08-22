import { AGENT_IDS } from '../../core/protocol.js';
import { getList } from '../../core/db/settings.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import type {
  AgentAdapter,
  AgentAvailability,
  AgentId,
  EffortOption,
  ModelOption,
} from './types.js';

/**
 * The registered agents. Adding one is a matter of writing an adapter and listing it
 * here; authentication, conversation storage, SSE and quota are reused as they are.
 *
 */
const adapters: AgentAdapter[] = [claudeAdapter, codexAdapter];

const byId = new Map<AgentId, AgentAdapter>(adapters.map((a) => [a.id, a]));

/**
 * The agent catalogue, which the frontend's /claude and /codex routes follow.
 *
 * An entry here with no adapter is reported honestly as not wired up, so someone who
 * clicks it sees why rather than a button that does nothing.
 */
const CATALOG: Array<{ id: AgentId; displayName: string }> = [
  { id: 'claude', displayName: 'Claude Code' },
  { id: 'codex', displayName: 'Codex' },
];

export function getAdapter(id: AgentId): AgentAdapter | undefined {
  return byId.get(id);
}

/**
 * Which agents an administrator offers.
 *
 * A different question from whether the CLI is installed: adapter.probe() answers that,
 * and a missing CLI is a fault. This is an operational decision, and an agent that is not
 * offered should not appear at all. Hence the two are expressed separately; see
 * AgentInfo.enabled.
 *
 * With no valid value, fall back to offering everything. An empty setting would leave a
 * user with an interface containing no agent, whereas "all available" is at least a
 * working system. The write side validates (settings.ts), so this fallback should be
 * unreachable in normal operation.
 */
export function enabledAgentIds(): AgentId[] {
  const configured = getList('agents.enabled').filter((id): id is AgentId =>
    (AGENT_IDS as readonly string[]).includes(id),
  );
  return configured.length ? configured : [...AGENT_IDS];
}

export function isEnabledAgent(id: AgentId): boolean {
  return enabledAgentIds().includes(id);
}

/**
 * Which agent a new conversation defaults to.
 *
 * Not a hardcoded 'claude': in a deployment that only offers Codex, a constant would open
 * every new conversation on an agent that is switched off.
 */
export function defaultAgent(): AgentId {
  return enabledAgentIds()[0] ?? AGENT_IDS[0];
}

/** Being in the catalogue makes a route legal; whether it can actually run is the adapter's answer */
export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && CATALOG.some((a) => a.id === value);
}

export interface AgentInfo {
  id: AgentId;
  displayName: string;
  /** Whether an administrator offers it. A disabled one is not drawn at all, which is separate from whether it is installed. */
  enabled: boolean;
  availability: AgentAvailability;
  models: ModelOption[];
  efforts: EffortOption[];
}

let cache: { at: number; enabledKey: string; rows: AgentInfo[] } | null = null;

/**
 * Probe results are cached for 60s, so opening the page does not spawn a set of processes
 * every time.
 *
 * The cache key includes the enabled set: when an administrator flips a switch the result
 * has to change at once. Waiting for a 60-second expiry, they would think it had not saved
 * and click again.
 */
export async function listAgents(): Promise<AgentInfo[]> {
  const ids = enabledAgentIds();
  const enabledKey = ids.join(',');
  if (cache && cache.enabledKey === enabledKey && Date.now() - cache.at < 60_000) return cache.rows;
  const enabled = new Set(ids);
  const rows = await Promise.all(
    CATALOG.map(async (entry) => {
      const adapter = byId.get(entry.id);
      const on = enabled.has(entry.id);

      // A disabled agent is not probed: probing spawns a process, and spending that on an
      // agent we have decided not to offer buys nothing. It still appears in the list with
      // enabled=false, which is what lets the console's card draw the switch that turns it
      // back on.
      if (!on) {
        return {
          id: entry.id,
          displayName: entry.displayName,
          enabled: false,
          availability: { available: false, reason: 'Disabled by an administrator' },
          models: [],
          efforts: [],
        };
      }

      if (!adapter) {
        return {
          id: entry.id,
          displayName: entry.displayName,
          enabled: true,
          availability: { available: false, reason: 'No adapter is wired up yet' },
          models: [],
          efforts: [],
        };
      }
      const availability = await adapter.probe();
      return {
        id: entry.id,
        displayName: entry.displayName,
        enabled: true,
        availability,
        // With no CLI there is no point reading its model list
        models: availability.available ? await adapter.models() : [],
        efforts: availability.available ? adapter.efforts() : [],
      };
    }),
  );
  cache = { at: Date.now(), enabledKey, rows };
  return rows;
}
