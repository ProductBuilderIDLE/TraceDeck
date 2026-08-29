import type { GraphIndex } from './graphIndex';
import { detectCycles } from './cycles';
import { computeTargetReviewImpact } from './reviewImpact';
import { fileNodeId } from '@shared/nodeIds';

export interface DiffImpactInput {
  changedPaths: readonly string[];
  index: GraphIndex;
  entryPoints: readonly string[];
  maxNodes?: number;
}

export interface ComputedDiffImpact {
  changedPaths: string[];
  affectedPaths: string[];
  testPaths: string[];
  entryPoints: string[];
  cyclesTouched: string[][];
  truncated: boolean;
}

/**
 * Unions the blast radii of every changed file. That is the "what if these diffs land"
 * answer: every file that currently depends on any of the touched paths.
 */
export function computeDiffImpact(input: DiffImpactInput): ComputedDiffImpact {
  const maxNodes = input.maxNodes ?? 2000;
  const traversal = computeTargetReviewImpact({
    index: input.index,
    changedPaths: input.changedPaths,
    maxDepth: 25,
    maxRetained: maxNodes,
  });
  const changed = [...new Set(input.changedPaths.map((path) => path.replaceAll('\\', '/')))].sort();
  const affected = traversal.affectedPaths;

  const entrySet = new Set(input.entryPoints);
  const entryPoints = affected.filter((path) => entrySet.has(path)).sort();
  const testPaths = traversal.testPaths;

  const cycles = detectCycles(input.index);
  const affectedNodes = new Set([...affected].map((path) => fileNodeId(path)));
  const cyclesTouched = cycles
    .filter((cycle) => cycle.nodes.some((nodeId) => affectedNodes.has(nodeId)))
    .map((cycle) => cycle.path.map((nodeId) => nodeId.replace(/^file:/, '')))
    .slice(0, 50);

  return {
    changedPaths: changed,
    affectedPaths: affected,
    testPaths,
    entryPoints,
    cyclesTouched,
    truncated: traversal.truncated,
  };
}
