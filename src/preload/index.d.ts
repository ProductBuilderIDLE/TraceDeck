import type { TraceDeckApi } from '@shared/ipc';

declare global {
  interface Window {
    tracedeck: TraceDeckApi;
  }
}

export {};
