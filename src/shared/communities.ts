/**
 * Groups a dependency graph into communities: sets of files that depend on each other more
 * than they depend on the rest of the project.
 *
 * Colouring the graph by folder shows how the repository is *filed*. Colouring it by
 * community shows how it is actually *coupled*, which is the thing a dependency graph is for
 * — a folder whose files never reference each other is three communities wearing one name,
 * and two folders that constantly cross-import are one community pretending to be two.
 *
 * This is modularity optimisation (Louvain): start with every node alone, repeatedly move
 * each node into whichever neighbouring community most improves modularity, then collapse
 * each community into a single node and repeat on the smaller graph.
 *
 * Determinism is not incidental here — the product's guarantee is that the same repository
 * always produces the same output. Louvain is normally order-dependent, so nodes are visited
 * in sorted order, ties are broken toward the lowest community index, and the final
 * numbering is by community size with the lowest member id breaking ties. The same graph
 * therefore always yields the same groups with the same numbers, and a rescan does not
 * recolour a picture the reader has learned.
 */

export interface CommunityEdge {
  source: string;
  target: string;
}

export interface Community {
  id: number;
  /** Member node ids, sorted. */
  nodes: string[];
  /** Directory shared by most members, used as a human-readable name. */
  label: string;
}

export interface CommunityResult {
  communityById: Map<string, number>;
  communities: Community[];
  /** Modularity of the final partition, from -0.5 to 1. Higher means clearer separation. */
  modularity: number;
}

/** Levels of aggregation. Two passes settle almost every real graph; more just costs time. */
const MAX_LEVELS = 4;
const MIN_GAIN = 1e-9;

interface Level {
  /** Weighted adjacency, node index to neighbour index to weight. */
  adjacency: Map<number, Map<number, number>>;
  /** Self-loop weight, which is how a collapsed community carries its internal edges. */
  selfLoops: number[];
  size: number;
}

function buildLevel(size: number, edges: ReadonlyArray<readonly [number, number]>): Level {
  const adjacency = new Map<number, Map<number, number>>();
  const selfLoops = new Array<number>(size).fill(0);

  for (let index = 0; index < size; index += 1) adjacency.set(index, new Map());

  for (const [from, to] of edges) {
    if (from === to) {
      selfLoops[from] = (selfLoops[from] ?? 0) + 1;
      continue;
    }
    const forward = adjacency.get(from);
    const backward = adjacency.get(to);
    if (!forward || !backward) continue;
    forward.set(to, (forward.get(to) ?? 0) + 1);
    backward.set(from, (backward.get(from) ?? 0) + 1);
  }

  return { adjacency, selfLoops, size };
}

/** One pass of local moving; returns the community index chosen for every node. */
function localMoving(level: Level): number[] {
  const { adjacency, selfLoops, size } = level;

  const degree = new Array<number>(size).fill(0);
  let totalWeight = 0;
  for (let index = 0; index < size; index += 1) {
    let sum = (selfLoops[index] ?? 0) * 2;
    for (const weight of adjacency.get(index)?.values() ?? []) sum += weight;
    degree[index] = sum;
    totalWeight += sum;
  }

  // An edgeless graph has no structure to find; every node is its own community.
  if (totalWeight === 0) return Array.from({ length: size }, (_, index) => index);

  const twiceTotal = totalWeight;
  const community = Array.from({ length: size }, (_, index) => index);
  const communityDegree = [...degree];

  let improved = true;
  let guard = 0;
  while (improved && guard < 32) {
    improved = false;
    guard += 1;

    for (let node = 0; node < size; node += 1) {
      const own = community[node]!;
      const nodeDegree = degree[node]!;

      communityDegree[own] = (communityDegree[own] ?? 0) - nodeDegree;

      const weightToCommunity = new Map<number, number>();
      for (const [neighbour, weight] of adjacency.get(node) ?? []) {
        if (neighbour === node) continue;
        const target = community[neighbour]!;
        weightToCommunity.set(target, (weightToCommunity.get(target) ?? 0) + weight);
      }

      let best = own;
      let bestGain =
        (weightToCommunity.get(own) ?? 0) -
        ((communityDegree[own] ?? 0) * nodeDegree) / twiceTotal;

      // Sorted so that the choice among equally good moves cannot depend on Map order.
      for (const candidate of [...weightToCommunity.keys()].sort((a, b) => a - b)) {
        const gain =
          (weightToCommunity.get(candidate) ?? 0) -
          ((communityDegree[candidate] ?? 0) * nodeDegree) / twiceTotal;
        if (gain > bestGain + MIN_GAIN || (Math.abs(gain - bestGain) <= MIN_GAIN && candidate < best)) {
          best = candidate;
          bestGain = gain;
        }
      }

      communityDegree[best] = (communityDegree[best] ?? 0) + nodeDegree;
      if (best !== own) {
        community[node] = best;
        improved = true;
      }
    }
  }

  return community;
}

/** Modularity of a partition: how much more internal edge weight it holds than chance. */
function modularityOf(level: Level, community: readonly number[]): number {
  const { adjacency, selfLoops, size } = level;

  const degree = new Array<number>(size).fill(0);
  let totalWeight = 0;
  for (let index = 0; index < size; index += 1) {
    let sum = (selfLoops[index] ?? 0) * 2;
    for (const weight of adjacency.get(index)?.values() ?? []) sum += weight;
    degree[index] = sum;
    totalWeight += sum;
  }
  if (totalWeight === 0) return 0;

  const internal = new Map<number, number>();
  const total = new Map<number, number>();
  for (let node = 0; node < size; node += 1) {
    const own = community[node]!;
    total.set(own, (total.get(own) ?? 0) + (degree[node] ?? 0));
    internal.set(own, (internal.get(own) ?? 0) + (selfLoops[node] ?? 0) * 2);
    for (const [neighbour, weight] of adjacency.get(node) ?? []) {
      if (community[neighbour] === own) internal.set(own, (internal.get(own) ?? 0) + weight);
    }
  }

  let score = 0;
  for (const [id, inside] of internal) {
    const degreeSum = total.get(id) ?? 0;
    score += inside / totalWeight - (degreeSum / totalWeight) ** 2;
  }
  return score;
}

/** Names a community after the deepest directory shared by most of its files. */
function labelFor(members: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const id of members) {
    const path = id.slice(id.indexOf(':') + 1).split('#')[0] ?? '';
    const parts = path.split('/').filter((part) => part.length > 0);
    parts.pop();
    if (parts.length === 0) {
      counts.set('(root)', (counts.get('(root)') ?? 0) + 1);
      continue;
    }
    // Every prefix counts, so a shared parent wins when the leaves disagree.
    let prefix = '';
    for (const part of parts) {
      prefix = prefix.length === 0 ? part : `${prefix}/${part}`;
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }

  let best = '(root)';
  let bestScore = -1;
  for (const [prefix, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Depth breaks ties toward the more specific name, which is the more useful one.
    const depth = prefix.split('/').length;
    const score = count * 1000 + depth;
    if (score > bestScore) {
      best = prefix;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Detects communities across a set of nodes and edges.
 *
 * Edges are treated as undirected: for grouping, `a` importing `b` couples the two whichever
 * way the arrow points. Nodes with no edges each end up alone, which is the honest answer
 * rather than filing them under a neighbour they do not have.
 */
export function detectCommunities(
  nodeIds: readonly string[],
  edges: readonly CommunityEdge[],
): CommunityResult {
  const ordered = [...new Set(nodeIds)].sort();
  const indexById = new Map(ordered.map((id, index) => [id, index] as const));

  if (ordered.length === 0) {
    return { communityById: new Map(), communities: [], modularity: 0 };
  }

  const indexedEdges: Array<readonly [number, number]> = [];
  for (const edge of edges) {
    const from = indexById.get(edge.source);
    const to = indexById.get(edge.target);
    if (from === undefined || to === undefined) continue;
    indexedEdges.push([from, to] as const);
  }

  let level = buildLevel(ordered.length, indexedEdges);
  // Which top-level community each original node currently belongs to.
  let assignment = Array.from({ length: ordered.length }, (_, index) => index);
  let modularity = 0;

  for (let pass = 0; pass < MAX_LEVELS; pass += 1) {
    const moved = localMoving(level);
    modularity = modularityOf(level, moved);

    // Renumber the surviving communities to a dense range for the next level.
    const dense = new Map<number, number>();
    for (const id of moved) {
      if (!dense.has(id)) dense.set(id, dense.size);
    }
    const collapsed = moved.map((id) => dense.get(id)!);

    const settled = dense.size === level.size;
    assignment = assignment.map((id) => collapsed[id]!);
    if (settled) break;

    const nextEdges: Array<readonly [number, number]> = [];
    for (let node = 0; node < level.size; node += 1) {
      for (let count = 0; count < (level.selfLoops[node] ?? 0); count += 1) {
        nextEdges.push([collapsed[node]!, collapsed[node]!] as const);
      }
      for (const [neighbour, weight] of level.adjacency.get(node) ?? []) {
        // Each undirected edge appears in both adjacency lists; take it once.
        if (neighbour < node) continue;
        for (let count = 0; count < weight; count += 1) {
          nextEdges.push([collapsed[node]!, collapsed[neighbour]!] as const);
        }
      }
    }
    level = buildLevel(dense.size, nextEdges);
  }

  const membersByCommunity = new Map<number, string[]>();
  ordered.forEach((id, index) => {
    const community = assignment[index]!;
    const bucket = membersByCommunity.get(community);
    if (bucket) bucket.push(id);
    else membersByCommunity.set(community, [id]);
  });

  // Largest first, so the biggest group is always community 0 and keeps its colour when a
  // smaller one appears or disappears. Size ties fall back to the lowest member id.
  const ranked = [...membersByCommunity.values()].sort((left, right) => {
    if (left.length !== right.length) return right.length - left.length;
    return (left[0] ?? '').localeCompare(right[0] ?? '');
  });

  const communityById = new Map<string, number>();
  const communities: Community[] = ranked.map((members, id) => {
    const sorted = [...members].sort();
    for (const member of sorted) communityById.set(member, id);
    return { id, nodes: sorted, label: labelFor(sorted) };
  });

  return { communityById, communities, modularity };
}
