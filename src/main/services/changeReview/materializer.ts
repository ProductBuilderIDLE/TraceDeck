import { randomUUID } from 'node:crypto';
import fileSystem from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { ReviewLimitation } from '@shared/changeReview';
import {
  MAX_REVIEW_BASELINE_BYTES,
  MAX_REVIEW_BASELINE_ENTRIES,
  REVIEW_TEMP_MARKER,
  REVIEW_TEMP_MAX_AGE_MS,
  REVIEW_TEMP_PREFIX,
} from '@shared/constants';
import { canonicalSha256, compareCodePoints } from './canonical';
import {
  GitReviewError,
  runGitCatFileBatch,
  runGitStreaming,
  type GitCatFileBatchOptions,
  type GitSpawnFactory,
} from './gitProcess';

const LS_TREE_TIMEOUT_MS = 60_000;
const CAT_FILE_TIMEOUT_MS = 5 * 60_000;
const MAX_LS_TREE_RECORD_BYTES = 64 * 1024;
const MAX_LS_TREE_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_MARKER_BYTES = 4096;
const MAX_ATTRIBUTE_LINE_BYTES = 1024 * 1024;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LFS_POINTER_HEADER = Buffer.from('version https://git-lfs.github.com/spec/v1');

export interface GitTreeEntry {
  mode: string;
  type: 'blob' | 'commit';
  objectId: string;
  size: number | null;
  relativePath: string;
}

export interface MaterializedInventoryEvidence {
  relativePath: string;
  entryKind: 'symlink' | 'submodule';
  reason: string;
}

export interface ReviewTempRoot {
  rootPath: string;
  treePath: string;
  statePath: string;
  markerPath: string;
  uuid: string;
}

export interface MaterializedHead {
  treeId: string;
  relativePaths: string[];
  inventoryEvidence: MaterializedInventoryEvidence[];
  limitations: ReviewLimitation[];
  totalEntries: number;
  totalBytes: number;
}

interface MaterializerFileSystem {
  mkdir: typeof fileSystem.mkdir;
  lstat: typeof fileSystem.lstat;
  open: typeof fileSystem.open;
  chmod: typeof fileSystem.chmod;
}

export interface MaterializerDependencies {
  fileSystem: MaterializerFileSystem;
  enumerateTree: typeof enumerateHeadTree;
  runBatch: typeof runGitCatFileBatch;
}

interface ReviewTempMarker {
  uuid: string;
  traceDeckVersion: string;
  startedAt: string;
}

interface VerifiedReviewTemp {
  rootPath: string;
  marker: ReviewTempMarker;
}

interface FilterRule {
  sourcePath: string;
  baseDirectory: string;
  pattern: string;
  enabled: boolean;
  line: number;
}

function materializationError(message = 'The committed tree could not be materialized safely.'): GitReviewError {
  return new GitReviewError('REVIEW_GIT_FAILED', message);
}

function cancellationError(): GitReviewError {
  return new GitReviewError('REVIEW_CANCELLED', 'Review materialization was cancelled.');
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError();
}

function sanitizedFailure(error: unknown): GitReviewError {
  if (error instanceof GitReviewError) return error;
  return materializationError();
}

function decodePath(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GitReviewError(
      'INVALID_GIT_PATH_ENCODING',
      'A Git path is not valid UTF-8 and cannot be reviewed safely.',
    );
  }
}

function validateRelativePath(relativePath: string): string[] {
  if (
    relativePath.length === 0
    || relativePath.includes('\\')
    || relativePath.includes('\0')
    || posix.isAbsolute(relativePath)
    || /^[A-Za-z]:\//.test(relativePath)
    || posix.normalize(relativePath) !== relativePath
  ) {
    throw materializationError();
  }

  const components = relativePath.split('/');
  if (components.some((component) => component.length === 0 || component === '.' || component === '..')) {
    throw materializationError();
  }
  return components;
}

function isWritableEntry(entry: GitTreeEntry): boolean {
  return entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
}

function isSubmoduleEntry(entry: GitTreeEntry): boolean {
  return entry.type === 'commit' || entry.mode === '160000';
}

function isSymlinkEntry(entry: GitTreeEntry): boolean {
  return !isSubmoduleEntry(entry) && entry.mode === '120000';
}

function sortedEntries(entries: readonly GitTreeEntry[]): GitTreeEntry[] {
  return [...entries].sort((left, right) => compareCodePoints(left.relativePath, right.relativePath));
}

export function parseLsTreeRecord(record: Buffer): GitTreeEntry {
  const tab = record.indexOf(0x09);
  if (tab <= 0 || tab === record.length - 1) throw materializationError();
  const metadataBytes = record.subarray(0, tab);
  if (metadataBytes.some((byte) => byte > 0x7f)) throw materializationError();
  const metadata = metadataBytes.toString('ascii');
  const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64}) +([0-9]+|-)$/.exec(metadata);
  if (!match) throw materializationError();

  const [, mode, typeValue, objectId, sizeValue] = match;
  const type = typeValue as GitTreeEntry['type'];
  const size = sizeValue === '-' ? null : Number(sizeValue);
  if (
    !mode
    || !objectId
    || sizeValue === undefined
    || (size !== null && (!Number.isSafeInteger(size) || size < 0))
    || (type === 'blob' && size === null)
    || (type === 'commit' && size !== null)
  ) {
    throw materializationError();
  }

  return {
    mode,
    type,
    objectId,
    size,
    relativePath: decodePath(record.subarray(tab + 1)),
  };
}

export function preflightTree(entries: readonly GitTreeEntry[]): {
  writable: GitTreeEntry[];
  inventoryEvidence: MaterializedInventoryEvidence[];
  totalEntries: number;
  totalBytes: number;
} {
  if (entries.length > MAX_REVIEW_BASELINE_ENTRIES) throw materializationError();

  const collisions = new Set<string>();
  const writable: GitTreeEntry[] = [];
  const inventoryEvidence: MaterializedInventoryEvidence[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    validateRelativePath(entry.relativePath);
    if (!OBJECT_ID_PATTERN.test(entry.objectId)) throw materializationError();
    const collisionKey = entry.relativePath.toLowerCase();
    if (collisions.has(collisionKey)) throw materializationError();
    collisions.add(collisionKey);

    if (isWritableEntry(entry)) {
      if (entry.size === null || !Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw materializationError();
      }
      totalBytes += entry.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_REVIEW_BASELINE_BYTES) {
        throw materializationError();
      }
      writable.push(entry);
    } else if (isSubmoduleEntry(entry)) {
      inventoryEvidence.push({
        relativePath: entry.relativePath,
        entryKind: 'submodule',
        reason: 'The committed submodule is inventory only; it was not initialized or materialized.',
      });
    } else if (isSymlinkEntry(entry)) {
      inventoryEvidence.push({
        relativePath: entry.relativePath,
        entryKind: 'symlink',
        reason: 'The committed symbolic link is inventory only; no link was created or followed.',
      });
    }
  }

  return {
    writable: sortedEntries(writable),
    inventoryEvidence: [...inventoryEvidence].sort((left, right) => (
      compareCodePoints(left.relativePath, right.relativePath)
    )),
    totalEntries: entries.length,
    totalBytes,
  };
}

export async function enumerateHeadTree(
  rootPath: string,
  commit: string,
  signal?: AbortSignal,
  spawnFactory?: GitSpawnFactory,
): Promise<GitTreeEntry[]> {
  throwIfCancelled(signal);
  if (!OBJECT_ID_PATTERN.test(commit)) {
    throw materializationError('A full commit identifier is required.');
  }

  const entries: GitTreeEntry[] = [];
  let pending = Buffer.alloc(0);
  let outputBytes = 0;
  try {
    await runGitStreaming({
      cwd: rootPath,
      args: ['ls-tree', '-r', '-l', '-z', '--full-tree', commit],
      timeoutMs: LS_TREE_TIMEOUT_MS,
      signal,
      spawnFactory,
    }, (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_LS_TREE_OUTPUT_BYTES) throw materializationError();
      let recordStart = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 0) continue;
        const tail = chunk.subarray(recordStart, index);
        const record = pending.length === 0 ? tail : Buffer.concat([pending, tail]);
        pending = Buffer.alloc(0);
        if (record.length === 0) throw materializationError();
        entries.push(parseLsTreeRecord(record));
        if (entries.length > MAX_REVIEW_BASELINE_ENTRIES) throw materializationError();
        recordStart = index + 1;
      }

      if (recordStart < chunk.length) {
        const tail = chunk.subarray(recordStart);
        pending = pending.length === 0 ? Buffer.from(tail) : Buffer.concat([pending, tail]);
        if (pending.length > MAX_LS_TREE_RECORD_BYTES) throw materializationError();
      }
    });
    if (pending.length !== 0) throw materializationError();
    throwIfCancelled(signal);
    return entries;
  } catch (error) {
    throw sanitizedFailure(error);
  }
}

function markerText(marker: ReviewTempMarker): string {
  return JSON.stringify({
    uuid: marker.uuid,
    traceDeckVersion: marker.traceDeckVersion,
    startedAt: marker.startedAt,
  });
}

export async function createReviewTempRoot(traceDeckVersion: string): Promise<ReviewTempRoot> {
  if (traceDeckVersion.length === 0 || traceDeckVersion.length > 256) throw materializationError();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const uuid = randomUUID();
    const rootPath = join(tmpdir(), `${REVIEW_TEMP_PREFIX}${uuid}`);
    const treePath = join(rootPath, 'tree');
    const statePath = join(rootPath, 'state');
    const markerPath = join(rootPath, REVIEW_TEMP_MARKER);
    try {
      await fileSystem.mkdir(rootPath, { recursive: false, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw materializationError('A review workspace could not be created.');
    }

    let markerCreated = false;
    try {
      const marker: ReviewTempMarker = {
        uuid,
        traceDeckVersion,
        startedAt: new Date().toISOString(),
      };
      await fileSystem.writeFile(markerPath, markerText(marker), { flag: 'wx', mode: 0o600 });
      markerCreated = true;
      await fileSystem.mkdir(treePath, { recursive: false, mode: 0o700 });
      await fileSystem.mkdir(statePath, { recursive: false, mode: 0o700 });
      return { rootPath, treePath, statePath, markerPath, uuid };
    } catch {
      if (markerCreated) await removeVerifiedReviewTemp(rootPath);
      else {
        try {
          await fileSystem.rmdir(rootPath);
        } catch {
          // A failed marker write may leave an unusable root, which startup cleanup will skip.
        }
      }
      throw materializationError('A review workspace could not be created.');
    }
  }

  throw materializationError('A review workspace could not be created.');
}

function parseMarker(value: string, expectedUuid: string): ReviewTempMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  const keys = Object.keys(source).sort(compareCodePoints);
  if (keys.join('\0') !== ['startedAt', 'traceDeckVersion', 'uuid'].join('\0')) return null;
  if (
    source.uuid !== expectedUuid
    || typeof source.traceDeckVersion !== 'string'
    || source.traceDeckVersion.length === 0
    || source.traceDeckVersion.length > 256
    || typeof source.startedAt !== 'string'
  ) {
    return null;
  }
  const startedAtTime = Date.parse(source.startedAt);
  if (!Number.isFinite(startedAtTime) || new Date(startedAtTime).toISOString() !== source.startedAt) {
    return null;
  }
  return {
    uuid: source.uuid,
    traceDeckVersion: source.traceDeckVersion,
    startedAt: source.startedAt,
  };
}

async function inspectVerifiedReviewTemp(
  rootPath: string,
  expectedVersion?: string,
): Promise<VerifiedReviewTemp | null> {
  try {
    const tempParent = resolve(tmpdir());
    if (
      !isAbsolute(rootPath)
      || normalize(rootPath) !== rootPath
      || dirname(rootPath) !== tempParent
    ) {
      return null;
    }
    const name = basename(rootPath);
    if (!name.startsWith(REVIEW_TEMP_PREFIX)) return null;
    const uuid = name.slice(REVIEW_TEMP_PREFIX.length);
    if (!UUID_PATTERN.test(uuid)) return null;

    const rootStats = await fileSystem.lstat(rootPath);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return null;
    const markerPath = join(rootPath, REVIEW_TEMP_MARKER);
    const markerStats = await fileSystem.lstat(markerPath);
    if (
      !markerStats.isFile()
      || markerStats.isSymbolicLink()
      || markerStats.size <= 0
      || markerStats.size > MAX_MARKER_BYTES
    ) {
      return null;
    }
    const marker = parseMarker(await fileSystem.readFile(markerPath, 'utf8'), uuid);
    if (!marker || (expectedVersion !== undefined && marker.traceDeckVersion !== expectedVersion)) {
      return null;
    }
    return { rootPath, marker };
  } catch {
    return null;
  }
}

async function removeVerifiedReviewTempForVersion(
  rootPath: string,
  expectedVersion?: string,
): Promise<boolean> {
  const verified = await inspectVerifiedReviewTemp(rootPath, expectedVersion);
  if (!verified) return false;

  try {
    const reverified = await inspectVerifiedReviewTemp(verified.rootPath, expectedVersion);
    if (!reverified || markerText(reverified.marker) !== markerText(verified.marker)) return false;
    await fileSystem.rm(verified.rootPath, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

export async function removeVerifiedReviewTemp(rootPath: string): Promise<boolean> {
  return removeVerifiedReviewTempForVersion(rootPath);
}

export async function cleanupAbandonedReviewTemps(
  traceDeckVersion: string,
  now = Date.now(),
): Promise<number> {
  let children;
  try {
    children = await fileSystem.readdir(tmpdir(), { withFileTypes: true });
  } catch {
    return 0;
  }

  let removed = 0;
  for (const child of children) {
    if (
      !child.isDirectory()
      || child.isSymbolicLink()
      || !child.name.startsWith(REVIEW_TEMP_PREFIX)
    ) {
      continue;
    }
    const rootPath = join(tmpdir(), child.name);
    const verified = await inspectVerifiedReviewTemp(rootPath, traceDeckVersion);
    if (!verified) continue;
    if (Date.parse(verified.marker.startedAt) >= now - REVIEW_TEMP_MAX_AGE_MS) continue;
    if (await removeVerifiedReviewTempForVersion(rootPath, traceDeckVersion)) removed += 1;
  }
  return removed;
}

class BatchChunkReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private current: Buffer = Buffer.alloc(0);
  private offset = 0;
  private ended = false;

  constructor(chunks: AsyncIterable<Buffer>) {
    this.iterator = chunks[Symbol.asyncIterator]();
  }

  private async ensureChunk(): Promise<boolean> {
    while (this.offset >= this.current.length && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        this.current = Buffer.alloc(0);
        this.offset = 0;
        return false;
      }
      this.current = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.offset = 0;
    }
    return this.offset < this.current.length;
  }

  async readLine(): Promise<Buffer> {
    const parts: Buffer[] = [];
    let length = 0;
    while (await this.ensureChunk()) {
      const newline = this.current.indexOf(0x0a, this.offset);
      const end = newline < 0 ? this.current.length : newline;
      const part = this.current.subarray(this.offset, end);
      if (part.length > 0) {
        parts.push(part);
        length += part.length;
      }
      this.offset = newline < 0 ? this.current.length : newline + 1;
      if (length > 512) throw materializationError('Git object data was invalid.');
      if (newline >= 0) return Buffer.concat(parts, length);
    }
    throw materializationError('Git object data was invalid.');
  }

  async readExactly(
    byteCount: number,
    onChunk: (chunk: Buffer) => Promise<void>,
  ): Promise<void> {
    let remaining = byteCount;
    while (remaining > 0) {
      if (!await this.ensureChunk()) throw materializationError('Git object data was invalid.');
      const available = Math.min(remaining, this.current.length - this.offset);
      const part = this.current.subarray(this.offset, this.offset + available);
      this.offset += available;
      remaining -= available;
      await onChunk(part);
    }
  }

  async readTerminator(): Promise<void> {
    if (!await this.ensureChunk() || this.current[this.offset] !== 0x0a) {
      throw materializationError('Git object data was invalid.');
    }
    this.offset += 1;
  }

  async expectEnd(): Promise<void> {
    if (await this.ensureChunk()) throw materializationError('Git object data was invalid.');
  }
}

class BlobContextTracker {
  private readonly prefixParts: Buffer[] = [];
  private prefixLength = 0;
  private readonly lineParts: Buffer[] = [];
  private lineLength = 0;
  private lineOverflow = false;
  private lineNumber = 0;
  readonly filterRules: FilterRule[] = [];
  uncertainFilterContext = false;

  constructor(private readonly relativePath: string) {}

  accept(chunk: Buffer): void {
    if (this.prefixLength < LFS_POINTER_HEADER.length + 1) {
      const retained = Buffer.from(chunk.subarray(
        0,
        Math.min(chunk.length, LFS_POINTER_HEADER.length + 1 - this.prefixLength),
      ));
      this.prefixParts.push(retained);
      this.prefixLength += retained.length;
    }
    if (!this.isAttributesFile()) return;

    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      this.appendLinePart(chunk.subarray(start, index));
      this.finishLine();
      start = index + 1;
    }
    if (start < chunk.length) this.appendLinePart(chunk.subarray(start));
  }

  finish(): { lfsPointer: boolean; rules: FilterRule[]; uncertain: boolean } {
    if (this.isAttributesFile() && (this.lineLength > 0 || this.lineOverflow)) this.finishLine();
    const prefix = Buffer.concat(this.prefixParts, this.prefixLength);
    const afterHeader = prefix[LFS_POINTER_HEADER.length];
    const lfsPointer = prefix.subarray(0, LFS_POINTER_HEADER.length).equals(LFS_POINTER_HEADER)
      && (afterHeader === undefined || afterHeader === 0x0a || afterHeader === 0x0d);
    return {
      lfsPointer,
      rules: this.filterRules,
      uncertain: this.uncertainFilterContext,
    };
  }

  private isAttributesFile(): boolean {
    return this.relativePath === '.gitattributes' || this.relativePath.endsWith('/.gitattributes');
  }

  private appendLinePart(part: Buffer): void {
    if (this.lineOverflow || part.length === 0) return;
    if (this.lineLength + part.length > MAX_ATTRIBUTE_LINE_BYTES) {
      this.lineParts.length = 0;
      this.lineLength = 0;
      this.lineOverflow = true;
      this.uncertainFilterContext = true;
      return;
    }
    this.lineParts.push(Buffer.from(part));
    this.lineLength += part.length;
  }

  private finishLine(): void {
    this.lineNumber += 1;
    if (!this.lineOverflow) this.parseLine(Buffer.concat(this.lineParts, this.lineLength).toString('utf8'));
    this.lineParts.length = 0;
    this.lineLength = 0;
    this.lineOverflow = false;
  }

  private parseLine(value: string): void {
    const line = value.endsWith('\r') ? value.slice(0, -1) : value;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) return;
    const fields = trimmed.split(/\s+/);
    const pattern = fields.shift();
    if (!pattern || pattern.startsWith('!') || pattern.startsWith('"') || pattern.includes('\\')) {
      if (fields.some((field) => /^(?:-?|!)filter(?:=|$)/.test(field))) {
        this.uncertainFilterContext = true;
      }
      return;
    }

    for (const attribute of fields) {
      let enabled: boolean | null = null;
      if (attribute === 'filter' || /^filter=[^\s]+$/.test(attribute)) enabled = true;
      else if (attribute === '-filter' || attribute === '!filter') enabled = false;
      if (enabled === null) continue;
      const sourceSlash = this.relativePath.lastIndexOf('/');
      this.filterRules.push({
        sourcePath: this.relativePath,
        baseDirectory: sourceSlash < 0 ? '' : this.relativePath.slice(0, sourceSlash),
        pattern,
        enabled,
        line: this.lineNumber,
      });
    }
  }
}

function globExpression(pattern: string): RegExp | null {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        while (pattern[index + 1] === '*') index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else if ('\\^$.*+?()[]{}|'.includes(character ?? '')) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  try {
    return new RegExp(`${source}$`, 'u');
  } catch {
    return null;
  }
}

function filterRuleMatches(rule: FilterRule, relativePath: string): boolean | null {
  const prefix = rule.baseDirectory.length === 0 ? '' : `${rule.baseDirectory}/`;
  if (!relativePath.startsWith(prefix)) return false;
  const candidate = relativePath.slice(prefix.length);
  const pattern = rule.pattern.startsWith('/') ? rule.pattern.slice(1) : rule.pattern;
  if (pattern.length === 0 || pattern.endsWith('/')) return false;
  if (pattern.includes('[') || pattern.includes(']')) return null;
  const expression = globExpression(pattern);
  if (!expression) return null;
  if (pattern.includes('/')) return expression.test(candidate);
  return candidate.split('/').some((component) => expression.test(component));
}

function pathsWithApplicableFilters(
  paths: readonly string[],
  rules: readonly FilterRule[],
): { paths: string[]; uncertain: boolean } {
  const orderedRules = [...rules].sort((left, right) => {
    const depthDifference = left.baseDirectory.split('/').filter(Boolean).length
      - right.baseDirectory.split('/').filter(Boolean).length;
    if (depthDifference !== 0) return depthDifference;
    const sourceDifference = compareCodePoints(left.sourcePath, right.sourcePath);
    return sourceDifference !== 0 ? sourceDifference : left.line - right.line;
  });
  const affected: string[] = [];
  let uncertain = false;
  for (const path of paths) {
    let enabled = false;
    for (const rule of orderedRules) {
      const matches = filterRuleMatches(rule, path);
      if (matches === null) uncertain = true;
      else if (matches) enabled = rule.enabled;
    }
    if (enabled) affected.push(path);
  }
  return { paths: affected, uncertain };
}

function limitation(code: string, message: string, paths: readonly string[]): ReviewLimitation {
  const orderedPaths = [...paths].sort(compareCodePoints);
  const evidence = {
    scope: 'baseline' as const,
    code,
    message,
    paths: orderedPaths,
    omittedCount: 0,
  };
  return {
    itemType: 'limitation',
    stableKey: canonicalSha256(evidence),
    ...evidence,
  };
}

function destinationPath(treePath: string, relativePath: string): string {
  const components = validateRelativePath(relativePath);
  const destination = resolve(treePath, ...components);
  const expected = join(treePath, ...components);
  const platformRelative = relative(treePath, destination);
  if (
    destination !== expected
    || platformRelative.length === 0
    || platformRelative.startsWith(`..${sep}`)
    || platformRelative === '..'
    || isAbsolute(platformRelative)
    || platformRelative.split(sep).join('/') !== relativePath
  ) {
    throw materializationError();
  }
  return destination;
}

async function ensureSafeParentDirectories(
  adapter: MaterializerFileSystem,
  treePath: string,
  relativePath: string,
): Promise<void> {
  const components = validateRelativePath(relativePath);
  let current = treePath;
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    await adapter.mkdir(current, { recursive: false, mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const stats = await adapter.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw materializationError();
  }
}

async function writeAll(
  handle: FileHandle,
  chunk: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    throwIfCancelled(signal);
    const result = await handle.write(chunk, offset, chunk.length - offset);
    if (result.bytesWritten <= 0) throw materializationError();
    offset += result.bytesWritten;
  }
}

async function consumeBatch(
  chunks: AsyncIterable<Buffer>,
  entries: readonly GitTreeEntry[],
  treePath: string,
  adapter: MaterializerFileSystem,
  signal: AbortSignal | undefined,
): Promise<{ lfsPaths: string[]; filterRules: FilterRule[]; uncertainFilterContext: boolean }> {
  const reader = new BatchChunkReader(chunks);
  const lfsPaths: string[] = [];
  const filterRules: FilterRule[] = [];
  let uncertainFilterContext = false;

  for (const entry of entries) {
    throwIfCancelled(signal);
    const header = (await reader.readLine()).toString('ascii');
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([^ ]+) ([0-9]+)$/.exec(header);
    if (
      !match
      || match[1] !== entry.objectId
      || match[2] !== 'blob'
      || Number(match[3]) !== entry.size
    ) {
      throw materializationError('Git object data was invalid.');
    }

    const destination = destinationPath(treePath, entry.relativePath);
    await ensureSafeParentDirectories(adapter, treePath, entry.relativePath);
    throwIfCancelled(signal);
    const handle = await adapter.open(destination, 'wx', entry.mode === '100755' ? 0o755 : 0o644);
    const tracker = new BlobContextTracker(entry.relativePath);
    try {
      await reader.readExactly(entry.size as number, async (chunk) => {
        throwIfCancelled(signal);
        tracker.accept(chunk);
        await writeAll(handle, chunk, signal);
      });
    } finally {
      await handle.close();
    }
    await reader.readTerminator();
    await adapter.chmod(destination, entry.mode === '100755' ? 0o755 : 0o644);
    const context = tracker.finish();
    if (context.lfsPointer) lfsPaths.push(entry.relativePath);
    filterRules.push(...context.rules);
    uncertainFilterContext ||= context.uncertain;
  }
  throwIfCancelled(signal);
  await reader.expectEnd();
  return { lfsPaths, filterRules, uncertainFilterContext };
}

async function verifyMaterializationTemp(temp: ReviewTempRoot): Promise<void> {
  const verified = await inspectVerifiedReviewTemp(temp.rootPath);
  if (
    !verified
    || verified.marker.uuid !== temp.uuid
    || temp.treePath !== join(temp.rootPath, 'tree')
    || temp.statePath !== join(temp.rootPath, 'state')
    || temp.markerPath !== join(temp.rootPath, REVIEW_TEMP_MARKER)
  ) {
    throw materializationError();
  }
  const treeStats = await fileSystem.lstat(temp.treePath);
  const stateStats = await fileSystem.lstat(temp.statePath);
  if (
    !treeStats.isDirectory()
    || treeStats.isSymbolicLink()
    || !stateStats.isDirectory()
    || stateStats.isSymbolicLink()
  ) {
    throw materializationError();
  }
}

const defaultDependencies: MaterializerDependencies = {
  fileSystem,
  enumerateTree: enumerateHeadTree,
  runBatch: runGitCatFileBatch,
};

export async function materializeHeadTree(
  input: {
    projectRoot: string;
    commit: string;
    treeId: string;
    temp: ReviewTempRoot;
    signal?: AbortSignal;
  },
  dependencies: MaterializerDependencies = defaultDependencies,
): Promise<MaterializedHead> {
  try {
    throwIfCancelled(input.signal);
    if (!OBJECT_ID_PATTERN.test(input.commit) || !OBJECT_ID_PATTERN.test(input.treeId)) {
      throw materializationError();
    }
    const entries = await dependencies.enumerateTree(
      input.projectRoot,
      input.commit,
      input.signal,
    );
    throwIfCancelled(input.signal);
    const preflight = preflightTree(entries);
    await verifyMaterializationTemp(input.temp);

    const destinations = new Set<string>();
    for (const entry of preflight.writable) {
      const destination = destinationPath(input.temp.treePath, entry.relativePath);
      if (destinations.has(destination.toLowerCase())) throw materializationError();
      destinations.add(destination.toLowerCase());
    }

    let context = { lfsPaths: [] as string[], filterRules: [] as FilterRule[], uncertainFilterContext: false };
    if (preflight.writable.length > 0) {
      const batchOptions: GitCatFileBatchOptions = {
        cwd: input.projectRoot,
        timeoutMs: CAT_FILE_TIMEOUT_MS,
        signal: input.signal,
      };
      await dependencies.runBatch(
        batchOptions,
        preflight.writable.map((entry) => entry.objectId),
        async (chunks) => {
          context = await consumeBatch(
            chunks,
            preflight.writable,
            input.temp.treePath,
            dependencies.fileSystem,
            input.signal,
          );
        },
      );
    }

    const limitations: ReviewLimitation[] = [];
    const symlinkPaths = preflight.inventoryEvidence
      .filter((evidence) => evidence.entryKind === 'symlink')
      .map((evidence) => evidence.relativePath);
    const submodulePaths = preflight.inventoryEvidence
      .filter((evidence) => evidence.entryKind === 'submodule')
      .map((evidence) => evidence.relativePath);
    const unsupportedPaths = entries
      .filter((entry) => !isWritableEntry(entry) && !isSymlinkEntry(entry) && !isSubmoduleEntry(entry))
      .map((entry) => entry.relativePath);
    if (symlinkPaths.length > 0) {
      limitations.push(limitation(
        'SYMLINK_NOT_MATERIALIZED',
        'Committed symbolic links are represented as inventory only.',
        symlinkPaths,
      ));
    }
    if (submodulePaths.length > 0) {
      limitations.push(limitation(
        'SUBMODULE_NOT_MATERIALIZED',
        'Committed submodules are represented as inventory only.',
        submodulePaths,
      ));
    }
    if (unsupportedPaths.length > 0) {
      limitations.push(limitation(
        'UNSUPPORTED_GIT_TREE_ENTRY',
        'Unsupported committed tree entries were not materialized.',
        unsupportedPaths,
      ));
    }

    const applicableFilters = pathsWithApplicableFilters(
      preflight.writable.map((entry) => entry.relativePath),
      context.filterRules,
    );
    const filterOrLfsPaths = new Set([...context.lfsPaths, ...applicableFilters.paths]);
    if (context.uncertainFilterContext || applicableFilters.uncertain) {
      for (const entry of preflight.writable) filterOrLfsPaths.add(entry.relativePath);
    }
    if (filterOrLfsPaths.size > 0) {
      limitations.push(limitation(
        'GIT_FILTER_OR_LFS_NOT_APPLIED',
        'Committed blobs were analyzed raw; Git filters and Git LFS content were not applied.',
        [...filterOrLfsPaths],
      ));
    }

    return {
      treeId: input.treeId,
      relativePaths: preflight.writable.map((entry) => entry.relativePath),
      inventoryEvidence: preflight.inventoryEvidence,
      limitations: limitations.sort((left, right) => compareCodePoints(left.code, right.code)),
      totalEntries: preflight.totalEntries,
      totalBytes: preflight.totalBytes,
    };
  } catch (error) {
    throw sanitizedFailure(error);
  }
}
