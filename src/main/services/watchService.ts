import { watch, type FSWatcher, type WatchEventType } from 'node:fs';
import { ALWAYS_EXCLUDED_DIRS } from '@shared/constants';

export type WatchFactory = (
  rootPath: string,
  options: { recursive: boolean },
  listener: (eventType: WatchEventType, filename: string | null) => void,
) => FSWatcher;

const nodeWatch: WatchFactory = (rootPath, options, listener) =>
  watch(rootPath, { ...options, encoding: 'utf8' }, listener);

interface WatchState {
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
}

const watchers = new Map<number, WatchState>();

export function stopWatching(projectId: number): void {
  const current = watchers.get(projectId);
  if (!current) return;
  if (current.timer) clearTimeout(current.timer);
  current.watcher.close();
  watchers.delete(projectId);
}

export function stopAllWatchers(): void {
  for (const projectId of [...watchers.keys()]) stopWatching(projectId);
}

/**
 * Watches a project folder and calls `onChange` after a short quiet period.
 * Excluded directories never trigger a scan.
 */
export function watchProject(
  projectId: number,
  rootPath: string,
  onChange: (relativePath: string) => void,
  watchFolder: WatchFactory = nodeWatch,
): void {
  stopWatching(projectId);
  const excluded = new Set(ALWAYS_EXCLUDED_DIRS);

  const state: WatchState = { watcher: null as unknown as FSWatcher, timer: null };
  state.watcher = watchFolder(rootPath, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const relativePath = filename.replaceAll('\\', '/');
    if (relativePath.split('/').some((part) => excluded.has(part))) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      onChange(relativePath);
    }, 800);
  });
  watchers.set(projectId, state);
}
