import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { ReviewFileChangeType, ReviewFileDiff, ReviewGitChange } from '@shared/changeReview';
import { sourceLanguage } from '@shared/sourceLanguage';
import { canonicalSha256, canonicalStringify, compareCodePoints } from './canonical';
import {
  GitReviewError,
  runGitBuffered,
  runGitNulRecords,
  runGitStreaming,
} from './gitProcess';

const REV_PARSE_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 60_000;
const DIFF_TIMEOUT_MS = 30_000;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_LINES = 20_000;
const MAX_SMALL_GIT_OUTPUT_BYTES = 8 * 1024;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface ResolvedReviewHead {
  fullCommit: string;
  shortCommit: string;
  treeId: string;
  branchName: string | null;
}

export interface CapturedWorkingTree {
  head: ResolvedReviewHead;
  changes: ReviewGitChange[];
  fingerprint: string;
}

interface ParsedChange {
  relativePath: string;
  oldPath: string | null;
  copiedFrom: string | null;
  changeType: ReviewFileChangeType;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  similarity: number | null;
}

interface PendingRenameOrCopy extends Omit<ParsedChange, 'oldPath' | 'copiedFrom'> {
  operation: 'R' | 'C';
}

function reviewFailure(message = 'Git review data could not be read.'): GitReviewError {
  return new GitReviewError('REVIEW_GIT_FAILED', message);
}

function preserveControlError(error: unknown): GitReviewError | null {
  if (
    error instanceof GitReviewError
    && (error.code === 'REVIEW_CANCELLED' || error.code === 'REVIEW_GIT_TIMEOUT')
  ) {
    return error;
  }
  return null;
}

function decodeGitPath(bytes: Buffer): string {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GitReviewError(
      'INVALID_GIT_PATH_ENCODING',
      'A Git path is not valid UTF-8 and cannot be reviewed safely.',
    );
  }

  if (
    decoded.length === 0
    || decoded.startsWith('/')
    || /^[A-Za-z]:\//.test(decoded)
    || decoded.split('/').some((part) => part === '..')
  ) {
    throw reviewFailure();
  }
  return decoded;
}

function splitFixedFields(
  record: Buffer,
  fieldCount: number,
): { fields: string[]; path: Buffer } {
  const fields: string[] = [];
  let start = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    const separator = record.indexOf(0x20, start);
    if (separator < 0) throw reviewFailure();
    fields.push(record.subarray(start, separator).toString('ascii'));
    start = separator + 1;
  }
  if (start >= record.length) throw reviewFailure();
  return { fields, path: record.subarray(start) };
}

function changeTypeForOrdinary(indexStatus: string, workTreeStatus: string): ReviewFileChangeType {
  if (indexStatus === 'A') return 'added';
  if (indexStatus === 'D' || workTreeStatus === 'D') return 'deleted';
  return 'modified';
}

function mergeChanges(left: ParsedChange, right: ParsedChange): ParsedChange {
  const types = new Set([left.changeType, right.changeType]);
  let changeType: ReviewFileChangeType;
  if (types.has('renamed')) changeType = 'renamed';
  else if (types.has('deleted') && types.has('added')) changeType = 'modified';
  else if (types.has('modified')) changeType = 'modified';
  else if (types.has('added')) changeType = 'added';
  else changeType = 'deleted';

  return {
    relativePath: left.relativePath,
    oldPath: left.oldPath ?? right.oldPath,
    copiedFrom: left.copiedFrom ?? right.copiedFrom,
    changeType,
    staged: left.staged || right.staged,
    unstaged: left.unstaged || right.unstaged,
    untracked: left.untracked || right.untracked,
    similarity: left.similarity ?? right.similarity,
  };
}

function toReviewChange(change: ParsedChange): ReviewGitChange {
  const stableEvidence = {
    relativePath: change.relativePath,
    oldPath: change.oldPath,
    copiedFrom: change.copiedFrom,
    changeType: change.changeType,
    staged: change.staged,
    unstaged: change.unstaged,
    untracked: change.untracked,
  };
  return {
    itemType: 'file',
    stableKey: canonicalSha256(stableEvidence),
    ...stableEvidence,
    similarity: change.similarity,
    language: sourceLanguage(change.relativePath),
  };
}

class PorcelainV2Parser {
  private readonly changes = new Map<string, ParsedChange>();
  private pending: PendingRenameOrCopy | null = null;

  accept(record: Buffer): void {
    if (this.pending) {
      const sourcePath = decodeGitPath(record);
      const pending = this.pending;
      this.pending = null;
      this.add({
        relativePath: pending.relativePath,
        oldPath: pending.operation === 'R' ? sourcePath : null,
        copiedFrom: pending.operation === 'C' ? sourcePath : null,
        changeType: pending.changeType,
        staged: pending.staged,
        unstaged: pending.unstaged,
        untracked: pending.untracked,
        similarity: pending.similarity,
      });
      return;
    }

    const recordType = String.fromCharCode(record[0] ?? 0);
    if (recordType === '?') {
      if (record[1] !== 0x20) throw reviewFailure();
      this.add({
        relativePath: decodeGitPath(record.subarray(2)),
        oldPath: null,
        copiedFrom: null,
        changeType: 'added',
        staged: false,
        unstaged: false,
        untracked: true,
        similarity: null,
      });
      return;
    }
    if (recordType === '!' || recordType === '#') return;

    if (recordType === '1') {
      const { fields, path } = splitFixedFields(record, 8);
      const xy = fields[1];
      if (!xy || xy.length !== 2) throw reviewFailure();
      this.add({
        relativePath: decodeGitPath(path),
        oldPath: null,
        copiedFrom: null,
        changeType: changeTypeForOrdinary(xy[0] as string, xy[1] as string),
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
        untracked: false,
        similarity: null,
      });
      return;
    }

    if (recordType === '2') {
      const { fields, path } = splitFixedFields(record, 9);
      const xy = fields[1];
      const score = fields[8];
      const operation = score?.[0];
      const similarity = Number(score?.slice(1));
      if (
        !xy
        || xy.length !== 2
        || (operation !== 'R' && operation !== 'C')
        || !Number.isInteger(similarity)
        || similarity < 0
        || similarity > 100
      ) {
        throw reviewFailure();
      }
      this.pending = {
        operation,
        relativePath: decodeGitPath(path),
        changeType: operation === 'R' ? 'renamed' : 'added',
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
        untracked: false,
        similarity,
      };
      return;
    }

    if (recordType === 'u') {
      const { fields, path } = splitFixedFields(record, 10);
      const xy = fields[1];
      if (!xy || xy.length !== 2) throw reviewFailure();
      this.add({
        relativePath: decodeGitPath(path),
        oldPath: null,
        copiedFrom: null,
        changeType: 'modified',
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
        untracked: false,
        similarity: null,
      });
      return;
    }

    throw reviewFailure();
  }

  finish(): ReviewGitChange[] {
    if (this.pending) throw reviewFailure();
    return [...this.changes.values()]
      .sort((left, right) => compareCodePoints(left.relativePath, right.relativePath))
      .map(toReviewChange);
  }

  private add(change: ParsedChange): void {
    const existing = this.changes.get(change.relativePath);
    this.changes.set(change.relativePath, existing ? mergeChanges(existing, change) : change);
  }
}

export function parsePorcelainV2(output: Buffer): ReviewGitChange[] {
  const parser = new PorcelainV2Parser();
  let recordStart = 0;
  for (let index = 0; index <= output.length; index += 1) {
    if (index < output.length && output[index] !== 0) continue;
    if (index > recordStart) parser.accept(output.subarray(recordStart, index));
    recordStart = index + 1;
  }
  return parser.finish();
}

async function readSmallGitOutput(
  rootPath: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const output = await runGitBuffered({
    cwd: rootPath,
    args,
    timeoutMs: REV_PARSE_TIMEOUT_MS,
    signal,
    maxStdoutBytes: MAX_SMALL_GIT_OUTPUT_BYTES,
  });
  return output.toString('utf8').trim();
}

export async function resolveReviewHead(
  rootPath: string,
  signal?: AbortSignal,
): Promise<ResolvedReviewHead> {
  let insideWorkTree: string;
  try {
    insideWorkTree = await readSmallGitOutput(rootPath, ['rev-parse', '--is-inside-work-tree'], signal);
  } catch (error) {
    const controlError = preserveControlError(error);
    if (controlError) throw controlError;
    throw new GitReviewError('NOT_A_GIT_REPO', 'The selected project is not a Git repository.');
  }
  if (insideWorkTree !== 'true') {
    throw new GitReviewError('NOT_A_GIT_REPO', 'The selected project is not a Git repository.');
  }

  let fullCommit: string;
  try {
    fullCommit = await readSmallGitOutput(rootPath, ['rev-parse', '--verify', 'HEAD'], signal);
  } catch (error) {
    const controlError = preserveControlError(error);
    if (controlError) throw controlError;
    throw new GitReviewError('HEAD_UNBORN', 'The Git repository does not have a commit yet.');
  }
  if (!OBJECT_ID_PATTERN.test(fullCommit)) throw reviewFailure();

  const treeId = await readSmallGitOutput(rootPath, ['rev-parse', '--verify', 'HEAD^{tree}'], signal);
  if (!OBJECT_ID_PATTERN.test(treeId)) throw reviewFailure();
  const shortCommit = await readSmallGitOutput(rootPath, ['rev-parse', '--short=12', 'HEAD'], signal);
  if (!/^[0-9a-f]{4,64}$/.test(shortCommit)) throw reviewFailure();

  const branchOutput = await readSmallGitOutput(rootPath, ['branch', '--show-current'], signal);
  const branchName = branchOutput.length > 0 ? branchOutput : null;

  return { fullCommit, shortCommit, treeId, branchName };
}

function sameFileVersion(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function staleCaptureError(): GitReviewError {
  return reviewFailure('The working tree changed while it was being captured.');
}

function cancelledCaptureError(): GitReviewError {
  return new GitReviewError('REVIEW_CANCELLED', 'Git operation was cancelled.');
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledCaptureError();
}

async function streamHandleIntoHash(
  handle: FileHandle,
  hash: Hash,
  signal?: AbortSignal,
): Promise<void> {
  throwIfCancelled(signal);
  const stream = handle.createReadStream({ autoClose: false });
  const onAbort = (): void => {
    stream.destroy(cancelledCaptureError());
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await new Promise<void>((resolveStream, rejectStream) => {
      stream.on('data', (chunk: Buffer | string) => {
        hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.once('end', resolveStream);
      stream.once('error', rejectStream);
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function appendPathFingerprint(
  hash: Hash,
  rootPath: string,
  change: ReviewGitChange,
  signal?: AbortSignal,
): Promise<Hash> {
  throwIfCancelled(signal);
  hash.update('\0PATH\0');
  hash.update(change.relativePath, 'utf8');
  hash.update('\0');
  if (change.changeType === 'deleted') {
    hash.update('DELETED\0');
    return hash;
  }

  const absoluteRoot = resolve(rootPath);
  const absolutePath = resolve(absoluteRoot, ...change.relativePath.split('/'));
  const rootPrefix = absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`;
  const comparablePath = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
  const comparablePrefix = process.platform === 'win32' ? rootPrefix.toLowerCase() : rootPrefix;
  if (!comparablePath.startsWith(comparablePrefix)) throw reviewFailure();

  let before: BigIntStats;
  try {
    before = await lstat(absolutePath, { bigint: true });
  } catch {
    hash.update('UNREADABLE\0');
    return hash;
  }
  if (before.isSymbolicLink()) {
    hash.update('SYMLINK\0');
    return hash;
  }
  if (!before.isFile()) {
    hash.update('UNSUPPORTED\0');
    return hash;
  }

  let handle: FileHandle;
  try {
    handle = await open(absolutePath, 'r');
  } catch {
    hash.update('UNREADABLE\0');
    return hash;
  }

  const candidate = hash.copy();
  candidate.update('REGULAR\0');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileVersion(before, opened)) throw staleCaptureError();
    await streamHandleIntoHash(handle, candidate, signal);
    const afterHandle = await handle.stat({ bigint: true });
    let afterPath: BigIntStats;
    try {
      afterPath = await lstat(absolutePath, { bigint: true });
    } catch {
      throw staleCaptureError();
    }
    if (
      !afterPath.isFile()
      || !sameFileVersion(before, afterHandle)
      || !sameFileVersion(before, afterPath)
    ) {
      throw staleCaptureError();
    }
    return candidate;
  } catch (error) {
    if (error instanceof GitReviewError) throw error;
    hash.update('UNREADABLE\0');
    return hash;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function workingTreeFingerprint(
  rootPath: string,
  changes: readonly ReviewGitChange[],
  signal?: AbortSignal,
): Promise<string> {
  const statusEvidence = changes.map((change) => ({
    relativePath: change.relativePath,
    oldPath: change.oldPath,
    copiedFrom: change.copiedFrom,
    changeType: change.changeType,
    staged: change.staged,
    unstaged: change.unstaged,
    untracked: change.untracked,
    similarity: change.similarity,
  }));
  let hash = createHash('sha256');
  hash.update('tracedeck-working-tree-v1\0');
  hash.update(canonicalStringify(statusEvidence), 'utf8');
  for (const change of changes) {
    hash = await appendPathFingerprint(hash, rootPath, change, signal);
  }
  return hash.digest('hex');
}

export async function captureWorkingTree(
  rootPath: string,
  signal?: AbortSignal,
): Promise<CapturedWorkingTree> {
  const head = await resolveReviewHead(rootPath, signal);
  const parser = new PorcelainV2Parser();
  await runGitNulRecords({
    cwd: rootPath,
    args: [
      '-c',
      'status.renames=true',
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--find-renames=50%',
    ],
    timeoutMs: STATUS_TIMEOUT_MS,
    signal,
  }, (record) => parser.accept(record));
  const changes = parser.finish();
  const fingerprint = await workingTreeFingerprint(rootPath, changes, signal);
  return { head, changes, fingerprint };
}

function validateDiffPath(relativePath: string): void {
  if (
    relativePath.length === 0
    || relativePath.includes('\\')
    || relativePath.includes('\0')
    || relativePath.startsWith('/')
    || /^[A-Za-z]:\//.test(relativePath)
    || relativePath.split('/').some((part) => part === '..')
  ) {
    throw reviewFailure('Review diff input is invalid.');
  }
}

export function buildReviewDiffArgs(
  baseCommit: string,
  change: ReviewGitChange,
): string[] {
  if (!OBJECT_ID_PATTERN.test(baseCommit)) {
    throw reviewFailure('Review diff input is invalid.');
  }
  validateDiffPath(change.relativePath);
  const priorPath = change.oldPath;
  if (priorPath) validateDiffPath(priorPath);

  const pathspecs = priorPath && priorPath !== change.relativePath
    ? [priorPath, change.relativePath]
    : [change.relativePath];
  return [
    '--no-pager',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    baseCommit,
    '--',
    ...pathspecs,
  ];
}

function bufferLineCount(bytes: Buffer, newlineCount: number): number {
  if (bytes.length === 0) return 0;
  return bytes[bytes.length - 1] === 0x0a ? newlineCount : newlineCount + 1;
}

export async function readReviewDiff(input: {
  rootPath: string;
  baseCommit: string;
  change: ReviewGitChange;
  signal?: AbortSignal;
}): Promise<ReviewFileDiff> {
  const args = buildReviewDiffArgs(input.baseCommit, input.change);
  const retainedChunks: Buffer[] = [];
  let totalBytes = 0;
  let totalNewlines = 0;
  let totalLastByte: number | undefined;
  let retainedBytes = 0;
  let retainedNewlines = 0;

  await runGitStreaming({
    cwd: input.rootPath,
    args,
    timeoutMs: DIFF_TIMEOUT_MS,
    signal: input.signal,
  }, (chunk) => {
    totalBytes += chunk.length;
    for (const byte of chunk) {
      if (byte === 0x0a) totalNewlines += 1;
    }
    if (chunk.length > 0) totalLastByte = chunk[chunk.length - 1];

    if (retainedBytes >= MAX_DIFF_BYTES || retainedNewlines >= MAX_DIFF_LINES) return;
    const byteBounded = chunk.subarray(0, MAX_DIFF_BYTES - retainedBytes);
    let retainLength = byteBounded.length;
    const remainingNewlines = MAX_DIFF_LINES - retainedNewlines;
    let seenNewlines = 0;
    for (let index = 0; index < byteBounded.length; index += 1) {
      if (byteBounded[index] !== 0x0a) continue;
      seenNewlines += 1;
      if (seenNewlines === remainingNewlines) {
        retainLength = index + 1;
        break;
      }
    }

    if (retainLength === 0) return;
    const retained = Buffer.from(byteBounded.subarray(0, retainLength));
    retainedChunks.push(retained);
    retainedBytes += retained.length;
    for (const byte of retained) {
      if (byte === 0x0a) retainedNewlines += 1;
    }
  });

  const retained = Buffer.concat(retainedChunks, retainedBytes);
  const totalLines = totalBytes === 0
    ? 0
    : (totalLastByte === 0x0a ? totalNewlines : totalNewlines + 1);
  const returnedLines = bufferLineCount(retained, retainedNewlines);
  const omittedBytes = totalBytes - retainedBytes;
  const omittedLines = totalLines - returnedLines;

  let oldPath: string | null;
  let newPath: string | null;
  if (input.change.changeType === 'added') {
    oldPath = null;
    newPath = input.change.relativePath;
  } else if (input.change.changeType === 'deleted') {
    oldPath = input.change.relativePath;
    newPath = null;
  } else if (input.change.changeType === 'renamed') {
    oldPath = input.change.oldPath;
    newPath = input.change.relativePath;
  } else {
    oldPath = input.change.relativePath;
    newPath = input.change.relativePath;
  }

  return {
    oldPath,
    newPath,
    diffText: retained.toString('utf8'),
    truncated: omittedBytes > 0 || omittedLines > 0,
    returnedBytes: retainedBytes,
    returnedLines,
    omittedBytes,
    omittedLines,
  };
}
