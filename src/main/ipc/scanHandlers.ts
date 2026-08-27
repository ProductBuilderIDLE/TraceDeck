import { BrowserWindow } from 'electron';
import { SCAN_PROGRESS_EVENT } from '@shared/ipc';
import type { ScanProgress } from '@shared/types';
import type { DataStore } from '../db';
import { runScan, ScanCancelledError } from '../analysis/scanner';
import { asObject, requireBoolean, requireInt } from '../utils/validation';
import { HandledError, type HandlerMap } from './registry';

interface RunningScan {
  scanId: number;
  signal: { cancelled: boolean };
}

/** One scan per project at a time; a second request is rejected rather than queued. */
const running = new Map<number, RunningScan>();

function broadcastProgress(progress: ScanProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(SCAN_PROGRESS_EVENT, progress);
  }
}

export function scanHandlers(store: DataStore): HandlerMap {
  return {
    'scan:start': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      const fullRescan = requireBoolean(value['fullRescan'], 'fullRescan');

      if (running.has(projectId)) {
        throw new HandledError('A scan is already running for this project.', 'SCAN_IN_PROGRESS');
      }

      const project = store.projects.findById(projectId);
      if (!project) throw new HandledError('That project no longer exists.', 'NOT_FOUND');

      const signal = { cancelled: false };
      const pending: RunningScan = { scanId: -1, signal };
      running.set(projectId, pending);

      try {
        const scan = await runScan(store, {
          project,
          fullRescan,
          signal,
          onProgress: (progress) => {
            broadcastProgress({ ...progress, scanId: pending.scanId });
          },
        });
        pending.scanId = scan.id;
        return { scanId: scan.id };
      } catch (error) {
        if (error instanceof ScanCancelledError) {
          throw new HandledError('Scan cancelled.', 'SCAN_CANCELLED');
        }
        throw error;
      } finally {
        running.delete(projectId);
      }
    },

    'scan:cancel': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);

      const active = running.get(projectId);
      if (!active) return { cancelled: false };

      // The scan loop checks this flag between files and unwinds at the next checkpoint.
      active.signal.cancelled = true;
      return { cancelled: true };
    },

    'scan:latest': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      return store.scans.latestForProject(projectId);
    },
  };
}
