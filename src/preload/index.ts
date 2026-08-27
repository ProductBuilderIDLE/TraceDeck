import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  SCAN_PROGRESS_EVENT,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
  type TraceDeckApi,
} from '@shared/ipc';
import type { ScanProgress } from '@shared/types';

const allowedChannels = new Set<string>(IPC_CHANNELS);

const api: TraceDeckApi = {
  invoke<C extends IpcChannel>(channel: C, payload: IpcRequest<C>) {
    if (!allowedChannels.has(channel)) {
      return Promise.resolve({
        ok: false,
        error: `Unknown channel: ${String(channel)}`,
        code: 'UNKNOWN_CHANNEL',
      } satisfies IpcResult<IpcResponse<C>>);
    }
    return ipcRenderer.invoke(channel, payload) as Promise<IpcResult<IpcResponse<C>>>;
  },

  onScanProgress(listener: (progress: ScanProgress) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: ScanProgress): void => {
      listener(progress);
    };
    ipcRenderer.on(SCAN_PROGRESS_EVENT, wrapped);
    return () => {
      ipcRenderer.removeListener(SCAN_PROGRESS_EVENT, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('tracedeck', api);
