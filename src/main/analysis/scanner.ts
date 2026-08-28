import { promises as fs } from 'node:fs';

import { ALL_FINDING_TYPES, type FindingType, type TypeCheckSummary, type Project, type Scan, type ScanProgress, type ScanSummary, type SymbolKind } from '@shared/types';
import { MAX_SOURCE_BYTES } from '@shared/constants';
import { fileNodeId } from '@shared/nodeIds';
import { DEPENDENCY_EDGE_TYPES, GraphIndex } from './algorithms/graphIndex';
import { detectCycles } from './algorithms/cycles';
import { COMPLEXITY_HOTSPOT_THRESHOLD } from './algorithms/complexity';
import { findDuplicateBlocks } from './algorithms/clones';
import { findTodoComments } from './algorithms/todos';
import { evaluateArchitectureRules, type ImportFact } from './algorithms/architectureRules';
import {
  findUnusedExportCandidates,
  packageEntryPointsFrom,
  type ExportedSymbolInput,
} from './algorithms/unusedExports';
import { buildGraph, type FileToBuild } from './graph';
import { isGitRepo, gitRecentRenames } from '../services/gitService';
import {
  discoverFiles,
  type DiscoveredFile,
  type DiscoveryExclusion,
  type DiscoveryResult,
} from './discovery';
import {
  inspectSourceContainerLimitations,
  parseSourceFile,
  sourceContainerLimitations,
  type ParsedFile,
  type ParsedImport,
  type ParsedCall,
  type SyntaxIssue,
} from './parser';
import { buildKnownFileIndex, type ResolverContext } from './resolver';
import { packageNameOf, readProjectManifests } from './packageManifest';
import { runTypeScriptDiagnostics } from './diagnostics';
import { diagnoseJson, findMergeConflicts, isJsonPath } from './textDiagnostics';
import { parseContainerMarkup, parseWithTreeSitter } from './treeSitter';
import { readLanguageRoots, rewriteLanguageImports } from './languageRoots';
import { decodeText, detectEncoding, isDecodableText } from '../services/fileClassificationService';
import { discoverProjectTsConfigs, loadProjectTsConfig } from './tsconfig';
import type { DataStore } from '../db';
import type { EdgeInsertInput } from '../db/repositories/edgeRepository';
import type { FileUpsertInput } from '../db/repositories/fileRepository';
import type { FindingInsertInput } from '../db/repositories/findingRepository';
import type { ProjectFileUpsertInput } from '../db/repositories/projectFileRepository';
import type { SymbolInsertInput } from '../db/repositories/symbolRepository';
import { fingerprint, hashContent } from '../utils/hashing';
import { toPosixPath } from '../utils/glob';

export type ProgressReporter = (progress: Omit<ScanProgress, 'scanId'>) => void;

export interface ScanOptions {
  project: Project;
  fullRescan: boolean;
  onProgress?: ProgressReporter;
  signal?: { cancelled: boolean };
}

export class ScanCancelledError extends Error {
  constructor() {
    super('Scan cancelled.');
    this.name = 'ScanCancelledError';
  }
}

const ANALYSED_FINDING_TYPES: FindingType[] = [...ALL_FINDING_TYPES];

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function examplesOf(exclusions: readonly DiscoveryExclusion[], limit = 3): string {
  const paths = exclusions.map((entry) => entry.relativePath).sort().slice(0, limit);
  const remaining = exclusions.length - paths.length;
  return `${paths.join(', ')}${remaining > 0 ? `, and ${remaining} more` : ''}`;
}

/** Turns exhaustive discovery evidence into a bounded, deterministic set of UI limitations. */
function discoveryLimitations(rootPath: string, result: DiscoveryResult): string[] {
  const { diagnostics, files } = result;
  const limitations: string[] = [];
  const excludedCount = diagnostics.exclusions.length;

  if (files.length === 0) {
    limitations.push(
      `No supported source files were found under "${rootPath}" after considering ` +
        `${plural(diagnostics.filesConsidered, 'file')}. TraceDeck currently builds its ` +
        'dependency graph from JavaScript, TypeScript, Vue, Svelte, Astro, HTML, CSS, ' +
        'Python, Go, and Rust source files.',
    );
  } else if (files.length === 1) {
    limitations.push(
      `Only 1 supported source file was found under "${rootPath}" after considering ` +
        `${plural(diagnostics.filesConsidered, 'file')}. The exclusions below explain the ` +
        'scope of this near-empty graph.',
    );
  }

  limitations.push(
    `Discovery visited ${plural(diagnostics.directoriesVisited, 'directory', 'directories')}, ` +
      `considered ${plural(diagnostics.filesConsidered, 'file')}, included ` +
      `${plural(files.length, 'source file')}, and recorded ${plural(excludedCount, 'explicit exclusion')}.`,
  );

  const unsupported = diagnostics.exclusions.filter(
    (entry) => entry.kind === 'unsupported-extension',
  );
  if (unsupported.length > 0) {
    const counts = new Map<string, number>();
    for (const entry of unsupported) counts.set(entry.detail, (counts.get(entry.detail) ?? 0) + 1);
    const extensions = [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([extension, count]) => `${extension} (${count})`)
      .join(', ');
    limitations.push(
      `Discovery left ${plural(unsupported.length, 'file with an unsupported graph extension')} ` +
        `outside the dependency graph: ${extensions}.`,
    );
  }

  const groupedKinds = new Set([
    'always-excluded-directory',
    'user-exclude',
    'gitignore',
    'test-file-disabled',
    'duplicate-real-path',
    'non-regular-entry',
  ]);
  const groups = new Map<string, DiscoveryExclusion[]>();
  for (const exclusion of diagnostics.exclusions) {
    if (!groupedKinds.has(exclusion.kind)) continue;
    const key = `${exclusion.kind}\0${exclusion.detail}`;
    const entries = groups.get(key) ?? [];
    entries.push(exclusion);
    groups.set(key, entries);
  }

  for (const [key, entries] of [...groups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const separator = key.indexOf('\0');
    const kind = key.slice(0, separator);
    const detail = key.slice(separator + 1);
    const count = entries.length;
    const examples = examplesOf(entries);

    if (kind === 'always-excluded-directory') {
      limitations.push(
        `Discovery skipped ${plural(count, `directory named "${detail}"`, `directories named "${detail}"`)} ` +
          `by the built-in exclusion policy (paths: ${examples}).`,
      );
    } else if (kind === 'user-exclude') {
      limitations.push(
        `Discovery excluded ${plural(count, 'path')} matching the configured pattern ` +
          `"${detail}" (paths: ${examples}).`,
      );
    } else if (kind === 'gitignore') {
      limitations.push(
        `Discovery excluded ${plural(count, 'path')} by .gitignore rule ${detail} ` +
          `(paths: ${examples}).`,
      );
    } else if (kind === 'test-file-disabled') {
      limitations.push(
        `Discovery excluded ${plural(count, 'test file')} because test-file scanning is disabled ` +
          `(paths: ${examples}).`,
      );
    } else if (kind === 'duplicate-real-path') {
      limitations.push(
        `Discovery skipped ${plural(count, 'duplicate real path')} to prevent a directory cycle ` +
          `(paths: ${examples}).`,
      );
    } else {
      limitations.push(
        `Discovery skipped ${plural(count, 'non-regular filesystem entry')} ` +
          `(paths: ${examples}).`,
      );
    }
  }

  return limitations;
}

/**
 * Reconstructs enough of a parse result from stored rows to participate in graph building
 * without re-reading the file.
 *
 * Incremental rescans skip parsing unchanged files, but the graph still needs their export
 * surface — otherwise a changed file importing through an unchanged barrel would lose its
 * reference edges. Everything needed for that is already in the symbols and edges tables.
 */
function reconstructParsedFile(store: DataStore, fileId: number): ParsedFile {
  const symbols = store.symbols.listByFile(fileId).map((symbol) => ({
    name: symbol.name,
    kind: symbol.kind,
    isExported: symbol.isExported,
    isDefaultExport: symbol.isDefaultExport,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    metadata: symbol.metadata,
  }));

  const imports: ParsedImport[] = [];
  const calls: ParsedCall[] = [];
  for (const edge of store.db
    .prepare<[number], { edge_type: string; source_line: number | null; metadata_json: string }>(
      `SELECT edge_type, source_line, metadata_json FROM graph_edges WHERE source_file_id = ?`,
    )
    .all(fileId)) {
    if (edge.edge_type === 'export' || edge.edge_type === 'reference') continue;

    const metadata = JSON.parse(edge.metadata_json) as {
      specifier?: string;
      importedNames?: string[];
      isStarExport?: boolean;
      isTypeOnly?: boolean;
      dynamicExpression?: boolean;
      callee?: string;
    };

    if (edge.edge_type === 'call') {
      if (metadata.callee) calls.push({ callee: metadata.callee, line: edge.source_line ?? 1 });
      continue;
    }

    if (!metadata.specifier) continue;

    imports.push({
      specifier: metadata.specifier,
      line: edge.source_line ?? 1,
      kind:
        edge.edge_type === 'dynamic-import'
          ? 'dynamic-import'
          : edge.edge_type === 'require'
            ? 'require'
            : edge.edge_type === 're-export'
              ? 're-export'
              : 'import',
      isTypeOnly: metadata.isTypeOnly === true,
      importedNames: metadata.importedNames ?? [],
      isStarExport: metadata.isStarExport === true,
      isDynamicExpression: metadata.dynamicExpression === true,
    });
  }

  return { imports, symbols, calls, parseErrors: [], syntaxIssues: [], limitations: [] };
}

/** Files with no resolved dependents are the best available guess at an entry point. */
function inferEntryPoints(
  configured: readonly string[],
  packageEntries: readonly string[],
  allPaths: readonly string[],
  index: GraphIndex,
): string[] {
  const explicit = new Set([...configured, ...packageEntries].map(toPosixPath));
  const known = new Set(allPaths);
  const result = new Set<string>();

  for (const path of explicit) {
    if (known.has(path)) result.add(path);
  }

  if (result.size > 0) return [...result];

  for (const path of allPaths) {
    if (index.edgesTo(fileNodeId(path)).length === 0) result.add(path);
  }
  return [...result];
}

export async function runScan(store: DataStore, options: ScanOptions): Promise<Scan> {
  const { project, fullRescan, onProgress, signal } = options;
  const startedAt = Date.now();
  const report: ProgressReporter = onProgress ?? (() => undefined);

  const checkCancelled = (): void => {
    if (signal?.cancelled) throw new ScanCancelledError();
  };

  const scan = store.scans.start(project.id, null);
  const limitations: string[] = [];

  try {
    report({ phase: 'discovering', processed: 0, total: 0, message: 'Finding source files…' });

    const discovery = await discoverFiles({
      rootPath: project.rootPath,
      respectGitignore: project.configuration.respectGitignore,
      includeTestFiles: project.configuration.includeTestFiles,
      excludePatterns: project.configuration.excludePatterns,
    });
    const { files: discovered, skipped } = discovery;
    checkCancelled();

    const storedInventory = store.projectFiles.listByProject(project.id);
    const inventoryUpserts: ProjectFileUpsertInput[] = discovery.inventory.map((entry) => ({
      projectId: project.id,
      relativePath: entry.relativePath,
      absolutePath: entry.absolutePath,
      scanId: scan.id,
      entryKind: entry.entryKind,
      extension: entry.extension,
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
      contentKind: entry.contentKind,
      encoding: entry.encoding,
      contentHash: entry.contentHash,
      isGitIgnored: entry.isGitIgnored,
      gitignoreRule: entry.gitignoreRule,
      isUserExcluded: entry.isUserExcluded,
      analysisStatus: entry.analysisStatus,
      analysisReason: entry.analysisReason,
    }));
    const inventoryPaths = new Set(discovery.inventory.map((entry) => entry.relativePath));
    const removedInventoryIds = storedInventory
      .filter((entry) => !inventoryPaths.has(entry.relativePath))
      .map((entry) => entry.id);

    limitations.push(...discoveryLimitations(project.rootPath, discovery));

    for (const entry of skipped) {
      limitations.push(`${entry.relativePath}: ${entry.reason}`);
    }
    for (const file of discovered) {
      limitations.push(
        ...sourceContainerLimitations(file.relativePath).map(
          (limitation) => `${file.relativePath}: ${limitation}`,
        ),
      );
    }

    const tsConfig = loadProjectTsConfig(project.rootPath);
    const tsConfigDiscovery = discoverProjectTsConfigs(project.rootPath);
    const tsConfigs = tsConfigDiscovery.configs;
    if (tsConfigDiscovery.truncated) {
      limitations.push(
        `Import resolution loaded the first ${tsConfigs.length} compiler configurations; ` +
          `${tsConfigDiscovery.omittedCount} additional configuration(s) were omitted.`,
      );
    }
    if (tsConfigDiscovery.depthLimited) {
      limitations.push(
        `Compiler configuration discovery stopped at directory depth ` +
          `${tsConfigDiscovery.maxDepth}; deeper configurations may have been omitted.`,
      );
    }
    if (tsConfig.configPath === null && tsConfigs.length > 0) {
      limitations.push(
        `No compiler configuration was found at the project root. Import resolution loaded ` +
          `${plural(tsConfigs.length, 'nested tsconfig/jsconfig')} and selects the nearest one ` +
          'for each source file.',
      );
    } else {
      limitations.push(...tsConfig.warnings);
    }
    for (const config of tsConfigs) {
      if (config.configPath === tsConfig.configPath) continue;
      limitations.push(
        ...config.warnings.map(
          (warning) => `${toPosixPath(config.configPath ?? project.rootPath)}: ${warning}`,
        ),
      );
    }

    const manifests = await readProjectManifests(project.rootPath);
    const languageRoots = await readLanguageRoots(project.rootPath);
    const renamedPaths = new Set<string>();
    try {
      if (await isGitRepo(project.rootPath)) {
        for (const entry of await gitRecentRenames(project.rootPath)) {
          if (entry.from) renamedPaths.add(entry.from);
          if (entry.to) renamedPaths.add(entry.to);
        }
      }
    } catch {
      // Git is optional; unused-export caveats simply stay quieter.
    }
    const previousFindings = store.findings.list(project.id, { includeDismissed: true });
    const previousInventory = new Map(
      store.projectFiles.listByProject(project.id).map((entry) => [entry.relativePath, entry]),
    );

    // --- Decide which files actually need parsing ---
    const storedFingerprints = store.files.fingerprints(project.id);
    const hashes = new Map<string, string>();
    const changed: DiscoveredFile[] = [];
    const unchanged: DiscoveredFile[] = [];
    const contents = new Map<string, string>();

    report({
      phase: 'parsing',
      processed: 0,
      total: discovered.length,
      message: 'Reading source files…',
    });

    for (const [position, file] of discovered.entries()) {
      checkCancelled();

      let raw: string;
      try {
        raw = await fs.readFile(file.absolutePath, 'utf8');
      } catch {
        limitations.push(`${file.relativePath}: file could not be read during this scan.`);
        continue;
      }

      limitations.push(
        ...inspectSourceContainerLimitations(file.relativePath, raw).map(
          (limitation) => `${file.relativePath}: ${limitation}`,
        ),
      );

      const hash = hashContent(raw);
      hashes.set(file.relativePath, hash);

      const stored = storedFingerprints.get(file.relativePath);
      const isUnchanged =
        !fullRescan &&
        stored !== undefined &&
        stored.contentHash === hash &&
        stored.modifiedAt === file.modifiedAt;

      if (isUnchanged) {
        unchanged.push(file);
      } else {
        changed.push(file);
        contents.set(file.relativePath, raw);
      }

      if (position % 200 === 0) {
        report({
          phase: 'parsing',
          processed: position,
          total: discovered.length,
          message: `Reading ${file.relativePath}`,
        });
      }
    }

    // --- Persist file rows first so every id exists before edges reference them ---
    const upserts: FileUpsertInput[] = discovered.map((file) => ({
      projectId: project.id,
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
      extension: file.extension,
      contentHash: hashes.get(file.relativePath) ?? '',
      modifiedAt: file.modifiedAt,
      isEntryPoint: false,
      scanId: scan.id,
    }));
    const fileIds = store.files.upsertMany(upserts);

    // A file that disappeared from disk takes its symbols and edges with it.
    const discoveredPaths = new Set(discovered.map((file) => file.relativePath));
    const removedIds = [...storedFingerprints.values()]
      .filter((stored) => !discoveredPaths.has(stored.relativePath))
      .map((stored) => stored.id);
    const removedFiles = store.files.removeByIds(removedIds);

    // --- Parse the changed files ---
    report({
      phase: 'parsing',
      processed: 0,
      total: changed.length,
      message: `Parsing ${changed.length} changed file(s)…`,
    });

    const toBuild: FileToBuild[] = [];
    let errorCount = 0;
    const collectedSyntax: Array<{ relativePath: string; issue: SyntaxIssue }> = [];

    for (const [position, file] of changed.entries()) {
      checkCancelled();
      const source = contents.get(file.relativePath) ?? '';

      try {
        const parsed =
          (await parseWithTreeSitter(file.relativePath, source)) ??
          parseSourceFile(file.absolutePath, source);
        if (/\.(vue|svelte|astro)$/i.test(file.relativePath)) {
          const extra = await parseContainerMarkup(file.relativePath, source);
          parsed.imports.push(...extra.imports);
          parsed.syntaxIssues.push(...extra.syntaxIssues);
          parsed.parseErrors.push(...extra.parseErrors);
          parsed.limitations.push(...extra.limitations);
        }
        rewriteLanguageImports(file.relativePath, parsed.imports, languageRoots);
        if (parsed.parseErrors.length > 0) {
          errorCount += parsed.parseErrors.length;
          limitations.push(...parsed.parseErrors.map((e) => `${file.relativePath}: ${e}`));
        }
        for (const issue of parsed.syntaxIssues) {
          if (issue.line >= 1) {
            errorCount += 1;
            collectedSyntax.push({ relativePath: file.relativePath, issue });
          } else {
            limitations.push(`${file.relativePath}: ${issue.message}`);
          }
        }
        for (const limitation of parsed.limitations) {
          const text = limitation.includes(file.relativePath)
            ? limitation
            : `${file.relativePath}: ${limitation}`;
          if (!limitations.includes(text)) limitations.push(text);
        }
        toBuild.push({
          relativePath: file.relativePath,
          absolutePath: file.absolutePath,
          parsed,
        });
      } catch (error) {
        errorCount += 1;
        limitations.push(
          `${file.relativePath}: could not be parsed (${
            error instanceof Error ? error.message : 'unknown error'
          }).`,
        );
      }

      if (position % 100 === 0) {
        report({
          phase: 'parsing',
          processed: position,
          total: changed.length,
          message: `Parsing ${file.relativePath}`,
        });
      }
    }

    for (const file of unchanged) {
      const id = fileIds.get(file.relativePath);
      if (id === undefined) continue;
      toBuild.push({
        relativePath: file.relativePath,
        absolutePath: file.absolutePath,
        parsed: reconstructParsedFile(store, id),
      });
    }

    // --- Build the graph over every file, changed or not ---
    checkCancelled();
    report({ phase: 'resolving', processed: 0, total: 0, message: 'Resolving imports…' });

    const context: ResolverContext = {
      rootPath: project.rootPath,
      tsConfig,
      tsConfigs,
      knownFiles: buildKnownFileIndex(discovered.map((file) => toPosixPath(file.absolutePath))),
      manifests,
    };

    const graph = buildGraph(toBuild, context);

    // --- Persist symbols and edges for changed files only ---
    report({ phase: 'persisting', processed: 0, total: 0, message: 'Saving analysis…' });

    const changedPaths = new Set(changed.map((file) => file.relativePath));
    const changedIds = changed
      .map((file) => fileIds.get(file.relativePath))
      .filter((id): id is number => id !== undefined);
    const unchangedIds = unchanged
      .map((file) => fileIds.get(file.relativePath))
      .filter((id): id is number => id !== undefined);

    store.transaction(() => {
      store.symbols.deleteByFileIds(changedIds);
      store.edges.deleteBySourceFileIds(changedIds);

      const symbolInserts: SymbolInsertInput[] = [];
      for (const file of toBuild) {
        if (!changedPaths.has(file.relativePath)) continue;
        const fileId = fileIds.get(file.relativePath);
        if (fileId === undefined) continue;

        for (const symbol of file.parsed.symbols) {
          symbolInserts.push({
            projectId: project.id,
            fileId,
            name: symbol.name,
            kind: symbol.kind,
            isExported: symbol.isExported,
            isDefaultExport: symbol.isDefaultExport,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
            metadata: symbol.metadata,
            scanId: scan.id,
          });
        }
      }
      store.symbols.insertMany(symbolInserts);

      const edgeInserts: EdgeInsertInput[] = [];
      for (const edge of graph.edges) {
        if (!changedPaths.has(edge.sourceRelativePath)) continue;
        const sourceFileId = fileIds.get(edge.sourceRelativePath);
        if (sourceFileId === undefined) continue;

        edgeInserts.push({
          projectId: project.id,
          fromNodeType: edge.fromNodeType,
          fromNodeId: edge.fromNodeId,
          toNodeType: edge.toNodeType,
          toNodeId: edge.toNodeId,
          edgeType: edge.edgeType,
          sourceFileId,
          sourceLine: edge.sourceLine,
          metadata: edge.metadata,
          scanId: scan.id,
        });
      }
      store.edges.insertMany(edgeInserts);

      // Unchanged rows are still current, so they move onto this scan rather than being
      // rebuilt — this is what makes pruning older scans safe.
      store.files.reassignToScan(unchangedIds, scan.id);
      store.symbols.reassignToScan(unchangedIds, scan.id);
      store.edges.reassignToScan(unchangedIds, scan.id);
    });

    // --- Run the analyses ---
    checkCancelled();
    report({ phase: 'analysing', processed: 0, total: 0, message: 'Analysing dependencies…' });

    const adjacency = store.edges.adjacency(project.id);
    const dependencyIndex = new GraphIndex(adjacency, { edgeTypes: DEPENDENCY_EDGE_TYPES });
    const referenceIndex = new GraphIndex(adjacency, { edgeTypes: ['reference'] });

    const cycles = detectCycles(dependencyIndex);

    const packageEntries = packageEntryPointsFrom(manifests.root);
    const allPaths = discovered.map((file) => file.relativePath);
    const entryPoints = inferEntryPoints(
      project.configuration.entryPoints,
      packageEntries,
      allPaths,
      dependencyIndex,
    );
    store.files.setEntryPoints(project.id, entryPoints);

    const exportedSymbols: ExportedSymbolInput[] = store.symbols
      .listExported(project.id)
      .map((symbol) => ({
        filePath: symbol.relativePath,
        symbolName: symbol.name,
        symbolKind: symbol.kind as SymbolKind,
        line: symbol.startLine,
        isDefaultExport: symbol.isDefaultExport,
        isReExport: symbol.metadata.reExportedFrom !== undefined,
      }));

    const unusedCandidates = findUnusedExportCandidates(exportedSymbols, referenceIndex, {
      entryPoints,
      exclusions: project.configuration.unusedExportExclusions,
      barrelCaveats: graph.barrelCaveats,
      packageEntryPoints: packageEntries,
      renamedPaths,
    });

    const importFacts: ImportFact[] = [];
    for (const edge of store.edges.listByProject(project.id)) {
      if (!DEPENDENCY_EDGE_TYPES.includes(edge.edgeType)) continue;
      if (edge.metadata.unresolved) continue;
      const from = store.files.findById(edge.sourceFileId ?? -1);
      if (!from) continue;
      importFacts.push({
        fromPath: from.relativePath,
        toPath: edge.toNodeId.startsWith('file:') ? edge.toNodeId.slice('file:'.length) : null,
        specifier: edge.metadata.specifier ?? '',
        line: edge.sourceLine,
      });
    }

    const rules = store.rules.listEnabled(project.id);
    const { violations, invalidRules } = evaluateArchitectureRules(rules, importFacts);
    for (const invalid of invalidRules) {
      limitations.push(`Architecture rule "${invalid.ruleName}" was skipped: ${invalid.error}`);
    }

    for (const [path, caveats] of graph.barrelCaveats) {
      for (const caveat of caveats) limitations.push(`${path}: ${caveat}`);
    }

    // --- Optional: real TypeScript diagnostics ---
    let typeCheckSummary: TypeCheckSummary | null = null;
    let typeDiagnostics: ReturnType<typeof runTypeScriptDiagnostics>['diagnostics'] = [];

    if (project.configuration.typeCheck) {
      checkCancelled();
      report({
        phase: 'type-checking',
        processed: 0,
        total: discovered.length,
        message: 'Type checking with the TypeScript compiler…',
      });

      const result = runTypeScriptDiagnostics({
        rootPath: project.rootPath,
        tsConfig,
        fallbackFileNames: discovered.map((file) => file.absolutePath),
        ...(signal ? { signal } : {}),
      });

      typeDiagnostics = result.diagnostics;
      limitations.push(...result.limitations);
      if (result.skippedReason) limitations.push(result.skippedReason);

      typeCheckSummary = {
        ran: !result.skipped,
        errorCount: result.errorCount,
        warningCount: result.warningCount,
        durationMs: result.durationMs,
        skippedReason: result.skippedReason,
      };
    }

    // --- Turn analyses into findings ---
    const findings: FindingInsertInput[] = [];

    for (const cycle of cycles) {
      const paths = cycle.path.map((nodeId) => nodeId.replace(/^file:/, ''));
      findings.push({
        projectId: project.id,
        scanId: scan.id,
        findingType: 'circular-dependency',
        severity: cycle.nodes.length > 3 ? 'high' : 'medium',
        title: `Import cycle between ${cycle.nodes.length} files`,
        description:
          'Static analysis result: these files form a cycle of resolved imports. ' +
          'Cycles can make load order fragile and make changes harder to reason about.',
        relatedNodeIds: cycle.nodes,
        details: {
          kind: 'cycle',
          cyclePath: paths,
          edges: cycle.edges.map((edge) => ({
            from: edge.from.replace(/^file:/, ''),
            to: edge.to.replace(/^file:/, ''),
            line: edge.line,
            specifier: edge.specifier,
          })),
        },
        fingerprint: fingerprint('cycle', ...[...cycle.nodes].sort()),
      });
    }

    for (const candidate of unusedCandidates) {
      findings.push({
        projectId: project.id,
        scanId: scan.id,
        findingType: 'unused-export-candidate',
        severity: candidate.caveats.length > 0 ? 'info' : 'low',
        title: `Unused export candidate: ${candidate.symbolName}`,
        description:
          'Static analysis found no resolved import of this exported symbol inside the ' +
          'project. It may still be used by a consumer this scan cannot see.',
        relatedNodeIds: [candidate.nodeId],
        details: {
          kind: 'unused-export',
          filePath: candidate.filePath,
          symbolName: candidate.symbolName,
          symbolKind: candidate.symbolKind,
          line: candidate.line,
          caveats: candidate.caveats,
        },
        fingerprint: fingerprint('unused', candidate.filePath, candidate.symbolName),
      });
    }

    for (const violation of violations) {
      findings.push({
        projectId: project.id,
        scanId: scan.id,
        findingType: 'architecture-violation',
        severity: violation.severity,
        title: `${violation.ruleName}`,
        description:
          `"${violation.sourcePath}" imports "${violation.targetPath}", which the rule ` +
          `"${violation.ruleName}" forbids.`,
        relatedNodeIds: [fileNodeId(violation.sourcePath), fileNodeId(violation.targetPath)],
        details: {
          kind: 'architecture-violation',
          ruleId: violation.ruleId,
          ruleName: violation.ruleName,
          sourcePath: violation.sourcePath,
          targetPath: violation.targetPath,
          line: violation.line,
          specifier: violation.specifier,
        },
        fingerprint: fingerprint(
          'arch',
          violation.ruleId,
          violation.sourcePath,
          violation.targetPath,
        ),
      });
    }

    const actionableUnresolved = graph.unresolved.filter(
      (record) => record.reason !== 'external-package' && record.reason !== 'non-source-asset',
    );

    // Importing a declared dependency is normal, so it is counted rather than reported as a
    // finding. Mixing packages into this list buried the handful of imports that are genuinely
    // broken under dozens that are working exactly as intended.
    const externalDependencies = new Set(
      graph.unresolved
        .filter((record) => record.reason === 'external-package')
        .map((record) => packageNameOf(record.specifier)),
    );

    for (const record of actionableUnresolved) {
      findings.push({
        projectId: project.id,
        scanId: scan.id,
        findingType: 'unresolved-import',
        severity: 'info',
        title:
          record.reason === 'dynamic-expression'
            ? `Could not resolve dynamically imported module in ${record.filePath}`
            : `Could not resolve "${record.specifier}"`,
        description: record.detail,
        relatedNodeIds: [fileNodeId(record.filePath)],
        details: {
          kind: 'unresolved-import',
          filePath: record.filePath,
          specifier: record.specifier,
          line: record.line,
          reason: record.reason,
        },
        fingerprint: fingerprint('unresolved', record.filePath, record.specifier, record.line),
      });
    }

    for (const diagnostic of typeDiagnostics) {
      const location = diagnostic.filePath
        ? `${diagnostic.filePath}${diagnostic.line !== null ? `:${diagnostic.line}` : ''}`
        : 'the project configuration';

      findings.push({
        projectId: project.id,
        scanId: scan.id,
        findingType: 'type-error',
        severity:
          diagnostic.category === 'error'
            ? 'high'
            : diagnostic.category === 'warning'
              ? 'medium'
              : 'info',
        title: `TS${diagnostic.code}: ${diagnostic.message}`,
        description: `Reported by the TypeScript compiler in ${location}.`,
        relatedNodeIds: diagnostic.filePath ? [fileNodeId(diagnostic.filePath)] : [],
        details: {
          kind: 'type-error',
          filePath: diagnostic.filePath,
          line: diagnostic.line,
          column: diagnostic.column,
          code: diagnostic.code,
          category: diagnostic.category,
          message: diagnostic.message,
        },
        // The line is deliberately excluded so unrelated edits above a diagnostic do not
        // resurrect one the user already dismissed.
        fingerprint: fingerprint(
          'type-error',
          diagnostic.filePath,
          diagnostic.code,
          diagnostic.message,
        ),
      });
    }

    for (const { relativePath, issue } of collectedSyntax) {
      findings.push({
        projectId: project.id,
        scanId: scan.id,
        findingType: 'syntax-error',
        severity: 'high',
        title: `Syntax error in ${relativePath}`,
        description: `${issue.message} (line ${issue.line}, column ${issue.column})`,
        relatedNodeIds: [fileNodeId(relativePath)],
        details: {
          kind: 'syntax-error',
          filePath: relativePath,
          line: issue.line,
          column: issue.column,
          code: 0,
          message: issue.message,
        },
        fingerprint: fingerprint('syntax-error', relativePath, issue.message),
      });
    }

    const cloneInputs: Array<{ relativePath: string; text: string }> = [];
    const changedPathSet = new Set(changed.map((file) => file.relativePath));

    // --- Syntax and merge-conflict findings over decodable inventory text ---
    //
    // This runs over the inventory rather than the graph subset, so a broken JSON config or a
    // half-merged stylesheet is reported even though neither is a dependency-graph node.
    for (const entry of discovery.inventory) {
      checkCancelled();
      if (entry.contentKind !== 'text' || entry.entryKind !== 'regular') continue;
      if (entry.sizeBytes > MAX_SOURCE_BYTES) continue;

      const previous = previousInventory.get(entry.relativePath);
      const hashUnchanged =
        !fullRescan &&
        previous?.contentHash != null &&
        entry.contentHash != null &&
        previous.contentHash === entry.contentHash;

      if (hashUnchanged) {
        for (const finding of previousFindings) {
          if (
            finding.findingType !== 'merge-conflict' &&
            finding.findingType !== 'todo-comment' &&
            finding.findingType !== 'syntax-error'
          ) {
            continue;
          }
          const details = finding.details as { filePath?: string };
          if (details.filePath !== entry.relativePath) continue;
          findings.push({
            projectId: project.id,
            scanId: scan.id,
            findingType: finding.findingType,
            severity: finding.severity,
            title: finding.title,
            description: finding.description,
            relatedNodeIds: finding.relatedNodeIds,
            details: finding.details,
            fingerprint: finding.fingerprint,
          });
        }
        continue;
      }

      let text: string;
      try {
        const bytes = await fs.readFile(entry.absolutePath);
        const encoding = detectEncoding(bytes);
        if (!isDecodableText(bytes, encoding)) continue;
        text = decodeText(bytes, encoding);
      } catch {
        continue;
      }

      cloneInputs.push({ relativePath: entry.relativePath, text });

      for (const todo of findTodoComments(text)) {
        findings.push({
          projectId: project.id,
          scanId: scan.id,
          findingType: 'todo-comment',
          severity: todo.tag === 'FIXME' ? 'medium' : 'info',
          title: `${todo.tag} in ${entry.relativePath}`,
          description: todo.text.length > 0 ? todo.text : `A ${todo.tag} comment is present.`,
          relatedNodeIds: [fileNodeId(entry.relativePath)],
          details: {
            kind: 'todo-comment',
            filePath: entry.relativePath,
            line: todo.line,
            tag: todo.tag,
            text: todo.text,
          },
          fingerprint: fingerprint('todo', entry.relativePath, todo.tag, todo.line, todo.text),
        });
      }

      for (const conflict of findMergeConflicts(text)) {
        findings.push({
          projectId: project.id,
          scanId: scan.id,
          findingType: 'merge-conflict',
          severity: 'high',
          title: `Unresolved merge conflict in ${entry.relativePath}`,
          description: conflict.complete
            ? `A conflict block spans lines ${conflict.startLine}-${String(conflict.endLine)}.`
            : `A conflict marker on line ${conflict.startLine} is not properly closed.`,
          relatedNodeIds: [fileNodeId(entry.relativePath)],
          details: {
            kind: 'merge-conflict',
            filePath: entry.relativePath,
            startLine: conflict.startLine,
            endLine: conflict.endLine,
            complete: conflict.complete,
            label: conflict.label,
          },
          // Keyed on the file and the marker label rather than the line, so an edit above the
          // conflict does not resurrect a finding the user already dismissed.
          fingerprint: fingerprint('merge-conflict', entry.relativePath, conflict.label),
        });
      }

      if (!isJsonPath(entry.relativePath)) continue;
      for (const diagnostic of diagnoseJson(entry.relativePath, text)) {
        findings.push({
          projectId: project.id,
          scanId: scan.id,
          findingType: 'syntax-error',
          severity: 'high',
          title: `Invalid JSON in ${entry.relativePath}`,
          description: `${diagnostic.message} (line ${diagnostic.line}, column ${diagnostic.column})`,
          relatedNodeIds: [fileNodeId(entry.relativePath)],
          details: {
            kind: 'syntax-error',
            filePath: entry.relativePath,
            line: diagnostic.line,
            column: diagnostic.column,
            code: diagnostic.code,
            message: diagnostic.message,
          },
          fingerprint: fingerprint(
            'syntax-error',
            entry.relativePath,
            diagnostic.code,
            diagnostic.message,
          ),
        });
      }
    }

    for (const file of toBuild) {
      for (const symbol of file.parsed.symbols) {
        const complexity = symbol.metadata.complexity ?? 0;
        if (complexity < COMPLEXITY_HOTSPOT_THRESHOLD) continue;
        findings.push({
          projectId: project.id,
          scanId: scan.id,
          findingType: 'complexity-hotspot',
          severity: complexity >= 20 ? 'high' : 'medium',
          title: `High complexity: ${symbol.name}`,
          description:
            `${symbol.name} in ${file.relativePath} has cyclomatic complexity ${complexity} ` +
            `(nesting depth ${symbol.metadata.nestingDepth ?? 0}).`,
          relatedNodeIds: [fileNodeId(file.relativePath)],
          details: {
            kind: 'complexity-hotspot',
            filePath: file.relativePath,
            symbolName: symbol.name,
            line: symbol.startLine,
            complexity,
            nestingDepth: symbol.metadata.nestingDepth ?? 0,
          },
          fingerprint: fingerprint('complexity', file.relativePath, symbol.name),
        });
      }
    }

    for (const group of findDuplicateBlocks(cloneInputs)) {
      findings.push({
        projectId: project.id,
        scanId: scan.id,
        findingType: 'duplicate-code',
        severity: 'low',
        title: `Duplicated block (${group.lineCount} lines) in ${group.filePaths.length} places`,
        description: group.filePaths
          .map((path, index) => `${path}:${group.startLines[index] ?? 1}`)
          .join(', '),
        relatedNodeIds: [...new Set(group.filePaths)].map((path) => fileNodeId(path)),
        details: {
          kind: 'duplicate-code',
          filePaths: group.filePaths,
          startLines: group.startLines,
          lineCount: group.lineCount,
        },
        fingerprint: fingerprint('duplicate', group.hash),
      });
    }

    if (!fullRescan) {
      for (const finding of previousFindings) {
        if (finding.findingType !== 'duplicate-code') continue;
        const details = finding.details;
        if (details.kind !== 'duplicate-code') continue;
        if (details.filePaths.some((path) => changedPathSet.has(path))) continue;
        findings.push({
          projectId: project.id,
          scanId: scan.id,
          findingType: finding.findingType,
          severity: finding.severity,
          title: finding.title,
          description: finding.description,
          relatedNodeIds: finding.relatedNodeIds,
          details: finding.details,
          fingerprint: finding.fingerprint,
        });
      }
    }

    store.findings.replaceForScan(project.id, scan.id, ANALYSED_FINDING_TYPES, findings);
    store.snapshots.insert(
      project.id,
      scan.id,
      findings.map((finding) => ({ fingerprint: finding.fingerprint, title: finding.title })),
    );
    store.snapshots.prune(project.id, 5);

    // --- Complete ---
    checkCancelled();
    const completed = store.transaction(() => {
      store.projectFiles.upsertMany(inventoryUpserts);
      store.projectFiles.removeByIds(removedInventoryIds);

      const inventoryCounts = store.projectFiles.countsByCapability(project.id);
      const graphEligibleFiles = store.files.countByProject(project.id);
      const unavailableFiles =
        inventoryCounts.excluded +
        inventoryCounts.oversize +
        inventoryCounts.unreadable +
        inventoryCounts.symlink;
      const summary: ScanSummary = {
        totalFiles: discovered.length,
        inventoryFiles: inventoryCounts.total,
        graphEligibleFiles,
        textOnlyFiles: inventoryCounts.textOnly,
        binaryFiles: inventoryCounts.binary,
        ignoredFiles: inventoryCounts.gitIgnored,
        unavailableFiles,
        parsedFiles: changed.length,
        skippedUnchangedFiles: unchanged.length,
        removedFiles,
        totalSymbols: store.symbols.countByProject(project.id),
        totalEdges: store.edges.countByProject(project.id),
        unresolvedImports: actionableUnresolved.length,
        dynamicImports: graph.unresolved.filter((r) => r.reason === 'dynamic-expression').length,
        externalDependencies: externalDependencies.size,
        cycles: cycles.length,
        unusedExportCandidates: unusedCandidates.length,
        architectureViolations: violations.length,
        typeCheck: typeCheckSummary,
        durationMs: Date.now() - startedAt,
        limitations: [...new Set(limitations)].slice(0, 500),
      };

      const completedScan = store.scans.complete(scan.id, {
        status: 'completed',
        totalFiles: discovered.length,
        parsedFiles: changed.length,
        errorCount,
        summary,
      });

      store.projects.markScanned(project.id, new Date().toISOString());
      store.scans.pruneOlderScans(project.id, scan.id);
      if (!completedScan) throw new Error('Completed scan could not be read back.');
      report({
        phase: 'done',
        processed: discovered.length,
        total: discovered.length,
        message: 'Scan complete.',
      });
      return completedScan;
    });

    return completed;
  } catch (error) {
    if (error instanceof ScanCancelledError) {
      store.scans.complete(scan.id, {
        status: 'cancelled',
        totalFiles: 0,
        parsedFiles: 0,
        errorCount: 0,
        summary: null,
      });
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    store.scans.fail(scan.id, message);
    report({ phase: 'failed', processed: 0, total: 0, message });
    throw error;
  }
}
