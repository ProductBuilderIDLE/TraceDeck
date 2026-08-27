import process from 'node:process';
import { BrowserWindow, app, nativeTheme, shell } from 'electron';
import { THEME_IDS, themeAppearance, themeWindowBackground } from '@shared/theme';
import type { DataStore } from '../db';
import {
  asObject,
  expectVoid,
  requireEnum,
  requireInt,
  requireNonEmptyString,
} from '../utils/validation';
import { resolveWithinProject } from '../utils/paths';
import { HandledError, type HandlerMap } from './registry';

export function systemHandlers(store: DataStore, databasePath: () => string): HandlerMap {
  /**
   * Turns a renderer-supplied relative path into an absolute one that is guaranteed to sit
   * inside the project the user opened. A compromised renderer cannot use these channels to
   * make the OS open an arbitrary file.
   */
  const resolveTarget = (payload: unknown): string => {
    const value = asObject(payload);
    const projectId = requireInt(value['projectId'], 'projectId', 1);
    const relativePath = requireNonEmptyString(value['relativePath'], 'relativePath', 4096);

    const project = store.projects.findById(projectId);
    if (!project) throw new HandledError('That project no longer exists.', 'NOT_FOUND');

    const file = store.files.findByPath(projectId, relativePath);
    if (!file) throw new HandledError('That file is not part of the last scan.', 'NOT_FOUND');

    return resolveWithinProject(project.rootPath, relativePath);
  };

  return {
    'system:app-info': async (payload) => {
      expectVoid(payload);
      return {
        version: app.getVersion(),
        electron: process.versions['electron'] ?? 'unknown',
        databasePath: databasePath(),
      };
    },

    'system:open-path': async (payload) => {
      const target = resolveTarget(payload);
      const error = await shell.openPath(target);
      if (error) throw new HandledError(`The file could not be opened: ${error}`, 'OPEN_FAILED');
    },

    'system:reveal-path': async (payload) => {
      shell.showItemInFolder(resolveTarget(payload));
    },

    /**
     * Keeps the native window chrome in step with the in-app theme. The renderer sends only a
     * theme id from a fixed list; the actual colour is looked up here, so a compromised
     * renderer cannot paint the window an arbitrary colour or inject a value into Electron.
     */
    'system:set-theme': async (payload) => {
      const value = asObject(payload);
      const theme = requireEnum(value['theme'], 'theme', THEME_IDS);

      nativeTheme.themeSource = themeAppearance(theme);

      const background = themeWindowBackground(theme);
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.setBackgroundColor(background);
      }
    },
  };
}
