import { BrowserWindow } from 'electron';
import { SCAN_PROGRESS_EVENT } from '@shared/ipc';
import type { ScanProgress } from '@shared/types';
import type { DataStore } from '../db';
import { runScan, ScanCancelledError } from '../analysis/scanner';
import { ProjectOperationRegistry } from '../services/projectOperations';
import { watchProject, type WatchFactory } from '../services/watchService';
import { asObject, requireBoolean, requireInt } from '../utils/validation';
import { HandledError, type HandlerMap } from './registry';

function broadcastProgress(progress: ScanProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(SCAN_PROGRESS_EVENT, progress);
  }
}

function operationInProgress(kind: 'scan' | 'review'): HandledError {
  return kind === 'review'
    ? new HandledError('A change review is already running for this project.', 'REVIEW_IN_PROGRESS')
    : new HandledError('A scan is already running for this project.', 'SCAN_IN_PROGRESS');
}

async function runProjectScan(
  store: DataStore,
  operations: ProjectOperationRegistry,
  projectId: number,
  fullRescan: boolean,
): Promise<{ scanId: number }> {
  const active = operations.active(projectId);
  if (active) throw operationInProgress(active.kind);

  const project = store.projects.findById(projectId);
  if (!project) throw new HandledError('That project no longer exists.', 'NOT_FOUND');

  const lease = operations.acquire(projectId, 'scan');
  if (!lease) {
    const competing = operations.active(projectId);
    throw operationInProgress(competing?.kind ?? 'scan');
  }

  let scanId = -1;
  try {
    const scan = await runScan(store, {
      project,
      fullRescan,
      signal: lease.scanSignal,
      onProgress: (progress) => {
        broadcastProgress({ ...progress, scanId });
      },
    });
    scanId = scan.id;
    return { scanId: scan.id };
  } catch (error) {
    if (error instanceof ScanCancelledError) {
      throw new HandledError('Scan cancelled.', 'SCAN_CANCELLED');
    }
    throw error;
  } finally {
    lease.release();
  }
}

export function startWatchingForProject(
  store: DataStore,
  projectId: number,
  operations: ProjectOperationRegistry = new ProjectOperationRegistry(),
  watchFolder?: WatchFactory,
): void {
  const project = store.projects.findById(projectId);
  if (!project) return;
  watchProject(
    projectId,
    project.rootPath,
    () => {
      const scan = () => {
        void runProjectScan(store, operations, projectId, false).catch(() => undefined);
      };
      if (!operations.deferWatcherScan(projectId, scan)) scan();
    },
    watchFolder,
  );
}

export function scanHandlers(
  store: DataStore,
  operations: ProjectOperationRegistry = new ProjectOperationRegistry(),
): HandlerMap {
  return {
    'scan:start': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      const fullRescan = requireBoolean(value['fullRescan'], 'fullRescan');
      startWatchingForProject(store, projectId, operations);
      return runProjectScan(store, operations, projectId, fullRescan);
    },

    'scan:cancel': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);

      const active = operations.active(projectId);
      if (active?.kind !== 'scan') return { cancelled: false };

      // The scan loop checks this flag between files and unwinds at the next checkpoint.
      return { cancelled: operations.cancel(projectId, active.operationId) };
    },

    'scan:latest': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      return store.scans.latestForProject(projectId);
    },
  };
}
