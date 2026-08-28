// Domain model shared by the main process, the preload bridge, and the renderer.
// Everything here must be structured-clone friendly: no class instances, no functions.

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'react-component'
  | 'unknown';

export type NodeType = 'file' | 'symbol' | 'folder';

/**
 * Every edge kind the analyser actually produces.
 *
 * `reference` is import-level: "this file imports this name, which is declared there",
 * resolved through barrel files. It is deliberately not a call graph — nothing here records
 * that one function calls another.
 */
export type EdgeType =
  | 'import'
  | 'export'
  | 're-export'
  | 'dynamic-import'
  | 'require'
  | 'reference';

export type ScanStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type FindingType =
  | 'circular-dependency'
  | 'unused-export-candidate'
  | 'architecture-violation'
  | 'unresolved-import'
  | 'type-error';

export type Severity = 'info' | 'low' | 'medium' | 'high';

export interface Project {
  id: number;
  name: string;
  rootPath: string;
  createdAt: string;
  lastOpenedAt: string | null;
  lastScanAt: string | null;
  configuration: ProjectConfiguration;
}

export interface ProjectConfiguration {
  /** Extra glob patterns excluded on top of ALWAYS_EXCLUDED_DIRS and .gitignore. */
  excludePatterns: string[];
  /** Relative paths treated as public entry points; their exports are never "unused". */
  entryPoints: string[];
  respectGitignore: boolean;
  includeTestFiles: boolean;
  /**
   * Run the TypeScript type checker during a scan. Off by default because it is far slower
   * than the import scan and needs a compiler configuration to be meaningful.
   */
  typeCheck: boolean;
  /** Relative paths or `path#symbol` keys the user has permanently excused. */
  unusedExportExclusions: string[];
}

export const DEFAULT_PROJECT_CONFIGURATION: ProjectConfiguration = {
  excludePatterns: [],
  entryPoints: [],
  respectGitignore: true,
  includeTestFiles: true,
  typeCheck: false,
  unusedExportExclusions: [],
};

export interface Scan {
  id: number;
  projectId: number;
  startedAt: string;
  completedAt: string | null;
  status: ScanStatus;
  gitCommit: string | null;
  totalFiles: number;
  parsedFiles: number;
  errorCount: number;
  summary: ScanSummary | null;
}

export interface ScanSummary {
  totalFiles: number;
  /** Every retained project entry, including non-graph assets. */
  inventoryFiles: number;
  /** Supported source files retained in the dependency graph. */
  graphEligibleFiles: number;
  textOnlyFiles: number;
  binaryFiles: number;
  ignoredFiles: number;
  /** Entries excluded from analysis or unavailable for safe analysis. */
  unavailableFiles: number;
  parsedFiles: number;
  skippedUnchangedFiles: number;
  removedFiles: number;
  totalSymbols: number;
  totalEdges: number;
  unresolvedImports: number;
  dynamicImports: number;
  /** Distinct third-party packages imported. Expected, not a problem. */
  externalDependencies: number;
  cycles: number;
  unusedExportCandidates: number;
  architectureViolations: number;
  /** Null when type checking was not run for this scan. */
  typeCheck: TypeCheckSummary | null;
  durationMs: number;
  /** Honest record of what the analyser could not determine. */
  limitations: string[];
}

export interface TypeCheckSummary {
  ran: boolean;
  errorCount: number;
  warningCount: number;
  durationMs: number;
  /** Present when the check could not run; explains why in plain language. */
  skippedReason: string | null;
}

export type SourceTokenKind =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'type'
  | 'identifier'
  | 'punctuation'
  | 'plain';

export interface SourceSpan {
  text: string;
  kind: SourceTokenKind;
}

export interface SourceLine {
  number: number;
  spans: SourceSpan[];
}

export type SourceUnavailableReason =
  | 'binary'
  | 'too-large'
  | 'unreadable'
  | 'symlink'
  | 'unsupported-encoding';

export interface SourceTextDocument {
  kind: 'text';
  relativePath: string;
  lines: SourceLine[];
  /** True when the file was too long to render in full. */
  truncated: boolean;
  totalLines: number;
  sizeBytes: number;
  encoding: string;
  /** SHA-256 of the exact bytes read, used to detect edits made outside the app. */
  contentHash: string;
  /** Raw decoded text, so an editor can round-trip the file without re-reading it. */
  text: string;
  /** False when the file is viewable but must not be written back. */
  editable: boolean;
}

export interface SourceUnavailableDocument {
  kind: 'unavailable';
  relativePath: string;
  reason: SourceUnavailableReason;
  /** Plain-language explanation shown directly to the user. */
  message: string;
  sizeBytes: number;
}

export type SourceDocument = SourceTextDocument | SourceUnavailableDocument;

export interface SourceFile {
  id: number;
  projectId: number;
  relativePath: string;
  absolutePath: string;
  extension: string;
  contentHash: string;
  modifiedAt: string;
  isEntryPoint: boolean;
  scanId: number;
}

/** The filesystem entry types retained in the project inventory. */
export type ProjectFileEntryKind = 'regular' | 'symlink';

/** Whether the inventory classifier can safely treat the entry as text content. */
export type ProjectFileContentKind = 'text' | 'binary' | 'unknown';

export type ProjectFileAnalysisStatus =
  | 'eligible'
  | 'text-only'
  | 'binary'
  | 'excluded'
  | 'oversize'
  | 'unreadable'
  | 'symlink';

/**
 * Authoritative project inventory entry. Unlike SourceFile, this includes entries that are
 * visible but cannot or should not participate in dependency-graph analysis.
 */
export interface ProjectFile {
  id: number;
  projectId: number;
  relativePath: string;
  absolutePath: string;
  scanId: number;
  entryKind: ProjectFileEntryKind;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
  contentKind: ProjectFileContentKind;
  encoding: string | null;
  contentHash: string | null;
  isGitIgnored: boolean;
  gitignoreRule: string | null;
  isUserExcluded: boolean;
  analysisStatus: ProjectFileAnalysisStatus;
  analysisReason: string;
}

export interface ProjectFileCapabilityCounts {
  total: number;
  eligible: number;
  textOnly: number;
  binary: number;
  excluded: number;
  oversize: number;
  unreadable: number;
  symlink: number;
  gitIgnored: number;
  userExcluded: number;
}

export interface SymbolRecord {
  id: number;
  projectId: number;
  fileId: number;
  name: string;
  kind: SymbolKind;
  isExported: boolean;
  isDefaultExport: boolean;
  startLine: number;
  endLine: number;
  metadata: SymbolMetadata;
  scanId: number;
}

export interface SymbolMetadata {
  /** For re-exports: the module specifier the symbol originally came from. */
  reExportedFrom?: string;
  /** Name under which the symbol is exported, when it differs from its local name. */
  exportedAs?: string;
  isTypeOnly?: boolean;
  isAsync?: boolean;
  paramCount?: number;
}

export interface GraphEdge {
  id: number;
  projectId: number;
  fromNodeType: NodeType;
  fromNodeId: string;
  toNodeType: NodeType;
  toNodeId: string;
  edgeType: EdgeType;
  sourceFileId: number | null;
  sourceLine: number | null;
  metadata: EdgeMetadata;
  scanId: number;
}

export interface EdgeMetadata {
  specifier?: string;
  /** True when the import target could not be resolved to a file in this project. */
  unresolved?: boolean;
  /** True when the specifier resolved outside the project (a package dependency). */
  external?: boolean;
  isTypeOnly?: boolean;
  importedNames?: string[];
  /** Set on `export * from '...'` edges, which weaken unused-export confidence. */
  isStarExport?: boolean;
  /**
   * Set when the module specifier was computed at runtime rather than written literally.
   * Persisted so an incremental rescan reproduces the same finding without re-parsing.
   */
  dynamicExpression?: boolean;
}

export interface Finding {
  id: number;
  projectId: number;
  scanId: number;
  findingType: FindingType;
  severity: Severity;
  title: string;
  description: string;
  relatedNodeIds: string[];
  details: FindingDetails;
  createdAt: string;
  dismissedAt: string | null;
}

export type FindingDetails =
  | CycleDetails
  | UnusedExportDetails
  | ArchitectureViolationDetails
  | UnresolvedImportDetails
  | TypeErrorDetails
  | Record<string, never>;

export interface TypeErrorDetails {
  kind: 'type-error';
  filePath: string | null;
  line: number | null;
  column: number | null;
  /** The TypeScript error number, e.g. 2322. */
  code: number;
  category: 'error' | 'warning' | 'suggestion' | 'message';
  message: string;
}

export interface CycleDetails {
  kind: 'cycle';
  /** File relative paths in traversal order; the cycle closes back to the first entry. */
  cyclePath: string[];
  edges: Array<{ from: string; to: string; line: number | null; specifier: string | null }>;
}

export interface UnusedExportDetails {
  kind: 'unused-export';
  filePath: string;
  symbolName: string;
  symbolKind: SymbolKind;
  line: number;
  /** Why confidence is reduced, e.g. "reachable through a barrel file". */
  caveats: string[];
}

export interface ArchitectureViolationDetails {
  kind: 'architecture-violation';
  ruleId: number;
  ruleName: string;
  sourcePath: string;
  targetPath: string;
  line: number | null;
  specifier: string | null;
}

export interface UnresolvedImportDetails {
  kind: 'unresolved-import';
  filePath: string;
  specifier: string;
  line: number | null;
  reason:
    | 'dynamic-expression'
    | 'alias-not-configured'
    | 'file-not-found'
    | 'external-package'
    | 'non-source-asset';
}

export type ArchitectureRuleType = 'forbid-import';

export interface ArchitectureRule {
  id: number;
  projectId: number;
  name: string;
  enabled: boolean;
  ruleType: ArchitectureRuleType;
  sourcePattern: string;
  targetPattern: string;
  configuration: ArchitectureRuleConfiguration;
  createdAt: string;
  updatedAt: string;
}

export interface ArchitectureRuleConfiguration {
  severity: Severity;
  /** Glob patterns exempted from this rule even when they match sourcePattern. */
  exceptions: string[];
}

export interface SavedReport {
  id: number;
  projectId: number;
  name: string;
  reportType: ReportFormat;
  configuration: ReportConfiguration;
  createdAt: string;
}

export type ReportFormat = 'markdown' | 'json' | 'html';

export type ReportScope =
  | { kind: 'project' }
  | { kind: 'file'; filePath: string }
  | { kind: 'symbol'; filePath: string; symbolName: string }
  | { kind: 'finding-type'; findingType: FindingType };

export interface ReportConfiguration {
  title: string;
  scope: ReportScope;
  sections: ReportSection[];
  format: ReportFormat;
}

export type ReportSection =
  | 'summary'
  | 'cycles'
  | 'unused-exports'
  | 'architecture-violations'
  | 'unresolved-imports'
  | 'type-errors'
  | 'top-impact-files'
  | 'blast-radius'
  | 'limitations';

// --- Analysis results (computed, not persisted verbatim) ---

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  /** Relative path for files and folders; `path#symbol` for symbols. */
  path: string;
  symbolKind?: SymbolKind;
  isEntryPoint?: boolean;
  inCycle?: boolean;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: Array<{
    id: string;
    source: string;
    target: string;
    edgeType: EdgeType;
    unresolved: boolean;
  }>;
  truncated: boolean;
  totalNodeCount: number;
}

export interface BlastRadiusEntry {
  nodeId: string;
  path: string;
  nodeType: NodeType;
  depth: number;
  /** Shortest chain from the selected node back to this dependent, inclusive of both ends. */
  explanationPath: string[];
  edgeTypes: EdgeType[];
}

export interface BlastRadiusResult {
  rootNodeId: string;
  rootPath: string;
  maxDepth: number;
  directDependents: BlastRadiusEntry[];
  transitiveDependents: BlastRadiusEntry[];
  directDependencies: BlastRadiusEntry[];
  transitiveDependencies: BlastRadiusEntry[];
  /** Nodes reached only through edges the analyser could not fully resolve. */
  partialResultWarnings: string[];
  truncatedAtDepth: boolean;
}

export interface RiskScoreFactor {
  key: string;
  label: string;
  rawValue: number | boolean;
  points: number;
  maxPoints: number;
  explanation: string;
}

export interface RiskScore {
  nodeId: string;
  path: string;
  score: number;
  factors: RiskScoreFactor[];
  formulaDescription: string;
}

export interface DashboardStats {
  project: Project;
  lastScan: Scan | null;
  /** Authoritative project inventory total, not the dependency-graph subset. */
  totalFiles: number;
  graphEligibleFiles: number;
  textOnlyFiles: number;
  binaryFiles: number;
  ignoredFiles: number;
  unavailableFiles: number;
  totalSymbols: number;
  totalEdges: number;
  cycleCount: number;
  unusedExportCandidateCount: number;
  architectureViolationCount: number;
  unresolvedImportCount: number;
  typeErrorCount: number;
  topImpactFiles: RiskScore[];
}

export interface SearchResult {
  nodeId: string;
  type: NodeType;
  label: string;
  path: string;
  symbolKind?: SymbolKind;
  isExported?: boolean;
  line?: number;
}

export interface FileDetail {
  file: SourceFile;
  symbols: SymbolRecord[];
  directDependencies: BlastRadiusEntry[];
  directDependents: BlastRadiusEntry[];
  riskScore: RiskScore;
  inCycle: boolean;
}

export interface ScanProgress {
  scanId: number;
  phase:
    | 'discovering'
    | 'parsing'
    | 'resolving'
    | 'analysing'
    | 'type-checking'
    | 'persisting'
    | 'done'
    | 'failed';
  processed: number;
  total: number;
  message: string;
}
