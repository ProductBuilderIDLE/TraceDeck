import { IPC_CHANNELS } from '@shared/ipc';
import type { DataStore } from '../db';
import { AnalysisService } from '../services/analysisService';
import { analysisHandlers } from './analysisHandlers';
import { projectHandlers } from './projectHandlers';
import { registerHandlers, registeredChannels } from './registry';
import { reportHandlers } from './reportHandlers';
import { ruleHandlers } from './ruleHandlers';
import { scanHandlers } from './scanHandlers';
import { systemHandlers } from './systemHandlers';

export function registerAllHandlers(store: DataStore, databasePath: () => string): void {
  const analysis = new AnalysisService(store);

  registerHandlers({
    ...projectHandlers(store),
    ...scanHandlers(store),
    ...analysisHandlers(store, analysis),
    ...ruleHandlers(store),
    ...reportHandlers(store, analysis),
    ...systemHandlers(store, databasePath),
  });

  // A channel declared in the contract but never implemented would fail at runtime with an
  // opaque error, so the mismatch is caught here at startup instead.
  const missing = IPC_CHANNELS.filter((channel) => !registeredChannels().includes(channel));
  if (missing.length > 0) {
    throw new Error(`IPC channels declared but not implemented: ${missing.join(', ')}`);
  }
}
