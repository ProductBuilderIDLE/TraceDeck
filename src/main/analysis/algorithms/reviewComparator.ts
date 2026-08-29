import type { ReachableExportRecord } from './reachableExports';
import { DEPENDENCY_EDGE_TYPES, GraphIndex } from './graphIndex';
import {
  computeReviewImpact,
  ReviewImpactCancelledError,
  type ReviewImpactResult,
} from './reviewImpact';
import type {
  ChangeReviewResult,
  ReviewArchitectureChange,
  ReviewCategoryCount,
  ReviewCycleChange,
  ReviewDeltaDirection,
  ReviewEdgeChange,
  ReviewExportChange,
  ReviewFindingChange,
  ReviewFindingEvidence,
  ReviewGitChange,
  ReviewGraphEvidence,
  ReviewLimitation,
  ReviewSection,
} from '@shared/changeReview';
import { MAX_REVIEW_DETAIL_ITEMS, REVIEW_RESULT_SCHEMA_VERSION } from '@shared/constants';
import { fileNodeId } from '@shared/nodeIds';
import type {
  NormalizedArchitectureViolation,
  NormalizedCycle,
  NormalizedReviewEdge,
  ReviewSnapshot,
} from '../../services/changeReview/snapshot';
import {
  canonicalSha256,
  canonicalStringify,
  compareCodePoints,
} from '../../services/changeReview/canonical';

export interface ReviewComparatorOptions {
  maxDepth: number;
  maxRetained: number;
  signal?: { cancelled: boolean };
}

export class ReviewComparisonCancelledError extends Error {
  readonly code = 'REVIEW_CANCELLED';

  constructor() {
    super('Change review comparison was cancelled.');
    this.name = 'ReviewComparisonCancelledError';
  }
}

export class ReviewComparisonIncompatibleError extends Error {
  readonly code = 'REVIEW_INCOMPATIBLE';

  constructor() {
    super('The baseline and target review snapshots are not comparable.');
    this.name = 'ReviewComparisonIncompatibleError';
  }
}

interface StableValue<T> {
  stableKey: string;
  value: T;
}

interface StableDelta<T> {
  added: StableValue<T>[];
  removed: StableValue<T>[];
}

interface RetainedCategory<T> {
  items: T[];
  count: ReviewCategoryCount;
}

interface DirectedStableValue {
  stableKey: string;
  direction: ReviewDeltaDirection;
}

type CancellationCheckpoint = () => void;

const DIRECTION_RANK: Record<ReviewDeltaDirection, number> = {
  added: 0,
  introduced: 0,
  removed: 1,
  resolved: 1,
};

export function stableEdgeKey(edge: NormalizedReviewEdge): string {
  return canonicalSha256({
    fromPath: edge.fromPath,
    toPath: edge.toPath,
    edgeType: edge.edgeType,
    typeOnly: edge.typeOnly,
  });
}

export function stableFindingKey(finding: ReviewFindingEvidence): string {
  return canonicalSha256({
    findingType: finding.findingType,
    fingerprint: finding.fingerprint,
  });
}

export function stableArchitectureKey(violation: NormalizedArchitectureViolation): string {
  return canonicalSha256({
    ruleId: violation.ruleId,
    ruleFingerprint: violation.ruleFingerprint,
    sourcePath: violation.sourcePath,
    targetPath: violation.targetPath,
  });
}

export function stableCycleKey(cycle: NormalizedCycle): string {
  return canonicalSha256({ memberPaths: sortedUniqueStrings(cycle.memberPaths) });
}

export function stableExportKey(record: ReachableExportRecord): string {
  return canonicalSha256({
    entryPoint: record.entryPoint,
    exportedName: record.exportedName,
    symbolKind: record.symbolKind,
    originPath: record.originPath,
  });
}

function sortedUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

function normalizedEdge(edge: NormalizedReviewEdge): NormalizedReviewEdge {
  return {
    ...edge,
    sourceLines: [...new Set(edge.sourceLines)].sort((left, right) => left - right),
    specifiers: sortedUniqueStrings(edge.specifiers),
  };
}

function normalizedFinding(finding: ReviewFindingEvidence): ReviewFindingEvidence {
  return {
    ...finding,
    relatedNodeIds: sortedUniqueStrings(finding.relatedNodeIds),
  };
}

function normalizedArchitecture(
  violation: NormalizedArchitectureViolation,
): NormalizedArchitectureViolation {
  return { ...violation };
}

function normalizedCycle(cycle: NormalizedCycle): NormalizedCycle {
  return {
    memberPaths: sortedUniqueStrings(cycle.memberPaths),
    cyclePath: [...cycle.cyclePath],
  };
}

function normalizedExport(record: ReachableExportRecord): ReachableExportRecord {
  return { ...record };
}

function deterministicValue<T>(existing: T, candidate: T): T {
  return compareCodePoints(canonicalStringify(candidate), canonicalStringify(existing)) < 0
    ? candidate
    : existing;
}

function diffByStableKey<T>(
  baseline: readonly T[],
  target: readonly T[],
  keyOf: (value: T) => string,
  normalize: (value: T) => T,
  checkpoint: CancellationCheckpoint,
  include: (value: T) => boolean = () => true,
): StableDelta<T> {
  const baselineByKey = new Map<string, T>();
  const targetByKey = new Map<string, T>();
  let processed = 0;

  const collect = (values: readonly T[], destination: Map<string, T>): void => {
    for (const input of values) {
      processed += 1;
      if (processed % 500 === 0) checkpoint();
      if (!include(input)) continue;
      const value = normalize(input);
      const stableKey = keyOf(value);
      const existing = destination.get(stableKey);
      destination.set(stableKey, existing === undefined ? value : deterministicValue(existing, value));
    }
  };

  collect(baseline, baselineByKey);
  collect(target, targetByKey);

  const added: StableValue<T>[] = [];
  const removed: StableValue<T>[] = [];
  for (const [stableKey, value] of targetByKey) {
    if (!baselineByKey.has(stableKey)) added.push({ stableKey, value });
  }
  for (const [stableKey, value] of baselineByKey) {
    if (!targetByKey.has(stableKey)) removed.push({ stableKey, value });
  }
  return { added, removed };
}

function compareDirected(left: DirectedStableValue, right: DirectedStableValue): number {
  return compareCodePoints(left.stableKey, right.stableKey)
    || DIRECTION_RANK[left.direction] - DIRECTION_RANK[right.direction];
}

function retainCategory<T>(
  items: readonly T[],
  limit: number,
  compare: (left: T, right: T) => number,
): RetainedCategory<T> {
  const ordered = [...items].sort(compare);
  const retained = ordered.slice(0, limit);
  return {
    items: retained,
    count: {
      totalCount: ordered.length,
      retainedCount: retained.length,
      truncated: retained.length < ordered.length,
      truncatedAtDepth: false,
    },
  };
}

function impactCount(
  totalCount: number,
  retainedCount: number,
  truncated: boolean,
  truncatedAtDepth: boolean,
): ReviewCategoryCount {
  return { totalCount, retainedCount, truncated, truncatedAtDepth };
}

function retainedLimit(maxRetained: number): number {
  if (!Number.isSafeInteger(maxRetained) || maxRetained < 0) {
    throw new RangeError('Review comparison maxRetained must be a non-negative safe integer.');
  }
  return Math.min(maxRetained, MAX_REVIEW_DETAIL_ITEMS);
}

function snapshotGraphIndex(snapshot: ReviewSnapshot): GraphIndex {
  return new GraphIndex(snapshot.edges.map((edge) => ({
    from: fileNodeId(edge.fromPath),
    to: fileNodeId(edge.toPath),
    edgeType: edge.edgeType,
    unresolved: false,
    sourceLine: edge.sourceLines[0] ?? null,
    specifier: edge.specifiers[0] ?? null,
  })), { edgeTypes: DEPENDENCY_EDGE_TYPES });
}

function assertComparable(baseline: ReviewSnapshot, target: ReviewSnapshot): void {
  if (
    baseline.side !== 'baseline'
    || target.side !== 'target'
    || baseline.baseCommit !== target.baseCommit
    || baseline.baseTreeId !== target.baseTreeId
    || baseline.userConfigurationFingerprint !== target.userConfigurationFingerprint
    || baseline.effectiveBaselineFingerprint !== target.effectiveBaselineFingerprint
  ) {
    throw new ReviewComparisonIncompatibleError();
  }
}

function uniqueFileChanges(
  changes: readonly ReviewGitChange[],
  checkpoint: CancellationCheckpoint,
): ReviewGitChange[] {
  const byStableKey = new Map<string, ReviewGitChange>();
  let processed = 0;
  for (const input of changes) {
    processed += 1;
    if (processed % 500 === 0) checkpoint();
    const value = { ...input };
    const existing = byStableKey.get(value.stableKey);
    byStableKey.set(
      value.stableKey,
      existing === undefined ? value : deterministicValue(existing, value),
    );
  }
  return [...byStableKey.values()];
}

function limitationStableKey(limitation: ReviewLimitation): string {
  return canonicalSha256({
    scope: limitation.scope,
    code: limitation.code,
    paths: sortedUniqueStrings(limitation.paths),
  });
}

function combinedLimitations(
  baseline: readonly ReviewLimitation[],
  target: readonly ReviewLimitation[],
  checkpoint: CancellationCheckpoint,
): ReviewLimitation[] {
  const byStableKey = new Map<string, ReviewLimitation>();
  let processed = 0;
  for (const input of [...baseline, ...target]) {
    processed += 1;
    if (processed % 500 === 0) checkpoint();
    const value: ReviewLimitation = {
      ...input,
      stableKey: limitationStableKey(input),
      paths: sortedUniqueStrings(input.paths),
    };
    const existing = byStableKey.get(value.stableKey);
    if (existing === undefined) {
      byStableKey.set(value.stableKey, value);
      continue;
    }
    const selected = deterministicValue(
      { ...existing, omittedCount: 0 },
      { ...value, omittedCount: 0 },
    );
    byStableKey.set(value.stableKey, {
      ...selected,
      omittedCount: Math.max(existing.omittedCount, value.omittedCount),
    });
  }
  return [...byStableKey.values()];
}

function graphEdgeStableKey(edge: ReviewGraphEvidence['edges'][number]): string {
  return [edge.fromPath, edge.toPath, edge.edgeType, edge.side].join('\0');
}

function buildGraphEvidence(
  baseline: ReviewSnapshot,
  target: ReviewSnapshot,
  edgeChanges: readonly ReviewEdgeChange[],
  cycleChanges: readonly ReviewCycleChange[],
  exportChanges: readonly ReviewExportChange[],
  checkpoint: CancellationCheckpoint,
): ReviewGraphEvidence {
  const nodePaths = new Set<string>();
  const edgesByKey = new Map<string, ReviewGraphEvidence['edges'][number]>();
  const cyclePairs = {
    baseline: new Set<string>(),
    target: new Set<string>(),
  };
  const exportPairs = {
    baseline: new Set<string>(),
    target: new Set<string>(),
  };
  let processed = 0;
  const recordProcessed = (): void => {
    processed += 1;
    if (processed % 500 === 0) checkpoint();
  };
  const addEdge = (candidate: ReviewGraphEvidence['edges'][number]): void => {
    nodePaths.add(candidate.fromPath);
    nodePaths.add(candidate.toPath);
    edgesByKey.set(graphEdgeStableKey(candidate), candidate);
  };

  for (const change of edgeChanges) {
    recordProcessed();
    addEdge({
      fromPath: change.fromPath,
      toPath: change.toPath,
      edgeType: change.edgeType,
      side: change.direction === 'added' ? 'target' : 'baseline',
    });
  }
  for (const change of cycleChanges) {
    recordProcessed();
    const side = change.direction === 'added' ? 'target' : 'baseline';
    for (const path of change.memberPaths) nodePaths.add(path);
    for (const path of change.cyclePath) nodePaths.add(path);
    for (let index = 1; index < change.cyclePath.length; index += 1) {
      cyclePairs[side].add(`${change.cyclePath[index - 1]}\0${change.cyclePath[index]}`);
    }
  }
  for (const change of exportChanges) {
    recordProcessed();
    const side = change.direction === 'added' ? 'target' : 'baseline';
    nodePaths.add(change.entryPoint);
    nodePaths.add(change.originPath);
    exportPairs[side].add(`${change.entryPoint}\0${change.originPath}`);
  }

  const collectSupportingEdges = (
    side: 'baseline' | 'target',
    snapshotEdges: readonly NormalizedReviewEdge[],
  ): void => {
    for (const edge of snapshotEdges) {
      recordProcessed();
      const edgePair = `${edge.fromPath}\0${edge.toPath}`;
      const supportsCycle = cyclePairs[side].has(edgePair);
      const supportsExport = exportPairs[side].has(edgePair);
      if (!supportsCycle && !supportsExport) continue;
      addEdge({
        fromPath: edge.fromPath,
        toPath: edge.toPath,
        edgeType: edge.edgeType,
        side,
      });
    }
  };

  collectSupportingEdges('baseline', baseline.edges);
  collectSupportingEdges('target', target.edges);

  return {
    nodePaths: [...nodePaths].sort(compareCodePoints),
    edges: [...edgesByKey.values()].sort((left, right) => compareCodePoints(
      graphEdgeStableKey(left),
      graphEdgeStableKey(right),
    )),
  };
}

function mergeGraphEvidence(
  structural: ReviewGraphEvidence,
  impact: ReviewGraphEvidence,
  checkpoint: CancellationCheckpoint,
): ReviewGraphEvidence {
  const nodePaths = new Set([...structural.nodePaths, ...impact.nodePaths]);
  const edgesByKey = new Map<string, ReviewGraphEvidence['edges'][number]>();
  let processed = 0;

  for (const edge of [...structural.edges, ...impact.edges]) {
    processed += 1;
    if (processed % 500 === 0) checkpoint();
    edgesByKey.set(graphEdgeStableKey(edge), edge);
  }

  return {
    nodePaths: [...nodePaths].sort(compareCodePoints),
    edges: [...edgesByKey.values()].sort((left, right) => compareCodePoints(
      graphEdgeStableKey(left),
      graphEdgeStableKey(right),
    )),
  };
}

export function compareReviewSnapshots(
  baseline: ReviewSnapshot,
  target: ReviewSnapshot,
  changes: readonly ReviewGitChange[],
  options: ReviewComparatorOptions,
): ChangeReviewResult {
  const checkpoint = (): void => {
    if (options.signal?.cancelled) throw new ReviewComparisonCancelledError();
  };

  checkpoint();
  assertComparable(baseline, target);
  const limit = retainedLimit(options.maxRetained);

  checkpoint();
  const files = retainCategory(
    uniqueFileChanges(changes, checkpoint),
    limit,
    (left, right) => compareCodePoints(left.stableKey, right.stableKey),
  );

  checkpoint();
  const edgeDelta = diffByStableKey(
    baseline.edges,
    target.edges,
    stableEdgeKey,
    normalizedEdge,
    checkpoint,
  );
  const edges = retainCategory<ReviewEdgeChange>([
    ...edgeDelta.added.map(({ stableKey, value }) => ({
      itemType: 'edge' as const,
      stableKey,
      direction: 'added' as const,
      ...value,
    })),
    ...edgeDelta.removed.map(({ stableKey, value }) => ({
      itemType: 'edge' as const,
      stableKey,
      direction: 'removed' as const,
      ...value,
    })),
  ], limit, compareDirected);

  checkpoint();
  const findingDelta = diffByStableKey(
    baseline.findings,
    target.findings,
    stableFindingKey,
    normalizedFinding,
    checkpoint,
    (finding) => finding.findingType !== 'architecture-violation',
  );
  const findings = retainCategory<ReviewFindingChange>([
    ...findingDelta.added.map(({ stableKey, value }) => ({
      itemType: 'finding' as const,
      stableKey,
      direction: 'introduced' as const,
      finding: value,
    })),
    ...findingDelta.removed.map(({ stableKey, value }) => ({
      itemType: 'finding' as const,
      stableKey,
      direction: 'resolved' as const,
      finding: value,
    })),
  ], limit, compareDirected);

  checkpoint();
  const architectureDelta = diffByStableKey(
    baseline.architectureViolations,
    target.architectureViolations,
    stableArchitectureKey,
    normalizedArchitecture,
    checkpoint,
  );
  const architecture = retainCategory<ReviewArchitectureChange>([
    ...architectureDelta.added.map(({ stableKey, value }) => ({
      itemType: 'architecture-violation' as const,
      stableKey,
      direction: 'introduced' as const,
      ...value,
    })),
    ...architectureDelta.removed.map(({ stableKey, value }) => ({
      itemType: 'architecture-violation' as const,
      stableKey,
      direction: 'resolved' as const,
      ...value,
    })),
  ], limit, compareDirected);

  checkpoint();
  const cycleDelta = diffByStableKey(
    baseline.cycles,
    target.cycles,
    stableCycleKey,
    normalizedCycle,
    checkpoint,
  );
  const cycles = retainCategory<ReviewCycleChange>([
    ...cycleDelta.added.map(({ stableKey, value }) => ({
      itemType: 'cycle' as const,
      stableKey,
      direction: 'added' as const,
      memberPaths: value.memberPaths,
      cyclePath: value.cyclePath,
    })),
    ...cycleDelta.removed.map(({ stableKey, value }) => ({
      itemType: 'cycle' as const,
      stableKey,
      direction: 'removed' as const,
      memberPaths: value.memberPaths,
      cyclePath: value.cyclePath,
    })),
  ], limit, compareDirected);

  checkpoint();
  const exportDelta = diffByStableKey(
    baseline.reachableExports,
    target.reachableExports,
    stableExportKey,
    normalizedExport,
    checkpoint,
  );
  const exports = retainCategory<ReviewExportChange>([
    ...exportDelta.added.map(({ stableKey, value }) => ({
      itemType: 'reachable-export' as const,
      stableKey,
      direction: 'added' as const,
      ...value,
    })),
    ...exportDelta.removed.map(({ stableKey, value }) => ({
      itemType: 'reachable-export' as const,
      stableKey,
      direction: 'removed' as const,
      ...value,
    })),
  ], limit, compareDirected);

  checkpoint();
  const limitations = retainCategory(
    combinedLimitations(baseline.limitations, target.limitations, checkpoint),
    limit,
    (left, right) => compareCodePoints(left.stableKey, right.stableKey),
  );

  checkpoint();
  let impact: ReviewImpactResult;
  try {
    impact = computeReviewImpact({
      baselineIndex: snapshotGraphIndex(baseline),
      targetIndex: snapshotGraphIndex(target),
      changes,
      maxDepth: options.maxDepth,
      maxRetained: limit,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof ReviewImpactCancelledError) throw new ReviewComparisonCancelledError();
    throw error;
  }

  checkpoint();
  const structuralGraphEvidence = buildGraphEvidence(
    baseline,
    target,
    edges.items,
    cycles.items,
    exports.items,
    checkpoint,
  );
  const graphEvidence = mergeGraphEvidence(structuralGraphEvidence, impact.graphEvidence, checkpoint);
  checkpoint();

  const counts: Record<ReviewSection, ReviewCategoryCount> = {
    files: files.count,
    edges: edges.count,
    findings: findings.count,
    'architecture-violations': architecture.count,
    cycles: cycles.count,
    'reachable-exports': exports.count,
    'affected-files': impactCount(
      impact.totalAffected,
      impact.affectedFiles.length,
      impact.truncatedAffected,
      impact.truncatedAtDepth,
    ),
    'candidate-tests': impactCount(
      impact.totalCandidateTests,
      impact.candidateTests.length,
      impact.truncatedCandidateTests,
      impact.truncatedAtDepth,
    ),
    'no-known-tests': impactCount(
      impact.totalNoKnownTests,
      impact.noKnownTests.length,
      impact.truncatedNoKnownTests,
      impact.truncatedAtDepth,
    ),
    limitations: limitations.count,
  };

  return {
    schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
    baseCommit: baseline.baseCommit,
    baseTreeId: baseline.baseTreeId,
    workingTreeFingerprint: target.workingTreeFingerprint,
    userConfigurationFingerprint: target.userConfigurationFingerprint,
    effectiveBaselineFingerprint: target.effectiveBaselineFingerprint,
    workingTreeScanId: target.scanId,
    traversalDepth: options.maxDepth,
    fileChanges: files.items,
    edgeChanges: edges.items,
    findingChanges: findings.items,
    architectureChanges: architecture.items,
    cycleChanges: cycles.items,
    exportChanges: exports.items,
    affectedFiles: impact.affectedFiles,
    candidateTests: impact.candidateTests,
    noKnownTests: impact.noKnownTests,
    limitations: limitations.items,
    graphEvidence,
    counts,
  };
}
