import { join } from 'node:path';
import { app } from 'electron';
import { createDataStore, type DataStore } from './index';

let store: DataStore | null = null;
let resolvedPath: string | null = null;

/**
 * The database lives in the OS application-data directory, never inside the scanned project.
 * A scanned repository is read-only as far as TraceDeck is concerned.
 */
export function databaseFilePath(): string {
  if (!resolvedPath) {
    resolvedPath = join(app.getPath('userData'), 'tracedeck.db');
  }
  return resolvedPath;
}

export function initialiseDatabase(): DataStore {
  if (!store) {
    store = createDataStore(databaseFilePath());
  }
  return store;
}

export function getDataStore(): DataStore {
  if (!store) {
    throw new Error('Database accessed before initialisation.');
  }
  return store;
}

export function shutdownDatabase(): void {
  if (store) {
    store.close();
    store = null;
  }
}
