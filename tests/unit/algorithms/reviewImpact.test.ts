import { describe, expect, it } from 'vitest';
import {
  computeReviewImpact,
  ReviewImpactCancelledError,
  type ReviewImpactOptions,
} from '@main/analysis/algorithms/reviewImpact';
import { GraphIndex } from '@main/analysis/algorithms/graphIndex';
import type { AdjacencyEdge } from '@main/db/repositories/edgeRepository';
import { canonicalSha256, canonicalStringify, compareCodePoints } from '@main/services/changeReview/canonical';
import type { ReviewGitChange, ReviewImpactItem } from '@shared/changeReview';
import { fileNodeId } from '@shared/nodeIds';
import type { EdgeType } from '@shared/types';

type EdgeOverrides = Partial<Omit<AdjacencyEdge, 'from' | 'to' | 'edgeType'>>;
type ChangeOverrides = Partial<
  Omit<ReviewGitChange, 'itemType' | 'stableKey' | 'changeType' | 'relativePath'>
>;

function dependency(
  fromPath: string,
  toPath: string,
  edgeType: EdgeType = 'import',
  overrides: EdgeOverrides = {},
): AdjacencyEdge {
  return {
    from: fileNodeId(fromPath),
    to: fileNodeId(toPath),
    edgeType,
    unresolved: false,
    sourceLine: 1,
    specifier: `./${toPath}`,
    ...overrides,
  };
}

function index(
  edges: readonly AdjacencyEdge[],
  options: ConstructorParameters<typeof GraphIndex>[1] = {},
): GraphIndex {
  return new GraphIndex(edges, options);
}

function changed(
  changeType: ReviewGitChange['changeType'],
  relativePath: string,
  overrides: ChangeOverrides = {},
): ReviewGitChange {
  const evidence = {
    relativePath,
    oldPath: null,
    copiedFrom: null,
    changeType,
    staged: false,
    unstaged: true,
    untracked: false,
    similarity: null,
    language: 'typescript',
    ...overrides,
  };
  return {
    itemType: 'file',
    stableKey: canonicalSha256({
      relativePath: evidence.relativePath,
      oldPath: evidence.oldPath,
      copiedFrom: evidence.copiedFrom,
      changeType: evidence.changeType,
      staged: evidence.staged,
      unstaged: evidence.unstaged,
      untracked: evidence.untracked,
    }),
    ...evidence,
  };
}

function options(overrides: Partial<ReviewImpactOptions> = {}): ReviewImpactOptions {
  return {
    baselineIndex: index([]),
    targetIndex: index([]),
    changes: [],
    maxDepth: 5,
    maxRetained: 2_000,
    signal: { cancelled: false },
    ...overrides,
  };
}

function byDestination(items: readonly ReviewImpactItem[]): Record<string, ReviewImpactItem> {
  return Object.fromEntries(items.map((item) => [item.destinationPath, item]));
}

function impactStableKey(itemType: ReviewImpactItem['itemType'], destinationPath: string): string {
  return canonicalSha256({ itemType, destinationPath });
}

describe('review impact graph-side selection', () => {
  it('uses only the target graph for an added file', () => {
    const result = computeReviewImpact(options({
      baselineIndex: index([dependency('baseline-app.ts', 'new.ts')]),
      targetIndex: index([dependency('target-app.ts', 'new.ts')]),
      changes: [changed('added', 'new.ts')],
    }));

    expect(result.affectedFiles).toEqual([expect.objectContaining({
      destinationPath: 'target-app.ts',
      baselinePresent: false,
      targetPresent: true,
    })]);
  });

  it('uses the baseline graph for a deleted dependency', () => {
    const result = computeReviewImpact(options({
      baselineIndex: index([dependency('app.ts', 'gone.ts')]),
      targetIndex: index([]),
      changes: [changed('deleted', 'gone.ts')],
    }));

    expect(result.affectedFiles[0]).toMatchObject({
      destinationPath: 'app.ts',
      depth: 1,
      direct: true,
      baselinePresent: true,
      targetPresent: false,
      explanations: [{
        side: 'baseline',
        originPath: 'gone.ts',
        path: ['gone.ts', 'app.ts'],
        edgeTypes: ['import'],
      }],
    });
  });

  it('uses both graphs for a modified file', () => {
    const result = computeReviewImpact(options({
      baselineIndex: index([dependency('old-consumer.ts', 'shared.ts')]),
      targetIndex: index([dependency('new-consumer.ts', 'shared.ts')]),
      changes: [changed('modified', 'shared.ts')],
    }));
    const affected = byDestination(result.affectedFiles);

    expect(affected['old-consumer.ts']).toMatchObject({
      baselinePresent: true,
      targetPresent: false,
    });
    expect(affected['new-consumer.ts']).toMatchObject({
      baselinePresent: false,
      targetPresent: true,
    });
  });

  it('uses the old baseline path and new target path for a rename', () => {
    const result = computeReviewImpact(options({
      baselineIndex: index([dependency('old-consumer.ts', 'old-name.ts')]),
      targetIndex: index([dependency('new-consumer.ts', 'new-name.ts')]),
      changes: [changed('renamed', 'new-name.ts', { oldPath: 'old-name.ts' })],
    }));
    const affected = byDestination(result.affectedFiles);

    expect(affected['old-consumer.ts']?.explanations[0]).toMatchObject({
      side: 'baseline',
      originPath: 'old-name.ts',
    });
    expect(affected['new-consumer.ts']?.explanations[0]).toMatchObject({
      side: 'target',
      originPath: 'new-name.ts',
    });
  });

  it('treats a copied file as target-only added evidence', () => {
    const result = computeReviewImpact(options({
      baselineIndex: index([dependency('baseline-consumer.ts', 'copy.ts')]),
      targetIndex: index([dependency('target-consumer.ts', 'copy.ts')]),
      changes: [changed('added', 'copy.ts', { copiedFrom: 'source.ts' })],
    }));

    expect(result.affectedFiles.map((item) => item.destinationPath)).toEqual(['target-consumer.ts']);
  });
});

describe('review impact traversal and provenance', () => {
  it('excludes every changed seed even when another changed seed reaches it', () => {
    const graph = index([
      dependency('b.ts', 'a.ts'),
      dependency('consumer.ts', 'b.ts'),
    ]);
    const result = computeReviewImpact(options({
      baselineIndex: graph,
      targetIndex: graph,
      changes: [changed('modified', 'a.ts'), changed('modified', 'b.ts')],
    }));

    expect(result.affectedFiles.map((item) => item.destinationPath)).toEqual(['consumer.ts']);
    expect(result.affectedFiles[0]?.explanations.map((item) => item.originPath)).toEqual([
      'b.ts',
      'b.ts',
    ]);
  });

  it('classifies direct and indirect dependents and records every explanation hop', () => {
    const graph = index([
      dependency('mid.ts', 'core.ts', 'require'),
      dependency('app.ts', 'mid.ts', 'dynamic-import'),
    ]);
    const result = computeReviewImpact(options({
      targetIndex: graph,
      changes: [changed('added', 'core.ts')],
    }));
    const affected = byDestination(result.affectedFiles);

    expect(affected['mid.ts']).toMatchObject({ depth: 1, direct: true });
    expect(affected['app.ts']).toMatchObject({
      depth: 2,
      direct: false,
      explanations: [{
        side: 'target',
        originPath: 'core.ts',
        path: ['core.ts', 'mid.ts', 'app.ts'],
        edgeTypes: ['require', 'dynamic-import'],
      }],
    });
    expect(result.graphEvidence).toEqual({
      nodePaths: ['app.ts', 'core.ts', 'mid.ts'],
      edges: [
        { fromPath: 'app.ts', toPath: 'mid.ts', edgeType: 'dynamic-import', side: 'target' },
        { fromPath: 'mid.ts', toPath: 'core.ts', edgeType: 'require', side: 'target' },
      ],
    });
  });

  it('keeps the shortest path to a destination', () => {
    const result = computeReviewImpact(options({
      targetIndex: index([
        dependency('consumer.ts', 'core.ts'),
        dependency('mid.ts', 'core.ts'),
        dependency('consumer.ts', 'mid.ts'),
      ]),
      changes: [changed('added', 'core.ts')],
    }));

    expect(byDestination(result.affectedFiles)['consumer.ts']).toMatchObject({
      depth: 1,
      explanations: [{ path: ['core.ts', 'consumer.ts'] }],
    });
  });

  it('breaks equal shortest paths by changed origin regardless of change order', () => {
    const graph = index([
      dependency('consumer.ts', 'b.ts'),
      dependency('consumer.ts', 'a.ts'),
    ]);
    const result = computeReviewImpact(options({
      baselineIndex: graph,
      targetIndex: graph,
      changes: [changed('modified', 'b.ts'), changed('modified', 'a.ts')],
    }));

    expect(result.affectedFiles[0]?.explanations.map((item) => item.originPath)).toEqual([
      'a.ts',
      'a.ts',
    ]);
  });

  it('breaks equal-origin paths by the complete code-point ordered path', () => {
    const result = computeReviewImpact(options({
      targetIndex: index([
        dependency('z-mid.ts', 'core.ts'),
        dependency('a-mid.ts', 'core.ts'),
        dependency('consumer.ts', 'z-mid.ts'),
        dependency('consumer.ts', 'a-mid.ts'),
      ]),
      changes: [changed('added', 'core.ts')],
    }));

    expect(byDestination(result.affectedFiles)['consumer.ts']?.explanations[0]?.path).toEqual([
      'core.ts',
      'a-mid.ts',
      'consumer.ts',
    ]);
  });

  it('terminates cycles without returning a changed root', () => {
    const graph = index([
      dependency('b.ts', 'a.ts'),
      dependency('a.ts', 'b.ts'),
    ]);
    const result = computeReviewImpact(options({
      baselineIndex: graph,
      targetIndex: graph,
      changes: [changed('modified', 'a.ts')],
      maxDepth: 10,
    }));

    expect(result.affectedFiles.map((item) => item.destinationPath)).toEqual(['b.ts']);
    expect(result.truncatedAtDepth).toBe(false);
  });

  it('retains deterministic explanations and presence from both sides', () => {
    const result = computeReviewImpact(options({
      baselineIndex: index([dependency('consumer.ts', 'core.ts', 'require')]),
      targetIndex: index([dependency('consumer.ts', 'core.ts', 'import')]),
      changes: [changed('modified', 'core.ts')],
    }));

    expect(result.affectedFiles[0]).toMatchObject({
      destinationPath: 'consumer.ts',
      depth: 1,
      baselinePresent: true,
      targetPresent: true,
      originPaths: ['core.ts'],
      explanations: [
        { side: 'baseline', edgeTypes: ['require'] },
        { side: 'target', edgeTypes: ['import'] },
      ],
    });
  });

  it('traverses only resolved dependency edge types', () => {
    const graph = index([
      dependency('included.ts', 'core.ts'),
      dependency('unresolved.ts', 'core.ts', 'import', { unresolved: true }),
      dependency('reference.ts', 'core.ts', 'reference'),
      dependency('export.ts', 'core.ts', 'export'),
    ], { includeUnresolved: true });
    const result = computeReviewImpact(options({
      targetIndex: graph,
      changes: [changed('added', 'core.ts')],
    }));

    expect(result.affectedFiles.map((item) => item.destinationPath)).toEqual(['included.ts']);
  });
});

describe('review impact candidates, limits, and determinism', () => {
  it('selects graph-reachable candidate tests but not sibling tests through a shared module', () => {
    const result = computeReviewImpact(options({
      targetIndex: index([
        dependency('app.ts', 'core.ts'),
        dependency('core.test.ts', 'core.ts'),
        dependency('core.ts', 'shared.ts'),
        dependency('shared.test.ts', 'shared.ts'),
      ]),
      changes: [changed('added', 'core.ts')],
    }));

    expect(result.candidateTests.map((item) => item.destinationPath)).toEqual(['core.test.ts']);
    expect(result.candidateTests[0]).toEqual({
      ...byDestination(result.affectedFiles)['core.test.ts'],
      itemType: 'candidate-test',
      stableKey: impactStableKey('candidate-test', 'core.test.ts'),
    });
    expect(result.affectedFiles.some((item) => item.destinationPath === 'shared.test.ts')).toBe(false);
  });

  it('reports no known test per logical origin and matches both rename origins', () => {
    const result = computeReviewImpact(options({
      baselineIndex: index([dependency('renamed.test.ts', 'old-name.ts')]),
      targetIndex: index([dependency('a.test.ts', 'a.ts')]),
      changes: [
        changed('modified', 'a.ts'),
        changed('modified', 'b.ts'),
        changed('renamed', 'new-name.ts', { oldPath: 'old-name.ts' }),
      ],
    }));

    expect(result.candidateTests.map((item) => item.destinationPath).sort(compareCodePoints)).toEqual([
      'a.test.ts',
      'renamed.test.ts',
    ]);
    expect(result.noKnownTests).toEqual([{
      itemType: 'no-known-test',
      stableKey: canonicalSha256({ changedPath: 'b.ts' }),
      changedPath: 'b.ts',
    }]);
  });

  it('marks depth truncation only when an unseen dependent exists beyond the boundary', () => {
    const truncated = computeReviewImpact(options({
      targetIndex: index([
        dependency('mid.ts', 'core.ts'),
        dependency('deep.ts', 'mid.ts'),
      ]),
      changes: [changed('added', 'core.ts')],
      maxDepth: 1,
    }));
    const complete = computeReviewImpact(options({
      targetIndex: index([dependency('mid.ts', 'core.ts')]),
      changes: [changed('added', 'core.ts')],
      maxDepth: 1,
    }));

    expect(truncated.affectedFiles.map((item) => item.destinationPath)).toEqual(['mid.ts']);
    expect(truncated.truncatedAtDepth).toBe(true);
    expect(complete.truncatedAtDepth).toBe(false);
  });

  it('counts 2,005 destinations before retaining the stable first 2,000', () => {
    const edges = Array.from({ length: 2_005 }, (_, edgeIndex) => (
      dependency(`consumer-${2_004 - edgeIndex}.ts`, 'core.ts')
    ));
    const result = computeReviewImpact(options({
      targetIndex: index(edges),
      changes: [changed('added', 'core.ts')],
    }));
    const expectedKeys = edges
      .map((candidate) => candidate.from.slice('file:'.length))
      .map((destinationPath) => impactStableKey('affected-file', destinationPath))
      .sort(compareCodePoints)
      .slice(0, 2_000);

    expect(result.totalAffected).toBe(2_005);
    expect(result.affectedFiles).toHaveLength(2_000);
    expect(result.truncatedAffected).toBe(true);
    expect(result.affectedFiles.map((item) => item.stableKey)).toEqual(expectedKeys);
  });

  it('throws a typed cancellation error without returning a partial result', () => {
    let reads = 0;
    const signal = {
      get cancelled(): boolean {
        reads += 1;
        return reads >= 5;
      },
    };
    const targetIndex = index(Array.from({ length: 1_001 }, (_, edgeIndex) => (
      dependency(`consumer-${edgeIndex}.ts`, 'core.ts')
    )));

    let thrown: unknown;
    try {
      computeReviewImpact(options({
        targetIndex,
        changes: [changed('added', 'core.ts')],
        signal,
      }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ReviewImpactCancelledError);
    expect(thrown).toMatchObject({ code: 'REVIEW_CANCELLED' });
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it('produces byte-identical output for reversed edge and change order', () => {
    const edges = [
      dependency('z.test.ts', 'b.ts', 'require'),
      dependency('consumer.ts', 'b.ts'),
      dependency('consumer.ts', 'a.ts'),
      dependency('a.test.ts', 'a.ts', 'dynamic-import'),
    ];
    const changes = [changed('modified', 'b.ts'), changed('modified', 'a.ts')];
    const forward = computeReviewImpact(options({
      baselineIndex: index(edges),
      targetIndex: index(edges),
      changes,
    }));
    const reversed = computeReviewImpact(options({
      baselineIndex: index([...edges].reverse()),
      targetIndex: index([...edges].reverse()),
      changes: [...changes].reverse(),
    }));

    expect(canonicalStringify(reversed)).toBe(canonicalStringify(forward));
  });
});
