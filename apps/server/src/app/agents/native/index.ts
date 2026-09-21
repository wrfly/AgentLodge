import * as models from '../../../core/db/models.js';
import { gatewayEnabled } from '../provider.js';
import type { AgentAdapter, EffortOption, ModelOption } from '../types.js';
import { runNativeTurn } from './runner.js';

const EFFORTS: EffortOption[] = [
  { id: '', label: 'Default' },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
  { id: 'xhigh', label: 'xhigh' },
  { id: 'max', label: 'max' },
];

async function availableModels(): Promise<ModelOption[]> {
  return models.names().map((id) => ({ id, label: id }));
}

export const nativeAdapter: AgentAdapter = {
  id: 'chat',
  displayName: 'Chat',
  needsContainer: false,
  bin: '',
  probe: async () => ({
    available: gatewayEnabled(),
    reason: gatewayEnabled() ? undefined : 'No upstream provider is enabled',
  }),
  models: availableModels,
  efforts: () => EFFORTS,
  run: runNativeTurn,
};
