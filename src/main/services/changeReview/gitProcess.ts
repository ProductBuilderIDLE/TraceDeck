import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const MAX_RETAINED_STDERR_BYTES = 8 * 1024;

export type GitReviewErrorCode =
  | 'REVIEW_CANCELLED'
  | 'REVIEW_GIT_TIMEOUT'
  | 'INVALID_GIT_PATH_ENCODING'
  | 'NOT_A_GIT_REPO'
  | 'HEAD_UNBORN'
  | 'REVIEW_GIT_FAILED';

export class GitReviewError extends Error {
  constructor(readonly code: GitReviewErrorCode, message: string) {
    super(message);
    this.name = 'GitReviewError';
  }
}

interface GitSpawnOptions {
  cwd: string;
  windowsHide: true;
  shell: false;
}

export type GitSpawnFactory = (
  command: string,
  args: readonly string[],
  options: GitSpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface GitProcessOptions {
  cwd: string;
  args: readonly string[];
  timeoutMs: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** Process seam for deterministic unit tests. Production callers leave this unset. */
  spawnFactory?: GitSpawnFactory;
}

function cancelledError(): GitReviewError {
  return new GitReviewError('REVIEW_CANCELLED', 'Git operation was cancelled.');
}

function timeoutError(): GitReviewError {
  return new GitReviewError('REVIEW_GIT_TIMEOUT', 'Git operation timed out.');
}

function failedError(message = 'Git command failed.'): GitReviewError {
  return new GitReviewError('REVIEW_GIT_FAILED', message);
}

export async function runGitStreaming(
  options: GitProcessOptions,
  onStdoutChunk: (chunk: Buffer) => void,
): Promise<void> {
  if (options.signal?.aborted) throw cancelledError();

  let child: ChildProcessWithoutNullStreams;
  const spawnOptions: GitSpawnOptions = {
    cwd: options.cwd,
    windowsHide: true,
    shell: false,
  };
  try {
    child = options.spawnFactory
      ? options.spawnFactory('git', options.args, spawnOptions)
      : spawn('git', [...options.args], spawnOptions);
  } catch {
    throw failedError();
  }

  const stderrLimit = Math.max(
    0,
    Math.min(options.maxStderrBytes ?? MAX_RETAINED_STDERR_BYTES, MAX_RETAINED_STDERR_BYTES),
  );
  const retainedStderr: Buffer[] = [];
  let retainedStderrBytes = 0;

  let settle: ((error?: GitReviewError) => void) | undefined;
  const completion = new Promise<void>((resolve, reject) => {
    let settled = false;
    settle = (error?: GitReviewError): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
  });

  const stopChild = (): void => {
    try {
      child.kill();
    } catch {
      // The operation already has a sanitized terminal error.
    }
  };
  const onAbort = (): void => {
    stopChild();
    settle?.(cancelledError());
  };
  const onStdout = (value: Buffer | string): void => {
    try {
      onStdoutChunk(Buffer.isBuffer(value) ? value : Buffer.from(value));
    } catch (error) {
      stopChild();
      settle?.(
        error instanceof GitReviewError
          ? error
          : failedError('Git command output could not be processed.'),
      );
    }
  };
  const onStderr = (value: Buffer | string): void => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = stderrLimit - retainedStderrBytes;
    if (remaining <= 0) return;
    const retained = Buffer.from(chunk.subarray(0, remaining));
    retainedStderr.push(retained);
    retainedStderrBytes += retained.length;
  };
  const onError = (): void => settle?.(failedError());
  const onClose = (exitCode: number | null): void => {
    if (exitCode === 0) settle?.();
    else settle?.(failedError());
  };

  child.stdout.on('data', onStdout);
  child.stderr.on('data', onStderr);
  child.once('error', onError);
  child.once('close', onClose);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    stopChild();
    settle?.(timeoutError());
  }, options.timeoutMs);

  try {
    await completion;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    child.stdout.off('data', onStdout);
    child.stderr.off('data', onStderr);
    child.off('error', onError);
    child.off('close', onClose);
    retainedStderr.length = 0;
  }
}

export type GitCatFileBatchOptions = Omit<GitProcessOptions, 'args' | 'maxStdoutBytes'>;

export async function runGitCatFileBatch(
  options: GitCatFileBatchOptions,
  objectIds: readonly string[],
  consumeStdout: (stdout: AsyncIterable<Buffer>) => Promise<void>,
): Promise<void> {
  if (options.signal?.aborted) throw cancelledError();
  if (objectIds.some((objectId) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId))) {
    throw failedError('Git object input was invalid.');
  }

  let child: ChildProcessWithoutNullStreams;
  const spawnOptions: GitSpawnOptions = {
    cwd: options.cwd,
    windowsHide: true,
    shell: false,
  };
  try {
    child = options.spawnFactory
      ? options.spawnFactory('git', ['cat-file', '--batch'], spawnOptions)
      : spawn('git', ['cat-file', '--batch'], spawnOptions);
  } catch {
    throw failedError();
  }

  const stderrLimit = Math.max(
    0,
    Math.min(options.maxStderrBytes ?? MAX_RETAINED_STDERR_BYTES, MAX_RETAINED_STDERR_BYTES),
  );
  const retainedStderr: Buffer[] = [];
  let retainedStderrBytes = 0;
  let settle: ((error?: GitReviewError) => void) | undefined;
  const completion = new Promise<void>((resolve, reject) => {
    let settled = false;
    settle = (error?: GitReviewError): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
  });

  let stopRequested = false;
  let terminalControlError: GitReviewError | undefined;
  const stopChild = (): void => {
    if (stopRequested) return;
    stopRequested = true;
    try {
      child.kill();
    } catch {
      // The operation already has a sanitized terminal error.
    }
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const onAbort = (): void => {
    terminalControlError = cancelledError();
    settle?.(terminalControlError);
    stopChild();
  };
  const onStderr = (value: Buffer | string): void => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = stderrLimit - retainedStderrBytes;
    if (remaining <= 0) return;
    const retained = Buffer.from(chunk.subarray(0, remaining));
    retainedStderr.push(retained);
    retainedStderrBytes += retained.length;
  };
  const onError = (): void => settle?.(failedError());
  const onClose = (exitCode: number | null): void => {
    if (exitCode === 0) settle?.();
    else settle?.(failedError());
  };
  const input = Buffer.from(objectIds.map((objectId) => `${objectId}\n`).join(''), 'ascii');
  const inputCompletion = new Promise<void>((resolve, reject) => {
    let finished = false;
    const cleanup = (): void => {
      child.stdin.off('error', onInputError);
      child.stdin.off('close', onInputClose);
    };
    const onInputError = (): void => {
      cleanup();
      reject(failedError());
    };
    const onInputClose = (): void => {
      if (finished) return;
      cleanup();
      reject(failedError());
    };
    child.stdin.once('error', onInputError);
    child.stdin.once('close', onInputClose);
    child.stdin.end(input, () => {
      finished = true;
      cleanup();
      resolve();
    });
  });

  child.stderr.on('data', onStderr);
  child.once('error', onError);
  child.once('close', onClose);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    terminalControlError = timeoutError();
    settle?.(terminalControlError);
    stopChild();
  }, options.timeoutMs);
  const guardedInputCompletion = inputCompletion.catch((error: unknown) => {
    const failure = error instanceof GitReviewError ? error : failedError();
    settle?.(failure);
    stopChild();
    throw failure;
  });
  const consumerCompletion = Promise.resolve()
    .then(() => consumeStdout(child.stdout as AsyncIterable<Buffer>))
    .catch((error: unknown) => {
      const failure = error instanceof GitReviewError
        ? error
        : failedError('Git command output could not be processed.');
      settle?.(failure);
      stopChild();
      throw failure;
    });

  try {
    const results = await Promise.allSettled([
      completion,
      guardedInputCompletion,
      consumerCompletion,
    ]);
    const rejected = results.find((result) => result.status === 'rejected');
    if (terminalControlError) throw terminalControlError;
    if (rejected?.status === 'rejected') {
      throw rejected.reason instanceof GitReviewError ? rejected.reason : failedError();
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    child.stderr.off('data', onStderr);
    child.off('error', onError);
    child.off('close', onClose);
    retainedStderr.length = 0;
  }
}

export async function runGitBuffered(options: GitProcessOptions): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  const maxStdoutBytes = Math.max(0, options.maxStdoutBytes ?? Number.MAX_SAFE_INTEGER);

  await runGitStreaming(options, (chunk) => {
    if (retainedBytes + chunk.length > maxStdoutBytes) {
      throw failedError('Git command output exceeded the safe limit.');
    }
    chunks.push(chunk);
    retainedBytes += chunk.length;
  });

  return Buffer.concat(chunks, retainedBytes);
}

export async function runGitNulRecords(
  options: GitProcessOptions,
  onRecord: (record: Buffer) => void,
): Promise<void> {
  let pending = Buffer.alloc(0);

  await runGitStreaming(options, (chunk) => {
    let recordStart = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0) continue;
      const tail = chunk.subarray(recordStart, index);
      const record = pending.length === 0 ? tail : Buffer.concat([pending, tail]);
      pending = Buffer.alloc(0);
      if (record.length > 0) onRecord(record);
      recordStart = index + 1;
    }

    if (recordStart < chunk.length) {
      const tail = chunk.subarray(recordStart);
      pending = pending.length === 0 ? Buffer.from(tail) : Buffer.concat([pending, tail]);
    }
  });

  if (pending.length > 0) onRecord(pending);
}
