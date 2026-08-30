import { isTestFile } from '../discovery';
import { DEPENDENCY_EDGE_TYPES, type GraphIndex } from './graphIndex';
import type { AdjacencyEdge } from '../../db/repositories/edgeRepository';
import { canonicalSha256, compareCodePoints } from '../../services/changeReview/canonical';
import { MAX_REVIEW_DETAIL_ITEMS } from '@shared/constants';
import type {
  ReviewGitChange,
  ReviewGraphEvidence,
  ReviewImpactExplanation,
  ReviewImpactItem,
  ReviewNoKnownTest,
} from '@shared/changeReview';
import { fileNodeId, parseNodeId } from '@shared/nodeIds';

export interface ReviewImpactOptions {
  baselineIndex: GraphIndex;
  targetIndex: GraphIndex;
  changes: readonly ReviewGitChange[];
  maxDepth: number;
  maxRetained: number;
  signal?: { cancelled: boolean };
}

export interface ReviewImpactResult {
  affectedFiles: ReviewImpactItem[];
  candidateTests: ReviewImpactItem[];
  noKnownTests: ReviewNoKnownTest[];
  totalAffected: number;
  totalCandidateTests: number;
  totalNoKnownTests: number;
  truncatedAffected: boolean;
  truncatedCandidateTests: boolean;
  truncatedNoKnownTests: boolean;
  truncatedAtDepth: boolean;
  graphEvidence: ReviewGraphEvidence;
}

export interface TargetReviewImpactOptions {
  index: GraphIndex;
  changedPaths: readonly string[];
  maxDepth: number;
  maxRetained: number;
  signal?: { cancelled: boolean };
}

export interface TargetReviewImpactResult {
  affectedPaths: string[];
  testPaths: string[];
  truncated: boolean;
}

export class ReviewImpactCancelledError extends Error {
  readonly code = 'REVIEW_CANCELLED';

  constructor() {
    super('Change review impact computation was cancelled.');
    this.name = 'ReviewImpactCancelledError';
  }
}

type ReviewSide = ReviewImpactExplanation['side'];
type CancellationCheckpoint = () => void;

interface SideSeed {
  nodeId: string;
  originPath: string;
}

interface SideVisit {
  nodeId: string;
  destinationPath: string;
  explanation: ReviewImpactExplanation;
}

interface SideTraversalResult {
  reachedByPath: Map<string, SideVisit>;
  truncatedAtDepth: boolean;
}

interface ChangeSeeds {
  baseline: string[];
  target: string[];
  excludedPaths: Set<string>;
}

interface LogicalChange {
  changedPath: string;
  originPaths: Set<string>;
}

const DEPENDENCY_EDGE_TYPE_SET = new Set(DEPENDENCY_EDGE_TYPES);

function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const order = compareCodePoints(left[index] as string, right[index] as string);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

function compareExplanations(
  left: ReviewImpactExplanation,
  right: ReviewImpactExplanation,
): number {
  return (left.path.length - right.path.length)
    || (left.side === right.side ? 0 : left.side === 'baseline' ? -1 : 1)
    || compareCodePoints(left.originPath, right.originPath)
    || compareStringArrays(left.path, right.path)
    || compareStringArrays(left.edgeTypes, right.edgeTypes);
}

function compareSideVisits(left: SideVisit, right: SideVisit): number {
  return (left.explanation.path.length - right.explanation.path.length)
    || compareCodePoints(left.explanation.originPath, right.explanation.originPath)
    || compareStringArrays(left.explanation.path, right.explanation.path)
    || compareStringArrays(left.explanation.edgeTypes, right.explanation.edgeTypes)
    || compareCodePoints(left.nodeId, right.nodeId);
}

function edgeOrderKey(edge: AdjacencyEdge): string {
  return [edge.from, edge.to, edge.edgeType].join('\0');
}

function relevantIncomingEdges(index: GraphIndex, nodeId: string): AdjacencyEdge[] {
  return index.edgesTo(nodeId)
    .filter((edge) => !edge.unresolved && DEPENDENCY_EDGE_TYPE_SET.has(edge.edgeType))
    .sort((left, right) => compareCodePoints(edgeOrderKey(left), edgeOrderKey(right)));
}

function filePathForNode(nodeId: string): string | null {
  const parsed = parseNodeId(nodeId);
  if (parsed === null) return normalizedPath(nodeId);
  return parsed.type === 'file' ? normalizedPath(parsed.path) : null;
}

function validatedMaxDepth(maxDepth: number): number {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new RangeError('Review impact maxDepth must be a non-negative safe integer.');
  }
  return maxDepth;
}

function retainedLimit(maxRetained: number): number {
  if (!Number.isSafeInteger(maxRetained) || maxRetained < 0) {
    throw new RangeError('Review impact maxRetained must be a non-negative safe integer.');
  }
  return Math.min(maxRetained, MAX_REVIEW_DETAIL_ITEMS);
}

function checkpointFor(signal: ReviewImpactOptions['signal']): CancellationCheckpoint {
  return (): void => {
    if (signal?.cancelled) throw new ReviewImpactCancelledError();
  };
}

function collectChangeSeeds(changes: readonly ReviewGitChange[]): ChangeSeeds {
  const baseline = new Set<string>();
  const target = new Set<string>();

  for (const change of changes) {
    const path = normalizedPath(change.relativePath);
    if (change.untracked || change.copiedFrom !== null || change.changeType === 'added') {
      target.add(path);
      continue;
    }

    if (change.changeType === 'deleted') {
      baseline.add(path);
    } else if (change.changeType === 'modified') {
      baseline.add(path);
      target.add(path);
    } else {
      if (change.oldPath !== null) baseline.add(normalizedPath(change.oldPath));
      target.add(path);
    }
  }

  const orderedBaseline = [...baseline].sort(compareCodePoints);
  const orderedTarget = [...target].sort(compareCodePoints);
  return {
    baseline: orderedBaseline,
    target: orderedTarget,
    excludedPaths: new Set([...orderedBaseline, ...orderedTarget]),
  };
}

function collectLogicalChanges(changes: readonly ReviewGitChange[]): LogicalChange[] {
  const byChangedPath = new Map<string, LogicalChange>();

  for (const change of changes) {
    const changedPath = normalizedPath(change.relativePath);
    let logical = byChangedPath.get(changedPath);
    if (logical === undefined) {
      logical = { changedPath, originPaths: new Set<string>() };
      byChangedPath.set(changedPath, logical);
    }
    logical.originPaths.add(changedPath);
    if (change.changeType === 'renamed' && change.oldPath !== null) {
      logical.originPaths.add(normalizedPath(change.oldPath));
    }
  }

  return [...byChangedPath.values()].sort((left, right) => (
    compareCodePoints(left.changedPath, right.changedPath)
  ));
}

function graphSeeds(index: GraphIndex, paths: readonly string[]): SideSeed[] {
  const byNodeId = new Map<string, SideSeed>();

  for (const originPath of paths) {
    const candidates = [fileNodeId(originPath), originPath];
    for (const nodeId of candidates) {
      if (!index.has(nodeId)) continue;
      const candidate = { nodeId, originPath };
      const existing = byNodeId.get(nodeId);
      if (existing === undefined || compareCodePoints(originPath, existing.originPath) < 0) {
        byNodeId.set(nodeId, candidate);
      }
    }
  }

  return [...byNodeId.values()].sort((left, right) => (
    compareCodePoints(left.originPath, right.originPath)
      || compareCodePoints(left.nodeId, right.nodeId)
  ));
}

function traverseSide(
  side: ReviewSide,
  index: GraphIndex,
  seedPaths: readonly string[],
  maxDepth: number,
  checkpoint: CancellationCheckpoint,
): SideTraversalResult {
  checkpoint();
  const seeds = graphSeeds(index, seedPaths);
  const visited = new Set(seeds.map((seed) => seed.nodeId));
  const reachedByPath = new Map<string, SideVisit>();
  let frontier: SideVisit[] = seeds.map((seed) => ({
    nodeId: seed.nodeId,
    destinationPath: seed.originPath,
    explanation: {
      side,
      originPath: seed.originPath,
      path: [seed.originPath],
      edgeTypes: [],
    },
  }));
  let processedEdges = 0;
  let truncatedAtDepth = false;

  const recordEdge = (): void => {
    processedEdges += 1;
    if (processedEdges % 500 === 0) checkpoint();
  };

  while (frontier.length > 0) {
    checkpoint();
    frontier.sort(compareSideVisits);
    const depth = (frontier[0]?.explanation.path.length ?? 1) - 1;

    if (depth >= maxDepth) {
      for (const visit of frontier) {
        for (const edge of relevantIncomingEdges(index, visit.nodeId)) {
          recordEdge();
          if (!visited.has(edge.from) && filePathForNode(edge.from) !== null) {
            truncatedAtDepth = true;
          }
        }
      }
      break;
    }

    const candidatesByNode = new Map<string, SideVisit>();
    for (const visit of frontier) {
      for (const edge of relevantIncomingEdges(index, visit.nodeId)) {
        recordEdge();
        if (visited.has(edge.from)) continue;
        const destinationPath = filePathForNode(edge.from);
        if (destinationPath === null) continue;
        const candidate: SideVisit = {
          nodeId: edge.from,
          destinationPath,
          explanation: {
            side,
            originPath: visit.explanation.originPath,
            path: [...visit.explanation.path, destinationPath],
            edgeTypes: [...visit.explanation.edgeTypes, edge.edgeType],
          },
        };
        const existing = candidatesByNode.get(candidate.nodeId);
        if (existing === undefined || compareSideVisits(candidate, existing) < 0) {
          candidatesByNode.set(candidate.nodeId, candidate);
        }
      }
    }

    frontier = [...candidatesByNode.values()].sort(compareSideVisits);
    for (const visit of frontier) {
      visited.add(visit.nodeId);
      const existing = reachedByPath.get(visit.destinationPath);
      if (existing === undefined || compareSideVisits(visit, existing) < 0) {
        reachedByPath.set(visit.destinationPath, visit);
      }
    }
  }

  return { reachedByPath, truncatedAtDepth };
}

function impactStableKey(
  itemType: ReviewImpactItem['itemType'],
  destinationPath: string,
): string {
  return canonicalSha256({ itemType, destinationPath });
}

function mergedImpactItems(
  baseline: SideTraversalResult,
  target: SideTraversalResult,
  excludedPaths: ReadonlySet<string>,
): ReviewImpactItem[] {
  const destinations = new Set([
    ...baseline.reachedByPath.keys(),
    ...target.reachedByPath.keys(),
  ]);
  const items: ReviewImpactItem[] = [];

  for (const destinationPath of destinations) {
    if (excludedPaths.has(destinationPath)) continue;
    const baselineVisit = baseline.reachedByPath.get(destinationPath);
    const targetVisit = target.reachedByPath.get(destinationPath);
    const explanations = [baselineVisit?.explanation, targetVisit?.explanation]
      .filter((explanation): explanation is ReviewImpactExplanation => explanation !== undefined)
      .sort(compareExplanations);
    const defaultExplanation = explanations[0];
    if (defaultExplanation === undefined) continue;
    const depth = defaultExplanation.path.length - 1;
    items.push({
      itemType: 'affected-file',
      stableKey: impactStableKey('affected-file', destinationPath),
      destinationPath,
      depth,
      direct: depth === 1,
      originPaths: [...new Set(explanations.map((explanation) => explanation.originPath))]
        .sort(compareCodePoints),
      baselinePresent: baselineVisit !== undefined,
      targetPresent: targetVisit !== undefined,
      explanations,
    });
  }

  return items.sort((left, right) => compareCodePoints(left.stableKey, right.stableKey));
}

function candidateFromAffected(item: ReviewImpactItem): ReviewImpactItem {
  return {
    ...item,
    itemType: 'candidate-test',
    stableKey: impactStableKey('candidate-test', item.destinationPath),
    originPaths: [...item.originPaths],
    explanations: item.explanations.map((explanation) => ({
      ...explanation,
      path: [...explanation.path],
      edgeTypes: [...explanation.edgeTypes],
    })),
  };
}

function noKnownTestItems(
  changes: readonly ReviewGitChange[],
  candidateTests: readonly ReviewImpactItem[],
): ReviewNoKnownTest[] {
  const candidateOrigins = new Set(candidateTests.flatMap((candidate) => (
    candidate.explanations.map((explanation) => explanation.originPath)
  )));

  return collectLogicalChanges(changes)
    .filter((change) => ![...change.originPaths].some((origin) => candidateOrigins.has(origin)))
    .map(({ changedPath }) => ({
      itemType: 'no-known-test' as const,
      stableKey: canonicalSha256({ changedPath }),
      changedPath,
    }))
    .sort((left, right) => compareCodePoints(left.stableKey, right.stableKey));
}

function graphEdgeKey(edge: ReviewGraphEvidence['edges'][number]): string {
  return [edge.fromPath, edge.toPath, edge.edgeType, edge.side].join('\0');
}

function impactGraphEvidence(
  affectedFiles: readonly ReviewImpactItem[],
  candidateTests: readonly ReviewImpactItem[],
): ReviewGraphEvidence {
  const nodePaths = new Set<string>();
  const edgesByKey = new Map<string, ReviewGraphEvidence['edges'][number]>();

  for (const item of [...affectedFiles, ...candidateTests]) {
    for (const explanation of item.explanations) {
      for (const path of explanation.path) nodePaths.add(path);
      for (let index = 0; index < explanation.edgeTypes.length; index += 1) {
        const toPath = explanation.path[index];
        const fromPath = explanation.path[index + 1];
        const edgeType = explanation.edgeTypes[index];
        if (fromPath === undefined || toPath === undefined || edgeType === undefined) continue;
        const edge = { fromPath, toPath, edgeType, side: explanation.side };
        edgesByKey.set(graphEdgeKey(edge), edge);
      }
    }
  }

  return {
    nodePaths: [...nodePaths].sort(compareCodePoints),
    edges: [...edgesByKey.values()].sort((left, right) => (
      compareCodePoints(graphEdgeKey(left), graphEdgeKey(right))
    )),
  };
}

export function computeReviewImpact(options: ReviewImpactOptions): ReviewImpactResult {
  const maxDepth = validatedMaxDepth(options.maxDepth);
  const limit = retainedLimit(options.maxRetained);
  const checkpoint = checkpointFor(options.signal);
  checkpoint();

  const seeds = collectChangeSeeds(options.changes);
  const baseline = traverseSide(
    'baseline',
    options.baselineIndex,
    seeds.baseline,
    maxDepth,
    checkpoint,
  );
  const target = traverseSide(
    'target',
    options.targetIndex,
    seeds.target,
    maxDepth,
    checkpoint,
  );
  checkpoint();

  const allAffected = mergedImpactItems(baseline, target, seeds.excludedPaths);
  const allCandidateTests = allAffected
    .filter((item) => isTestFile(item.destinationPath))
    .map(candidateFromAffected)
    .sort((left, right) => compareCodePoints(left.stableKey, right.stableKey));
  const allNoKnownTests = noKnownTestItems(options.changes, allCandidateTests);
  const affectedFiles = allAffected.slice(0, limit);
  const candidateTests = allCandidateTests.slice(0, limit);
  const noKnownTests = allNoKnownTests.slice(0, limit);

  checkpoint();
  return {
    affectedFiles,
    candidateTests,
    noKnownTests,
    totalAffected: allAffected.length,
    totalCandidateTests: allCandidateTests.length,
    totalNoKnownTests: allNoKnownTests.length,
    truncatedAffected: affectedFiles.length < allAffected.length,
    truncatedCandidateTests: candidateTests.length < allCandidateTests.length,
    truncatedNoKnownTests: noKnownTests.length < allNoKnownTests.length,
    truncatedAtDepth: baseline.truncatedAtDepth || target.truncatedAtDepth,
    graphEvidence: impactGraphEvidence(affectedFiles, candidateTests),
  };
}

/**
 * Dashboard compatibility adapter over the target-side review traversal. It preserves the legacy
 * flat-path behavior, including a changed path only when that path has no graph node.
 */
export function computeTargetReviewImpact(
  options: TargetReviewImpactOptions,
): TargetReviewImpactResult {
  const maxDepth = validatedMaxDepth(options.maxDepth);
  const limit = retainedLimit(options.maxRetained);
  const checkpoint = checkpointFor(options.signal);
  const changedPaths = [...new Set(options.changedPaths.map(normalizedPath))].sort(compareCodePoints);
  const traversal = traverseSide('target', options.index, changedPaths, maxDepth, checkpoint);
  const missingChangedPaths = changedPaths.filter((path) => (
    !options.index.has(fileNodeId(path)) && !options.index.has(path)
  ));
  const allAffected = [...new Set([
    ...missingChangedPaths,
    ...traversal.reachedByPath.keys(),
  ])].sort(compareCodePoints);
  const affectedPaths = allAffected.slice(0, limit);

  return {
    affectedPaths,
    testPaths: affectedPaths.filter((path) => isTestFile(path)),
    truncated: traversal.truncatedAtDepth || affectedPaths.length < allAffected.length,
  };
}
