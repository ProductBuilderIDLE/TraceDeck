import { describe, expect, it, vi } from 'vitest';
import type { DataStore, ChangeReviewRecord } from '@main/db';
import {
  ChangeReviewCoordinator,
  ChangeReviewCoordinatorError,
  type ChangeReviewCoordinatorDependencies,
} from '@main/services/changeReview/coordinator';
import type { HandlerMap } from '@main/ipc/registry';
import { HandledError } from '@main/ipc/registry';
import { reviewHandlers } from '@main/ipc/reviewHandlers';
import type { ReviewFileDiff, ReviewFilters, ReviewSection, ReviewStatus } from '@shared/changeReview';
import { IPC_CHANNELS } from '@shared/ipc';

const OPERATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const BASE_COMMIT = 'a'.repeat(40);

function filters(): ReviewFilters {
  return {
    changeTypes: [], gitStates: [], findingTypes: [], severities: [], deltaDirections: [],
    directness: [], languages: [], folderPrefix: null, minDepth: null, maxDepth: null,
  };
}

function record(): ChangeReviewRecord {
  const sections: ReviewSection[] = [
    'files', 'edges', 'findings', 'architecture-violations', 'cycles', 'reachable-exports',
    'affected-files', 'candidate-tests', 'no-known-tests', 'limitations',
  ];
  const counts = Object.fromEntries(sections.map((section) => [section, {
    totalCount: section === 'files' ? 3 : 0,
    retainedCount: section === 'files' ? 3 : 0,
    truncated: false,
    truncatedAtDepth: false,
  }])) as NonNullable<ChangeReviewRecord['result']>['counts'];
  return {
    id: 7,
    projectId: 2,
    baseCommit: BASE_COMMIT,
    baseTreeId: 'b'.repeat(40),
    workingTreeFingerprint: 'working',
    userConfigurationFingerprint: 'configuration',
    effectiveBaselineFingerprint: 'baseline',
    workingTreeScanId: 1,
    traceDeckVersion: 'test',
    resultSchemaVersion: 1,
    traversalDepth: 5,
    completedAt: '2026-08-29T00:00:00.000Z',
    compatible: true,
    summary: null,
    result: {
      schemaVersion: 1,
      baseCommit: BASE_COMMIT,
      baseTreeId: 'b'.repeat(40),
      workingTreeFingerprint: 'working',
      userConfigurationFingerprint: 'configuration',
      effectiveBaselineFingerprint: 'baseline',
      workingTreeScanId: 1,
      traversalDepth: 5,
      fileChanges: [
        {
          itemType: 'file', stableKey: 'deleted', relativePath: 'gone.ts', oldPath: null,
          copiedFrom: null, changeType: 'deleted', staged: true, unstaged: false,
          untracked: false, similarity: null, language: 'typescript',
        },
        {
          itemType: 'file', stableKey: 'renamed', relativePath: 'new.ts', oldPath: 'old.ts',
          copiedFrom: null, changeType: 'renamed', staged: true, unstaged: false,
          untracked: false, similarity: 100, language: 'typescript',
        },
        {
          itemType: 'file', stableKey: 'copied', relativePath: 'copy.ts', oldPath: null,
          copiedFrom: 'source.ts', changeType: 'added', staged: true, unstaged: false,
          untracked: false, similarity: 90, language: 'typescript',
        },
      ],
      edgeChanges: [], findingChanges: [], architectureChanges: [], cycleChanges: [],
      exportChanges: [], affectedFiles: [], candidateTests: [], noKnownTests: [], limitations: [],
      graphEvidence: { nodePaths: [], edges: [] }, counts,
    },
  };
}

function currentStatus(overrides: Partial<ReviewStatus> = {}): ReviewStatus {
  return {
    projectId: 2,
    repositoryState: 'ready',
    baseCommit: BASE_COMMIT,
    baseTreeId: 'b'.repeat(40),
    branchName: 'main',
    gitChanges: [],
    latestReview: { reviewId: 7, freshness: 'current', staleReasons: [] },
    activeOperation: null,
    lastOutcome: null,
    ...overrides,
  };
}

function handler<C extends keyof HandlerMap>(handlers: HandlerMap, channel: C) {
  const selected = handlers[channel];
  if (!selected) throw new Error(`Missing handler ${String(channel)}`);
  return selected;
}

describe('reviewHandlers', () => {
  it('keeps the closed contract and review handler allowlists at exactly the same six channels', () => {
    const coordinator = {
      status: vi.fn(), start: vi.fn(), cancel: vi.fn(), summary: vi.fn(), fileDiff: vi.fn(),
    };
    const handlers = reviewHandlers(
      { changeReviews: { findById: vi.fn() } } as unknown as DataStore,
      coordinator as unknown as ChangeReviewCoordinator,
    );
    const expected = [
      'review:status',
      'review:start',
      'review:cancel',
      'review:summary',
      'review:query',
      'review:file-diff',
    ];

    expect(Object.keys(handlers)).toEqual(expected);
    expect(IPC_CHANNELS.filter((channel) => channel.startsWith('review:'))).toEqual(expected);
    expect(IPC_CHANNELS).not.toContain('review:export');
  });

  it('validates malformed requests before coordinator or database access', async () => {
    const findById = vi.fn();
    const coordinator = {
      status: vi.fn(), start: vi.fn(), cancel: vi.fn(), summary: vi.fn(), fileDiff: vi.fn(),
    };
    const handlers = reviewHandlers(
      { changeReviews: { findById } } as unknown as DataStore,
      coordinator as unknown as ChangeReviewCoordinator,
    );

    await expect(handler(handlers, 'review:status')({ projectId: 0 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(handler(handlers, 'review:query')({
      projectId: 2, reviewId: 7, section: 'files', filters: filters(), ref: 'HEAD~1',
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(coordinator.status).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
  });

  it('forwards status, start, cancel, summary, and query through typed requests', async () => {
    const stored = record();
    const status = currentStatus();
    const summary = { reviewId: 7 };
    const coordinator = {
      status: vi.fn(async () => status),
      start: vi.fn(() => ({ operationId: OPERATION_ID })),
      cancel: vi.fn(() => true),
      summary: vi.fn(async () => summary),
      fileDiff: vi.fn(),
    };
    const handlers = reviewHandlers(
      { changeReviews: { findById: vi.fn(() => stored) } } as unknown as DataStore,
      coordinator as unknown as ChangeReviewCoordinator,
    );

    await expect(handler(handlers, 'review:status')({ projectId: 2 })).resolves.toBe(status);
    await expect(handler(handlers, 'review:start')({ projectId: 2, traversalDepth: 99 }))
      .resolves.toEqual({ operationId: OPERATION_ID });
    await expect(handler(handlers, 'review:cancel')({ projectId: 2, operationId: OPERATION_ID }))
      .resolves.toEqual({ requested: true });
    await expect(handler(handlers, 'review:summary')({ projectId: 2 })).resolves.toBe(summary);
    await expect(handler(handlers, 'review:query')({
      projectId: 2, reviewId: 7, section: 'files', filters: filters(), pageLimit: 1,
    })).resolves.toMatchObject({ reviewId: 7, returnedCount: 1, totalCount: 3 });
    expect(coordinator.start).toHaveBeenCalledWith(2, 25);
  });

  it('maps coordinator failures to fixed sanitized HandledError messages and codes', async () => {
    const coordinator = {
      status: vi.fn(),
      start: vi.fn(() => {
        throw new ChangeReviewCoordinatorError('REVIEW_IN_PROGRESS', 'private C:\\secret\\repo');
      }),
      cancel: vi.fn(), summary: vi.fn(), fileDiff: vi.fn(),
    };
    const handlers = reviewHandlers(
      { changeReviews: { findById: vi.fn() } } as unknown as DataStore,
      coordinator as unknown as ChangeReviewCoordinator,
    );

    const error = await handler(handlers, 'review:start')({ projectId: 2, traversalDepth: 5 })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HandledError);
    expect(error).toMatchObject({ code: 'REVIEW_IN_PROGRESS' });
    expect((error as Error).message).toBe('A change review is already running for this project.');
    expect((error as Error).message).not.toContain('secret');
  });

  it('requires a compatible review owned by the requested project before query or diff', async () => {
    const stored = record();
    const findById = vi.fn(() => stored);
    const coordinator = {
      status: vi.fn(), start: vi.fn(), cancel: vi.fn(), summary: vi.fn(), fileDiff: vi.fn(),
    };
    const handlers = reviewHandlers(
      { changeReviews: { findById } } as unknown as DataStore,
      coordinator as unknown as ChangeReviewCoordinator,
    );

    await expect(handler(handlers, 'review:query')({
      projectId: 99, reviewId: 7, section: 'files', filters: filters(),
    })).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });
    stored.compatible = false;
    stored.result = null;
    await expect(handler(handlers, 'review:file-diff')({
      projectId: 2, reviewId: 7, relativePath: 'gone.ts',
    })).rejects.toMatchObject({ code: 'REVIEW_INCOMPATIBLE' });
    expect(coordinator.fileDiff).not.toHaveBeenCalled();
  });
});

describe('ChangeReviewCoordinator.fileDiff', () => {
  function coordinatorFixture() {
    const diff: ReviewFileDiff = {
      oldPath: 'old.ts', newPath: 'new.ts', diffText: 'diff', truncated: false,
      returnedBytes: 4, returnedLines: 1, omittedBytes: 0, omittedLines: 0,
    };
    const readReviewDiff = vi.fn(async () => diff);
    const store = {
      projects: { findById: vi.fn(() => ({ id: 2, rootPath: 'C:\\project' })) },
    } as unknown as DataStore;
    const dependencies = { readReviewDiff } as unknown as ChangeReviewCoordinatorDependencies;
    const coordinator = new ChangeReviewCoordinator(store, {} as never, dependencies);
    vi.spyOn(coordinator, 'status').mockResolvedValue(currentStatus());
    return { coordinator, readReviewDiff, diff };
  }

  it.each([
    ['gone.ts', 'deleted'],
    ['old.ts', 'renamed'],
    ['source.ts', 'copied'],
  ])('serves a current captured %s path using its whole stored change', async (relativePath, stableKey) => {
    const fixture = coordinatorFixture();
    await expect(fixture.coordinator.fileDiff(record(), relativePath)).resolves.toBe(fixture.diff);
    expect(fixture.readReviewDiff).toHaveBeenCalledWith(expect.objectContaining({
      rootPath: 'C:\\project',
      baseCommit: BASE_COMMIT,
      change: expect.objectContaining({ stableKey }),
    }));
  });

  it.each<[string, Partial<ReviewStatus>]>([
    ['stale freshness', { latestReview: { reviewId: 7, freshness: 'stale', staleReasons: ['WORKING_TREE_CHANGED'] } }],
    ['wrong review', { latestReview: { reviewId: 8, freshness: 'current', staleReasons: [] } }],
    ['missing commit', { baseCommit: null }],
    ['changed commit', { baseCommit: 'c'.repeat(40) }],
  ])('rejects %s as stale without invoking the diff Git command', async (_name, status) => {
    const fixture = coordinatorFixture();
    vi.mocked(fixture.coordinator.status).mockResolvedValue(currentStatus(status));

    await expect(fixture.coordinator.fileDiff(record(), 'gone.ts')).rejects.toMatchObject({
      code: 'REVIEW_STALE',
    });
    expect(fixture.readReviewDiff).not.toHaveBeenCalled();
  });

  it('rejects an uncaptured path without invoking the diff Git command', async () => {
    const fixture = coordinatorFixture();

    await expect(fixture.coordinator.fileDiff(record(), 'not-captured.ts')).rejects.toMatchObject({
      code: 'REVIEW_NOT_FOUND',
    });
    expect(fixture.readReviewDiff).not.toHaveBeenCalled();
  });

  it('normalizes diff Git failures to sanitized coordinator codes', async () => {
    const fixture = coordinatorFixture();
    fixture.readReviewDiff.mockRejectedValueOnce({
      code: 'REVIEW_GIT_TIMEOUT',
      message: 'private C:\\secret\\repo',
    });

    await expect(fixture.coordinator.fileDiff(record(), 'gone.ts')).rejects.toMatchObject({
      code: 'REVIEW_GIT_TIMEOUT',
      message: 'Git did not finish in time while preparing the change review.',
    });
  });
});
