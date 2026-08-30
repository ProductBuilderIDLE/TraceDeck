import { createElement } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ReviewArchitectureChange,
  ReviewEdgeChange,
  ReviewFindingChange,
  ReviewGitChange,
  ReviewImpactExplanation,
  ReviewImpactItem,
  ReviewPage as ReviewPageData,
  ReviewStatus,
} from '@shared/changeReview';
import type { ArchitectureRule, Finding } from '@shared/types';
// @ts-expect-error The Node test project has no JSX transform.
import { ReviewPage } from '../../../src/renderer/src/components/changeReview/ReviewPage';
// @ts-expect-error The Node test project has no JSX transform.
import { ReviewEvidenceInspector } from '../../../src/renderer/src/components/changeReview/ReviewEvidenceInspector';
// @ts-expect-error The Node test project has no JSX transform.
import { useUiStore } from '../../../src/renderer/src/store/uiStore';

const BASE_COMMIT = 'a'.repeat(40);

const appState = {
  currentProject: { id: 7, name: 'Example', rootPath: 'C:/project' },
  rules: [] as ArchitectureRule[],
};

const reviewState: { status: ReviewStatus | null } = {
  status: {
    projectId: 7,
    repositoryState: 'ready',
    baseCommit: BASE_COMMIT,
    baseTreeId: 'b'.repeat(40),
    branchName: 'main',
    gitChanges: [],
    latestReview: { reviewId: 7, freshness: 'current', staleReasons: [] },
    activeOperation: null,
    lastOutcome: null,
  },
};

vi.mock('../../../src/renderer/src/lib/ipc', () => ({
  invoke: vi.fn(),
  subscribeToScanProgress: vi.fn(() => () => undefined),
}));

vi.mock('../../../src/renderer/src/lib/theme', () => ({
  applyTheme: vi.fn(),
  loadStoredTheme: vi.fn(() => 'dark'),
  storeTheme: vi.fn(),
  tokenColor: vi.fn(() => 'rgb(0, 0, 0)'),
}));

vi.mock('../../../src/renderer/src/store/appStore', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}));

vi.mock('../../../src/renderer/src/store/reviewStore', () => ({
  useReviewStore: (selector: (state: typeof reviewState) => unknown) => selector(reviewState),
}));

function pageFor(items: unknown[]): ReviewPageData {
  return {
    section: 'files',
    items: items as ReviewPageData['items'],
    returnedCount: items.length,
    retainedCount: items.length,
    totalCount: items.length,
    nextCursor: null,
    truncated: false,
    truncatedAtDepth: null,
  };
}

function fileItem(changeType: ReviewGitChange['changeType'] = 'modified'): ReviewGitChange {
  return {
    itemType: 'file',
    stableKey: 'file:test',
    relativePath: 'src/app.ts',
    oldPath: null,
    changeType,
    staged: true,
    unstaged: false,
    untracked: false,
    similarity: null,
    language: 'typescript',
  };
}

function edgeItem(): ReviewEdgeChange {
  return {
    itemType: 'edge',
    stableKey: 'edge:test',
    fromPath: 'src/a.ts',
    toPath: 'src/b.ts',
    edgeType: 'import',
    typeOnly: false,
    direction: 'added',
    sourceLines: [12],
    specifiers: ['foo'],
  };
}

function findingItem(): ReviewFindingChange {
  return {
    itemType: 'finding',
    stableKey: 'finding:test',
    direction: 'introduced',
    finding: {
      id: 1,
      projectId: 7,
      findingType: 'circular-dependency',
      title: 'Cycle',
      description: 'A cycle was found.',
      severity: 'high',
      relatedNodeIds: ['file:src/a.ts', 'file:src/b.ts'],
      details: { kind: 'cycle', cyclePath: ['src/a.ts', 'src/b.ts'] } as Finding['details'],
      fingerprint: 'fp1',
      createdAt: '2026-08-29T00:00:00.000Z',
      dismissedAt: null,
    },
  };
}

function architectureItem(ruleFingerprint: string): ReviewArchitectureChange {
  return {
    itemType: 'architecture-violation',
    stableKey: 'arch:test',
    direction: 'introduced',
    ruleId: 1,
    ruleFingerprint,
    sourcePath: 'src/ui.ts',
    targetPath: 'src/db.ts',
    severity: 'high',
    line: 42,
  };
}

function impactItem(): ReviewImpactItem {
  return {
    itemType: 'affected-file',
    stableKey: 'impact:test',
    destinationPath: 'src/app.ts',
    depth: 2,
    direct: true,
    originPaths: ['src/core.ts'],
    baselinePresent: true,
    targetPresent: true,
    explanations: [
      {
        side: 'target',
        originPath: 'src/core.ts',
        path: ['src/core.ts', 'src/feature.ts', 'src/app.ts'],
        edgeTypes: ['import', 'import'],
      } as ReviewImpactExplanation,
    ],
  };
}

describe('ChangeReview drill-down', () => {
  beforeEach(() => {
    appState.rules = [];
    useUiStore.setState({
      reviewGraphOverlay: null,
      reviewEvidence: null,
      focusedFindingFingerprint: null,
    });
  });

  it('renders a drill-down action on each row type', () => {
    const page = pageFor([fileItem(), edgeItem(), findingItem(), impactItem()]);
    const html = renderToStaticMarkup(
      createElement(ReviewPage, { page, onDrillDown: vi.fn() }),
    );
    expect(html).toContain('Details for file:test');
    expect(html).toContain('Graph for edge:test');
    expect(html).toContain('Find for finding:test');
    expect(html).toContain('Graph for impact:test');
    expect(html).toContain('data-review-stable-key');
  });

  it('keeps a deleted file in the review inspector and offers a diff, not source', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewEvidenceInspector, { evidence: fileItem('deleted') }),
    );
    expect(html).toContain('View diff');
    expect(html).not.toContain('View source');
    expect(html).toContain('Review evidence');
  });

  it('disables source and diff actions for a stale review', () => {
    reviewState.status = {
      ...reviewState.status,
      latestReview: { reviewId: 7, freshness: 'stale', staleReasons: ['WORKING_TREE_CHANGED'] },
    } as ReviewStatus;
    const html = renderToStaticMarkup(
      createElement(ReviewEvidenceInspector, { evidence: fileItem('modified') }),
    );
    expect(html).toContain('disabled');
    expect(html).not.toMatch(/View diff/);
  });

  it('disables the rule link when the rule fingerprint has changed semantically', () => {
    appState.rules = [
      {
        id: 1,
        projectId: 7,
        name: 'UI must not reach the database',
        enabled: true,
        ruleType: 'forbid-import',
        sourcePattern: 'src/ui/**',
        targetPattern: 'src/db/**',
        configuration: { severity: 'high', exceptions: [] },
        fingerprint: 'stale-rule-fingerprint',
        createdAt: '2026-08-29T00:00:00.000Z',
        updatedAt: '2026-08-29T00:00:00.000Z',
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ReviewEvidenceInspector, {
        evidence: architectureItem('current-rule-fingerprint'),
      }),
    );
    expect(html).toContain('View rule');
    expect(html).toContain('disabled');
    expect(html).toContain('The rule has changed since this violation was captured');
  });

  it('enables the rule link when the rule fingerprint matches', () => {
    appState.rules = [
      {
        id: 1,
        projectId: 7,
        name: 'UI must not reach the database',
        enabled: true,
        ruleType: 'forbid-import',
        sourcePattern: 'src/ui/**',
        targetPattern: 'src/db/**',
        configuration: { severity: 'high', exceptions: [] },
        fingerprint: 'matching-fingerprint',
        createdAt: '2026-08-29T00:00:00.000Z',
        updatedAt: '2026-08-29T00:00:00.000Z',
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ReviewEvidenceInspector, {
        evidence: architectureItem('matching-fingerprint'),
      }),
    );
    expect(html).toContain('View rule');
    expect(html).not.toContain('The rule has changed since this violation was captured');
  });

  it('retains baseline impact evidence in the inspector and never queries current SQLite', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewEvidenceInspector, {
        evidence: impactItem(),
        selectedNodeId: 'file:src/core.ts',
      }),
    );
    expect(html).toContain('Review evidence');
    expect(html).toContain('src/core.ts');
    expect(html).toContain('baseline');
    expect(html).not.toContain('This node is not a file in the last scan');
  });

  it('sets the graph overlay and evidence when showReviewGraph is called', () => {
    useUiStore.getState().showReviewGraph(edgeItem());
    const state = useUiStore.getState();
    expect(state.reviewGraphOverlay).not.toBeNull();
    expect(state.reviewGraphOverlay?.title).toContain('Added import edge');
    expect(state.reviewEvidence).not.toBeNull();
    expect(state.activeView).toBe('graph');
  });

  it('focuses a finding by fingerprint and maps it to the findings view', () => {
    useUiStore.getState().focusFinding('fp1', 'circular-dependency');
    const state = useUiStore.getState();
    expect(state.focusedFindingFingerprint).toEqual({
      fingerprint: 'fp1',
      findingType: 'circular-dependency',
    });
    expect(state.activeView).toBe('cycles');
  });
});
