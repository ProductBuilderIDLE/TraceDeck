import type { IpcChannel, IpcRequest, IpcResponse } from '@shared/ipc';

export class IpcError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly channel: string,
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

/**
 * Unwraps the result envelope so component code can use plain async/await and catch a single
 * error type. The bridge itself never throws; failures always arrive as `{ ok: false }`.
 */
export async function invoke<C extends IpcChannel>(
  channel: C,
  payload: IpcRequest<C>,
): Promise<IpcResponse<C>> {
  const result = await window.tracedeck.invoke(channel, payload);
  if (!result.ok) {
    throw new IpcError(result.error, result.code, channel);
  }
  return result.data;
}

export function subscribeToScanProgress(
  listener: Parameters<Window['tracedeck']['onScanProgress']>[0],
): () => void {
  return window.tracedeck.onScanProgress(listener);
}
