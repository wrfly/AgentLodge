import * as audit from '../core/db/audit.js';
import * as modelsRepo from '../core/db/models.js';
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

async function refreshOnce(
  egressFor: (p: providersRepo.Provider, apiKey: string) => Egress,
  log: (msg: string) => void,
): Promise<void> {
  if (!getBoolFresh('agents.autoRefreshModels')) return;

  // Every provider that can be asked, not one of them: with several upstreams live at
  // once, refreshing only one would leave the rest of the picker frozen at whatever was
  // configured by hand.
  for (const provider of providersRepo.list()) {
    if (provider.kind === 'mock' || provider.kind === 'local-agent') continue;

    const apiKey = (await providersRepo.secretOf(provider.id)) ?? '';
    if (!apiKey) continue;

    const result = await fetchModels(provider, apiKey, egressFor(provider, apiKey));
    if (result.error || result.models.length === 0) {
      log(`model refresh: ${provider.name} — ${result.error ?? 'no models'}`);
      continue;
    }

    // Only additions. A name somebody turned off stays off, an order somebody set stays,
    // and a name that vanished upstream for a minute does not empty anybody's picker.
    const added = modelsRepo.addMissing(provider.id, result.models);
    if (added === 0) continue;

    audit.log({
      action: 'provider.models.refresh',
      targetType: 'provider',
      targetId: provider.id,
      detail: { added, models: result.models },
    });
    log(`model refresh: ${provider.name} — ${added} new model(s)`);
  }
}

/**
 * @param egressFor how a request to this provider should leave — the audit proxy when one is
 * configured. Passed in rather than imported so this file has no opinion about egress. It
 * is handed the key as well, because resolving one can mean a call to the credential
 * manager and doing it twice would mean two.
 */
export function startModelRefresh(
  egressFor: (p: providersRepo.Provider, apiKey: string) => Egress,
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
