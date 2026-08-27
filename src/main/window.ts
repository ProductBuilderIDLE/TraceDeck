import { join } from 'node:path';
import { BrowserWindow, shell } from 'electron';
import { DEFAULT_THEME_ID, themeWindowBackground } from '@shared/theme';
import { hardenWindow } from './security';

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    // Repainted to match once the renderer reports the user's stored theme.
    backgroundColor: themeWindowBackground(DEFAULT_THEME_ID),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  hardenWindow(window);

  window.once('ready-to-show', () => window.show());

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

export function openExternalDocs(url: string): void {
  if (url.startsWith('https://')) {
    void shell.openExternal(url);
  }
}
