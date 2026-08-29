import { basename } from 'node:path';
import { promises as fs } from 'node:fs';
import { BrowserWindow, dialog } from 'electron';
import type { OpenProjectResult } from '@shared/ipc';
import { DEFAULT_PROJECT_CONFIGURATION, type ProjectConfiguration } from '@shared/types';
import type { DataStore } from '../db';
import {
  asObject,
  expectVoid,
  requireBoolean,
  requireInt,
  requireStringArray,
} from '../utils/validation';
import { startWatchingForProject } from './scanHandlers';
import { forgetPreviewContext } from '../services/previewService';
import type { ProjectOperationRegistry } from '../services/projectOperations';
import { stopWatching } from '../services/watchService';
import { HandledError, type HandlerMap } from './registry';

function parseConfiguration(raw: unknown): ProjectConfiguration {
  const value = asObject(raw, 'configuration');
  return {
    excludePatterns: requireStringArray(
      value['excludePatterns'] ?? [],
      'configuration.excludePatterns',
      200,
    ),
    entryPoints: requireStringArray(value['entryPoints'] ?? [], 'configuration.entryPoints', 200),
    respectGitignore: requireBoolean(
      value['respectGitignore'] ?? DEFAULT_PROJECT_CONFIGURATION.respectGitignore,
      'configuration.respectGitignore',
    ),
    includeTestFiles: requireBoolean(
      value['includeTestFiles'] ?? DEFAULT_PROJECT_CONFIGURATION.includeTestFiles,
      'configuration.includeTestFiles',
    ),
    typeCheck: requireBoolean(
      value['typeCheck'] ?? DEFAULT_PROJECT_CONFIGURATION.typeCheck,
      'configuration.typeCheck',
    ),
    unusedExportExclusions: requireStringArray(
      value['unusedExportExclusions'] ?? [],
      'configuration.unusedExportExclusions',
      2000,
    ),
  };
}

export function projectHandlers(store: DataStore, operations: ProjectOperationRegistry): HandlerMap {
  return {
    'project:list': async (payload) => {
      expectVoid(payload);
      return store.projects.list();
    },

    'project:open-dialog': async (payload): Promise<OpenProjectResult> => {
      expectVoid(payload);

      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const result = window
        ? await dialog.showOpenDialog(window, {
            title: 'Open a JavaScript or TypeScript project',
            properties: ['openDirectory'],
            buttonLabel: 'Open project',
          })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] });

      const chosen = result.filePaths[0];
      if (result.canceled || !chosen) {
        return { project: null, cancelled: true };
      }

      // The renderer never supplies a path; it only triggers this dialog, and the path the
      // user picked is verified to be a readable directory before it is stored.
      const stats = await fs.stat(chosen).catch(() => null);
      if (!stats?.isDirectory()) {
        throw new HandledError('The selected path is not a readable folder.', 'INVALID_FOLDER');
      }

      return {
        project: store.projects.createOrTouch(basename(chosen) || chosen, chosen),
        cancelled: false,
      };
    },

    'project:select': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);

      const project = store.projects.findById(projectId);
      if (!project) throw new HandledError('That project no longer exists.', 'NOT_FOUND');

      store.projects.touch(projectId);
      startWatchingForProject(store, projectId, operations);
      return store.projects.findById(projectId) ?? project;
    },

    'project:remove': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      stopWatching(projectId);
      forgetPreviewContext(projectId);
      // Only the app's own analysis rows are deleted; the scanned folder is never touched.
      return { removed: store.projects.remove(projectId) };
    },

    'project:update-config': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      const configuration = parseConfiguration(value['configuration']);

      const updated = store.projects.updateConfiguration(projectId, configuration);
      if (!updated) throw new HandledError('That project no longer exists.', 'NOT_FOUND');
      return updated;
    },
  };
}
