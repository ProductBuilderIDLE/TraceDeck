import type { EdgeType, GraphNode, GraphPayload } from '@shared/types';
import type { ReviewImpactExplanation, ReviewImpactItem, ReviewItem } from '@shared/changeReview';
import { fileNodeId, parseNodeId } from '@shared/nodeIds';

export interface ReviewNodeMeta {
  side?: 'baseline' | 'target';
  delta?: 'added' | 'removed';
}

export interface ReviewEdgeMeta {
  side?: 'baseline' | 'target';
  delta?: 'added' | 'removed';
}

export interface ReviewGraphOverlay {
  title: string;
  payload: GraphPayload;
  nodeMeta: Record<string, ReviewNodeMeta>;
  edgeMeta: Record<string, ReviewEdgeMeta>;
  evidence: ReviewItem;
  mode: '2d';
}

function mapDirection(
  direction: 'added' | 'removed' | 'introduced' | 'resolved' | string,
): 'added' | 'removed' | undefined {
  if (direction === 'added' || direction === 'introduced') return 'added';
  if (direction === 'removed' || direction === 'resolved') return 'removed';
  return undefined;
}

function nodeIdForPath(path: string): string {
  return fileNodeId(path);
}

function nodeFromNodeId(nodeId: string): GraphNode | null {
  const parsed = parseNodeId(nodeId);
  if (!parsed) return null;
  if (parsed.type === 'folder') {
    return {
      id: nodeId,
      type: 'folder',
      label: parsed.path.split('/').pop() ?? parsed.path,
      path: parsed.path,
    };
  }
  if (parsed.type === 'symbol') {
    return {
      id: nodeId,
      type: 'symbol',
      label: parsed.symbolName ?? parsed.path.split('/').pop() ?? parsed.path,
      path: `${parsed.path}#${parsed.symbolName}`,
      symbolKind: 'unknown',
    };
  }
  return {
    id: nodeId,
    type: 'file',
    label: parsed.path.split('/').pop() ?? parsed.path,
    path: parsed.path,
    isEntryPoint: false,
    inCycle: false,
  };
}

function addNode(
  byId: Map<string, GraphNode>,
  nodeMeta: Record<string, ReviewNodeMeta>,
  node: GraphNode,
  meta: ReviewNodeMeta = {},
): void {
  const existing = byId.get(node.id);
  if (existing) {
    const existingMeta = nodeMeta[node.id] ?? {};
    nodeMeta[node.id] = {
      side: meta.side ?? existingMeta.side,
      delta: meta.delta ?? existingMeta.delta,
    };
    return;
  }
  byId.set(node.id, node);
  nodeMeta[node.id] = meta;
}

function addFileNode(
  byId: Map<string, GraphNode>,
  nodeMeta: Record<string, ReviewNodeMeta>,
  path: string,
  meta: ReviewNodeMeta = {},
): void {
  addNode(
    byId,
    nodeMeta,
    {
      id: nodeIdForPath(path),
      type: 'file',
      label: path.split('/').pop() ?? path,
      path,
      isEntryPoint: false,
      inCycle: false,
    },
    meta,
  );
}

function edgeId(source: string, target: string, edgeType: EdgeType): string {
  return `${source}|${target}|${edgeType}`;
}

function addEdge(
  edges: GraphPayload['edges'],
  edgeMeta: Record<string, ReviewEdgeMeta>,
  source: string,
  target: string,
  edgeType: EdgeType,
  meta: ReviewEdgeMeta = {},
): void {
  const id = edgeId(source, target, edgeType);
  if (edges.some((edge) => edge.id === id)) return;
  edges.push({
    id,
    source,
    target,
    edgeType,
    unresolved: false,
    typeOnly: false,
  });
  edgeMeta[id] = meta;
}

function addNodesForExplanations(
  byId: Map<string, GraphNode>,
  nodeMeta: Record<string, ReviewNodeMeta>,
  edges: GraphPayload['edges'],
  edgeMeta: Record<string, ReviewEdgeMeta>,
  explanations: readonly ReviewImpactExplanation[],
): void {
  for (const explanation of explanations) {
    for (let index = 0; index < explanation.path.length; index++) {
      const path = explanation.path[index] as string;
      addFileNode(byId, nodeMeta, path, { side: explanation.side });
      if (index < explanation.path.length - 1) {
        const nextPath = explanation.path[index + 1] as string;
        const edgeType = explanation.edgeTypes[index] ?? 'import';
        addEdge(
          edges,
          edgeMeta,
          nodeIdForPath(path),
          nodeIdForPath(nextPath),
          edgeType,
          { side: explanation.side },
        );
      }
    }
  }
}

function impactTitle(item: ReviewImpactItem, sides: Set<string>): string {
  const explanations = item.explanations;
  if (explanations.length === 0) {
    return `${item.itemType === 'candidate-test' ? 'Candidate test' : 'Affected file'}: ${item.destinationPath}`;
  }
  const last = explanations[explanations.length - 1] as ReviewImpactExplanation;
  const origin = last.originPath;
  const destination = last.path[last.path.length - 1] ?? origin;
  const sideList = [...sides].sort().join(' · ');
  const head = sides.has('baseline') ? ' · HEAD' : '';
  return `Impact path from ${origin} to ${destination} (${sideList}${head})`;
}

function collectImpactSides(item: ReviewImpactItem): Set<string> {
  const sides = new Set<string>();
  for (const explanation of item.explanations) {
    sides.add(explanation.side);
  }
  return sides;
}

export function reviewItemToGraphOverlay(item: ReviewItem): ReviewGraphOverlay {
  const byId = new Map<string, GraphNode>();
  const edges: GraphPayload['edges'] = [];
  const nodeMeta: Record<string, ReviewNodeMeta> = {};
  const edgeMeta: Record<string, ReviewEdgeMeta> = {};

  switch (item.itemType) {
    case 'file': {
      const meta: ReviewNodeMeta = {
        delta: item.changeType === 'added' ? 'added' : item.changeType === 'deleted' ? 'removed' : undefined,
      };
      addFileNode(byId, nodeMeta, item.relativePath, meta);
      break;
    }
    case 'edge': {
      const delta = mapDirection(item.direction);
      const source = nodeIdForPath(item.fromPath);
      const target = nodeIdForPath(item.toPath);
      addFileNode(byId, nodeMeta, item.fromPath, { delta });
      addFileNode(byId, nodeMeta, item.toPath, { delta });
      addEdge(edges, edgeMeta, source, target, item.edgeType, { delta });
      break;
    }
    case 'finding': {
      const delta = mapDirection(item.direction);
      for (const nodeId of item.finding.relatedNodeIds) {
        const node = nodeFromNodeId(nodeId);
        if (node) addNode(byId, nodeMeta, node, { delta });
      }
      break;
    }
    case 'architecture-violation': {
      const delta = mapDirection(item.direction);
      const source = nodeIdForPath(item.sourcePath);
      const target = nodeIdForPath(item.targetPath);
      addFileNode(byId, nodeMeta, item.sourcePath, { delta });
      addFileNode(byId, nodeMeta, item.targetPath, { delta });
      addEdge(edges, edgeMeta, source, target, 'import', { delta });
      break;
    }
    case 'cycle': {
      const delta = mapDirection(item.direction);
      const seen = new Set<string>();
      for (const path of item.cyclePath) {
        if (seen.has(path)) continue;
        seen.add(path);
        addFileNode(byId, nodeMeta, path, { delta });
      }
      for (let index = 0; index < item.cyclePath.length; index++) {
        const from = item.cyclePath[index] as string;
        const to = item.cyclePath[index + 1] ?? item.cyclePath[0];
        if (from === to) continue;
        addEdge(edges, edgeMeta, nodeIdForPath(from), nodeIdForPath(to as string), 'import', { delta });
      }
      break;
    }
    case 'reachable-export': {
      const delta = mapDirection(item.direction);
      const source = nodeIdForPath(item.entryPoint);
      const target = nodeIdForPath(item.originPath);
      addFileNode(byId, nodeMeta, item.entryPoint, { delta });
      addFileNode(byId, nodeMeta, item.originPath, { delta });
      addEdge(edges, edgeMeta, source, target, 'import', { delta });
      break;
    }
    case 'affected-file':
    case 'candidate-test': {
      addNodesForExplanations(byId, nodeMeta, edges, edgeMeta, item.explanations);
      break;
    }
    case 'no-known-test': {
      addFileNode(byId, nodeMeta, item.changedPath, {});
      break;
    }
    case 'limitation': {
      for (const path of item.paths) {
        addFileNode(byId, nodeMeta, path, {});
      }
      break;
    }
    default:
      break;
  }

  const nodes = [...byId.values()].sort((left, right) => left.path.localeCompare(right.path));
  const title = overlayTitle(item, nodes);

  return {
    title,
    payload: {
      nodes,
      edges,
      truncated: false,
      totalNodeCount: nodes.length,
    },
    nodeMeta,
    edgeMeta,
    evidence: item,
    mode: '2d',
  };
}

function overlayTitle(item: ReviewItem, nodes: readonly GraphNode[]): string {
  switch (item.itemType) {
    case 'file':
      return `Changed file (${item.changeType}): ${item.relativePath}`;
    case 'edge':
      return `${capitalize(item.direction)} ${item.edgeType} edge: ${item.fromPath} \u2192 ${item.toPath}`;
    case 'finding':
      return `${capitalize(item.direction)} finding: ${item.finding.title}`;
    case 'architecture-violation':
      return `${capitalize(item.direction)} architecture violation: ${item.sourcePath} \u2192 ${item.targetPath}`;
    case 'cycle':
      return `${capitalize(item.direction)} cycle of ${nodes.length} files`;
    case 'reachable-export':
      return `${capitalize(item.direction)} reachable export ${item.exportedName} from ${item.entryPoint}`;
    case 'affected-file':
    case 'candidate-test': {
      const sides = collectImpactSides(item);
      return impactTitle(item, sides);
    }
    case 'no-known-test':
      return `No known test for: ${item.changedPath}`;
    case 'limitation':
      return `Limitation: ${item.code}`;
    default:
      return 'Review evidence';
  }
}

function capitalize(value: string): string {
  if (value.length === 0) return value;
  return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}
