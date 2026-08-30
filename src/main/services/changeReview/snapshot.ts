import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import type { ReviewFindingEvidence, ReviewLimitation } from '@shared/changeReview';
import {
  ALWAYS_EXCLUDED_DIRS,
  FRAMEWORK_CONVENTION_PATTERNS,
  INDEX_BASENAMES,
  MAX_FILE_SIZE_BYTES,
  MAX_SOURCE_BYTES,
  NON_SOURCE_IMPORT_EXTENSIONS,
  RESOLUTION_EXTENSIONS,
  REVIEW_RESULT_SCHEMA_VERSION,
  SOURCE_EXTENSIONS,
  TEST_FILE_PATTERNS,
} from '@shared/constants';
import { parseNodeId } from '@shared/nodeIds';
import { sourceLanguage } from '@shared/sourceLanguage';
import type {
  EdgeType,
  FindingDetails,
  Project,
  ProjectFileAnalysisStatus,
  ProjectFileContentKind,
  ProjectFileEntryKind,
  Severity,
} from '@shared/types';
import { detectCycles } from '../../analysis/algorithms/cycles';
import { DEPENDENCY_EDGE_TYPES, GraphIndex } from '../../analysis/algorithms/graphIndex';
import {
  discoverReachableExports,
  type ExportModuleFact,
  type ReachableExportRecord,
} from '../../analysis/algorithms/reachableExports';
import { packageEntryPointsFrom } from '../../analysis/algorithms/unusedExports';
import { COMPLEXITY_HOTSPOT_THRESHOLD } from '../../analysis/algorithms/complexity';
import { MAX_PROJECT_CONFIGS } from '../../analysis/tsconfig';
import type { DataStore } from '../../db';
import type { MaterializedInventoryEvidence } from './materializer';
import { canonicalSha256, compareCodePoints } from './canonical';
import { toPosixPath } from '../../utils/glob';

const TYPESCRIPT_FAMILY_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);
const MAX_LIMITATION_PATHS = 50;
const TYPE_ERROR_LIMITATION_MESSAGE =
  "Type errors were not compared because the isolated HEAD baseline does not reproduce the working tree's compiler dependency environment.";

export type ReviewSnapshotSide = 'baseline' | 'target';

export interface NormalizedInventoryEvidence {
  relativePath: string;
  entryKind: ProjectFileEntryKind | 'submodule';
  extension: string | null;
  sizeBytes: number | null;
  contentKind: ProjectFileContentKind;
  encoding: string | null;
  contentHash: string | null;
  isGitIgnored: boolean;
  gitignoreRule: string | null;
  isUserExcluded: boolean;
  analysisStatus: ProjectFileAnalysisStatus | 'inventory-only';
  analysisReason: string;
}

export interface NormalizedGraphFile {
  relativePath: string;
  extension: string;
  language: string;
  contentHash: string;
  isEntryPoint: boolean;
}

export interface NormalizedReviewEdge {
  fromPath: string;
  toPath: string;
  edgeType: EdgeType;
  typeOnly: boolean;
  sourceLines: number[];
  specifiers: string[];
}

export interface NormalizedArchitectureViolation {
  ruleId: number;
  ruleFingerprint: string;
  sourcePath: string;
  targetPath: string;
  severity: Severity;
  line: number | null;
}

export interface NormalizedCycle {
  memberPaths: string[];
  cyclePath: string[];
}

export interface ReviewSnapshot {
  side: ReviewSnapshotSide;
  scanId: number;
  baseCommit: string;
  baseTreeId: string | null;
  workingTreeFingerprint: string;
  userConfigurationFingerprint: string;
  effectiveBaselineFingerprint: string;
  inventory: NormalizedInventoryEvidence[];
  graphFiles: NormalizedGraphFile[];
  edges: NormalizedReviewEdge[];
  findings: ReviewFindingEvidence[];
  architectureViolations: NormalizedArchitectureViolation[];
  cycles: NormalizedCycle[];
  reachableExports: ReachableExportRecord[];
  limitations: ReviewLimitation[];
}

function normalizedRelativePath(value: string, projectRoot: string): string | null {
  const normalized = toPosixPath(value);
  const normalizedRoot = toPosixPath(projectRoot).replace(/\/$/, '');
  const withoutRoot = normalized === normalizedRoot
    ? ''
    : normalized.startsWith(`${normalizedRoot}/`)
      ? normalized.slice(normalizedRoot.length + 1)
      : normalized;
  if (
    withoutRoot.length === 0
    || posix.isAbsolute(withoutRoot)
    || /^[A-Za-z]:\//.test(withoutRoot)
    || posix.normalize(withoutRoot) !== withoutRoot
    || withoutRoot === '..'
    || withoutRoot.startsWith('../')
  ) {
    return null;
  }
  return withoutRoot.replace(/^\.\//, '');
}

function sanitizeText(value: string, projectRoot: string): string {
  const rootForms = [projectRoot, toPosixPath(projectRoot)]
    .filter((candidate, index, values) => candidate.length > 0 && values.indexOf(candidate) === index)
    .sort((left, right) => right.length - left.length);
  let sanitized = value;
  for (const root of rootForms) sanitized = sanitized.split(root).join('<project root>');
  sanitized = sanitized.replace(/\\\\[^\s"'(),]+(?:\\[^\s"'(),]+)*/g, '<absolute path>');
  sanitized = sanitized.replace(/[A-Za-z]:[\\/][^\s"'(),]*/g, '<absolute path>');
  sanitized = sanitized.replace(/(^|[\s"'(])\/(?:[^\s"'(),]+\/?)+/g, '$1<absolute path>');
  return sanitized;
}

function sanitizeValue(value: unknown, projectRoot: string): unknown {
  if (typeof value === 'string') return sanitizeText(toPosixPath(value), projectRoot);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, projectRoot));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    sanitizeValue(item, projectRoot),
  ]));
}

function normalizedPattern(value: string): string {
  return toPosixPath(value).trim();
}

function normalizedSet(values: readonly string[], normalize = (value: string): string => value): string[] {
  return [...new Set(values.map(normalize))].sort(compareCodePoints);
}

function semanticRuleFingerprint(rule: ReturnType<DataStore['rules']['listEnabled']>[number]): string {
  return canonicalSha256({
    name: rule.name,
    ruleType: rule.ruleType,
    sourcePattern: normalizedPattern(rule.sourcePattern),
    targetPattern: normalizedPattern(rule.targetPattern),
    severity: rule.configuration.severity,
    exceptions: normalizedSet(rule.configuration.exceptions, normalizedPattern),
  });
}

function normalizedConfiguration(project: Project, typeCheck: boolean): Project['configuration'] {
  return {
    excludePatterns: normalizedSet(project.configuration.excludePatterns, normalizedPattern),
    entryPoints: normalizedSet(project.configuration.entryPoints, (value) => toPosixPath(value).replace(/^\.\//, '')),
    respectGitignore: project.configuration.respectGitignore,
    includeTestFiles: project.configuration.includeTestFiles,
    typeCheck,
    unusedExportExclusions: normalizedSet(
      project.configuration.unusedExportExclusions,
      (value) => toPosixPath(value).replace(/^\.\//, ''),
    ),
  };
}

function configurationFingerprints(
  project: Project,
  rules: ReturnType<DataStore['rules']['listEnabled']>,
  traceDeckVersion: string,
): { user: string; effectiveBaseline: string; byRuleId: Map<number, string> } {
  const byRuleId = new Map<number, string>();
  for (const rule of rules) byRuleId.set(rule.id, semanticRuleFingerprint(rule));
  const ruleRecords = rules
    .map((rule) => ({ id: rule.id, semanticFingerprint: byRuleId.get(rule.id) as string }))
    .sort((left, right) => left.id - right.id || compareCodePoints(
      left.semanticFingerprint,
      right.semanticFingerprint,
    ));
  const userConfiguration = normalizedConfiguration(project, project.configuration.typeCheck);

  const structuralConstants = {
    alwaysExcludedDirectories: normalizedSet(ALWAYS_EXCLUDED_DIRS),
    sourceExtensions: normalizedSet(SOURCE_EXTENSIONS),
    resolutionExtensions: [...RESOLUTION_EXTENSIONS],
    indexBasenames: normalizedSet(INDEX_BASENAMES),
    nonSourceImportExtensions: normalizedSet(NON_SOURCE_IMPORT_EXTENSIONS),
    testFilePatterns: TEST_FILE_PATTERNS
      .map((pattern) => ({ source: pattern.source, flags: pattern.flags }))
      .sort((left, right) => compareCodePoints(
        `${left.source}\0${left.flags}`,
        `${right.source}\0${right.flags}`,
      )),
    frameworkConventionPatterns: FRAMEWORK_CONVENTION_PATTERNS
      .map((pattern) => ({ source: pattern.source, flags: pattern.flags }))
      .sort((left, right) => compareCodePoints(
        `${left.source}\0${left.flags}`,
        `${right.source}\0${right.flags}`,
      )),
    dependencyEdgeTypes: [...DEPENDENCY_EDGE_TYPES].sort(compareCodePoints),
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    maxSourceBytes: MAX_SOURCE_BYTES,
    maxProjectConfigs: MAX_PROJECT_CONFIGS,
    complexityHotspotThreshold: COMPLEXITY_HOTSPOT_THRESHOLD,
  };

  return {
    user: canonicalSha256({ configuration: userConfiguration, enabledRules: ruleRecords }),
    effectiveBaseline: canonicalSha256({
      configuration: normalizedConfiguration(project, false),
      enabledRules: ruleRecords,
      structuralConstants,
      resultSchemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
      traceDeckVersion,
    }),
    byRuleId,
  };
}

function inventoryEvidence(
  store: DataStore,
  project: Project,
  side: ReviewSnapshotSide,
  extraInventory: readonly MaterializedInventoryEvidence[],
): NormalizedInventoryEvidence[] {
  const byPath = new Map<string, NormalizedInventoryEvidence>();
  for (const file of store.projectFiles.listByProject(project.id)) {
    const relativePath = normalizedRelativePath(file.relativePath, project.rootPath);
    if (!relativePath) continue;
    byPath.set(relativePath, {
      relativePath,
      entryKind: file.entryKind,
      extension: file.extension,
      sizeBytes: file.sizeBytes,
      contentKind: file.contentKind,
      encoding: file.encoding,
      contentHash: file.contentHash,
      isGitIgnored: file.isGitIgnored,
      gitignoreRule: file.gitignoreRule === null
        ? null
        : sanitizeText(file.gitignoreRule, project.rootPath),
      isUserExcluded: file.isUserExcluded,
      analysisStatus: file.analysisStatus,
      analysisReason: sanitizeText(file.analysisReason, project.rootPath),
    });
  }

  if (side === 'baseline') {
    for (const extra of extraInventory) {
      const relativePath = normalizedRelativePath(extra.relativePath, project.rootPath);
      if (!relativePath) continue;
      byPath.set(relativePath, {
        relativePath,
        entryKind: extra.entryKind,
        extension: null,
        sizeBytes: null,
        contentKind: 'unknown',
        encoding: null,
        contentHash: null,
        isGitIgnored: false,
        gitignoreRule: null,
        isUserExcluded: false,
        analysisStatus: 'inventory-only',
        analysisReason: sanitizeText(extra.reason, project.rootPath),
      });
    }
  }

  return [...byPath.values()].sort((left, right) => (
    compareCodePoints(left.relativePath, right.relativePath)
  ));
}

function edgeIdentity(edge: Pick<NormalizedReviewEdge, 'fromPath' | 'toPath' | 'edgeType' | 'typeOnly'>): string {
  return [edge.fromPath, edge.toPath, edge.edgeType, String(edge.typeOnly)].join('\0');
}

function graphEvidence(store: DataStore, project: Project): {
  graphFiles: NormalizedGraphFile[];
  edges: NormalizedReviewEdge[];
  rawEdges: ReturnType<DataStore['edges']['listByProject']>;
} {
  const graphFiles = store.files.listByProject(project.id)
    .flatMap((file): NormalizedGraphFile[] => {
      const relativePath = normalizedRelativePath(file.relativePath, project.rootPath);
      return relativePath === null ? [] : [{
        relativePath,
        extension: file.extension,
        language: sourceLanguage(relativePath),
        contentHash: file.contentHash,
        isEntryPoint: file.isEntryPoint,
      }];
    })
    .sort((left, right) => compareCodePoints(left.relativePath, right.relativePath));
  const graphPaths = new Set(graphFiles.map((file) => file.relativePath));
  const rawEdges = store.edges.listByProject(project.id);
  const byIdentity = new Map<string, {
    edge: Omit<NormalizedReviewEdge, 'sourceLines' | 'specifiers'>;
    sourceLines: Set<number>;
    specifiers: Set<string>;
  }>();

  for (const candidate of rawEdges) {
    if (!DEPENDENCY_EDGE_TYPES.includes(candidate.edgeType) || candidate.metadata.unresolved === true) continue;
    if (candidate.fromNodeType !== 'file' || candidate.toNodeType !== 'file') continue;
    const from = parseNodeId(candidate.fromNodeId);
    const to = parseNodeId(candidate.toNodeId);
    if (from?.type !== 'file' || to?.type !== 'file') continue;
    const fromPath = normalizedRelativePath(from.path, project.rootPath);
    const toPath = normalizedRelativePath(to.path, project.rootPath);
    if (!fromPath || !toPath || !graphPaths.has(fromPath) || !graphPaths.has(toPath)) continue;
    const edge = {
      fromPath,
      toPath,
      edgeType: candidate.edgeType,
      typeOnly: candidate.metadata.isTypeOnly === true,
    };
    const key = edgeIdentity(edge);
    let aggregate = byIdentity.get(key);
    if (!aggregate) {
      aggregate = { edge, sourceLines: new Set(), specifiers: new Set() };
      byIdentity.set(key, aggregate);
    }
    if (candidate.sourceLine !== null && Number.isSafeInteger(candidate.sourceLine)) {
      aggregate.sourceLines.add(candidate.sourceLine);
    }
    if (candidate.metadata.specifier) {
      aggregate.specifiers.add(sanitizeText(toPosixPath(candidate.metadata.specifier), project.rootPath));
    }
  }

  return {
    graphFiles,
    edges: [...byIdentity.values()]
      .map((aggregate) => ({
        ...aggregate.edge,
        sourceLines: [...aggregate.sourceLines].sort((left, right) => left - right),
        specifiers: [...aggregate.specifiers].sort(compareCodePoints),
      }))
      .sort((left, right) => compareCodePoints(edgeIdentity(left), edgeIdentity(right))),
    rawEdges,
  };
}

function findingEvidence(
  store: DataStore,
  project: Project,
  ruleFingerprints: ReadonlyMap<number, string>,
): { findings: ReviewFindingEvidence[]; architectureViolations: NormalizedArchitectureViolation[] } {
  const findingByIdentity = new Map<string, ReviewFindingEvidence>();
  const violationByIdentity = new Map<string, NormalizedArchitectureViolation>();

  for (const finding of store.findings.list(project.id, { includeDismissed: true })) {
    if (finding.findingType === 'type-error') continue;
    if (finding.findingType === 'architecture-violation') {
      const details = finding.details;
      if (details.kind !== 'architecture-violation') continue;
      const sourcePath = normalizedRelativePath(details.sourcePath, project.rootPath);
      const targetPath = normalizedRelativePath(details.targetPath, project.rootPath);
      const ruleFingerprint = ruleFingerprints.get(details.ruleId);
      if (!sourcePath || !targetPath || !ruleFingerprint) continue;
      const violation: NormalizedArchitectureViolation = {
        ruleId: details.ruleId,
        ruleFingerprint,
        sourcePath,
        targetPath,
        severity: finding.severity,
        line: details.line,
      };
      const key = [
        String(violation.ruleId),
        violation.ruleFingerprint,
        violation.sourcePath,
        violation.targetPath,
      ].join('\0');
      const existing = violationByIdentity.get(key);
      if (!existing || (violation.line ?? Number.MAX_SAFE_INTEGER) < (existing.line ?? Number.MAX_SAFE_INTEGER)) {
        violationByIdentity.set(key, violation);
      }
      continue;
    }

    const evidence: ReviewFindingEvidence = {
      findingType: finding.findingType,
      severity: finding.severity,
      title: sanitizeText(finding.title, project.rootPath),
      description: sanitizeText(finding.description, project.rootPath),
      relatedNodeIds: normalizedSet(finding.relatedNodeIds, (value) => (
        sanitizeText(toPosixPath(value), project.rootPath)
      )),
      details: sanitizeValue(finding.details, project.rootPath) as FindingDetails,
      fingerprint: finding.fingerprint,
      dismissed: finding.dismissedAt !== null,
    };
    findingByIdentity.set(`${evidence.findingType}\0${evidence.fingerprint}`, evidence);
  }

  return {
    findings: [...findingByIdentity.values()].sort((left, right) => compareCodePoints(
      `${left.findingType}\0${left.fingerprint}`,
      `${right.findingType}\0${right.fingerprint}`,
    )),
    architectureViolations: [...violationByIdentity.values()].sort((left, right) => compareCodePoints(
      [String(left.ruleId), left.ruleFingerprint, left.sourcePath, left.targetPath].join('\0'),
      [String(right.ruleId), right.ruleFingerprint, right.sourcePath, right.targetPath].join('\0'),
    )),
  };
}

function cycleEvidence(edges: readonly NormalizedReviewEdge[]): NormalizedCycle[] {
  const index = new GraphIndex(edges.map((edge) => ({
    from: edge.fromPath,
    to: edge.toPath,
    edgeType: edge.edgeType,
    unresolved: false,
    sourceLine: edge.sourceLines[0] ?? null,
    specifier: edge.specifiers[0] ?? null,
  })), { edgeTypes: DEPENDENCY_EDGE_TYPES });

  return detectCycles(index)
    .map((cycle) => ({
      memberPaths: [...cycle.nodes].sort(compareCodePoints),
      cyclePath: cycle.path.map(toPosixPath),
    }))
    .sort((left, right) => compareCodePoints(
      left.memberPaths.join('\0'),
      right.memberPaths.join('\0'),
    ));
}

function readRootManifest(projectRoot: string): unknown {
  try {
    return JSON.parse(readFileSync(`${projectRoot.replace(/[\\/]$/, '')}/package.json`, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function reachableExportEvidence(
  project: Project,
  graphFiles: readonly NormalizedGraphFile[],
  rawEdges: ReturnType<DataStore['edges']['listByProject']>,
  exportedSymbols: ReturnType<DataStore['symbols']['listExported']>,
): ReturnType<typeof discoverReachableExports> {
  const supportedPaths = new Set(graphFiles
    .filter((file) => TYPESCRIPT_FAMILY_EXTENSIONS.has(file.extension.toLowerCase()))
    .map((file) => file.relativePath));
  const modulesByPath = new Map<string, ExportModuleFact>();
  for (const path of supportedPaths) modulesByPath.set(path, { path, symbols: [], links: [] });

  for (const symbol of exportedSymbols) {
    const path = normalizedRelativePath(symbol.relativePath, project.rootPath);
    const module = path === null ? undefined : modulesByPath.get(path);
    if (!module) continue;
    module.symbols.push({
      name: symbol.name,
      exportedName: symbol.metadata.exportedAs ?? (symbol.isDefaultExport ? 'default' : symbol.name),
      kind: symbol.kind,
      line: symbol.startLine,
      isDefault: symbol.isDefaultExport,
      reExportedFrom: symbol.metadata.reExportedFrom ?? null,
    });
  }

  for (const edge of rawEdges) {
    if (edge.edgeType !== 're-export' || edge.fromNodeType !== 'file' || edge.toNodeType !== 'file') continue;
    const from = parseNodeId(edge.fromNodeId);
    const to = parseNodeId(edge.toNodeId);
    if (from?.type !== 'file' || to?.type !== 'file') continue;
    const fromPath = normalizedRelativePath(from.path, project.rootPath);
    const targetPath = normalizedRelativePath(to.path, project.rootPath);
    const module = fromPath === null ? undefined : modulesByPath.get(fromPath);
    if (!module) continue;
    module.links.push({
      targetPath: edge.metadata.unresolved === true || targetPath === null || !supportedPaths.has(targetPath)
        ? null
        : targetPath,
      specifier: sanitizeText(toPosixPath(edge.metadata.specifier ?? ''), project.rootPath),
      isStar: edge.metadata.isStarExport === true,
    });
  }

  const configured = project.configuration.entryPoints
    .map((path) => normalizedRelativePath(path, project.rootPath))
    .filter((path): path is string => path !== null);
  const manifest = packageEntryPointsFrom(readRootManifest(project.rootPath))
    .map((path) => normalizedRelativePath(path, project.rootPath))
    .filter((path): path is string => path !== null);
  const requestedEntryPoints = normalizedSet([...configured, ...manifest]);
  const graphPaths = new Set(graphFiles.map((file) => file.relativePath));
  const unsupportedEntryPoints = requestedEntryPoints.filter((path) => (
    graphPaths.has(path) && !supportedPaths.has(path)
  ));
  const result = discoverReachableExports(
    requestedEntryPoints.filter((path) => supportedPaths.has(path)),
    [...modulesByPath.values()],
  );
  if (unsupportedEntryPoints.length > 0) {
    result.limitations.push(limitation(
      'review',
      'UNSUPPORTED_EXPORT_SURFACE',
      'Reachable exports are available only for JavaScript and TypeScript family entry points.',
      unsupportedEntryPoints,
    ));
    result.limitations.sort((left, right) => compareCodePoints(left.stableKey, right.stableKey));
  }
  return result;
}

function limitation(
  scope: ReviewLimitation['scope'],
  code: string,
  message: string,
  paths: readonly string[],
  omittedCount = 0,
): ReviewLimitation {
  const orderedPaths = normalizedSet(paths);
  const evidence = { scope, code, message, paths: orderedPaths, omittedCount };
  return {
    itemType: 'limitation',
    stableKey: canonicalSha256(evidence),
    ...evidence,
  };
}

function scanLimitations(
  side: ReviewSnapshotSide,
  messages: readonly string[],
  project: Project,
  knownPaths: readonly string[],
): ReviewLimitation[] {
  const normalizedKnownPaths = normalizedSet(knownPaths);
  return messages.map((rawMessage) => {
    const searchable = toPosixPath(rawMessage);
    const extractedPaths = normalizedKnownPaths.filter((path) => searchable.includes(path));
    const retainedPaths = extractedPaths.slice(0, MAX_LIMITATION_PATHS);
    return limitation(
      side,
      'SCAN_LIMITATION',
      sanitizeText(rawMessage, project.rootPath),
      retainedPaths,
      extractedPaths.length - retainedPaths.length,
    );
  });
}

export function extractReviewSnapshot(input: {
  store: DataStore;
  project: Project;
  side: ReviewSnapshotSide;
  baseCommit: string;
  baseTreeId: string | null;
  workingTreeFingerprint: string;
  traceDeckVersion: string;
  extraInventory: readonly MaterializedInventoryEvidence[];
}): ReviewSnapshot {
  const scan = input.store.scans.latestCompletedForProject(input.project.id);
  if (!scan) throw new Error('A completed scan is required to extract a review snapshot.');

  const rules = input.store.rules.listEnabled(input.project.id);
  const fingerprints = configurationFingerprints(input.project, rules, input.traceDeckVersion);
  const inventory = inventoryEvidence(
    input.store,
    input.project,
    input.side,
    input.extraInventory,
  );
  const graph = graphEvidence(input.store, input.project);
  const findings = findingEvidence(input.store, input.project, fingerprints.byRuleId);
  const reachable = reachableExportEvidence(
    input.project,
    graph.graphFiles,
    graph.rawEdges,
    input.store.symbols.listExported(input.project.id),
  );
  const knownPaths = normalizedSet([
    ...inventory.map((entry) => entry.relativePath),
    ...graph.graphFiles.map((file) => file.relativePath),
  ]);
  const limitations = [
    ...scanLimitations(input.side, scan.summary?.limitations ?? [], input.project, knownPaths),
    ...reachable.limitations.map((entry) => limitation(
      input.side,
      entry.code,
      entry.message,
      entry.paths,
      entry.omittedCount,
    )),
    ...(input.project.configuration.typeCheck
      ? [limitation(
          'review',
          'TYPE_ERROR_BASELINE_NOT_COMPARABLE',
          TYPE_ERROR_LIMITATION_MESSAGE,
          [],
        )]
      : []),
  ].sort((left, right) => compareCodePoints(left.stableKey, right.stableKey));

  return {
    side: input.side,
    scanId: scan.id,
    baseCommit: input.baseCommit,
    baseTreeId: input.baseTreeId,
    workingTreeFingerprint: input.workingTreeFingerprint,
    userConfigurationFingerprint: fingerprints.user,
    effectiveBaselineFingerprint: fingerprints.effectiveBaseline,
    inventory,
    graphFiles: graph.graphFiles,
    edges: graph.edges,
    findings: findings.findings,
    architectureViolations: findings.architectureViolations,
    cycles: cycleEvidence(graph.edges),
    reachableExports: reachable.exports,
    limitations,
  };
}
