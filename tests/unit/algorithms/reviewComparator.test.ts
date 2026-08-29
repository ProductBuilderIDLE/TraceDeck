import { describe, expect, it } from 'vitest';
import type { ReachableExportRecord } from '@main/analysis/algorithms/reachableExports';
import {
  compareReviewSnapshots,
  ReviewComparisonCancelledError,
  stableArchitectureKey,
  stableCycleKey,
  stableEdgeKey,
  stableExportKey,
  stableFindingKey,
  type ReviewComparatorOptions,
} from '@main/analysis/algorithms/reviewComparator';
import {
  canonicalSha256,
  canonicalStringify,
  compareCodePoints,
} from '@main/services/changeReview/canonical';
import type {
  NormalizedArchitectureViolation,
  NormalizedCycle,
  NormalizedReviewEdge,
  ReviewSnapshot,
} from '@main/services/changeReview/snapshot';
import type {
  ReviewFindingEvidence,
  ReviewGitChange,
  ReviewLimitation,
} from '@shared/changeReview';

const BASE_COMMIT = 'a'.repeat(40);
const BASE_TREE_ID = 'b'.repeat(40);

type SnapshotOverrides = Partial<Omit<ReviewSnapshot, 'side'>>;
type EdgeOverrides = Partial<Omit<NormalizedReviewEdge, 'fromPath' | 'toPath' | 'typeOnly'>>;
type FindingOverrides = Partial<Omit<ReviewFindingEvidence, 'fingerprint'>>;
type ViolationOverrides = Partial<
  Omit<NormalizedArchitectureViolation, 'ruleId' | 'sourcePath' | 'targetPath'>
>;
type ExportOverrides = Partial<
  Omit<ReachableExportRecord, 'entryPoint' | 'exportedName' | 'originPath'>
>;
type ChangeOverrides = Partial<Omit<ReviewGitChange, 'itemType' | 'stableKey' | 'relativePath'>>;

function reviewSnapshot(
  side: ReviewSnapshot['side'],
  overrides: SnapshotOverrides = {},
): ReviewSnapshot {
  return {
    side,
    scanId: side === 'baseline' ? 11 : 22,
    baseCommit: BASE_COMMIT,
    baseTreeId: BASE_TREE_ID,
    workingTreeFingerprint: side === 'baseline' ? 'baseline-tree' : 'target-tree',
    userConfigurationFingerprint: 'user-configuration',
    effectiveBaselineFingerprint: 'effective-baseline',
    inventory: [],
    graphFiles: [],
    edges: [],
    findings: [],
    architectureViolations: [],
    cycles: [],
    reachableExports: [],
    limitations: [],
    ...overrides,
  };
}

function edge(
  fromPath: string,
  toPath: string,
  typeOnly = false,
  overrides: EdgeOverrides = {},
): NormalizedReviewEdge {
  return {
    fromPath,
    toPath,
    edgeType: 'import',
    typeOnly,
    sourceLines: [1],
    specifiers: [`./${toPath}`],
    ...overrides,
  };
}

function finding(
  fingerprint: string,
  overrides: FindingOverrides = {},
): ReviewFindingEvidence {
  return {
    findingType: 'syntax-error',
    severity: 'high',
    title: `Finding ${fingerprint}`,
    description: `Description ${fingerprint}`,
    relatedNodeIds: [`file:src/${fingerprint}.ts`],
    details: {
      kind: 'syntax-error',
      filePath: `src/${fingerprint}.ts`,
      line: 3,
      column: 4,
      code: 1005,
      message: `Message ${fingerprint}`,
    },
    fingerprint,
    dismissed: false,
    ...overrides,
  };
}

function violation(
  ruleId: number,
  sourcePath: string,
  targetPath: string,
  overrides: ViolationOverrides = {},
): NormalizedArchitectureViolation {
  return {
    ruleId,
    ruleFingerprint: `rule-${ruleId}`,
    sourcePath,
    targetPath,
    severity: 'high',
    line: 7,
    ...overrides,
  };
}

function cycle(memberPaths: string[], cyclePath: string[]): NormalizedCycle {
  return { memberPaths, cyclePath };
}

function reachableExport(
  entryPoint: string,
  exportedName: string,
  originPath: string,
  overrides: ExportOverrides = {},
): ReachableExportRecord {
  return {
    entryPoint,
    exportedName,
    symbolKind: 'function',
    originPath,
    line: 5,
    ...overrides,
  };
}

function change(relativePath: string, overrides: ChangeOverrides = {}): ReviewGitChange {
  const evidence = {
    relativePath,
    oldPath: null,
    copiedFrom: null,
    changeType: 'modified' as const,
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

function limitation(
  scope: ReviewLimitation['scope'],
  code: string,
  paths: string[],
  overrides: Partial<Pick<ReviewLimitation, 'message' | 'omittedCount'>> = {},
): ReviewLimitation {
  const orderedPaths = [...new Set(paths)].sort(compareCodePoints);
  return {
    itemType: 'limitation',
    stableKey: canonicalSha256({ scope, code, paths: orderedPaths }),
    scope,
    code,
    message: `${code} limitation`,
    paths,
    omittedCount: 0,
    ...overrides,
  };
}

function compareOptions(overrides: Partial<ReviewComparatorOptions> = {}): ReviewComparatorOptions {
  return { maxDepth: 5, maxRetained: 2_000, ...overrides };
}

function reverseSnapshotArrays(snapshot: ReviewSnapshot): ReviewSnapshot {
  return {
    ...snapshot,
    inventory: [...snapshot.inventory].reverse(),
    graphFiles: [...snapshot.graphFiles].reverse(),
    edges: [...snapshot.edges]
      .map((candidate) => ({
        ...candidate,
        sourceLines: [...candidate.sourceLines].reverse(),
        specifiers: [...candidate.specifiers].reverse(),
      }))
      .reverse(),
    findings: [...snapshot.findings]
      .map((candidate) => ({
        ...candidate,
        relatedNodeIds: [...candidate.relatedNodeIds].reverse(),
      }))
      .reverse(),
    architectureViolations: [...snapshot.architectureViolations].reverse(),
    cycles: [...snapshot.cycles]
      .map((candidate) => ({
        ...candidate,
        memberPaths: [...candidate.memberPaths].reverse(),
      }))
      .reverse(),
    reachableExports: [...snapshot.reachableExports].reverse(),
    limitations: [...snapshot.limitations]
      .map((candidate) => ({ ...candidate, paths: [...candidate.paths].reverse() }))
      .reverse(),
  };
}

function graphEdgeKey(edgeEvidence: {
  fromPath: string;
  toPath: string;
  edgeType: string;
  side: string;
}): string {
  return [
    edgeEvidence.fromPath,
    edgeEvidence.toPath,
    edgeEvidence.edgeType,
    edgeEvidence.side,
  ].join('\0');
}

describe('review snapshot comparison', () => {
  it('builds canonical stable identities from semantic fields only', () => {
    const edgeEvidence = edge('src/a.ts', 'src/b.ts', false, {
      sourceLines: [90],
      specifiers: ['different-spelling'],
    });
    const findingEvidence = finding('finding-fingerprint', {
      title: 'Display-only title',
      dismissed: true,
    });
    const architectureEvidence = violation(17, 'src/a.ts', 'src/b.ts', {
      line: 99,
      severity: 'low',
    });
    const cycleEvidence = cycle(
      ['src/z.ts', 'src/a.ts'],
      ['src/z.ts', 'src/a.ts', 'src/z.ts'],
    );
    const exportEvidence = reachableExport('src/index.ts', 'publicName', 'src/origin.ts', {
      line: 101,
    });

    expect(stableEdgeKey(edgeEvidence)).toBe(canonicalSha256({
      fromPath: 'src/a.ts',
      toPath: 'src/b.ts',
      edgeType: 'import',
      typeOnly: false,
    }));
    expect(stableFindingKey(findingEvidence)).toBe(canonicalSha256({
      findingType: 'syntax-error',
      fingerprint: 'finding-fingerprint',
    }));
    expect(stableArchitectureKey(architectureEvidence)).toBe(canonicalSha256({
      ruleId: 17,
      ruleFingerprint: 'rule-17',
      sourcePath: 'src/a.ts',
      targetPath: 'src/b.ts',
    }));
    expect(stableCycleKey(cycleEvidence)).toBe(canonicalSha256({
      memberPaths: ['src/a.ts', 'src/z.ts'],
    }));
    expect(stableExportKey(exportEvidence)).toBe(canonicalSha256({
      entryPoint: 'src/index.ts',
      exportedName: 'publicName',
      symbolKind: 'function',
      originPath: 'src/origin.ts',
    }));
  });

  it('deduplicates and sorts file changes before applying the retained cap', () => {
    const changes = [change('src/z.ts'), change('src/a.ts'), change('src/m.ts')];
    const input = [changes[0] as ReviewGitChange, changes[1] as ReviewGitChange, changes[0] as ReviewGitChange,
      changes[2] as ReviewGitChange];
    const before = canonicalStringify(input);

    const result = compareReviewSnapshots(
      reviewSnapshot('baseline'),
      reviewSnapshot('target'),
      input,
      compareOptions({ maxRetained: 2 }),
    );

    const expectedKeys = changes.map((candidate) => candidate.stableKey).sort(compareCodePoints);
    expect(result.fileChanges.map((candidate) => candidate.stableKey)).toEqual(expectedKeys.slice(0, 2));
    expect(result.counts.files).toEqual({
      totalCount: 3,
      retainedCount: 2,
      truncated: true,
      truncatedAtDepth: false,
    });
    expect(canonicalStringify(input)).toBe(before);
    expect(result).toMatchObject({
      schemaVersion: 1,
      baseCommit: BASE_COMMIT,
      baseTreeId: BASE_TREE_ID,
      workingTreeFingerprint: 'target-tree',
      userConfigurationFingerprint: 'user-configuration',
      effectiveBaselineFingerprint: 'effective-baseline',
      workingTreeScanId: 22,
      traversalDepth: 5,
      affectedFiles: [],
      candidateTests: [],
    });
    expect(result.noKnownTests).toHaveLength(2);
    expect(result.counts['affected-files']).toEqual({
      totalCount: 0,
      retainedCount: 0,
      truncated: false,
      truncatedAtDepth: false,
    });
    expect(result.counts['no-known-tests']).toEqual({
      totalCount: 3,
      retainedCount: 2,
      truncated: true,
      truncatedAtDepth: false,
    });
  });

  it('reports added and removed edges while omitting unchanged identities', () => {
    const unchanged = edge('src/shared.ts', 'src/core.ts');
    const removed = edge('src/old.ts', 'src/core.ts', false, { sourceLines: [8] });
    const added = edge('src/new.ts', 'src/core.ts', false, { sourceLines: [13] });

    const result = compareReviewSnapshots(
      reviewSnapshot('baseline', { edges: [removed, unchanged] }),
      reviewSnapshot('target', { edges: [unchanged, added] }),
      [],
      compareOptions(),
    );

    expect(result.edgeChanges).toHaveLength(2);
    expect(result.edgeChanges).toContainEqual({
      itemType: 'edge',
      stableKey: stableEdgeKey(added),
      direction: 'added',
      ...added,
    });
    expect(result.edgeChanges).toContainEqual({
      itemType: 'edge',
      stableKey: stableEdgeKey(removed),
      direction: 'removed',
      ...removed,
    });
    expect(result.edgeChanges.some((candidate) => candidate.fromPath === 'src/shared.ts')).toBe(false);
  });

  it('treats runtime and type-only edges as distinct identities', () => {
    const baseline = reviewSnapshot('baseline', {
      edges: [edge('a.ts', 'b.ts', false)],
    });
    const target = reviewSnapshot('target', {
      edges: [edge('a.ts', 'b.ts', true)],
    });

    const result = compareReviewSnapshots(baseline, target, [], compareOptions());

    expect(result.edgeChanges.map((item) => item.direction)).toEqual(['added', 'removed']);
  });

  it('ignores edge line and specifier-only changes while preserving inputs', () => {
    const baselineEdge = edge('src/a.ts', 'src/b.ts', false, {
      sourceLines: [4, 2],
      specifiers: ['./b', './b.js'],
    });
    const targetEdge = edge('src/a.ts', 'src/b.ts', false, {
      sourceLines: [100, 99],
      specifiers: ['@alias/b'],
    });
    const baseline = reviewSnapshot('baseline', { edges: [baselineEdge] });
    const target = reviewSnapshot('target', { edges: [targetEdge] });
    const before = canonicalStringify({ baseline, target });

    const result = compareReviewSnapshots(baseline, target, [], compareOptions());

    expect(result.edgeChanges).toEqual([]);
    expect(result.counts.edges.totalCount).toBe(0);
    expect(canonicalStringify({ baseline, target })).toBe(before);
  });

  it('retains side-specific finding details and ignores dismissal-only changes', () => {
    const resolved = finding('resolved', {
      title: 'Baseline title',
      dismissed: true,
      relatedNodeIds: ['file:z.ts', 'file:a.ts'],
    });
    const introduced = finding('introduced', {
      title: 'Target title',
      severity: 'medium',
      dismissed: true,
    });
    const dismissalChangedBefore = finding('same', { dismissed: false, title: 'Old display title' });
    const dismissalChangedAfter = finding('same', { dismissed: true, title: 'New display title' });

    const result = compareReviewSnapshots(
      reviewSnapshot('baseline', { findings: [dismissalChangedBefore, resolved] }),
      reviewSnapshot('target', { findings: [introduced, dismissalChangedAfter] }),
      [],
      compareOptions(),
    );

    expect(result.findingChanges).toHaveLength(2);
    expect(result.findingChanges).toContainEqual({
      itemType: 'finding',
      stableKey: stableFindingKey(introduced),
      direction: 'introduced',
      finding: introduced,
    });
    expect(result.findingChanges).toContainEqual({
      itemType: 'finding',
      stableKey: stableFindingKey(resolved),
      direction: 'resolved',
      finding: { ...resolved, relatedNodeIds: ['file:a.ts', 'file:z.ts'] },
    });
    expect(result.findingChanges.some((candidate) => candidate.finding.fingerprint === 'same')).toBe(false);
  });

  it('keeps architecture violations out of general finding deltas', () => {
    const architecture = violation(41, 'src/feature.ts', 'src/internal.ts');
    const architectureFinding = finding('architecture-row-fingerprint', {
      findingType: 'architecture-violation',
      details: {
        kind: 'architecture-violation',
        ruleId: 41,
        ruleName: 'Feature boundary',
        sourcePath: 'src/feature.ts',
        targetPath: 'src/internal.ts',
        line: 7,
        specifier: './internal',
      },
    });

    const result = compareReviewSnapshots(
      reviewSnapshot('baseline'),
      reviewSnapshot('target', {
        findings: [architectureFinding],
        architectureViolations: [architecture],
      }),
      [],
      compareOptions(),
    );

    expect(result.findingChanges).toEqual([]);
    expect(result.counts.findings.totalCount).toBe(0);
    expect(result.architectureChanges).toEqual([{
      itemType: 'architecture-violation',
      stableKey: stableArchitectureKey(architecture),
      direction: 'introduced',
      ...architecture,
    }]);
    expect(result.counts['architecture-violations'].totalCount).toBe(1);
  });

  it('uses SCC members rather than display paths and reports merges and splits', () => {
    const unchangedBefore = cycle(
      ['src/a.ts', 'src/b.ts'],
      ['src/a.ts', 'src/b.ts', 'src/a.ts'],
    );
    const unchangedAfter = cycle(
      ['src/a.ts', 'src/b.ts'],
      ['src/b.ts', 'src/a.ts', 'src/b.ts'],
    );
    const removed = cycle(
      ['src/c.ts', 'src/d.ts'],
      ['src/c.ts', 'src/d.ts', 'src/c.ts'],
    );
    const merged = cycle(
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/a.ts'],
    );

    const result = compareReviewSnapshots(
      reviewSnapshot('baseline', { cycles: [removed, unchangedBefore] }),
      reviewSnapshot('target', { cycles: [merged, unchangedAfter] }),
      [],
      compareOptions(),
    );

    expect(result.cycleChanges).toHaveLength(2);
    expect(result.cycleChanges).toContainEqual({
      itemType: 'cycle',
      stableKey: stableCycleKey(removed),
      direction: 'removed',
      memberPaths: ['src/c.ts', 'src/d.ts'],
      cyclePath: removed.cyclePath,
    });
    expect(result.cycleChanges).toContainEqual({
      itemType: 'cycle',
      stableKey: stableCycleKey(merged),
      direction: 'added',
      memberPaths: merged.memberPaths,
      cyclePath: merged.cyclePath,
    });
    expect(result.cycleChanges.some((candidate) => candidate.stableKey === stableCycleKey(unchangedBefore)))
      .toBe(false);
  });

  it('compares reachable exports by public origin identity rather than line', () => {
    const unchangedBefore = reachableExport('src/index.ts', 'same', 'src/same.ts', { line: 2 });
    const unchangedAfter = reachableExport('src/index.ts', 'same', 'src/same.ts', { line: 200 });
    const removed = reachableExport('src/index.ts', 'removed', 'src/old.ts', { line: 8 });
    const added = reachableExport('src/index.ts', 'added', 'src/new.ts', {
      line: 17,
      symbolKind: 'interface',
    });

    const result = compareReviewSnapshots(
      reviewSnapshot('baseline', { reachableExports: [unchangedBefore, removed] }),
      reviewSnapshot('target', { reachableExports: [added, unchangedAfter] }),
      [],
      compareOptions(),
    );

    expect(result.exportChanges).toHaveLength(2);
    expect(result.exportChanges).toContainEqual({
      itemType: 'reachable-export',
      stableKey: stableExportKey(added),
      direction: 'added',
      ...added,
    });
    expect(result.exportChanges).toContainEqual({
      itemType: 'reachable-export',
      stableKey: stableExportKey(removed),
      direction: 'removed',
      ...removed,
    });
  });

  it('deduplicates, normalizes, sorts, and caps combined limitations', () => {
    const baselineOnly = limitation('baseline', 'BASELINE_ONLY', ['src/z.ts', 'src/a.ts']);
    const sharedBefore = limitation('review', 'SHARED', ['src/shared.ts'], { omittedCount: 2 });
    const sharedAfter = limitation('review', 'SHARED', ['src/shared.ts'], { omittedCount: 7 });
    const targetOnly = limitation('target', 'TARGET_ONLY', ['src/target.ts']);
    const baseline = reviewSnapshot('baseline', { limitations: [sharedBefore, baselineOnly] });
    const target = reviewSnapshot('target', { limitations: [targetOnly, sharedAfter] });

    const complete = compareReviewSnapshots(baseline, target, [], compareOptions());
    const capped = compareReviewSnapshots(
      baseline,
      target,
      [],
      compareOptions({ maxRetained: 2 }),
    );

    expect(complete.limitations).toHaveLength(3);
    expect(complete.limitations.map((candidate) => candidate.stableKey)).toEqual(
      complete.limitations.map((candidate) => candidate.stableKey).sort(compareCodePoints),
    );
    expect(complete.limitations).toContainEqual({
      ...sharedBefore,
      paths: ['src/shared.ts'],
      omittedCount: 7,
    });
    expect(complete.limitations).toContainEqual({
      ...baselineOnly,
      paths: ['src/a.ts', 'src/z.ts'],
    });
    expect(capped.limitations).toEqual(complete.limitations.slice(0, 2));
    expect(capped.counts.limitations).toEqual({
      totalCount: 3,
      retainedCount: 2,
      truncated: true,
      truncatedAtDepth: false,
    });
  });

  it('retains normalized graph evidence required by retained edge, cycle, and export deltas', () => {
    const cycleForward = edge('src/a.ts', 'src/b.ts', false, { edgeType: 'require' });
    const cycleBack = edge('src/b.ts', 'src/a.ts', false, { edgeType: 'dynamic-import' });
    const cycleChord = edge('src/a.ts', 'src/a.ts');
    const exportLink = edge('src/index.ts', 'src/origin.ts', false, { edgeType: 're-export' });
    const addedEdge = edge('src/new.ts', 'src/core.ts');
    const sharedEdges = [cycleForward, cycleBack, cycleChord, exportLink];
    const removedCycle = cycle(
      ['src/b.ts', 'src/a.ts'],
      ['src/a.ts', 'src/b.ts', 'src/a.ts'],
    );
    const addedExport = reachableExport('src/index.ts', 'publicValue', 'src/origin.ts');

    const result = compareReviewSnapshots(
      reviewSnapshot('baseline', { edges: sharedEdges, cycles: [removedCycle] }),
      reviewSnapshot('target', {
        edges: [...sharedEdges, addedEdge],
        reachableExports: [addedExport],
      }),
      [],
      compareOptions(),
    );

    expect(result.graphEvidence.nodePaths).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/core.ts',
      'src/index.ts',
      'src/new.ts',
      'src/origin.ts',
    ]);
    expect(result.graphEvidence.edges).toEqual([
      { fromPath: 'src/a.ts', toPath: 'src/b.ts', edgeType: 'require', side: 'baseline' },
      { fromPath: 'src/b.ts', toPath: 'src/a.ts', edgeType: 'dynamic-import', side: 'baseline' },
      { fromPath: 'src/index.ts', toPath: 'src/origin.ts', edgeType: 're-export', side: 'target' },
      { fromPath: 'src/new.ts', toPath: 'src/core.ts', edgeType: 'import', side: 'target' },
    ].sort((left, right) => compareCodePoints(graphEdgeKey(left), graphEdgeKey(right))));
  });

  it('fills possible impact, candidate tests, counts, depth, and explanation graph evidence', () => {
    const appEdge = edge('src/app.ts', 'src/gone.ts', false, { edgeType: 'require' });
    const testEdge = edge('src/gone.test.ts', 'src/gone.ts', false, { edgeType: 'dynamic-import' });
    const result = compareReviewSnapshots(
      reviewSnapshot('baseline', { edges: [testEdge, appEdge] }),
      reviewSnapshot('target'),
      [change('src/gone.ts', { changeType: 'deleted' })],
      compareOptions({ maxDepth: 3 }),
    );
    const appImpact = result.affectedFiles.find((item) => item.destinationPath === 'src/app.ts');

    expect(result.traversalDepth).toBe(3);
    expect(appImpact).toMatchObject({
      depth: 1,
      direct: true,
      baselinePresent: true,
      targetPresent: false,
      explanations: [{
        side: 'baseline',
        originPath: 'src/gone.ts',
        path: ['src/gone.ts', 'src/app.ts'],
        edgeTypes: ['require'],
      }],
    });
    expect(result.candidateTests.map((item) => item.destinationPath)).toEqual(['src/gone.test.ts']);
    expect(result.noKnownTests).toEqual([]);
    expect(result.counts['affected-files']).toEqual({
      totalCount: 2,
      retainedCount: 2,
      truncated: false,
      truncatedAtDepth: false,
    });
    expect(result.counts['candidate-tests']).toEqual({
      totalCount: 1,
      retainedCount: 1,
      truncated: false,
      truncatedAtDepth: false,
    });
    expect(result.counts['no-known-tests']).toEqual({
      totalCount: 0,
      retainedCount: 0,
      truncated: false,
      truncatedAtDepth: false,
    });
    expect(result.graphEvidence.edges).toContainEqual({
      fromPath: 'src/app.ts',
      toPath: 'src/gone.ts',
      edgeType: 'require',
      side: 'baseline',
    });
  });

  it.each([
    ['base commit', { baseCommit: 'c'.repeat(40) }],
    ['base tree', { baseTreeId: 'd'.repeat(40) }],
    ['user configuration', { userConfigurationFingerprint: 'different-user-configuration' }],
    ['effective baseline', { effectiveBaselineFingerprint: 'different-effective-baseline' }],
  ] as const)('rejects snapshots with incompatible %s identity', (_label, targetOverrides) => {
    expect(() => compareReviewSnapshots(
      reviewSnapshot('baseline'),
      reviewSnapshot('target', targetOverrides),
      [],
      compareOptions(),
    )).toThrowError(/not comparable/i);
  });

  it('throws a typed cancellation error at a five-hundred-record checkpoint', () => {
    let reads = 0;
    const signal = {
      get cancelled(): boolean {
        reads += 1;
        return reads >= 5;
      },
    };
    const target = reviewSnapshot('target', {
      edges: Array.from({ length: 1_001 }, (_, index) => edge(`src/${index}.ts`, 'src/core.ts')),
    });

    let thrown: unknown;
    try {
      compareReviewSnapshots(
        reviewSnapshot('baseline'),
        target,
        [],
        compareOptions({ signal }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ReviewComparisonCancelledError);
    expect(thrown).toMatchObject({ code: 'REVIEW_CANCELLED' });
    expect(reads).toBe(5);
  });

  it('produces byte-identical results for reversed set-like input order without mutation', () => {
    const baseline = reviewSnapshot('baseline', {
      edges: [
        edge('src/z.ts', 'src/a.ts', false, { sourceLines: [9, 1], specifiers: ['./z', './a'] }),
        edge('src/removed.ts', 'src/core.ts'),
      ],
      findings: [finding('resolved', { relatedNodeIds: ['file:z.ts', 'file:a.ts'] })],
      architectureViolations: [violation(2, 'src/z.ts', 'src/a.ts')],
      cycles: [cycle(['src/z.ts', 'src/a.ts'], ['src/a.ts', 'src/z.ts', 'src/a.ts'])],
      reachableExports: [reachableExport('src/index.ts', 'removed', 'src/removed.ts')],
      limitations: [limitation('review', 'SHARED', ['src/z.ts', 'src/a.ts'])],
    });
    const target = reviewSnapshot('target', {
      edges: [
        edge('src/z.ts', 'src/a.ts', false, { sourceLines: [1, 9], specifiers: ['./a', './z'] }),
        edge('src/added.ts', 'src/core.ts'),
      ],
      findings: [finding('introduced', { relatedNodeIds: ['file:z.ts', 'file:a.ts'] })],
      architectureViolations: [violation(3, 'src/a.ts', 'src/z.ts')],
      cycles: [cycle(['src/a.ts', 'src/m.ts'], ['src/a.ts', 'src/m.ts', 'src/a.ts'])],
      reachableExports: [reachableExport('src/index.ts', 'added', 'src/added.ts')],
      limitations: [limitation('review', 'SHARED', ['src/a.ts', 'src/z.ts'])],
    });
    const changes = [change('src/z.ts'), change('src/a.ts')];
    const before = canonicalStringify({ baseline, target, changes });

    const forward = compareReviewSnapshots(baseline, target, changes, compareOptions());
    const reversed = compareReviewSnapshots(
      reverseSnapshotArrays(baseline),
      reverseSnapshotArrays(target),
      [...changes].reverse(),
      compareOptions(),
    );

    expect(canonicalStringify(reversed)).toBe(canonicalStringify(forward));
    expect(canonicalStringify({ baseline, target, changes })).toBe(before);
  });

  it('sorts before retaining a stable prefix of two thousand out of 2,005 edges', () => {
    const targetEdges = Array.from({ length: 2_005 }, (_, index) => (
      edge(`src/z${2_004 - index}.ts`, 'src/core.ts')
    ));
    const target = reviewSnapshot('target', { edges: targetEdges });

    const result = compareReviewSnapshots(
      reviewSnapshot('baseline'),
      target,
      [],
      compareOptions(),
    );
    const expectedPrefix = targetEdges
      .map(stableEdgeKey)
      .sort(compareCodePoints)
      .slice(0, 2_000);

    expect(result.counts.edges).toEqual({
      totalCount: 2_005,
      retainedCount: 2_000,
      truncated: true,
      truncatedAtDepth: false,
    });
    expect(result.edgeChanges).toHaveLength(2_000);
    expect(result.edgeChanges.map((item) => item.stableKey)).toEqual(expectedPrefix);
  });
});
