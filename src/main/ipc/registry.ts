import { ipcMain } from 'electron';
import type { IpcChannel, IpcResponse, IpcResult } from '@shared/ipc';
import { ValidationError } from '../utils/validation';

export type IpcHandler<C extends IpcChannel> = (payload: unknown) => Promise<IpcResponse<C>>;

export type HandlerMap = { [C in IpcChannel]?: IpcHandler<C> };

/** Raised by handlers for expected, user-facing failures that should not be logged as bugs. */
export class HandledError extends Error {
  constructor(
    message: string,
    readonly code: string = 'HANDLER_ERROR',
  ) {
    super(message);
    this.name = 'HandledError';
  }
}

function toResult(error: unknown): IpcResult<never> {
  if (error instanceof ValidationError) {
    return { ok: false, error: error.message, code: error.code };
  }
  if (error instanceof HandledError) {
    return { ok: false, error: error.message, code: error.code };
  }
  // Unexpected failures are logged locally but reduced to a generic message before crossing
  // the bridge, so internal paths and stack frames never reach the renderer.
  console.error('[ipc] unhandled error', error);
  return { ok: false, error: 'An unexpected internal error occurred.', code: 'INTERNAL_ERROR' };
}

const registered = new Set<string>();

export function registerHandlers(handlers: HandlerMap): void {
  for (const [channel, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    if (registered.has(channel)) {
      throw new Error(`IPC channel registered twice: ${channel}`);
    }
    registered.add(channel);

    ipcMain.handle(channel, async (_event, payload: unknown) => {
      try {
        const data = await (handler as IpcHandler<IpcChannel>)(payload);
        return { ok: true, data } satisfies IpcResult<unknown>;
      } catch (error) {
        return toResult(error);
      }
    });
  }
}

export function registeredChannels(): string[] {
  return [...registered];
}
