import { execFile } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fileSystem from 'node:fs/promises';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupAbandonedReviewTemps,
  createReviewTempRoot,
  enumerateHeadTree,
  materializeHeadTree,
  parseLsTreeRecord,
  preflightTree,
  removeVerifiedReviewTemp,
  type GitTreeEntry,
  type MaterializerDependencies,
  type ReviewTempRoot,
} from '@main/services/changeReview/materializer';
import type { GitSpawnFactory } from '@main/services/changeReview/gitProcess';
import {
  MAX_REVIEW_BASELINE_BYTES,
  MAX_REVIEW_BASELINE_ENTRIES,
  REVIEW_TEMP_MARKER,
  REVIEW_TEMP_PREFIX,
} from '@shared/constants';

const temporaryDirectories: string[] = [];
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

function entry(overrides: Partial<GitTreeEntry> = {}): GitTreeEntry {
  return {
    mode: '100644',
    type: 'blob',
    objectId: OID_A,
    size: 4,
    relativePath: 'src/file.ts',
    ...overrides,
  };
}

function git(rootPath: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd: rootPath,
        encoding: 'buffer',
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(rootPath);
  return rootPath;
}

async function initializeRepository(rootPath: string): Promise<void> {
  await git(rootPath, ['init', '-b', 'review-branch']);
  await git(rootPath, ['config', 'user.email', 'review@example.test']);
  await git(rootPath, ['config', 'user.name', 'Review Fixture']);
}

interface MarkerOptions {
  uuid?: string;
  markerUuid?: string;
  traceDeckVersion?: string;
  startedAt?: string;
  markerText?: string;
}

async function createMarkerFixture(options: MarkerOptions = {}): Promise<ReviewTempRoot> {
  const uuid = options.uuid ?? randomUUID();
  const rootPath = join(tmpdir(), `${REVIEW_TEMP_PREFIX}${uuid}`);
  const treePath = join(rootPath, 'tree');
  const statePath = join(rootPath, 'state');
  const markerPath = join(rootPath, REVIEW_TEMP_MARKER);
  await mkdir(treePath, { recursive: true });
  await mkdir(statePath);
  await writeFile(
    markerPath,
    options.markerText ?? JSON.stringify({
      uuid: options.markerUuid ?? uuid,
      traceDeckVersion: options.traceDeckVersion ?? 'marker-test',
      startedAt: options.startedAt ?? new Date().toISOString(),
    }),
  );
  temporaryDirectories.push(rootPath);
  return { rootPath, treePath, statePath, markerPath, uuid };
}

async function* chunks(values: readonly Buffer[]): AsyncGenerator<Buffer> {
  for (const value of values) yield value;
}

function fakeLsTreeSpawn(output: Buffer): {
  spawnFactory: GitSpawnFactory;
  calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }>;
} {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const spawnFactory = ((
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      kill: vi.fn(() => true),
    });
    queueMicrotask(() => {
      stdout.end(output);
      stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  }) as unknown as GitSpawnFactory;
  return { spawnFactory, calls };
}

function batchDependencies(
  entries: readonly GitTreeEntry[],
  outputChunks: readonly Buffer[],
  requestedIds: string[] = [],
): MaterializerDependencies {
  return {
    fileSystem,
    enumerateTree: vi.fn(async () => [...entries]),
    runBatch: vi.fn(async (_options, objectIds, consume) => {
      requestedIds.push(...objectIds);
      await consume(chunks(outputChunks));
    }),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

describe('ls-tree parsing and preflight', () => {
  it('parses regular, executable, symlink, and submodule records from bytes', () => {
    expect(parseLsTreeRecord(Buffer.from(`100644 blob ${OID_A} 12\tsrc/a file.ts`))).toEqual(
      entry({ size: 12, relativePath: 'src/a file.ts' }),
    );
    expect(parseLsTreeRecord(Buffer.from(`100755 blob ${OID_B} 3\tbin/run`))).toEqual(
      entry({ mode: '100755', objectId: OID_B, size: 3, relativePath: 'bin/run' }),
    );
    expect(parseLsTreeRecord(Buffer.from(`120000 blob ${OID_A} 6\tlink`))).toEqual(
      entry({ mode: '120000', size: 6, relativePath: 'link' }),
    );
    expect(parseLsTreeRecord(Buffer.from(`160000 commit ${OID_B} -\tvendor/lib`))).toEqual(
      entry({ mode: '160000', type: 'commit', objectId: OID_B, size: null, relativePath: 'vendor/lib' }),
    );
  });

  it('rejects invalid UTF-8 path bytes and malformed metadata', () => {
    const invalidUtf8 = Buffer.concat([
      Buffer.from(`100644 blob ${OID_A} 1\t`),
      Buffer.from([0xff]),
    ]);

    expect(() => parseLsTreeRecord(invalidUtf8)).toThrowError(
      expect.objectContaining({ code: 'INVALID_GIT_PATH_ENCODING' }),
    );
    expect(() => parseLsTreeRecord(Buffer.from(`100644 tree ${OID_A} -\tdir`))).toThrow();
    expect(() => parseLsTreeRecord(Buffer.from(`100644 blob ${OID_A} no\tfile`))).toThrow();
  });

  it.each([
    '/absolute.ts',
    'C:/absolute.ts',
    '../escape.ts',
    'src/../escape.ts',
    'src\\windows-separator.ts',
    'src//double.ts',
    'src/./dot.ts',
    '',
  ])('rejects unsafe or ambiguously resolved path %j before extraction', (relativePath) => {
    expect(() => preflightTree([entry({ relativePath })])).toThrow();
  });

  it('classifies writable files and synthetic inventory without counting link bytes', () => {
    const result = preflightTree([
      entry({ relativePath: 'plain', size: 4 }),
      entry({ mode: '100755', relativePath: 'executable', size: 5 }),
      entry({ mode: '120000', relativePath: 'link', size: 20 }),
      entry({ mode: '160000', type: 'commit', relativePath: 'module', size: null }),
      entry({ mode: '040000', relativePath: 'unsupported', size: null }),
    ]);

    expect(result.writable.map((item) => item.relativePath)).toEqual(['executable', 'plain']);
    expect(result.inventoryEvidence).toEqual([
      expect.objectContaining({ relativePath: 'link', entryKind: 'symlink' }),
      expect.objectContaining({ relativePath: 'module', entryKind: 'submodule' }),
    ]);
    expect(result.totalEntries).toBe(5);
    expect(result.totalBytes).toBe(9);
  });

  it('rejects the entry ceiling before extraction', () => {
    const entries = Array.from({ length: MAX_REVIEW_BASELINE_ENTRIES + 1 }, (_, index) => entry({
      relativePath: `files/${index.toString().padStart(6, '0')}`,
      size: 0,
    }));

    expect(() => preflightTree(entries)).toThrow();
  });

  it('rejects the regular blob byte ceiling before extraction', () => {
    expect(() => preflightTree([
      entry({ relativePath: 'large-a', size: MAX_REVIEW_BASELINE_BYTES }),
      entry({ relativePath: 'large-b', size: 1 }),
    ])).toThrow();
  });

  it('rejects deterministic lowercase POSIX path collisions', () => {
    expect(() => preflightTree([
      entry({ relativePath: 'Src/File.ts' }),
      entry({ relativePath: 'src/file.ts', objectId: OID_B }),
    ])).toThrow();
  });

  it('uses the fixed ls-tree argument array without dangerous Git operations', async () => {
    const commit = 'c'.repeat(40);
    const fake = fakeLsTreeSpawn(Buffer.from(`100644 blob ${OID_A} 4\tsafe.txt\0`));

    await expect(enumerateHeadTree('C:\\project with spaces', commit, undefined, fake.spawnFactory))
      .resolves.toEqual([entry({ relativePath: 'safe.txt' })]);

    expect(fake.calls).toEqual([{
      command: 'git',
      args: ['ls-tree', '-r', '-l', '-z', '--full-tree', commit],
      options: {
        cwd: 'C:\\project with spaces',
        shell: false,
        windowsHide: true,
      },
    }]);
    const allArguments = fake.calls.flatMap((call) => call.args);
    for (const forbidden of [
      'checkout', 'reset', 'clean', 'worktree', 'submodule', 'hook', 'filter',
      '--ext-diff', '--textconv',
    ]) {
      expect(allArguments).not.toContain(forbidden);
    }
  });

  it('requires a full lowercase hex commit before spawning Git', async () => {
    const fake = fakeLsTreeSpawn(Buffer.alloc(0));

    await expect(enumerateHeadTree('C:\\private\\project', 'HEAD', undefined, fake.spawnFactory))
      .rejects.toThrow('A full commit identifier is required.');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('verified review temporary roots', () => {
  it('creates a direct temp child with exact marker JSON and private directories', async () => {
    const before = Date.now();
    const temp = await createReviewTempRoot('0.1.0-test');
    temporaryDirectories.push(temp.rootPath);
    const after = Date.now();
    const markerBytes = await readFile(temp.markerPath, 'utf8');
    const marker = JSON.parse(markerBytes) as Record<string, unknown>;

    expect(dirname(temp.rootPath)).toBe(tmpdir());
    expect(temp.rootPath).toBe(join(tmpdir(), `${REVIEW_TEMP_PREFIX}${temp.uuid}`));
    expect(temp.markerPath).toBe(join(temp.rootPath, REVIEW_TEMP_MARKER));
    expect(markerBytes).toBe(JSON.stringify({
      uuid: temp.uuid,
      traceDeckVersion: '0.1.0-test',
      startedAt: marker.startedAt,
    }));
    expect(Date.parse(marker.startedAt as string)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(marker.startedAt as string)).toBeLessThanOrEqual(after);
    expect((await lstat(temp.markerPath)).isFile()).toBe(true);
    expect((await lstat(temp.treePath)).isDirectory()).toBe(true);
    expect((await lstat(temp.statePath)).isDirectory()).toBe(true);
  });

  it('removes a verified direct child with a regular matching marker', async () => {
    const temp = await createMarkerFixture();

    await expect(removeVerifiedReviewTemp(temp.rootPath)).resolves.toBe(true);
    await expect(lstat(temp.rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['UUID mismatch', { markerUuid: randomUUID() }],
    ['malformed marker', { markerText: '{broken' }],
  ] as const)('refuses a root with %s', async (_label, options) => {
    const temp = await createMarkerFixture(options);

    await expect(removeVerifiedReviewTemp(temp.rootPath)).resolves.toBe(false);
    expect((await lstat(temp.rootPath)).isDirectory()).toBe(true);
  });

  it('refuses an unverified matching directory and a verified nested directory', async () => {
    const uuid = randomUUID();
    const unverified = join(tmpdir(), `${REVIEW_TEMP_PREFIX}${uuid}`);
    await mkdir(unverified);
    temporaryDirectories.push(unverified);
    const verified = await createMarkerFixture();
    const nested = join(verified.rootPath, `${REVIEW_TEMP_PREFIX}${randomUUID()}`);
    await mkdir(nested);

    await expect(removeVerifiedReviewTemp(unverified)).resolves.toBe(false);
    await expect(removeVerifiedReviewTemp(nested)).resolves.toBe(false);
  });

  it('refuses a symlink marker where file symlinks are supported', async () => {
    const uuid = randomUUID();
    const rootPath = join(tmpdir(), `${REVIEW_TEMP_PREFIX}${uuid}`);
    const markerPath = join(rootPath, REVIEW_TEMP_MARKER);
    await mkdir(rootPath);
    temporaryDirectories.push(rootPath);
    const target = join(rootPath, 'marker-target');
    await writeFile(target, JSON.stringify({
      uuid,
      traceDeckVersion: 'marker-test',
      startedAt: new Date().toISOString(),
    }));
    try {
      await symlink(target, markerPath, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    await expect(removeVerifiedReviewTemp(rootPath)).resolves.toBe(false);
    expect((await lstat(rootPath)).isDirectory()).toBe(true);
  });

  it('skips a 23-hour root and removes a 25-hour root at startup', async () => {
    const now = Date.now();
    const version = `cleanup-test-${randomUUID()}`;
    const young = await createMarkerFixture({
      traceDeckVersion: version,
      startedAt: new Date(now - 23 * 60 * 60 * 1000).toISOString(),
    });
    const old = await createMarkerFixture({
      traceDeckVersion: version,
      startedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    });
    await createMarkerFixture({
      traceDeckVersion: `${version}-other`,
      startedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    });

    await expect(cleanupAbandonedReviewTemps(version, now)).resolves.toBe(1);
    expect((await lstat(young.rootPath)).isDirectory()).toBe(true);
    await expect(lstat(old.rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('cat-file protocol and materialization', () => {
  it('reassembles split headers, payloads, and terminators and requests sorted objects once', async () => {
    const temp = await createReviewTempRoot('batch-test');
    temporaryDirectories.push(temp.rootPath);
    const first = entry({ objectId: OID_A, size: 4, relativePath: 'z-last.txt' });
    const second = entry({ objectId: OID_B, size: 3, relativePath: 'a-first.txt' });
    const protocol = Buffer.concat([
      Buffer.from(`${OID_B} blob 3\n`), Buffer.from('two'), Buffer.from('\n'),
      Buffer.from(`${OID_A} blob 4\n`), Buffer.from('one!'), Buffer.from('\n'),
    ]);
    const outputChunks = [
      protocol.subarray(0, 7),
      protocol.subarray(7, 43),
      protocol.subarray(43, 48),
      protocol.subarray(48, 51),
      protocol.subarray(51, 93),
      protocol.subarray(93, protocol.length - 1),
      protocol.subarray(protocol.length - 1),
    ];
    const syntheticLink = entry({ mode: '120000', size: 6, relativePath: 'regular-link' });
    const syntheticModule = entry({
      mode: '160000',
      type: 'commit',
      objectId: OID_B,
      size: null,
      relativePath: 'vendor/module',
    });
    const requestedIds: string[] = [];
    const symlinkSpy = vi.spyOn(fileSystem, 'symlink');
    const readlinkSpy = vi.spyOn(fileSystem, 'readlink');

    const result = await materializeHeadTree({
      projectRoot: 'C:\\private\\repository',
      commit: 'c'.repeat(40),
      treeId: 'd'.repeat(40),
      temp,
    }, batchDependencies(
      [first, syntheticLink, syntheticModule, second],
      outputChunks,
      requestedIds,
    ));

    expect(requestedIds).toEqual([OID_B, OID_A]);
    expect(await readFile(join(temp.treePath, 'a-first.txt'))).toEqual(Buffer.from('two'));
    expect(await readFile(join(temp.treePath, 'z-last.txt'))).toEqual(Buffer.from('one!'));
    expect(result.relativePaths).toEqual(['a-first.txt', 'z-last.txt']);
    expect(result.inventoryEvidence).toEqual([
      expect.objectContaining({ relativePath: 'regular-link', entryKind: 'symlink' }),
      expect.objectContaining({ relativePath: 'vendor/module', entryKind: 'submodule' }),
    ]);
    expect(symlinkSpy).not.toHaveBeenCalled();
    expect(readlinkSpy).not.toHaveBeenCalled();
  });

  it('detects an applicable committed filter rule without executing it', async () => {
    const temp = await createReviewTempRoot('filter-test');
    temporaryDirectories.push(temp.rootPath);
    const attributes = Buffer.from('*.bin filter=custom -text\n');
    const content = Buffer.from('raw committed bytes\n');
    const attributesEntry = entry({
      objectId: OID_A,
      size: attributes.length,
      relativePath: '.gitattributes',
    });
    const contentEntry = entry({
      objectId: OID_B,
      size: content.length,
      relativePath: 'nested/data.bin',
    });
    const protocol = Buffer.concat([
      Buffer.from(`${OID_A} blob ${attributes.length}\n`), attributes, Buffer.from('\n'),
      Buffer.from(`${OID_B} blob ${content.length}\n`), content, Buffer.from('\n'),
    ]);

    const result = await materializeHeadTree({
      projectRoot: 'C:\\private\\repository',
      commit: 'c'.repeat(40),
      treeId: 'd'.repeat(40),
      temp,
    }, batchDependencies([contentEntry, attributesEntry], [protocol]));

    expect(result.limitations).toContainEqual(expect.objectContaining({
      code: 'GIT_FILTER_OR_LFS_NOT_APPLIED',
      paths: ['nested/data.bin'],
    }));
  });

  it('checks cancellation after enumeration and before starting the batch', async () => {
    const temp = await createReviewTempRoot('cancel-after-enumeration-test');
    temporaryDirectories.push(temp.rootPath);
    const controller = new AbortController();
    const dependencies = batchDependencies([entry()], []);
    dependencies.enumerateTree = vi.fn(async () => {
      controller.abort();
      return [entry()];
    });

    await expect(materializeHeadTree({
      projectRoot: 'C:\\private\\repository',
      commit: 'c'.repeat(40),
      treeId: 'd'.repeat(40),
      temp,
      signal: controller.signal,
    }, dependencies)).rejects.toEqual(expect.objectContaining({ code: 'REVIEW_CANCELLED' }));
    expect(dependencies.runBatch).not.toHaveBeenCalled();
  });

  it('checks cancellation between batch objects', async () => {
    const temp = await createReviewTempRoot('cancel-between-objects-test');
    temporaryDirectories.push(temp.rootPath);
    const controller = new AbortController();
    const first = entry({ objectId: OID_A, size: 1, relativePath: 'a.txt' });
    const second = entry({ objectId: OID_B, size: 1, relativePath: 'b.txt' });
    const dependencies: MaterializerDependencies = {
      fileSystem,
      enumerateTree: vi.fn(async () => [first, second]),
      runBatch: vi.fn(async (_options, _objectIds, consume) => {
        await consume((async function* stream(): AsyncGenerator<Buffer> {
          yield Buffer.from(`${OID_A} blob 1\na\n`);
          controller.abort();
          yield Buffer.from(`${OID_B} blob 1\nb\n`);
        })());
      }),
    };

    await expect(materializeHeadTree({
      projectRoot: 'C:\\private\\repository',
      commit: 'c'.repeat(40),
      treeId: 'd'.repeat(40),
      temp,
      signal: controller.signal,
    }, dependencies)).rejects.toEqual(expect.objectContaining({ code: 'REVIEW_CANCELLED' }));
    expect(await readFile(join(temp.treePath, 'a.txt'))).toEqual(Buffer.from('a'));
    await expect(lstat(join(temp.treePath, 'b.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports unsupported entries without starting an empty batch', async () => {
    const temp = await createReviewTempRoot('unsupported-test');
    temporaryDirectories.push(temp.rootPath);
    const dependencies = batchDependencies([
      entry({ mode: '100664', relativePath: 'odd-mode.txt' }),
    ], []);

    const result = await materializeHeadTree({
      projectRoot: 'C:\\private\\repository',
      commit: 'c'.repeat(40),
      treeId: 'd'.repeat(40),
      temp,
    }, dependencies);

    expect(dependencies.runBatch).not.toHaveBeenCalled();
    expect(result.limitations).toContainEqual(expect.objectContaining({
      code: 'UNSUPPORTED_GIT_TREE_ENTRY',
      paths: ['odd-mode.txt'],
    }));
  });

  it.each([
    ['wrong object ID', `${OID_B} blob 4\none!\n`],
    ['wrong object type', `${OID_A} commit 4\none!\n`],
    ['wrong object size', `${OID_A} blob 5\none!x\n`],
    ['missing payload terminator', `${OID_A} blob 4\none!x`],
    ['trailing protocol bytes', `${OID_A} blob 4\none!\nextra`],
  ])('rejects %s without exposing absolute paths', async (_label, protocol) => {
    const temp = await createReviewTempRoot('batch-reject-test');
    temporaryDirectories.push(temp.rootPath);
    const failure = await materializeHeadTree({
      projectRoot: 'C:\\private\\repository',
      commit: 'c'.repeat(40),
      treeId: 'd'.repeat(40),
      temp,
    }, batchDependencies([entry()], [Buffer.from(protocol)])).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain('private');
    expect((failure as Error).message).not.toContain(temp.rootPath);
  });

  it('finishes preflight before opening any blob destination', async () => {
    const temp = await createReviewTempRoot('preflight-test');
    temporaryDirectories.push(temp.rootPath);
    const openSpy = vi.fn(fileSystem.open.bind(fileSystem));
    const dependencies = batchDependencies([entry({ relativePath: '../escape' })], []);
    dependencies.fileSystem = { ...fileSystem, open: openSpy };

    await expect(materializeHeadTree({
      projectRoot: 'C:\\private\\repository',
      commit: 'c'.repeat(40),
      treeId: 'd'.repeat(40),
      temp,
    }, dependencies)).rejects.toThrow();
    expect(openSpy).not.toHaveBeenCalled();
    expect(dependencies.runBatch).not.toHaveBeenCalled();
  });

  it('materializes committed raw blobs without changing repository or index bytes', async () => {
    const projectRoot = await temporaryDirectory('tracedeck-materializer-repo-');
    await initializeRepository(projectRoot);
    await writeFile(join(projectRoot, 'regular.txt'), 'regular bytes\n');
    await writeFile(join(projectRoot, 'run.sh'), '#!/bin/sh\necho safe\n');
    await writeFile(join(projectRoot, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    const pointer = [
      'version https://git-lfs.github.com/spec/v1',
      `oid sha256:${'1'.repeat(64)}`,
      'size 12',
      '',
    ].join('\n');
    await writeFile(join(projectRoot, 'asset.bin'), pointer);

    let hasSymlink = false;
    try {
      await symlink('regular.txt', join(projectRoot, 'regular-link'), 'file');
      hasSymlink = (await lstat(join(projectRoot, 'regular-link'))).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }

    await git(projectRoot, ['add', '--all']);
    await git(projectRoot, ['update-index', '--chmod=+x', '--', 'run.sh']);
    await git(projectRoot, ['commit', '-m', 'fixture files']);
    const firstCommit = (await git(projectRoot, ['rev-parse', '--verify', 'HEAD'])).toString().trim();
    await git(projectRoot, ['update-index', '--add', '--cacheinfo', `160000,${firstCommit},vendor/module`]);
    await git(projectRoot, ['commit', '-m', 'fixture gitlink']);
    const commit = (await git(projectRoot, ['rev-parse', '--verify', 'HEAD'])).toString().trim();
    const treeId = (await git(projectRoot, ['rev-parse', '--verify', 'HEAD^{tree}'])).toString().trim();
    const statusBefore = await git(projectRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
    const indexBefore = await readFile(join(projectRoot, '.git', 'index'));
    const temp = await createReviewTempRoot('integration-test');
    temporaryDirectories.push(temp.rootPath);

    const result = await materializeHeadTree({ projectRoot, commit, treeId, temp });

    expect(result.treeId).toBe(treeId);
    expect(result.inventoryEvidence).toContainEqual(expect.objectContaining({
      relativePath: 'vendor/module',
      entryKind: 'submodule',
    }));
    if (hasSymlink) {
      expect(result.inventoryEvidence).toContainEqual(expect.objectContaining({
        relativePath: 'regular-link',
        entryKind: 'symlink',
      }));
    }
    for (const relativePath of result.relativePaths) {
      const expected = await git(projectRoot, ['cat-file', 'blob', `${commit}:${relativePath}`]);
      expect(await readFile(join(temp.treePath, ...relativePath.split('/')))).toEqual(expected);
    }
    if (process.platform !== 'win32') {
      expect((await stat(join(temp.treePath, 'run.sh'))).mode & 0o111).not.toBe(0);
    }
    expect(result.limitations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SUBMODULE_NOT_MATERIALIZED', paths: ['vendor/module'] }),
      expect.objectContaining({ code: 'GIT_FILTER_OR_LFS_NOT_APPLIED', paths: ['asset.bin'] }),
    ]));
    if (hasSymlink) {
      expect(result.limitations).toContainEqual(expect.objectContaining({
        code: 'SYMLINK_NOT_MATERIALIZED',
        paths: ['regular-link'],
      }));
    }
    expect(JSON.stringify(result)).not.toContain(projectRoot);
    expect(JSON.stringify(result)).not.toContain(temp.rootPath);
    expect(await git(projectRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=all']))
      .toEqual(statusBefore);
    expect(await readFile(join(projectRoot, '.git', 'index')).then((bytes) => bytes.equals(indexBefore)))
      .toBe(true);
  }, 30_000);
});
