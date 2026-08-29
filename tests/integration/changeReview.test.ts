import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareReviewSnapshots } from '@main/analysis/algorithms/reviewComparator';
import { runScan } from '@main/analysis/scanner';
import { DataStore, createDataStore } from '@main/db';
import { openDatabase } from '@main/db/connection';
import {
  ChangeReviewCoordinator,
  type ChangeReviewCoordinatorDependencies,
} from '@main/services/changeReview/coordinator';
import { captureWorkingTree } from '@main/services/changeReview/gitStatus';
import {
  createReviewTempRoot,
  materializeHeadTree,
  removeVerifiedReviewTemp,
} from '@main/services/changeReview/materializer';
import { extractReviewSnapshot } from '@main/services/changeReview/snapshot';
import { ProjectOperationRegistry } from '@main/services/projectOperations';
import type { Project } from '@shared/types';

const execFileAsync = promisify(execFile);
const TRACEDECK_VERSION = '9.0.0-test';
const roots = new Set<string>();
const stores = new Set<DataStore>();

interface ReviewFixture {
  root: string;
  store: DataStore;
  operations: ProjectOperationRegistry;
  project: Project;
  dependencies: ChangeReviewCoordinatorDependencies;
  coordinator: ChangeReviewCoordinator;
  mutate(): Promise<void>;
}

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  return stdout;
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const destination = join(root, ...relativePath.split('/'));
    await fs.mkdir(join(destination, '..'), { recursive: true });
    await fs.writeFile(destination, contents, 'utf8');
  }
}

function defaultDependencies(): ChangeReviewCoordinatorDependencies {
  return {
    traceDeckVersion: TRACEDECK_VERSION,
    runScan,
    captureWorkingTree,
    createReviewTempRoot,
    materializeHeadTree,
    removeVerifiedReviewTemp,
    extractReviewSnapshot,
    compareReviewSnapshots,
    createDataStore,
  };
}

async function createReviewRepository(): Promise<ReviewFixture> {
  const root = await fs.mkdtemp(join(tmpdir(), 'tracedeck-review-integration-'));
  roots.add(root);
  await git(root, 'init');
  await git(root, 'config', 'user.name', 'TraceDeck Test');
  await git(root, 'config', 'user.email', 'tracedeck@example.invalid');
  await writeFiles(root, {
    '.gitignore': '.tracedeck/\n',
    'package.json': JSON.stringify({
      name: 'review-fixture',
      version: '1.0.0',
      exports: './src/index.ts',
    }, null, 2),
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true },
      include: ['src/**/*.ts'],
    }, null, 2),
    'src/index.ts': "export { oldApi } from './api';\n",
    'src/api.ts': "import { helper } from './helper';\nexport const oldApi = helper + 1;\n",
    'src/helper.ts': 'export const helper = 1;\n',
    'src/core.ts': "import { oldApi } from './api';\nexport const core = oldApi + 1;\n",
    'src/consumer.ts': "import { oldApi } from './api';\nexport const consumed = oldApi;\n",
    'src/api.test.ts': "import { consumed } from './consumer';\nvoid consumed;\n",
    'src/remove.ts': 'export const removed = true;\n',
    'src/rename.ts': 'export const renamed = true;\n',
  });
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'baseline');

  const store = new DataStore(openDatabase({ filePath: ':memory:' }));
  stores.add(store);
  let project = store.projects.createOrTouch('review-fixture', root);
  project = store.projects.updateConfiguration(project.id, {
    ...project.configuration,
    entryPoints: ['src/index.ts'],
    includeTestFiles: true,
    typeCheck: true,
  }) as Project;
  store.rules.upsert({
    projectId: project.id,
    name: 'API must not import core',
    enabled: true,
    ruleType: 'forbid-import',
    sourcePattern: 'src/api.ts',
    targetPattern: 'src/core.ts',
    configuration: { severity: 'high', exceptions: [] },
  });

  const operations = new ProjectOperationRegistry();
  const dependencies = defaultDependencies();
  const coordinator = new ChangeReviewCoordinator(store, operations, dependencies);
  return {
    root,
    store,
    operations,
    project,
    dependencies,
    coordinator,
    mutate: async () => {
      await fs.writeFile(
        join(root, 'src', 'api.ts'),
        "import { core } from './core';\nexport const newApi = core + 1;\n",
        'utf8',
      );
      await git(root, 'add', 'src/api.ts');
      await fs.appendFile(join(root, 'src', 'api.ts'), '// unstaged evidence\n', 'utf8');
      await fs.writeFile(join(root, 'src', 'index.ts'), "export { newApi } from './api';\n", 'utf8');
      await git(root, 'rm', 'src/remove.ts');
      await git(root, 'mv', 'src/rename.ts', 'src/renamed.ts');
      await fs.writeFile(
        join(root, 'src', 'added.ts'),
        "import { newApi } from './api';\nexport const added = newApi;\n",
        'utf8',
      );
    },
  };
}

afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all([...roots].map((root) => fs.rm(root, { recursive: true, force: true })));
  roots.clear();
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function withDependencies(
  fixture: ReviewFixture,
  overrides: Partial<ChangeReviewCoordinatorDependencies>,
): ChangeReviewCoordinator {
  return new ChangeReviewCoordinator(fixture.store, fixture.operations, {
    ...fixture.dependencies,
    ...overrides,
  });
}

async function latestReviewId(fixture: ReviewFixture): Promise<number> {
  const review = await fixture.coordinator.runNow(fixture.project.id, 5);
  return review.id;
}

describe('ChangeReviewCoordinator', { timeout: 15_000 }, () => {
  it('compares an already-dirty working tree with HEAD without changing Git state', async () => {
    const fixture = await createReviewRepository();
    await fixture.mutate();
    const statusBefore = await git(fixture.root, 'status', '--porcelain=v2', '-z', '--untracked-files=all');
    const indexBefore = await fs.readFile(join(fixture.root, '.git', 'index'));

    const review = await fixture.coordinator.runNow(fixture.project.id, 5);

    expect(review.result).not.toBeNull();
    expect(review.result?.fileChanges.map((item) => item.changeType)).toEqual(
      expect.arrayContaining(['added', 'modified', 'deleted', 'renamed']),
    );
    expect(review.result?.fileChanges.some((item) => item.staged)).toBe(true);
    expect(review.result?.fileChanges.some((item) => item.unstaged)).toBe(true);
    expect(review.result?.fileChanges.some((item) => item.untracked)).toBe(true);
    expect(review.result?.edgeChanges.length).toBeGreaterThan(0);
    expect(review.result?.findingChanges.length).toBeGreaterThan(0);
    expect(review.result?.architectureChanges.length).toBeGreaterThan(0);
    expect(review.result?.cycleChanges.length).toBeGreaterThan(0);
    expect(review.result?.exportChanges.length).toBeGreaterThan(0);
    expect(review.result?.affectedFiles.map((item) => item.destinationPath)).toContain('src/consumer.ts');
    expect(review.result?.candidateTests.map((item) => item.destinationPath)).toContain('src/api.test.ts');
    expect(review.result?.limitations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TYPE_ERROR_BASELINE_NOT_COMPARABLE', paths: [] }),
    ]));
    expect(review.result?.limitations.every((item) => !item.message.includes(fixture.root))).toBe(true);
    expect(fixture.store.changeReviews.latestForProject(fixture.project.id)).toEqual(review);
    expect(await git(fixture.root, 'status', '--porcelain=v2', '-z', '--untracked-files=all')).toBe(statusBefore);
    expect(await fs.readFile(join(fixture.root, '.git', 'index'))).toEqual(indexBefore);
  });

  it.each([
    ['not-git', false, 'NOT_A_GIT_REPO'],
    ['unborn-head', true, 'HEAD_UNBORN'],
  ] as const)('reports %s as a successful disabled state with a typed start failure', async (
    expectedState,
    initialiseGit,
    expectedCode,
  ) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'tracedeck-review-state-'));
    roots.add(root);
    if (initialiseGit) await git(root, 'init');
    const store = new DataStore(openDatabase({ filePath: ':memory:' }));
    stores.add(store);
    const project = store.projects.createOrTouch('state-fixture', root);
    const coordinator = new ChangeReviewCoordinator(
      store,
      new ProjectOperationRegistry(),
      defaultDependencies(),
    );

    await expect(coordinator.status(project.id)).resolves.toMatchObject({
      repositoryState: expectedState,
      baseCommit: null,
      baseTreeId: null,
      branchName: null,
      gitChanges: [],
    });
    expect(() => coordinator.start(project.id, 5)).toThrow(expect.objectContaining({
      code: expectedCode,
    }));
  });

  it('rejects scan/review conflicts and returns background work immediately with pollable progress', async () => {
    const fixture = await createReviewRepository();
    await fixture.mutate();
    const scanLease = fixture.operations.acquire(fixture.project.id, 'scan');
    expect(() => fixture.coordinator.start(fixture.project.id, 5)).toThrow(expect.objectContaining({
      code: 'SCAN_IN_PROGRESS',
    }));
    scanLease?.release();

    const entered = deferred();
    const proceed = deferred();
    let firstCapture = true;
    const coordinator = withDependencies(fixture, {
      captureWorkingTree: async (root, signal) => {
        if (firstCapture) {
          firstCapture = false;
          entered.resolve();
          await proceed.promise;
        }
        return captureWorkingTree(root, signal);
      },
    });

    const started = coordinator.start(fixture.project.id, 5);
    expect(started.operationId).toMatch(/^[0-9a-f-]{36}$/i);
    await entered.promise;
    expect(fixture.operations.active(fixture.project.id)).toMatchObject({
      kind: 'review',
      operationId: started.operationId,
    });
    await expect(coordinator.status(fixture.project.id)).resolves.toMatchObject({
      activeOperation: {
        operationId: started.operationId,
        phase: 'capturing',
        cancellationRequested: false,
      },
    });
    expect(() => coordinator.start(fixture.project.id, 5)).toThrow(expect.objectContaining({
      code: 'REVIEW_IN_PROGRESS',
    }));

    proceed.resolve();
    await waitUntil(
      () => fixture.operations.active(fixture.project.id) === null,
      'background review did not finish',
    );
    await expect(coordinator.status(fixture.project.id)).resolves.toMatchObject({
      activeOperation: null,
      lastOutcome: { operationId: started.operationId, status: 'completed', code: null },
    });
  });

  it.each(['materialization', 'baseline', 'comparison'] as const)(
    'cancels exactly during %s, cleans up, and leaves the target scan completed',
    async (phase) => {
      const fixture = await createReviewRepository();
      await fixture.mutate();
      const entered = deferred();
      const proceed = deferred();
      const overrides: Partial<ChangeReviewCoordinatorDependencies> = {};

      if (phase === 'materialization') {
        overrides.materializeHeadTree = async (input, dependencies) => {
          entered.resolve();
          await proceed.promise;
          return materializeHeadTree(input, dependencies);
        };
      } else if (phase === 'baseline') {
        overrides.runScan = async (store, options) => {
          if (options.project.rootPath !== fixture.root) {
            entered.resolve();
            await proceed.promise;
          }
          return runScan(store, options);
        };
      } else {
        overrides.compareReviewSnapshots = (baseline, target, changes, options) => {
          entered.resolve();
          const active = fixture.operations.active(fixture.project.id);
          if (active) fixture.operations.cancel(fixture.project.id, active.operationId);
          return compareReviewSnapshots(baseline, target, changes, options);
        };
      }
      const coordinator = withDependencies(fixture, overrides);

      const started = coordinator.start(fixture.project.id, 5);
      await entered.promise;
      if (phase !== 'comparison') {
        expect(coordinator.cancel(fixture.project.id, 'not-the-operation')).toBe(false);
        expect(coordinator.cancel(fixture.project.id, started.operationId)).toBe(true);
        proceed.resolve();
      }
      await waitUntil(
        () => fixture.operations.active(fixture.project.id) === null,
        `review did not cancel during ${phase}`,
      );

      const status = await coordinator.status(fixture.project.id);
      expect(status.lastOutcome).toMatchObject({
        operationId: started.operationId,
        status: 'cancelled',
        code: 'REVIEW_CANCELLED',
      });
      expect(fixture.store.changeReviews.latestForProject(fixture.project.id)).toBeNull();
      expect(fixture.store.scans.latestCompletedForProject(fixture.project.id)?.status).toBe('completed');
    },
  );

  it.each(['head', 'bytes', 'rules', 'configuration', 'watcher'] as const)(
    'discards a candidate made stale by changed %s and preserves the previous review',
    async (change) => {
      const fixture = await createReviewRepository();
      await fixture.mutate();
      const previousId = await latestReviewId(fixture);
      const deferredScan = vi.fn();
      let captureCount = 0;
      let changed = false;
      const coordinator = withDependencies(fixture, {
        captureWorkingTree: async (root, signal) => {
          captureCount += 1;
          if (captureCount === 2 && change === 'head') {
            await git(root, 'add', '.');
            await git(root, 'commit', '-m', 'move head during review');
          }
          if (captureCount === 2 && change === 'bytes') {
            await fs.appendFile(join(root, 'src', 'api.ts'), '// changed during review\n', 'utf8');
          }
          return captureWorkingTree(root, signal);
        },
        materializeHeadTree: async (input, dependencies) => {
          if (!changed && change === 'rules') {
            changed = true;
            const rule = fixture.store.rules.listEnabled(fixture.project.id)[0];
            if (rule) fixture.store.rules.upsert({ ...rule, sourcePattern: 'src/**' });
          }
          if (!changed && change === 'configuration') {
            changed = true;
            const current = fixture.store.projects.findById(fixture.project.id) as Project;
            fixture.store.projects.updateConfiguration(current.id, {
              ...current.configuration,
              excludePatterns: ['generated/**'],
            });
          }
          if (!changed && change === 'watcher') {
            changed = true;
            expect(fixture.operations.deferWatcherScan(fixture.project.id, deferredScan)).toBe(true);
          }
          return materializeHeadTree(input, dependencies);
        },
      });

      await expect(coordinator.runNow(fixture.project.id, 5)).rejects.toMatchObject({
        code: 'REVIEW_STALE',
      });
      expect(fixture.store.changeReviews.latestForProject(fixture.project.id)?.id).toBe(previousId);
      expect(fixture.store.scans.latestCompletedForProject(fixture.project.id)?.status).toBe('completed');
      await Promise.resolve();
      expect(deferredScan).toHaveBeenCalledTimes(change === 'watcher' ? 1 : 0);
      const status = await coordinator.status(fixture.project.id);
      expect(status.lastOutcome).toMatchObject({ status: 'stale', code: 'REVIEW_STALE' });
    },
  );

  it('preserves the prior review on a candidate failure and always removes the verified temp root', async () => {
    const fixture = await createReviewRepository();
    await fixture.mutate();
    const previousId = await latestReviewId(fixture);
    let createdRoot = '';
    const remove = vi.fn(async (root: string) => removeVerifiedReviewTemp(root));
    const coordinator = withDependencies(fixture, {
      createReviewTempRoot: async (version) => {
        const temp = await createReviewTempRoot(version);
        createdRoot = temp.rootPath;
        return temp;
      },
      materializeHeadTree: async () => {
        throw new Error(`sensitive failure at ${fixture.root}`);
      },
      removeVerifiedReviewTemp: remove,
    });

    await expect(coordinator.runNow(fixture.project.id, 5)).rejects.toMatchObject({
      code: 'REVIEW_FAILED',
    });
    expect(fixture.store.changeReviews.latestForProject(fixture.project.id)?.id).toBe(previousId);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(createdRoot).not.toBe('');
    await expect(fs.stat(createdRoot)).rejects.toThrow();
    expect((await coordinator.status(fixture.project.id)).lastOutcome).toEqual(expect.objectContaining({
      status: 'failed',
      code: 'REVIEW_FAILED',
    }));
    expect(JSON.stringify((await coordinator.status(fixture.project.id)).lastOutcome)).not.toContain(
      fixture.root,
    );
  });

  it('forces baseline type checking off and preserves persistent architecture-rule IDs', async () => {
    const fixture = await createReviewRepository();
    await fixture.mutate();
    const expectedRuleIds = fixture.store.rules.listEnabled(fixture.project.id).map((rule) => rule.id);
    let inspectedBaseline = false;
    const coordinator = withDependencies(fixture, {
      runScan: async (store, options) => {
        if (options.project.rootPath !== fixture.root) {
          inspectedBaseline = true;
          expect(options.fullRescan).toBe(true);
          expect(options.project.configuration.typeCheck).toBe(false);
          expect(store.projects.findById(options.project.id)?.configuration.typeCheck).toBe(false);
          expect(store.rules.listEnabled(options.project.id).map((rule) => rule.id)).toEqual(
            expectedRuleIds,
          );
        } else {
          expect(options.fullRescan).toBe(false);
        }
        return runScan(store, options);
      },
    });

    const review = await coordinator.runNow(fixture.project.id, 99);

    expect(inspectedBaseline).toBe(true);
    expect(review.traversalDepth).toBe(25);
    expect(review.result?.limitations.filter(
      (item) => item.code === 'TYPE_ERROR_BASELINE_NOT_COMPARABLE',
    )).toHaveLength(1);
  });

  it('produces order-stable summaries for full and incremental target scans and clamps low depth', async () => {
    const fixture = await createReviewRepository();
    await fixture.mutate();
    const incremental = await fixture.coordinator.runNow(fixture.project.id, 0);
    const fullCoordinator = withDependencies(fixture, {
      runScan: (store, options) => runScan(store, {
        ...options,
        fullRescan: options.project.rootPath === fixture.root ? true : options.fullRescan,
      }),
    });
    const full = await fullCoordinator.runNow(fixture.project.id, 1);

    expect(incremental.traversalDepth).toBe(1);
    expect(incremental.summary && {
      ...incremental.summary,
      reviewId: 0,
      completedAt: '',
    }).toEqual(full.summary && {
      ...full.summary,
      reviewId: 0,
      completedAt: '',
    });
  });

  it('reports current, stale, and incompatible freshness from read-only status checks', async () => {
    const fixture = await createReviewRepository();
    await fixture.mutate();
    await fixture.coordinator.runNow(fixture.project.id, 5);

    await expect(fixture.coordinator.status(fixture.project.id)).resolves.toMatchObject({
      latestReview: { freshness: 'current', staleReasons: [] },
    });
    await fs.appendFile(join(fixture.root, 'src', 'api.ts'), '// stale status\n', 'utf8');
    await expect(fixture.coordinator.status(fixture.project.id)).resolves.toMatchObject({
      latestReview: {
        freshness: 'stale',
        staleReasons: expect.arrayContaining(['WORKING_TREE_CHANGED']),
      },
    });
    fixture.store.db.prepare('UPDATE change_reviews SET result_schema_version = 999').run();
    await expect(fixture.coordinator.status(fixture.project.id)).resolves.toMatchObject({
      latestReview: { freshness: 'incompatible' },
    });
  });
});
