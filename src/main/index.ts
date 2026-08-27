import { app, BrowserWindow, dialog } from 'electron';
import { applyProcessSecurity, applySessionSecurity, hardenWebContents } from './security';
import { createMainWindow } from './window';
import { registerAllHandlers } from './ipc';
import { databaseFilePath, initialiseDatabase, shutdownDatabase } from './db/appDatabase';

// Sandboxing must be enabled before the app is ready, so it runs at module load.
applyProcessSecurity();

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Applies to every WebContents the app ever creates, including ones created indirectly.
app.on('web-contents-created', (_event, contents) => {
  hardenWebContents(contents);
});

app.whenReady().then(() => {
  applySessionSecurity();

  let store;
  try {
    store = initialiseDatabase();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox(
      'TraceDeck could not start',
      [
        'The local database could not be opened or migrated.',
        detail,
        `Database location: ${databaseFilePath()}`,
      ].join('\n\n'),
    );
    app.quit();
    return;
  }

  registerAllHandlers(store, databaseFilePath);

  mainWindow = createMainWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  shutdownDatabase();
});
