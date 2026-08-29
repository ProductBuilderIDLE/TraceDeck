import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ReviewArchitectureChange,
  ReviewCycleChange,
  ReviewEdgeChange,
  ReviewExportChange,
  ReviewFileDiff,
  ReviewFindingChange,
  ReviewGitChange,
  ReviewImpactItem,
  ReviewLimitation,
  ReviewNoKnownTest,
  ReviewPage,
  ReviewSection,
} from '@shared/changeReview';
// @ts-expect-error The Node test project has no JSX transform.
import { ReviewFilters } from '../../../src/renderer/src/components/changeReview/ReviewFilters';
// @ts-expect-error The Node test project has no JSX transform.
import { ReviewPage as ReviewPageView } from '../../../src/renderer/src/components/changeReview/ReviewPage';
// @ts-expect-error The Node test project has no JSX transform.
import { ReviewDiff } from '../../../src/renderer/src/components/changeReview/ReviewDiff';

const DEFAULT_FILTERS = {
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
} as const;

function page(overrides: Partial<ReviewPage> = {}): ReviewPage {
  return {
    reviewId: 7,
    section: 'files' as ReviewSection,
    items: [],
    nextCursor: null,
    returnedCount: 0,
    retainedCount: 0,
    totalCount: 0,
    truncated: false,
    truncatedAtDepth: false,
    ...overrides,
  };
}

function renderResults(pageData: ReviewPage, extraProps: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(ReviewPageView, {
      page: pageData,
      previousCursors: [],
      onNext: vi.fn(),
      onPrevious: vi.fn(),
      onDiff: vi.fn(),
      ...extraProps,
    }),
  );
}

function fileItem(overrides: Partial<ReviewGitChange> = {}): ReviewGitChange {
  return {
    itemType: 'file',
    stableKey: 'file:src/app.ts',
    relativePath: 'src/app.ts',
    oldPath: null,
    copiedFrom: null,
    changeType: 'modified',
    staged: true,
    unstaged: false,
    untracked: false,
    similarity: null,
    language: 'typescript',
    ...overrides,
  };
}

function edgeItem(overrides: Partial<ReviewEdgeChange> = {}): ReviewEdgeChange {
  return {
    itemType: 'edge',
    stableKey: 'edge:src/a.ts:src/b.ts',
    direction: 'added',
    fromPath: 'src/a.ts',
    toPath: 'src/b.ts',
    edgeType: 'import',
    typeOnly: false,
    sourceLines: [10],
    specifiers: ['default'],
    ...overrides,
  };
}

function findingItem(overrides: Partial<ReviewFindingChange> = {}): ReviewFindingChange {
  return {
    itemType: 'finding',
    stableKey: 'finding:1',
    direction: 'introduced',
    finding: {
      findingType: 'unused-export-candidate',
      severity: 'low',
      title: 'Unused export',
      description: 'The export may be unused.',
      relatedNodeIds: ['file:src/utils.ts', 'symbol:src/utils.ts#unused'],
      details: { kind: 'unused-export', filePath: 'src/utils.ts', symbolName: 'unused', symbolKind: 'function', line: 5, caveats: [] } as never,
      fingerprint: 'fp-1',
      dismissed: false,
    },
    ...overrides,
  };
}

function architectureItem(overrides: Partial<ReviewArchitectureChange> = {}): ReviewArchitectureChange {
  return {
    itemType: 'architecture-violation',
    stableKey: 'arch:1',
    direction: 'introduced',
    ruleId: 1,
    ruleFingerprint: 'rule-a',
    sourcePath: 'src/ui.tsx',
    targetPath: 'src/db.ts',
    severity: 'high',
    line: 12,
    ...overrides,
  };
}

function cycleItem(overrides: Partial<ReviewCycleChange> = {}): ReviewCycleChange {
  return {
    itemType: 'cycle',
    stableKey: 'cycle:1',
    direction: 'added',
    memberPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    cyclePath: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/a.ts'],
    ...overrides,
  };
}

function exportItem(overrides: Partial<ReviewExportChange> = {}): ReviewExportChange {
  return {
    itemType: 'reachable-export',
    stableKey: 'export:1',
    direction: 'added',
    entryPoint: 'src/index.ts',
    exportedName: 'render',
    symbolKind: 'function',
    originPath: 'src/app.ts',
    line: 4,
    ...overrides,
  };
}

function impactItem(overrides: Partial<ReviewImpactItem> = {}): ReviewImpactItem {
  return {
    itemType: 'affected-file',
    stableKey: 'impact:1',
    destinationPath: 'src/feature.ts',
    depth: 2,
    direct: true,
    originPaths: ['src/app.ts'],
    baselinePresent: true,
    targetPresent: true,
    explanations: [
      {
        side: 'target',
        originPath: 'src/app.ts',
        path: ['src/app.ts', 'src/feature.ts'],
        edgeTypes: ['import'],
      },
    ],
    ...overrides,
  };
}

function candidateTestItem(overrides: Partial<ReviewImpactItem> = {}): ReviewImpactItem {
  return {
    ...impactItem({ itemType: 'candidate-test' as const, destinationPath: 'src/feature.test.ts', direct: false }),
    ...overrides,
  };
}

function noKnownTestItem(overrides: Partial<ReviewNoKnownTest> = {}): ReviewNoKnownTest {
  return {
    itemType: 'no-known-test',
    stableKey: 'nokt:1',
    changedPath: 'src/feature.ts',
    ...overrides,
  };
}

function limitationItem(overrides: Partial<ReviewLimitation> = {}): ReviewLimitation {
  return {
    itemType: 'limitation',
    stableKey: 'lim:1',
    scope: 'target',
    code: 'LIMIT_EXCEEDED',
    message: 'Traversal stopped at the configured depth.',
    paths: ['src/deep'],
    omittedCount: 50,
    ...overrides,
  };
}

describe('ReviewFilters', () => {
  it('renders only controls applicable to the active section', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewFilters, {
        section: 'files',
        filters: DEFAULT_FILTERS,
        onChange: vi.fn(),
      }),
    );
    expect(html).toContain('Change type');
    expect(html).toContain('Git state');
    expect(html).toContain('Language');
    expect(html).toContain('Folder');
    expect(html).not.toContain('Finding type');
    expect(html).not.toContain('Severity');
    expect(html).not.toContain('Directness');
  });

  it('marks active filter buttons with aria-pressed', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewFilters, {
        section: 'files',
        filters: { ...DEFAULT_FILTERS, changeTypes: ['added'], gitStates: ['staged'] },
        onChange: vi.fn(),
      }),
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
  });

  it('shows depth controls for impact sections', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewFilters, {
        section: 'affected-files',
        filters: DEFAULT_FILTERS,
        onChange: vi.fn(),
      }),
    );
    expect(html).toContain('Depth');
    expect(html).toContain('Min');
    expect(html).toContain('Max');
    expect(html).toContain('Directness');
  });

  it('shows direction controls for findings and edges', () => {
    const findings = renderToStaticMarkup(
      createElement(ReviewFilters, {
        section: 'findings',
        filters: { ...DEFAULT_FILTERS, deltaDirections: ['introduced'] },
        onChange: vi.fn(),
      }),
    );
    expect(findings).toContain('Direction');
    expect(findings).toContain('Introduced');
    expect(findings).toContain('Resolved');

    const edges = renderToStaticMarkup(
      createElement(ReviewFilters, {
        section: 'edges',
        filters: { ...DEFAULT_FILTERS, deltaDirections: ['removed'] },
        onChange: vi.fn(),
      }),
    );
    expect(edges).toContain('Added');
    expect(edges).toContain('Removed');
  });
});

describe('ReviewPage', () => {
  it('renders file Git badges and change type', () => {
    const html = renderResults(page({ items: [fileItem()] }));
    expect(html).toContain('src/app.ts');
    expect(html).toContain('modified');
    expect(html).toContain('staged');
    expect(html).toContain('Diff');
  });

  it('renders added and removed edges', () => {
    const html = renderResults(page({
      section: 'edges',
      items: [
        edgeItem({ direction: 'added' }),
        edgeItem({ stableKey: 'edge:2', direction: 'removed', fromPath: 'src/c.ts', toPath: 'src/d.ts' }),
      ],
    }));
    expect(html).toContain('src/a.ts');
    expect(html).toContain('src/b.ts');
    expect(html).toContain('added');
    expect(html).toContain('removed');
    expect(html).toContain('import');
  });

  it('renders introduced and resolved findings', () => {
    const html = renderResults(page({
      section: 'findings',
      items: [
        findingItem(),
        findingItem({ stableKey: 'finding:2', direction: 'resolved' }),
      ],
    }));
    expect(html).toContain('Unused export');
    expect(html).toContain('introduced');
    expect(html).toContain('resolved');
    expect(html).toContain('low');
  });

  it('renders architecture violations', () => {
    const html = renderResults(page({ section: 'architecture-violations', items: [architectureItem()] }));
    expect(html).toContain('src/ui.tsx');
    expect(html).toContain('src/db.ts');
    expect(html).toContain('rule-a');
    expect(html).toContain('high');
  });

  it('renders cycles', () => {
    const html = renderResults(page({ section: 'cycles', items: [cycleItem()] }));
    expect(html).toContain('src/a.ts');
    expect(html).toContain('src/b.ts');
    expect(html).toContain('src/c.ts');
    expect(html).toContain('added');
  });

  it('renders reachable exports', () => {
    const html = renderResults(page({ section: 'reachable-exports', items: [exportItem()] }));
    expect(html).toContain('render');
    expect(html).toContain('function');
    expect(html).toContain('src/index.ts');
    expect(html).toContain('src/app.ts');
  });

  it('renders direct and indirect impact', () => {
    const html = renderResults(page({
      section: 'affected-files',
      items: [impactItem(), impactItem({ stableKey: 'impact:2', direct: false, depth: 3 })],
    }));
    expect(html).toContain('src/feature.ts');
    expect(html).toContain('direct');
    expect(html).toContain('indirect');
    expect(html).toContain('depth 2');
    expect(html).toContain('target');
  });

  it('renders candidate tests', () => {
    const html = renderResults(page({ section: 'candidate-tests', items: [candidateTestItem()] }));
    expect(html).toContain('src/feature.test.ts');
    expect(html).toContain('Candidate test');
    expect(html).toContain('indirect');
  });

  it('renders no-known-tests', () => {
    const html = renderResults(page({ section: 'no-known-tests', items: [noKnownTestItem()] }));
    expect(html).toContain('src/feature.ts');
    expect(html).toContain('no known candidate test');
  });

  it('renders grouped limitations', () => {
    const html = renderResults(page({ section: 'limitations', items: [limitationItem()] }));
    expect(html).toContain('LIMIT_EXCEEDED');
    expect(html).toContain('Traversal stopped');
    expect(html).toContain('50');
  });

  it('does not call a truncated filtered count the complete match total', () => {
    const html = renderResults(page({ totalCount: 5000, retainedCount: 2000, truncated: true }));
    expect(html).toContain('matching retained details');
    expect(html).toContain('5,000 total');
    expect(html).toContain('2,000');
  });

  it('shows returned, retained, and total counts', () => {
    const html = renderResults(page({ returnedCount: 25, retainedCount: 100, totalCount: 150 }));
    expect(html).toContain('25');
    expect(html).toContain('100');
    expect(html).toContain('150');
    expect(html).toContain('returned');
    expect(html).toContain('matching');
    expect(html).toContain('total');
  });

  it('defends against missing page items', () => {
    const broken = { ...page(), items: undefined } as unknown as ReviewPage;
    const html = renderResults(broken);
    expect(html).toContain('No items match');
  });

  it('shows the empty impact copy exactly', () => {
    const html = renderResults(page({ section: 'affected-files', items: [] }));
    expect(html).toContain(
      'No additional affected files were found within the analyzed dependency graph and configured limits.',
    );
  });

  it('shows the empty test copy exactly', () => {
    const html = renderResults(page({ section: 'candidate-tests', items: [] }));
    expect(html).toContain(
      'No graph-reachable candidate test was found within the analyzed files and traversal limits. This does not mean no test exercises the change.',
    );
  });

  it('enables next and previous based on cursor stack', () => {
    const withBoth = renderResults(
      page({ nextCursor: 'cursor-2' }),
      { previousCursors: ['cursor-1'] },
    );
    expect(withBoth).not.toContain('disabled=""');

    const without = renderResults(page({ nextCursor: null }));
    expect(without).toContain('disabled=""');
  });

  it('disables the diff action when canDiff is false', () => {
    const html = renderResults(page({ items: [fileItem()] }), { canDiff: false });
    expect(html).toContain('disabled=""');
  });
});

describe('ReviewDiff', () => {
  function renderDiff(overrides: Partial<ReviewFileDiff> = {}): string {
    const diff: ReviewFileDiff = {
      oldPath: 'src/old.ts',
      newPath: 'src/new.ts',
      diffText: '+ added line',
      truncated: false,
      returnedBytes: 100,
      returnedLines: 10,
      omittedBytes: 0,
      omittedLines: 0,
      ...overrides,
    };
    return renderToStaticMarkup(createElement(ReviewDiff, { diff }));
  }

  it('shows rename labels for old and new paths', () => {
    const html = renderDiff();
    expect(html).toContain('Renamed');
    expect(html).toContain('src/old.ts');
    expect(html).toContain('src/new.ts');
  });

  it('warns about truncation and shows exact omitted counts', () => {
    const html = renderDiff({
      truncated: true,
      omittedBytes: 1024,
      omittedLines: 50,
    });
    expect(html).toContain('bounded');
    expect(html).toContain('1,024');
    expect(html).toContain('50');
  });

  it('is read-only and has no edit, save, or format actions', () => {
    const html = renderDiff();
    expect(html).not.toContain('Edit');
    expect(html).not.toContain('Save');
    expect(html).not.toContain('Format');
    expect(html).toContain('Diff');
    expect(html).toContain('+ added line');
  });

  it('announces staleness for stale diff evidence', () => {
    const diff: ReviewFileDiff = {
      oldPath: 'src/old.ts',
      newPath: 'src/new.ts',
      diffText: '+ added line',
      truncated: false,
      returnedBytes: 100,
      returnedLines: 10,
      omittedBytes: 0,
      omittedLines: 0,
    };
    const html = renderToStaticMarkup(createElement(ReviewDiff, { diff, stale: true }));
    expect(html).toContain('stale review');
  });
});
