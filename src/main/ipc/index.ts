import { app } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type { DataStore } from '../db';
import { AnalysisService } from '../services/analysisService';
import {
  ChangeReviewCoordinator,
  defaultChangeReviewCoordinatorDependencies,
} from '../services/changeReview/coordinator';
import { ProjectOperationRegistry } from '../services/projectOperations';
import { analysisHandlers } from './analysisHandlers';
import { projectHandlers } from './projectHandlers';
import { registerHandlers, registeredChannels } from './registry';
import { reportHandlers } from './reportHandlers';
import { reviewHandlers } from './reviewHandlers';
import { ruleHandlers } from './ruleHandlers';
import { scanHandlers } from './scanHandlers';
import { systemHandlers } from './systemHandlers';
import { extraHandlers } from './extraHandlers';

export function registerAllHandlers(store: DataStore, databasePath: () => string): void {
  const analysis = new AnalysisService(store);
  const operations = new ProjectOperationRegistry();
  const review = new ChangeReviewCoordinator(
    store,
    operations,
    defaultChangeReviewCoordinatorDependencies(app.getVersion()),
  );

  registerHandlers({
    ...projectHandlers(store, operations),
    ...scanHandlers(store, operations),
    ...reviewHandlers(store, review),
    ...analysisHandlers(store, analysis),
    ...ruleHandlers(store),
    ...reportHandlers(store, analysis),
    ...systemHandlers(store, databasePath),
    ...extraHandlers(store, analysis),
  });

  // A channel declared in the contract but never implemented would fail at runtime with an
  // opaque error, so the mismatch is caught here at startup instead.
  const missing = IPC_CHANNELS.filter((channel) => !registeredChannels().includes(channel));
  if (missing.length > 0) {
    throw new Error(`IPC channels declared but not implemented: ${missing.join(', ')}`);
  }
}
