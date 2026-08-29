import type {
  BlastRadiusResult,
  DashboardStats,
  DiffImpactResult,
  EdgeType,
  FileDetail,
  FileOutlier,
  GraphNode,
  GraphPayload,
  NodeType,
  Project,
  ProjectMetrics,
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
import { computeMartinMetrics } from '../analysis/algorithms/martin';
import { computeDiffImpact } from '../analysis/algorithms/diffImpact';
import { compareFingerprints } from '../analysis/algorithms/scanCompare';
import { ownersForPath } from './codeowners';
import {
  declaredDependencyNames,
  licenseInventory,
  publicApiFromManifest,
  readRootManifest,
} from './licenseInventory';

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

    const ranked = this.withPercentiles(
      this.store.files
        .listByProject(projectId)
        .map((file) => this.riskScore(projectId, fileNodeId(file.relativePath), index, cyclicNodes)),
    );
    const topImpactFiles = [...ranked]
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, 10);

    let comparison: DashboardStats['scanComparison'] = null;
    try {
      const snapshots = this.store.snapshots.latestTwo(projectId);
      const currentSnap = snapshots[0];
      const previousSnap = snapshots[1];
      if (currentSnap) {
        const diff = compareFingerprints(
          Array.isArray(previousSnap?.fingerprints) ? previousSnap.fingerprints : [],
          Array.isArray(currentSnap.fingerprints) ? currentSnap.fingerprints : [],
        );
        comparison = {
          previousScanId: previousSnap?.scanId ?? null,
          added: diff.added.length,
          removed: diff.removed.length,
          persisted: diff.persisted,
          addedTitles: diff.added.slice(0, 8).map((entry) => entry.title ?? ''),
          removedTitles: diff.removed.slice(0, 8).map((entry) => entry.title ?? ''),
        };
      }
    } catch {
      comparison = null;
    }

    let licenses: DashboardStats['licenses'] = [];
    let publicApi: string[] = [];
    try {
      const rootManifest = readRootManifest(project.rootPath);
      licenses = licenseInventory(project.rootPath, declaredDependencyNames(rootManifest));
      publicApi = publicApiFromManifest(rootManifest);
    } catch {
      licenses = [];
      publicApi = [];
    }

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
      todoCommentCount: this.store.findings.countByType(projectId, 'todo-comment'),
      duplicateCodeCount: this.store.findings.countByType(projectId, 'duplicate-code'),
      complexityHotspotCount: this.store.findings.countByType(projectId, 'complexity-hotspot'),
      topImpactFiles,
      licenses,
      publicApi,
      scanComparison: comparison,
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

    return {
      ...computeRiskScore({
        nodeId,
        index,
        inCycle: cyclicNodes.has(nodeId),
        reachableFromEntryPoint: reachable.has(nodeId),
        unresolvedEdgeCount,
        hasTestDependents,
      }),
      percentile: 0,
    };
  }

  private withPercentiles(scores: RiskScore[]): RiskScore[] {
    if (scores.length === 0) return scores;
    const ranked = [...scores].sort((left, right) => left.score - right.score);
    const last = ranked.length - 1;
    const percentileById = new Map<string, number>();
    ranked.forEach((entry, index) => {
      percentileById.set(entry.nodeId, last === 0 ? 100 : Math.round((index / last) * 100));
    });
    return scores.map((entry) => ({
      ...entry,
      percentile: percentileById.get(entry.nodeId) ?? 0,
    }));
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
      const starts = [request.focusNodeId];
      if (edgeTypes.includes('call')) {
        const parsedFocus = parseNodeId(request.focusNodeId);
        if (parsedFocus?.type === 'file') {
          const file = files.find((entry) => entry.relativePath === parsedFocus.path);
          if (file) {
            for (const symbol of this.store.symbols.listByFile(file.id)) {
              starts.push(symbolNodeId(file.relativePath, symbol.name));
            }
          }
        }
      }

      const focused = new Set<string>(starts);
      for (const start of starts) {
        for (const direction of ['dependents', 'dependencies'] as const) {
          const { entries } = traverse(index, start, { maxDepth: depth, direction });
          for (const entry of entries) focused.add(entry.nodeId);
        }
      }

      candidateIds = new Set(
        [...candidateIds, ...starts].filter((id) => focused.has(id) || starts.includes(id)),
      );
      for (const id of focused) {
        if (id.startsWith('symbol:')) candidateIds.add(id);
      }
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
      const isSymbol = parsed?.type === 'symbol';
      const label = parsed?.symbolName ?? path.split('/').pop() ?? path;

      nodes.push({
        id,
        type: isSymbol ? 'symbol' : 'file',
        label,
        path: isSymbol && parsed?.symbolName ? `${path}#${parsed.symbolName}` : path,
        isEntryPoint: entryPoints.has(id),
        inCycle: cyclicNodes.has(id),
        ...(isSymbol
          ? { symbolKind: 'unknown' as SymbolKind }
          : knownPaths.has(path)
            ? {}
            : { symbolKind: 'unknown' as SymbolKind }),
      });
    }

    if (nodeTypes.has('symbol') || (edgeTypes.includes('call') && request.focusNodeId)) {
      for (const file of files) {
        const parentId = fileNodeId(file.relativePath);

        for (const symbol of this.store.symbols.listByFile(file.id)) {
          if (nodes.length >= GRAPH_NODE_HARD_LIMIT) break;
          const id = symbolNodeId(file.relativePath, symbol.name);
          if (visible.has(id)) continue;
          const parentVisible = visible.has(parentId);
          if (!parentVisible && !visible.has(id)) continue;
          if (!symbol.isExported && !edgeTypes.includes('call')) continue;
          if (edgeTypes.includes('call') && !nodeTypes.has('symbol')) {
            const hasCall = index.edgesFrom(id).length + index.edgesTo(id).length > 0;
            if (!hasCall) continue;
          }
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
        typeOnly: edge.metadata.isTypeOnly === true,
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
      const kinds = request.kinds ? new Set(request.kinds) : null;
      for (const symbol of this.store.symbols.search(projectId, query, limit * 4)) {
        if (request.exportedOnly && !symbol.isExported) continue;
        if (kinds && !kinds.has(symbol.kind)) continue;
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
    const allDependents = traverse(index, fileId, { maxDepth: 25, direction: 'dependents' });
    const testDependents = allDependents.entries.filter((entry) => isTestFile(entry.path));
    const entryPoints = this.entryPointNodeIds(projectId);
    const covering = allDependents.entries
      .filter((entry) => entryPoints.includes(entry.nodeId))
      .map((entry) => entry.path);
    if (entryPoints.includes(fileId)) covering.unshift(file.relativePath);

    const symbols = this.store.symbols.listByFile(file.id);
    const maxComplexity = symbols.reduce<number | null>((max, symbol) => {
      const value = symbol.metadata.complexity;
      if (value === undefined) return max;
      return max === null ? value : Math.max(max, value);
    }, null);
    const maxLcom = symbols.reduce<number | null>((max, symbol) => {
      const value = symbol.metadata.lcom;
      if (value === undefined) return max;
      return max === null ? value : Math.max(max, value);
    }, null);

    const allScores = this.withPercentiles(
      this.store.files
        .listByProject(projectId)
        .map((entry) => this.riskScore(projectId, fileNodeId(entry.relativePath), index, cyclicNodes)),
    );
    const mine = allScores.find((entry) => entry.nodeId === fileId || entry.nodeId === nodeId);

    return {
      file,
      symbols,
      directDependencies: dependencies.entries,
      directDependents: dependents.entries,
      riskScore: mine ?? this.riskScore(projectId, nodeId, index, cyclicNodes),
      inCycle: cyclicNodes.has(fileId),
      fanIn: index.edgesTo(fileId).length,
      fanOut: index.edgesFrom(fileId).length,
      testDependents,
      entryPointsCovering: [...new Set(covering)],
      owners:
        ownersForPath(
          this.store.projects.findById(projectId)?.rootPath ?? '',
          file.relativePath,
        ) ?? [],
      maxComplexity,
      maxLcom,
    };
  }

  diffImpact(projectId: number, changedPaths: readonly string[]): DiffImpactResult {
    return computeDiffImpact({
      changedPaths,
      index: this.dependencyIndex(projectId),
      entryPoints: this.store.files
        .listByProject(projectId)
        .filter((file) => file.isEntryPoint)
        .map((file) => file.relativePath),
    });
  }

  folderMetrics(projectId: number): ProjectMetrics {
    const files = this.store.files.listByProject(projectId);
    const composition = new Map<
      string,
      { folder: string; fileCount: number; abstractFileCount: number }
    >();
    const index = this.dependencyIndex(projectId);
    const outliers: FileOutlier[] = [];

    for (const file of files) {
      const parts = file.relativePath.split('/');
      const folder = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '.';
      const current = composition.get(folder) ?? { folder, fileCount: 0, abstractFileCount: 0 };
      current.fileCount += 1;
      const symbols = this.store.symbols.listByFile(file.id);
      if (symbols.some((symbol) => symbol.kind === 'interface' || symbol.kind === 'type')) {
        current.abstractFileCount += 1;
      }
      composition.set(folder, current);

      const nodeId = fileNodeId(file.relativePath);
      const inventory = this.store.projectFiles.findByPath(projectId, file.relativePath);
      outliers.push({
        relativePath: file.relativePath,
        sizeBytes: inventory?.sizeBytes ?? 0,
        symbolCount: symbols.length,
        fanIn: index.edgesTo(nodeId).length,
        fanOut: index.edgesFrom(nodeId).length,
      });
    }

    const coupling = this.store.edges
      .listByProject(projectId)
      .filter((edge) => DEPENDENCY_EDGE_TYPES.includes(edge.edgeType) && !edge.metadata.unresolved)
      .map((edge) => ({
        fromPath: parseNodeId(edge.fromNodeId)?.path ?? '',
        toPath: parseNodeId(edge.toNodeId)?.path ?? '',
      }))
      .filter((edge) => edge.fromPath.length > 0 && edge.toPath.length > 0);

    const ranked = [...outliers].sort(
      (left, right) =>
        right.sizeBytes + right.symbolCount * 80 + right.fanIn * 40 -
          (left.sizeBytes + left.symbolCount * 80 + left.fanIn * 40),
    );

    return {
      folders: computeMartinMetrics(coupling, [...composition.values()]),
      outliers: ranked.slice(0, 25),
    };
  }

  /** Total dependents ignoring depth, used by report generation. */
  totalDependents(projectId: number, nodeId: string): number {
    return countAllDependents(this.dependencyIndex(projectId), nodeId);
  }
}
