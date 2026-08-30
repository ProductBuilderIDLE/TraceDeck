import { app, BrowserWindow, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import { IPC_CHANNELS } from '@shared/ipc';
import type { DataStore } from '../db';
import { AnalysisService } from '../services/analysisService';
import { createChangeReviewCoordinator } from '../services/changeReview/coordinator';
import { ProjectOperationRegistry } from '../services/projectOperations';
import { analysisHandlers } from './analysisHandlers';
import { projectHandlers } from './projectHandlers';
import { registerHandlers, registeredChannels } from './registry';
import { reportHandlers } from './reportHandlers';
import { reviewHandlers, type ReviewExportDependencies } from './reviewHandlers';
import { ruleHandlers } from './ruleHandlers';
import { scanHandlers } from './scanHandlers';
import { systemHandlers } from './systemHandlers';
import { extraHandlers } from './extraHandlers';

function reviewExportDependencies(): ReviewExportDependencies {
  return {
    async showSaveDialog(defaultFileName) {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      return window
        ? await dialog.showSaveDialog(window, { defaultPath: defaultFileName })
        : await dialog.showSaveDialog({ defaultPath: defaultFileName });
    },
    writeFile: (filePath, contents, encoding) => fs.writeFile(filePath, contents, encoding),
    generatedAt: () => new Date().toISOString(),
  };
}

export function registerAllHandlers(store: DataStore, databasePath: () => string): void {
  const analysis = new AnalysisService(store);
  const operations = new ProjectOperationRegistry();
  const review = createChangeReviewCoordinator(store, operations, app.getVersion());

  registerHandlers({
    ...projectHandlers(store, operations),
    ...scanHandlers(store, operations),
    ...reviewHandlers(store, review, reviewExportDependencies()),
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
