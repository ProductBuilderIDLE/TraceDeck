import type { GraphIndex } from './graphIndex';
import { traverse } from './blastRadius';
import { detectCycles } from './cycles';
import { isTestFile } from '../discovery';
import { fileNodeId, parseNodeId } from '@shared/nodeIds';

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
  const changed = [...new Set(input.changedPaths.map((path) => path.replaceAll('\\', '/')))];
  const affected = new Set<string>();
  let truncated = false;

  for (const path of changed) {
    const nodeId = fileNodeId(path);
    if (!input.index.has(nodeId)) {
      affected.add(path);
      continue;
    }
    const walk = traverse(input.index, nodeId, { maxDepth: 25, direction: 'dependents' });
    if (walk.truncated) truncated = true;
    for (const entry of walk.entries) {
      const parsed = parseNodeId(entry.nodeId);
      if (parsed) affected.add(parsed.path);
      if (affected.size >= maxNodes) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  const entrySet = new Set(input.entryPoints);
  const entryPoints = [...affected].filter((path) => entrySet.has(path)).sort();
  const testPaths = [...affected].filter((path) => isTestFile(path)).sort();

  const cycles = detectCycles(input.index);
  const affectedNodes = new Set([...affected].map((path) => fileNodeId(path)));
  const cyclesTouched = cycles
    .filter((cycle) => cycle.nodes.some((nodeId) => affectedNodes.has(nodeId)))
    .map((cycle) => cycle.path.map((nodeId) => nodeId.replace(/^file:/, '')))
    .slice(0, 50);

  return {
    changedPaths: changed.sort(),
    affectedPaths: [...affected].sort(),
    testPaths,
    entryPoints,
    cyclesTouched,
    truncated,
  };
}
