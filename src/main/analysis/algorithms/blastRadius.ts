import type { BlastRadiusEntry, EdgeType, NodeType } from '@shared/types';
import { parseNodeId } from '@shared/nodeIds';
import type { GraphIndex } from './graphIndex';

export type Direction = 'dependents' | 'dependencies';

export interface TraversalOptions {
  maxDepth: number;
  direction: Direction;
}

interface Visit {
  nodeId: string;
  depth: number;
  path: string[];
  edgeTypes: EdgeType[];
}

function describe(nodeId: string): { path: string; nodeType: NodeType } {
  const parsed = parseNodeId(nodeId);
  if (!parsed) return { path: nodeId, nodeType: 'file' };
  return {
    path: parsed.symbolName ? `${parsed.path}#${parsed.symbolName}` : parsed.path,
    nodeType: parsed.type,
  };
}

/**
 * Breadth-first traversal from a node, recording the shortest chain that reaches each result.
 *
 * BFS rather than DFS is deliberate: the first time a node is reached is along a shortest
 * path, which is exactly the explanation a developer wants — the most direct reason a change
 * here can affect that file, not an arbitrary long way round.
 *
 * `dependents` walks incoming edges (what breaks if this changes); `dependencies` walks
 * outgoing edges (what this needs).
 */
export function traverse(
  index: GraphIndex,
  rootNodeId: string,
  options: TraversalOptions,
): { entries: BlastRadiusEntry[]; truncated: boolean } {
  const { maxDepth, direction } = options;
  const seen = new Set<string>([rootNodeId]);
  const entries: BlastRadiusEntry[] = [];
  let truncated = false;

  let frontier: Visit[] = [{ nodeId: rootNodeId, depth: 0, path: [rootNodeId], edgeTypes: [] }];

  while (frontier.length > 0) {
    const next: Visit[] = [];

    for (const visit of frontier) {
      if (visit.depth >= maxDepth) {
        // Something lies beyond the requested depth, so the result is knowingly partial.
        const hasMore =
          direction === 'dependents'
            ? index.edgesTo(visit.nodeId).some((edge) => !seen.has(edge.from))
            : index.edgesFrom(visit.nodeId).some((edge) => !seen.has(edge.to));
        if (hasMore) truncated = true;
        continue;
      }

      const edges =
        direction === 'dependents' ? index.edgesTo(visit.nodeId) : index.edgesFrom(visit.nodeId);

      // Sorting keeps the traversal order stable when several edges tie at the same depth.
      const sorted = [...edges].sort((a, b) =>
        direction === 'dependents' ? a.from.localeCompare(b.from) : a.to.localeCompare(b.to),
      );

      for (const edge of sorted) {
        const neighbour = direction === 'dependents' ? edge.from : edge.to;
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);

        const path = [...visit.path, neighbour];
        const edgeTypes = [...visit.edgeTypes, edge.edgeType];
        const described = describe(neighbour);

        entries.push({
          nodeId: neighbour,
          path: described.path,
          nodeType: described.nodeType,
          depth: visit.depth + 1,
          explanationPath: path.map((id) => describe(id).path),
          edgeTypes,
        });

        next.push({ nodeId: neighbour, depth: visit.depth + 1, path, edgeTypes });
      }
    }

    frontier = next;
  }

  return { entries, truncated };
}

export function splitByDepth(entries: readonly BlastRadiusEntry[]): {
  direct: BlastRadiusEntry[];
  transitive: BlastRadiusEntry[];
} {
  return {
    direct: entries.filter((entry) => entry.depth === 1),
    transitive: entries.filter((entry) => entry.depth > 1),
  };
}

/** Counts every node reachable by reverse edges, ignoring any depth limit. */
export function countAllDependents(index: GraphIndex, rootNodeId: string): number {
  const seen = new Set<string>([rootNodeId]);
  const queue = [rootNodeId];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of index.edgesTo(current)) {
      if (seen.has(edge.from)) continue;
      seen.add(edge.from);
      queue.push(edge.from);
    }
  }

  return seen.size - 1;
}

/** Node ids reachable forward from any of the given entry points. */
export function reachableFrom(index: GraphIndex, entryPointNodeIds: readonly string[]): Set<string> {
  const seen = new Set<string>(entryPointNodeIds);
  const queue = [...entryPointNodeIds];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of index.edgesFrom(current)) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }

  return seen;
}
