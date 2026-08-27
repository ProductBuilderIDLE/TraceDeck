import type { EdgeType } from '@shared/types';
import type { AdjacencyEdge } from '../../db/repositories/edgeRepository';

/** Edge types that represent "this file needs that file at build or run time". */
export const DEPENDENCY_EDGE_TYPES: readonly EdgeType[] = [
  'import',
  're-export',
  'dynamic-import',
  'require',
];

export interface GraphIndexOptions {
  edgeTypes?: readonly EdgeType[];
  /** When false, edges whose target could not be resolved are left out of traversal. */
  includeUnresolved?: boolean;
}

/**
 * An in-memory adjacency index over the persisted edges.
 *
 * Traversals run against this rather than issuing a query per hop: a blast-radius walk over a
 * large repository visits tens of thousands of edges, and doing that one SQL round trip at a
 * time is orders of magnitude slower than loading the edge list once.
 */
export class GraphIndex {
  private readonly outgoing = new Map<string, AdjacencyEdge[]>();
  private readonly incoming = new Map<string, AdjacencyEdge[]>();
  private readonly nodes = new Set<string>();

  constructor(edges: readonly AdjacencyEdge[], options: GraphIndexOptions = {}) {
    const allowedTypes = options.edgeTypes ? new Set(options.edgeTypes) : null;
    const includeUnresolved = options.includeUnresolved ?? false;

    for (const edge of edges) {
      if (allowedTypes && !allowedTypes.has(edge.edgeType)) continue;
      if (!includeUnresolved && edge.unresolved) continue;

      this.nodes.add(edge.from);
      this.nodes.add(edge.to);

      const out = this.outgoing.get(edge.from);
      if (out) out.push(edge);
      else this.outgoing.set(edge.from, [edge]);

      const into = this.incoming.get(edge.to);
      if (into) into.push(edge);
      else this.incoming.set(edge.to, [edge]);
    }
  }

  get nodeIds(): string[] {
    return [...this.nodes];
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  has(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  /** Edges leaving the node: what this node depends on. */
  edgesFrom(nodeId: string): readonly AdjacencyEdge[] {
    return this.outgoing.get(nodeId) ?? [];
  }

  /** Edges entering the node: what depends on this node. */
  edgesTo(nodeId: string): readonly AdjacencyEdge[] {
    return this.incoming.get(nodeId) ?? [];
  }

  dependenciesOf(nodeId: string): string[] {
    return [...new Set(this.edgesFrom(nodeId).map((edge) => edge.to))];
  }

  dependentsOf(nodeId: string): string[] {
    return [...new Set(this.edgesTo(nodeId).map((edge) => edge.from))];
  }
}
