import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GitReviewError,
  runGitBuffered,
  runGitCatFileBatch,
  runGitNulRecords,
  type GitSpawnFactory,
} from '@main/services/changeReview/gitProcess';
import {
  buildReviewDiffArgs,
  captureWorkingTree,
  parsePorcelainV2,
  readReviewDiff,
  resolveReviewHead,
} from '@main/services/changeReview/gitStatus';

const temporaryDirectories: string[] = [];
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
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

async function initializeRepository(rootPath: string): Promise<void> {
  await git(rootPath, ['init', '-b', 'review-branch']);
  await git(rootPath, ['config', 'user.email', 'review@example.test']);
  await git(rootPath, ['config', 'user.name', 'Review Fixture']);
}

async function commitAll(rootPath: string, message = 'fixture'): Promise<void> {
  await git(rootPath, ['add', '--all']);
  await git(rootPath, ['commit', '-m', message]);
}

function countLines(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) lines += 1;
  }
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}

interface FakeSpawnOptions {
  stdoutChunks?: readonly Buffer[];
  stderr?: Buffer;
  exitCode?: number;
  closeDelayMs?: number;
  waitForKill?: boolean;
}

function fakeSpawn(options: FakeSpawnOptions = {}): {
  spawnFactory: GitSpawnFactory;
  calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }>;
  kills: ReturnType<typeof vi.fn>[];
} {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const kills: ReturnType<typeof vi.fn>[] = [];

  const spawnFactory = ((
    command: string,
    args: readonly string[],
    spawnOptions: Record<string, unknown>,
  ) => {
    calls.push({ command, args: [...args], options: spawnOptions });
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let closed = false;
    const close = (exitCode: number | null): void => {
      if (closed) return;
      closed = true;
      stdout.end();
      stderr.end();
      child.emit('close', exitCode, null);
    };
    const kill = vi.fn(() => {
      queueMicrotask(() => close(null));
      return true;
    });
    kills.push(kill);
    Object.assign(child, { stdin, stdout, stderr, kill });

    if (!options.waitForKill) {
      setTimeout(() => {
        for (const chunk of options.stdoutChunks ?? []) stdout.write(chunk);
        if (options.stderr) stderr.write(options.stderr);
        close(options.exitCode ?? 0);
      }, options.closeDelayMs ?? 0);
    }
    return child;
  }) as unknown as GitSpawnFactory;

  return { spawnFactory, calls, kills };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

describe('porcelain v2 parsing', () => {
  const ordinary = Buffer.from(
    '1 M. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb src/file.ts\0',
  );
  const both = Buffer.from(
    '1 MM N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb both.ts\0',
  );
  const deleted = Buffer.from(
    '1 .D N... 100644 100644 000000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb gone.ts\0',
  );
  const untracked = Buffer.from('? new file.js\0');
  const rename = Buffer.from(
    '2 R. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R087 renamed.ts\0old.ts\0',
  );
  const copy = Buffer.from(
    '2 C. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb C075 copied.ts\0source.ts\0',
  );

  it('parses ordinary, staged and unstaged type-1 records', () => {
    expect(parsePorcelainV2(Buffer.concat([ordinary, both]))).toEqual([
      expect.objectContaining({
        relativePath: 'both.ts',
        changeType: 'modified',
        staged: true,
        unstaged: true,
        untracked: false,
      }),
      expect.objectContaining({
        relativePath: 'src/file.ts',
        changeType: 'modified',
        staged: true,
        unstaged: false,
        language: 'typescript',
      }),
    ]);
  });

  it('parses rename and copy token pairs without inventing a copy change type', () => {
    expect(parsePorcelainV2(Buffer.concat([rename, copy]))).toEqual([
      expect.objectContaining({
        relativePath: 'copied.ts',
        copiedFrom: 'source.ts',
        oldPath: null,
        changeType: 'added',
        similarity: 75,
      }),
      expect.objectContaining({
        relativePath: 'renamed.ts',
        oldPath: 'old.ts',
        copiedFrom: null,
        changeType: 'renamed',
        similarity: 87,
      }),
    ]);
  });

  it('parses deletion and untracked records', () => {
    expect(parsePorcelainV2(Buffer.concat([untracked, deleted]))).toEqual([
      expect.objectContaining({
        relativePath: 'gone.ts',
        changeType: 'deleted',
        staged: false,
        unstaged: true,
      }),
      expect.objectContaining({
        relativePath: 'new file.js',
        changeType: 'added',
        untracked: true,
      }),
    ]);
  });

  it('sorts by code point and produces byte-identical evidence for reversed input', () => {
    const forward = parsePorcelainV2(Buffer.concat([ordinary, untracked, deleted]));
    const reversed = parsePorcelainV2(Buffer.concat([deleted, untracked, ordinary]));

    expect(reversed).toEqual(forward);
    expect(forward.every((change) => /^[0-9a-f]{64}$/.test(change.stableKey))).toBe(true);
  });

  it('rejects path bytes that are not valid UTF-8', () => {
    const output = Buffer.concat([Buffer.from('? '), Buffer.from([0xff]), Buffer.from([0])]);

    expect(() => parsePorcelainV2(output)).toThrowError(
      expect.objectContaining({ code: 'INVALID_GIT_PATH_ENCODING' }),
    );
  });
});

describe('Git process execution', () => {
  it('passes argument arrays to git with shell disabled', async () => {
    const fake = fakeSpawn({ stdoutChunks: [Buffer.from('ok')] });

    await expect(runGitBuffered({
      cwd: 'C:\\project with spaces',
      args: ['rev-parse', '--verify', 'HEAD'],
      timeoutMs: 1000,
      spawnFactory: fake.spawnFactory,
    })).resolves.toEqual(Buffer.from('ok'));

    expect(fake.calls).toEqual([{
      command: 'git',
      args: ['rev-parse', '--verify', 'HEAD'],
      options: {
        cwd: 'C:\\project with spaces',
        shell: false,
        windowsHide: true,
      },
    }]);
  });

  it('kills the child and reports cancellation', async () => {
    const fake = fakeSpawn({ waitForKill: true });
    const controller = new AbortController();
    const operation = runGitBuffered({
      cwd: 'C:\\project',
      args: ['status'],
      timeoutMs: 1000,
      signal: controller.signal,
      spawnFactory: fake.spawnFactory,
    });

    controller.abort();

    await expect(operation).rejects.toEqual(expect.objectContaining({ code: 'REVIEW_CANCELLED' }));
    expect(fake.kills[0]).toHaveBeenCalledOnce();
  });

  it('kills the child and reports timeout', async () => {
    const fake = fakeSpawn({ waitForKill: true });

    await expect(runGitBuffered({
      cwd: 'C:\\project',
      args: ['status'],
      timeoutMs: 5,
      spawnFactory: fake.spawnFactory,
    })).rejects.toEqual(expect.objectContaining({ code: 'REVIEW_GIT_TIMEOUT' }));
    expect(fake.kills[0]).toHaveBeenCalledOnce();
  });

  it('bounds and sanitizes stderr on nonzero exit', async () => {
    const privateStderr = Buffer.from(`C:\\private\\repository\\secret.txt\n${'x'.repeat(16 * 1024)}`);
    const fake = fakeSpawn({ stderr: privateStderr, exitCode: 2 });

    const failure = await runGitBuffered({
      cwd: 'C:\\private\\repository',
      args: ['status'],
      timeoutMs: 1000,
      maxStderrBytes: 1024 * 1024,
      spawnFactory: fake.spawnFactory,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitReviewError);
    expect(failure).toEqual(expect.objectContaining({ code: 'REVIEW_GIT_FAILED' }));
    expect((failure as Error).message).toBe('Git command failed.');
    expect((failure as Error).message).not.toContain('private');
    expect((failure as Error).message).not.toContain('secret.txt');
  });

  it('reassembles NUL records across arbitrary stdout chunk boundaries', async () => {
    const fake = fakeSpawn({
      stdoutChunks: [Buffer.from('first\0sec'), Buffer.from('ond\0third'), Buffer.from('\0')],
    });
    const records: string[] = [];

    await runGitNulRecords({
      cwd: 'C:\\project',
      args: ['status', '-z'],
      timeoutMs: 1000,
      spawnFactory: fake.spawnFactory,
    }, (record) => records.push(record.toString('utf8')));

    expect(records).toEqual(['first', 'second', 'third']);
  });

  it('runs one fixed cat-file batch with streamed stdin and stdout', async () => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const stdinChunks: Buffer[] = [];
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
      stdin.on('data', (chunk: Buffer) => stdinChunks.push(Buffer.from(chunk)));
      stdin.once('finish', () => {
        stdout.write(Buffer.from('response-a'));
        stdout.end(Buffer.from('-response-b'));
        stderr.end();
        queueMicrotask(() => child.emit('close', 0, null));
      });
      Object.assign(child, { stdin, stdout, stderr, kill: vi.fn(() => true) });
      return child;
    }) as unknown as GitSpawnFactory;
    const stdoutChunks: Buffer[] = [];

    await runGitCatFileBatch({
      cwd: 'C:\\project with spaces',
      timeoutMs: 1000,
      spawnFactory,
    }, [OID_A, OID_B], async (stdout) => {
      for await (const chunk of stdout) stdoutChunks.push(Buffer.from(chunk));
    });

    expect(calls).toEqual([{
      command: 'git',
      args: ['cat-file', '--batch'],
      options: {
        cwd: 'C:\\project with spaces',
        shell: false,
        windowsHide: true,
      },
    }]);
    expect(Buffer.concat(stdinChunks).toString('ascii')).toBe(`${OID_A}\n${OID_B}\n`);
    expect(Buffer.concat(stdoutChunks).toString()).toBe('response-a-response-b');
  });

  it('kills a cat-file batch on cancellation and waits for consumer cleanup', async () => {
    const fake = fakeSpawn({ waitForKill: true });
    const controller = new AbortController();
    let releaseConsumer: (() => void) | undefined;
    const consumerCleanup = new Promise<void>((resolve) => {
      releaseConsumer = resolve;
    });
    let settled = false;
    const operation = runGitCatFileBatch({
      cwd: 'C:\\private\\project',
      timeoutMs: 1000,
      signal: controller.signal,
      spawnFactory: fake.spawnFactory,
    }, [OID_A], async () => {
      await consumerCleanup;
    });
    void operation.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseConsumer?.();

    await expect(operation).rejects.toEqual(expect.objectContaining({
      code: 'REVIEW_CANCELLED',
      message: 'Git operation was cancelled.',
    }));
    expect(settled).toBe(true);
    expect(fake.kills[0]).toHaveBeenCalledOnce();
  });

  it('kills a cat-file batch on timeout', async () => {
    const fake = fakeSpawn({ waitForKill: true });

    await expect(runGitCatFileBatch({
      cwd: 'C:\\private\\project',
      timeoutMs: 5,
      spawnFactory: fake.spawnFactory,
    }, [OID_A], async (stdout) => {
      for await (const chunk of stdout) {
        void chunk;
        // The fake remains open until timeout.
      }
    })).rejects.toEqual(expect.objectContaining({ code: 'REVIEW_GIT_TIMEOUT' }));
    expect(fake.kills[0]).toHaveBeenCalledOnce();
  });
});

describe('canonical working tree capture', () => {
  it('distinguishes a non-repository and an unborn HEAD without leaking paths', async () => {
    const nonRepository = await temporaryDirectory('tracedeck-not-git-');
    const unbornRepository = await temporaryDirectory('tracedeck-unborn-');
    await initializeRepository(unbornRepository);

    await expect(resolveReviewHead(nonRepository)).rejects.toEqual(expect.objectContaining({
      code: 'NOT_A_GIT_REPO',
      message: 'The selected project is not a Git repository.',
    }));
    await expect(resolveReviewHead(unbornRepository)).rejects.toEqual(expect.objectContaining({
      code: 'HEAD_UNBORN',
      message: 'The Git repository does not have a commit yet.',
    }));
  });

  it('captures HEAD identity and deterministic staged, unstaged, untracked, delete and rename evidence', async () => {
    const rootPath = await temporaryDirectory('tracedeck-status-');
    await initializeRepository(rootPath);
    await Promise.all([
      writeFile(join(rootPath, 'staged.txt'), 'before staged\n'),
      writeFile(join(rootPath, 'unstaged.txt'), 'before unstaged\n'),
      writeFile(join(rootPath, 'deleted.txt'), 'delete me\n'),
      writeFile(join(rootPath, 'rename-old.ts'), 'export const renamed = true;\n'),
      writeFile(join(rootPath, 'replace.txt'), 'tracked version\n'),
      writeFile(join(rootPath, 'space name.md'), '# before\n'),
    ]);
    await commitAll(rootPath);

    await writeFile(join(rootPath, 'staged.txt'), 'after staged\n');
    await git(rootPath, ['add', '--', 'staged.txt']);
    await writeFile(join(rootPath, 'unstaged.txt'), 'after unstaged\n');
    await rm(join(rootPath, 'deleted.txt'));
    await git(rootPath, ['mv', '--', 'rename-old.ts', 'rename-new.ts']);
    await git(rootPath, ['rm', '--', 'replace.txt']);
    await writeFile(join(rootPath, 'replace.txt'), 'untracked replacement\n');
    await writeFile(join(rootPath, 'space name.md'), '# after\n');
    await writeFile(join(rootPath, '雪.js'), 'export const snow = true;\n');

    const first = await captureWorkingTree(rootPath);
    const second = await captureWorkingTree(rootPath);
    const expectedCommit = (await git(rootPath, ['rev-parse', '--verify', 'HEAD'])).toString().trim();
    const expectedTree = (await git(rootPath, ['rev-parse', '--verify', 'HEAD^{tree}'])).toString().trim();

    expect(first.head).toEqual({
      branchName: 'review-branch',
      fullCommit: expectedCommit,
      shortCommit: expectedCommit.slice(0, 12),
      treeId: expectedTree,
    });
    expect(first.changes).toEqual(second.changes);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.changes.map((change) => change.relativePath)).toEqual([
      'deleted.txt',
      'rename-new.ts',
      'replace.txt',
      'space name.md',
      'staged.txt',
      'unstaged.txt',
      '雪.js',
    ]);
    expect(first.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'staged.txt', staged: true, unstaged: false }),
      expect.objectContaining({ relativePath: 'unstaged.txt', staged: false, unstaged: true }),
      expect.objectContaining({ relativePath: 'deleted.txt', changeType: 'deleted' }),
      expect.objectContaining({
        relativePath: 'rename-new.ts',
        oldPath: 'rename-old.ts',
        changeType: 'renamed',
      }),
      expect.objectContaining({
        relativePath: 'replace.txt',
        changeType: 'modified',
        staged: true,
        untracked: true,
      }),
      expect.objectContaining({ relativePath: 'space name.md', language: 'markdown' }),
      expect.objectContaining({ relativePath: '雪.js', changeType: 'added', untracked: true }),
    ]));

    await writeFile(join(rootPath, 'unstaged.txt'), 'another unstaged value\n');
    const changed = await captureWorkingTree(rootPath);
    expect(changed.changes).toEqual(first.changes);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });
});

describe('bounded review diffs', () => {
  it('builds the fixed no-hook argument list with an option terminator', () => {
    expect(buildReviewDiffArgs(
      'a'.repeat(40),
      {
        itemType: 'file',
        stableKey: 'key',
        relativePath: '-dangerous name.ts',
        oldPath: 'old name.ts',
        copiedFrom: null,
        changeType: 'renamed',
        staged: true,
        unstaged: false,
        untracked: false,
        similarity: 100,
        language: 'typescript',
      },
    )).toEqual([
      '--no-pager',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      'a'.repeat(40),
      '--',
      'old name.ts',
      '-dangerous name.ts',
    ]);
  });

  it('reports exact omitted byte totals while retaining at most 2 MiB', async () => {
    const rootPath = await temporaryDirectory('tracedeck-diff-bytes-');
    await initializeRepository(rootPath);
    await writeFile(join(rootPath, 'wide.txt'), `${'a'.repeat(1_100_000)}\n`);
    await commitAll(rootPath);
    await writeFile(join(rootPath, 'wide.txt'), `${'b'.repeat(1_100_000)}\n`);
    const capture = await captureWorkingTree(rootPath);
    const change = capture.changes.find((candidate) => candidate.relativePath === 'wide.txt');
    expect(change).toBeDefined();

    const result = await readReviewDiff({
      rootPath,
      baseCommit: capture.head.fullCommit,
      change: change!,
    });
    const complete = await git(rootPath, buildReviewDiffArgs(capture.head.fullCommit, change!));

    expect(complete.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(result.returnedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(result.returnedBytes + result.omittedBytes).toBe(complete.length);
    expect(result.returnedLines + result.omittedLines).toBe(countLines(complete));
    expect(result.truncated).toBe(true);
    expect(result).toEqual(expect.objectContaining({ oldPath: 'wide.txt', newPath: 'wide.txt' }));
  }, 30_000);

  it('reports exact omitted line totals while retaining at most 20,000 lines', async () => {
    const rootPath = await temporaryDirectory('tracedeck-diff-lines-');
    await initializeRepository(rootPath);
    const oldLines = Array.from({ length: 10_500 }, (_, index) => `old ${index}`).join('\n');
    const newLines = Array.from({ length: 10_500 }, (_, index) => `new ${index}`).join('\n');
    await writeFile(join(rootPath, 'many-lines.txt'), `${oldLines}\n`);
    await commitAll(rootPath);
    await writeFile(join(rootPath, 'many-lines.txt'), `${newLines}\n`);
    const capture = await captureWorkingTree(rootPath);
    const change = capture.changes.find((candidate) => candidate.relativePath === 'many-lines.txt');
    expect(change).toBeDefined();

    const result = await readReviewDiff({
      rootPath,
      baseCommit: capture.head.fullCommit,
      change: change!,
    });
    const complete = await git(rootPath, buildReviewDiffArgs(capture.head.fullCommit, change!));

    expect(countLines(complete)).toBeGreaterThan(20_000);
    expect(result.returnedLines).toBeLessThanOrEqual(20_000);
    expect(result.returnedBytes + result.omittedBytes).toBe(complete.length);
    expect(result.returnedLines + result.omittedLines).toBe(countLines(complete));
    expect(result.truncated).toBe(true);
  }, 30_000);
});
