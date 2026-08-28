import type {
  BlastRadiusResult,
  DashboardStats,
  EdgeType,
  FileDetail,
  GraphNode,
  GraphPayload,
  NodeType,
  Project,
  RiskScore,
  SearchResult,
  SymbolKind,
} from '@shared/types';
import { GRAPH_NODE_HARD_LIMIT, GRAPH_NODE_SOFT_LIMIT } from '@shared/constants';
import { fileNodeId, parseNodeId, symbolNodeId } from '@shared/nodeIds';
import type { BlastRadiusRequest, GraphQueryRequest, SearchRequest } from '@shared/ipc';
import type { DataStore } from '../db';
import { DEPENDENCY_EDGE_TYPES, GraphIndex } from '../analysis/algorithms/graphIndex';
import { detectCycles, nodesInCycles } from '../analysis/algorithms/cycles';
import {
  countAllDependents,
  reachableFrom,
  splitByDepth,
  traverse,
} from '../analysis/algorithms/blastRadius';
import { computeRiskScore } from '../analysis/algorithms/riskScore';
import { isTestFile } from '../analysis/discovery';
import { toPosixPath } from '../utils/glob';

/**
 * Read-side queries over a completed scan.
 *
 * Each call rebuilds an in-memory index from the stored edges. For the repository sizes this
 * app targets that is a few milliseconds and keeps every answer consistent with what is
 * actually in the database, rather than depending on cached state that a rescan could
 * invalidate underneath the UI.
 */
export class AnalysisService {
  constructor(private readonly store: DataStore) {}

  private dependencyIndex(projectId: number, includeUnresolved = false): GraphIndex {
    return new GraphIndex(this.store.edges.adjacency(projectId), {
      edgeTypes: DEPENDENCY_EDGE_TYPES,
      includeUnresolved,
    });
  }

  private entryPointNodeIds(projectId: number): string[] {
    return this.store.files
      .listByProject(projectId)
      .filter((file) => file.isEntryPoint)
      .map((file) => fileNodeId(file.relativePath));
  }

  dashboardStats(project: Project): DashboardStats {
    const projectId = project.id;
    const index = this.dependencyIndex(projectId);
    const cyclicNodes = nodesInCycles(detectCycles(index));
    const inventoryCounts = this.store.projectFiles.countsByCapability(projectId);
    const unavailableFiles =
      inventoryCounts.excluded +
      inventoryCounts.oversize +
      inventoryCounts.unreadable +
      inventoryCounts.symlink;

    const topImpactFiles = this.store.files
      .listByProject(projectId)
      .map((file) => this.riskScore(projectId, fileNodeId(file.relativePath), index, cyclicNodes))
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, 10);

    return {
      project,
      lastScan: this.store.scans.latestCompletedForProject(projectId),
      totalFiles: inventoryCounts.total,
      graphEligibleFiles: this.store.files.countByProject(projectId),
      textOnlyFiles: inventoryCounts.textOnly,
      binaryFiles: inventoryCounts.binary,
      ignoredFiles: inventoryCounts.gitIgnored,
      unavailableFiles,
      totalSymbols: this.store.symbols.countByProject(projectId),
      totalEdges: this.store.edges.countByProject(projectId),
      cycleCount: this.store.findings.countByType(projectId, 'circular-dependency'),
      unusedExportCandidateCount: this.store.findings.countByType(
        projectId,
        'unused-export-candidate',
      ),
      architectureViolationCount: this.store.findings.countByType(
        projectId,
        'architecture-violation',
      ),
      unresolvedImportCount: this.store.findings.countByType(projectId, 'unresolved-import'),
      typeErrorCount: this.store.findings.countByType(projectId, 'type-error'),
      syntaxErrorCount: this.store.findings.countByType(projectId, 'syntax-error'),
      mergeConflictCount: this.store.findings.countByType(projectId, 'merge-conflict'),
      topImpactFiles,
    };
  }

  riskScore(
    projectId: number,
    nodeId: string,
    prebuiltIndex?: GraphIndex,
    prebuiltCyclicNodes?: Set<string>,
  ): RiskScore {
    const index = prebuiltIndex ?? this.dependencyIndex(projectId);
    const cyclicNodes = prebuiltCyclicNodes ?? nodesInCycles(detectCycles(index));
    const entryPoints = this.entryPointNodeIds(projectId);
    const reachable = reachableFrom(index, entryPoints);

    const unresolvedEdgeCount = this.store.edges
      .listFrom(projectId, nodeId)
      .filter((edge) => edge.metadata.unresolved === true).length;

    const hasTestDependents = index
      .dependentsOf(nodeId)
      .some((dependent) => isTestFile(parseNodeId(dependent)?.path ?? ''));

    return computeRiskScore({
      nodeId,
      index,
      inCycle: cyclicNodes.has(nodeId),
      reachableFromEntryPoint: reachable.has(nodeId),
      unresolvedEdgeCount,
      hasTestDependents,
    });
  }

  blastRadius(request: BlastRadiusRequest): BlastRadiusResult {
    const { projectId, nodeId, maxDepth } = request;
    const edgeTypes = (request.edgeTypes ?? [
      ...DEPENDENCY_EDGE_TYPES,
      'reference',
    ]) as EdgeType[];

    const index = new GraphIndex(this.store.edges.adjacency(projectId), {
      edgeTypes,
      includeUnresolved: request.includeUnresolved ?? false,
    });

    const dependents = traverse(index, nodeId, { maxDepth, direction: 'dependents' });
    const dependencies = traverse(index, nodeId, { maxDepth, direction: 'dependencies' });

    const warnings: string[] = [];
    const unresolvedFromNode = this.store.edges
      .listFrom(projectId, nodeId)
      .filter((edge) => edge.metadata.unresolved === true);

    if (unresolvedFromNode.length > 0) {
      warnings.push(
        `${unresolvedFromNode.length} import(s) from this file could not be resolved, so its ` +
          'dependencies may be incomplete.',
      );
    }

    const dynamicEdges = this.store.edges
      .listTo(projectId, nodeId)
      .filter((edge) => edge.edgeType === 'dynamic-import');
    if (dynamicEdges.length > 0) {
      warnings.push(
        `${dynamicEdges.length} dependent(s) reach this file through a dynamic import, which ` +
          'may not run on every code path.',
      );
    }

    const parsed = parseNodeId(nodeId);
    const dependentSplit = splitByDepth(dependents.entries);
    const dependencySplit = splitByDepth(dependencies.entries);

    return {
      rootNodeId: nodeId,
      rootPath: parsed
        ? parsed.symbolName
          ? `${parsed.path}#${parsed.symbolName}`
          : parsed.path
        : nodeId,
      maxDepth,
      directDependents: dependentSplit.direct,
      transitiveDependents: dependentSplit.transitive,
      directDependencies: dependencySplit.direct,
      transitiveDependencies: dependencySplit.transitive,
      partialResultWarnings: warnings,
      truncatedAtDepth: dependents.truncated || dependencies.truncated,
    };
  }

  graph(request: GraphQueryRequest): GraphPayload {
    const { projectId } = request;
    const nodeLimit = Math.min(request.nodeLimit ?? GRAPH_NODE_SOFT_LIMIT, GRAPH_NODE_HARD_LIMIT);
    const includeUnresolved = request.includeUnresolved ?? false;
    const edgeTypes = request.edgeTypes ?? DEPENDENCY_EDGE_TYPES;
    const nodeTypes = new Set<NodeType>(request.nodeTypes ?? ['file']);

    const index = new GraphIndex(this.store.edges.adjacency(projectId), {
      edgeTypes: edgeTypes as EdgeType[],
      includeUnresolved,
    });
    const cyclicNodes = nodesInCycles(detectCycles(index));

    const files = this.store.files.listByProject(projectId);
    const entryPoints = new Set(
      files.filter((file) => file.isEntryPoint).map((file) => fileNodeId(file.relativePath)),
    );

    // Start from every file node, then narrow by folder and focus before applying the limit.
    let candidateIds = new Set<string>(files.map((file) => fileNodeId(file.relativePath)));

    if (request.folderPrefix) {
      const prefix = toPosixPath(request.folderPrefix).replace(/\/$/, '');
      candidateIds = new Set(
        [...candidateIds].filter((id) => {
          const path = parseNodeId(id)?.path ?? '';
          return path === prefix || path.startsWith(`${prefix}/`);
        }),
      );
    }

    if (request.focusNodeId) {
      const depth = request.focusDepth ?? 2;
      const focused = new Set<string>([request.focusNodeId]);

      for (const direction of ['dependents', 'dependencies'] as const) {
        const { entries } = traverse(index, request.focusNodeId, { maxDepth: depth, direction });
        for (const entry of entries) focused.add(entry.nodeId);
      }

      candidateIds = new Set([...candidateIds].filter((id) => focused.has(id)));
      // The focus node itself must be present even if a folder filter excluded it.
      candidateIds.add(request.focusNodeId);
    }

    if (includeUnresolved) {
      for (const id of index.nodeIds) {
        if (!id.startsWith('file:')) continue;
        if (candidateIds.has(id)) continue;
        const path = parseNodeId(id)?.path ?? '';
        if (!files.some((file) => file.relativePath === path)) candidateIds.add(id);
      }
    }

    const totalNodeCount = candidateIds.size;

    // When over the limit, keep the most-connected nodes: a truncated graph is far more
    // useful showing hubs than an arbitrary alphabetical slice.
    let visibleIds = [...candidateIds];
    const truncated = visibleIds.length > nodeLimit;
    if (truncated) {
      visibleIds = visibleIds
        .map((id) => ({
          id,
          degree: index.edgesFrom(id).length + index.edgesTo(id).length,
        }))
        .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
        .slice(0, nodeLimit)
        .map((entry) => entry.id);
    }

    const visible = new Set(visibleIds);
    const nodes: GraphNode[] = [];
    const knownPaths = new Set(files.map((file) => file.relativePath));

    for (const id of visibleIds) {
      const parsed = parseNodeId(id);
      const path = parsed?.path ?? id;
      const label = path.split('/').pop() ?? path;

      nodes.push({
        id,
        type: 'file',
        label,
        path,
        isEntryPoint: entryPoints.has(id),
        inCycle: cyclicNodes.has(id),
        ...(knownPaths.has(path) ? {} : { symbolKind: 'unknown' as SymbolKind }),
      });
    }

    if (nodeTypes.has('symbol')) {
      for (const file of files) {
        const parentId = fileNodeId(file.relativePath);
        if (!visible.has(parentId)) continue;

        for (const symbol of this.store.symbols.listByFile(file.id)) {
          if (!symbol.isExported) continue;
          if (nodes.length >= GRAPH_NODE_HARD_LIMIT) break;

          const id = symbolNodeId(file.relativePath, symbol.name);
          visible.add(id);
          nodes.push({
            id,
            type: 'symbol',
            label: symbol.name,
            path: `${file.relativePath}#${symbol.name}`,
            symbolKind: symbol.kind,
          });
        }
      }
    }

    const edges: GraphPayload['edges'] = [];
    const seenEdges = new Set<string>();

    for (const edge of this.store.edges.listByProject(projectId)) {
      if (!edgeTypes.includes(edge.edgeType) && edge.edgeType !== 'export') continue;
      if (edge.edgeType === 'export' && !nodeTypes.has('symbol')) continue;
      if (!includeUnresolved && edge.metadata.unresolved) continue;
      if (!visible.has(edge.fromNodeId) || !visible.has(edge.toNodeId)) continue;

      const key = `${edge.fromNodeId}|${edge.toNodeId}|${edge.edgeType}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);

      edges.push({
        id: key,
        source: edge.fromNodeId,
        target: edge.toNodeId,
        edgeType: edge.edgeType,
        unresolved: edge.metadata.unresolved === true,
      });
    }

    return { nodes, edges, truncated, totalNodeCount };
  }

  search(request: SearchRequest): SearchResult[] {
    const { projectId, query } = request;
    const limit = Math.min(request.limit ?? 50, 200);
    const types = new Set<NodeType>(request.types ?? ['file', 'symbol', 'folder']);
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [];

    const results: SearchResult[] = [];
    const files = this.store.files.listByProject(projectId);

    if (types.has('file')) {
      for (const file of files) {
        if (!file.relativePath.toLowerCase().includes(needle)) continue;
        results.push({
          nodeId: fileNodeId(file.relativePath),
          type: 'file',
          label: file.relativePath.split('/').pop() ?? file.relativePath,
          path: file.relativePath,
        });
        if (results.length >= limit) return results;
      }
    }

    if (types.has('folder')) {
      const folders = new Set<string>();
      for (const file of files) {
        const parts = file.relativePath.split('/');
        parts.pop();
        let current = '';
        for (const part of parts) {
          current = current.length === 0 ? part : `${current}/${part}`;
          folders.add(current);
        }
      }
      for (const folder of [...folders].sort()) {
        if (!folder.toLowerCase().includes(needle)) continue;
        results.push({
          nodeId: `folder:${folder}`,
          type: 'folder',
          label: folder.split('/').pop() ?? folder,
          path: folder,
        });
        if (results.length >= limit) return results;
      }
    }

    if (types.has('symbol')) {
      for (const symbol of this.store.symbols.search(projectId, query, limit)) {
        results.push({
          nodeId: symbolNodeId(symbol.relativePath, symbol.name),
          type: 'symbol',
          label: symbol.name,
          path: `${symbol.relativePath}#${symbol.name}`,
          symbolKind: symbol.kind,
          isExported: symbol.isExported,
          line: symbol.startLine,
        });
        if (results.length >= limit) return results;
      }
    }

    return results;
  }

  fileDetail(projectId: number, nodeId: string): FileDetail | null {
    const parsed = parseNodeId(nodeId);
    if (!parsed) return null;

    const file = this.store.files.findByPath(projectId, parsed.path);
    if (!file) return null;

    const index = this.dependencyIndex(projectId);
    const cyclicNodes = nodesInCycles(detectCycles(index));
    const fileId = fileNodeId(file.relativePath);

    const dependents = traverse(index, fileId, { maxDepth: 1, direction: 'dependents' });
    const dependencies = traverse(index, fileId, { maxDepth: 1, direction: 'dependencies' });

    return {
      file,
      symbols: this.store.symbols.listByFile(file.id),
      directDependencies: dependencies.entries,
      directDependents: dependents.entries,
      riskScore: this.riskScore(projectId, nodeId, index, cyclicNodes),
      inCycle: cyclicNodes.has(fileId),
    };
  }

  /** Total dependents ignoring depth, used by report generation. */
  totalDependents(projectId: number, nodeId: string): number {
    return countAllDependents(this.dependencyIndex(projectId), nodeId);
  }
}
