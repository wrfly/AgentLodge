/**
 * Model setup: credentials, upstreams, the catalogue, and what each name costs.
 *
 * These four used to sit on System settings, under mail and quota. They are the routing
 * table a turn actually uses, so they have a tab of their own — System settings is the
 * rest of the deployment (agents, the gate, mail, ceilings).
 */
import { CredentialsCard } from './Credentials';
import { ProvidersCard } from './Providers';
import { ModelsCard } from './Models';
import { PricingCard } from './Pricing';

export function ModelSetupTab() {
  return (
    <>
      <CredentialsCard />
      <ProvidersCard />
      <ModelsCard />
      <PricingCard />
    </>
  );
}
