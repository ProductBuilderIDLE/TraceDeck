import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReviewStatus } from '@shared/changeReview';
// @ts-expect-error The Node test project has no JSX transform.
import { ChangeReview } from '../../../src/renderer/src/components/views/ChangeReview';

const BASE_COMMIT = 'a'.repeat(40);

const appState: { currentProject: { id: number; name: string; rootPath: string } | null; stats: null } = {
  currentProject: { id: 7, name: 'Example', rootPath: 'C:/project' },
  stats: null,
};

const filters = {
  changeTypes: [],
  gitStates: [],
  findingTypes: [],
  severities: [],
  deltaDirections: [],
  directness: [],
  languages: [],
  folderPrefix: null,
  minDepth: null,
  maxDepth: null,
};

function reviewStatus(overrides: Partial<ReviewStatus> = {}): ReviewStatus {
  return {
    projectId: 7,
    repositoryState: 'ready',
    baseCommit: BASE_COMMIT,
    baseTreeId: 'b'.repeat(40),
    branchName: 'main',
    gitChanges: [],
    latestReview: null,
    activeOperation: null,
    lastOutcome: null,
    ...overrides,
  };
}

function buildState(state: Record<string, unknown>): Record<string, unknown> {
  return {
    status: (state.status as ReviewStatus | null) ?? null,
    summary: (state.summary as Record<string, unknown> | null) ?? null,
    operation: (state.operation as Record<string, unknown> | null) ?? null,
    selectedTab: (state.selectedTab as string) ?? 'overview',
    filters,
    selectedDepth: (state.selectedDepth as number) ?? 5,
    requestGeneration: 0,
    queryRequestGeneration: 0,
    loading: (state.loading as boolean) ?? false,
    error: (state.error as string | null) ?? null,
    cancellationRequested: (state.cancellationRequested as boolean) ?? false,
    loadStatus: vi.fn(),
    loadSummary: vi.fn(),
    loadPage: vi.fn(),
    startReview: vi.fn(),
    cancelReview: vi.fn(),
    selectTab: vi.fn(),
    setFilters: vi.fn(),
    setDepth: vi.fn(),
    resetForProject: vi.fn(),
    markRequestGeneration: vi.fn(() => 0),
    markQueryRequestGeneration: vi.fn(() => 0),
  };
}

let reviewState = buildState({});

vi.mock('../../../src/renderer/src/lib/ipc', () => ({
  invoke: vi.fn(),
  subscribeToScanProgress: vi.fn(() => () => undefined),
}));

vi.mock('../../../src/renderer/src/store/appStore', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}));

vi.mock('../../../src/renderer/src/store/reviewStore', () => ({
  useReviewStore: () => reviewState,
}));

vi.mock('../../../src/renderer/src/store/uiStore', () => ({
  useUiStore: () => ({
    showReviewGraph: vi.fn(),
    showReviewEvidence: vi.fn(),
    focusFinding: vi.fn(),
    clearReviewContext: vi.fn(),
  }),
}));

describe('ChangeReview shell', () => {
  it('announces the workspace with aria-live and explains no project', () => {
    appState.currentProject = null;
    reviewState = buildState({});
    const html = renderToStaticMarkup(createElement(ChangeReview));
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Open a project');
    appState.currentProject = { id: 7, name: 'Example', rootPath: 'C:/project' };
  });

  it('explains a non-Git project without a Run Review button', () => {
    reviewState = buildState({ status: reviewStatus({ repositoryState: 'not-git' }) });
    const html = renderToStaticMarkup(createElement(ChangeReview));
    expect(html).toContain('not a Git repository');
    expect(html).not.toContain('Run review');
  });

  it('explains an unborn HEAD', () => {
    reviewState = buildState({ status: reviewStatus({ repositoryState: 'unborn-head' }) });
    const html = renderToStaticMarkup(createElement(ChangeReview));
    expect(html).toContain('commit');
  });

  it('shows a ready state with a Run Review control', () => {
    reviewState = buildState({ status: reviewStatus() });
    const html = renderToStaticMarkup(createElement(ChangeReview));
    expect(html).toContain('Run review');
  });

  it('shows a running operation and a Cancel button', () => {
    reviewState = buildState({
      status: reviewStatus({ activeOperation: {
        operationId: 'op-1',
        phase: 'comparing',
        processed: 3,
        total: 10,
        message: 'Comparing…',
        cancellationRequested: false,
      } }),
    });
    const html = renderToStaticMarkup(createElement(ChangeReview));
    expect(html).toContain('Comparing');
    expect(html).toContain('Cancel');
  });

  it('shows cancellation as requested', () => {
    reviewState = buildState({
      status: reviewStatus({ activeOperation: {
        operationId: 'op-1',
        phase: 'comparing',
        processed: 3,
        total: 10,
        message: 'Comparing…',
        cancellationRequested: true,
      } }),
      cancellationRequested: true,
    });
    const html = renderToStaticMarkup(createElement(ChangeReview));
    expect(html).toMatch(/Cancelling/i);
  });

  it('shows stale state with a warning', () => {
    reviewState = buildState({
      status: reviewStatus({
        latestReview: {
          reviewId: 7,
          freshness: 'stale',
          staleReasons: ['WORKING_TREE_CHANGED'],
        },
      }),
    });
    const html = renderToStaticMarkup(createElement(ChangeReview));
    expect(html).toContain('stale');
    expect(html).toContain('WORKING_TREE_CHANGED');
  });

  it('shows workspace tabs for a current review', () => {
    reviewState = buildState({
      status: reviewStatus({
        latestReview: { reviewId: 7, freshness: 'current', staleReasons: [] },
      }),
      summary: {
        reviewId: 7,
        projectId: 7,
        baseCommit: BASE_COMMIT,
        baseTreeId: 'b'.repeat(40),
        workingTreeFingerprint: 'working',
        userConfigurationFingerprint: 'config',
        effectiveBaselineFingerprint: 'baseline',
        traceDeckVersion: 'test',
        resultSchemaVersion: 1,
        traversalDepth: 5,
        completedAt: '2026-08-29T00:00:00.000Z',
        counts: {},
        categoryAvailability: {},
        limitations: [],
      },
    });
    const html = renderToStaticMarkup(createElement(ChangeReview));
    expect(html).toContain('Overview');
    expect(html).toContain('Files and edges');
    expect(html).toContain('Findings');
    expect(html).toContain('Possible impact');
    expect(html).toContain('Limitations');
  });
});
