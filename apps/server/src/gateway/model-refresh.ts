import * as audit from '../core/db/audit.js';
import * as providersRepo from '../core/db/providers.js';
import { getBoolFresh } from '../core/db/settings.js';
import { fetchModels } from './models.js';

/**
 * Keeping the model list current without anybody editing it.
 *
 * A new model appears upstream and the picker does not know about it until an administrator
 * types the name in. Asking once an hour closes that gap — and asking has to happen **here**,
 * because the key that authorises the question only exists in this process.
 *
 * Two decisions worth stating:
 *
 * - **The active provider only.** That is the one the picker draws from. Configuring another
 *   is a thing an administrator is doing at that moment, with the button in front of them;
 *   polling every upstream on the off chance is traffic and key exposure for nothing.
 *
 * - **A failure changes nothing.** A compatibility layer that has no model list answers 404
 *   every hour; emptying the list on that would take a working picker away over a question
 *   the upstream was never able to answer.
 */

/** Hourly, as the setting's label says */
const EVERY_MS = 60 * 60_000;

/**
 * Long enough after boot that a compose stack has finished coming up, short enough that a
 * fresh deployment is not an hour behind.
 */
const FIRST_MS = 30_000;

/** Reused from the console's button, so both go out under the same audit rules */
type Egress = Parameters<typeof fetchModels>[2];

async function refreshOnce(egressFor: (p: providersRepo.Provider) => Egress, log: (msg: string) => void): Promise<void> {
  if (!getBoolFresh('agents.autoRefreshModels')) return;

  const provider = providersRepo.active();
  if (!provider) return;

  const apiKey = providersRepo.secretOf(provider.id) ?? '';
  const result = await fetchModels(provider, apiKey, egressFor(provider));
  if (result.error || result.models.length === 0) {
    log(`model refresh: ${provider.name} — ${result.error ?? 'no models'}`);
    return;
  }

  // Same list, same order: nothing to write, and updated_at should not move every hour
  if (result.models.join(',') === provider.models.join(',')) return;

  providersRepo.update(provider.id, { models: result.models });
  audit.log({
    action: 'provider.models.refresh',
    targetType: 'provider',
    targetId: provider.id,
    detail: { before: provider.models, after: result.models },
  });
  log(`model refresh: ${provider.name} — ${provider.models.length} → ${result.models.length} models`);
}

/**
 * @param egressFor how a request to this provider should leave — the audit proxy when one is
 * configured. Passed in rather than imported so this file has no opinion about egress.
 */
export function startModelRefresh(
  egressFor: (p: providersRepo.Provider) => Egress,
  log: (msg: string) => void,
): void {
  const tick = (): void => {
    void refreshOnce(egressFor, log).catch((e: unknown) => log(`model refresh failed: ${String(e)}`));
  };
  // unref so this never holds the process open, the same way every other timer here does not
  setTimeout(tick, FIRST_MS).unref();
  setInterval(tick, EVERY_MS).unref();
}

/** Exported for the tests: one pass, no timers */
export { refreshOnce };
