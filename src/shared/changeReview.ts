import type { EdgeType, FindingDetails, FindingType, Severity, SymbolKind } from './types';

export type ReviewRepositoryState = 'ready' | 'not-git' | 'unborn-head';
export type ReviewFreshness = 'current' | 'stale' | 'incompatible';
export type ReviewFileChangeType = 'added' | 'modified' | 'deleted' | 'renamed';
export type ReviewGitState = 'staged' | 'unstaged' | 'untracked';
export type ReviewDeltaDirection = 'added' | 'removed' | 'introduced' | 'resolved';
export type ReviewExportFormat = 'text' | 'json' | 'markdown' | 'html';
export type ReviewOperationPhase =
  | 'capturing'
  | 'refreshing-target'
  | 'materializing-baseline'
  | 'analyzing-baseline'
  | 'comparing'
  | 'validating'
  | 'persisting'
  | 'cleanup';

export type ReviewSection =
  | 'files'
  | 'edges'
  | 'findings'
  | 'architecture-violations'
  | 'cycles'
  | 'reachable-exports'
  | 'affected-files'
  | 'candidate-tests'
  | 'no-known-tests'
  | 'limitations';

export interface ReviewGitChange {
  itemType: 'file';
  stableKey: string;
  relativePath: string;
  oldPath: string | null;
  copiedFrom: string | null;
  changeType: ReviewFileChangeType;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  similarity: number | null;
  language: string | null;
}

export interface ReviewFileDiff {
  oldPath: string | null;
  newPath: string | null;
  diffText: string;
  truncated: boolean;
  returnedBytes: number;
  returnedLines: number;
  omittedBytes: number;
  omittedLines: number;
}

export interface ReviewStatus {
  projectId: number;
  repositoryState: ReviewRepositoryState;
  baseCommit: string | null;
  baseTreeId: string | null;
  branchName: string | null;
  gitChanges: ReviewGitChange[];
  latestReview: { reviewId: number; freshness: ReviewFreshness; staleReasons: string[] } | null;
  activeOperation: {
    operationId: string;
    phase: ReviewOperationPhase;
    processed: number;
    total: number;
    message: string;
    cancellationRequested: boolean;
  } | null;
  lastOutcome: {
    operationId: string;
    status: 'completed' | 'cancelled' | 'stale' | 'failed';
    code: string | null;
    message: string;
  } | null;
}

export interface ReviewEdgeChange {
  itemType: 'edge';
  stableKey: string;
  direction: 'added' | 'removed';
  fromPath: string;
  toPath: string;
  edgeType: EdgeType;
  typeOnly: boolean;
  sourceLines: number[];
  specifiers: string[];
}

export interface ReviewFindingEvidence {
  findingType: FindingType;
  severity: Severity;
  title: string;
  description: string;
  relatedNodeIds: string[];
  details: FindingDetails;
  fingerprint: string;
  dismissed: boolean;
}

export interface ReviewFindingChange {
  itemType: 'finding';
  stableKey: string;
  direction: 'introduced' | 'resolved';
  finding: ReviewFindingEvidence;
}

export interface ReviewArchitectureChange {
  itemType: 'architecture-violation';
  stableKey: string;
  direction: 'introduced' | 'resolved';
  ruleId: number;
  ruleFingerprint: string;
  sourcePath: string;
  targetPath: string;
  severity: Severity;
  line: number | null;
}

export interface ReviewCycleChange {
  itemType: 'cycle';
  stableKey: string;
  direction: 'added' | 'removed';
  memberPaths: string[];
  cyclePath: string[];
}

export interface ReviewExportChange {
  itemType: 'reachable-export';
  stableKey: string;
  direction: 'added' | 'removed';
  entryPoint: string;
  exportedName: string;
  symbolKind: SymbolKind;
  originPath: string;
  line: number | null;
}

export interface ReviewImpactExplanation {
  side: 'baseline' | 'target';
  originPath: string;
  path: string[];
  edgeTypes: EdgeType[];
}

export interface ReviewImpactItem {
  itemType: 'affected-file' | 'candidate-test';
  stableKey: string;
  destinationPath: string;
  depth: number;
  direct: boolean;
  originPaths: string[];
  baselinePresent: boolean;
  targetPresent: boolean;
  explanations: ReviewImpactExplanation[];
}

export interface ReviewNoKnownTest {
  itemType: 'no-known-test';
  stableKey: string;
  changedPath: string;
}

export interface ReviewLimitation {
  itemType: 'limitation';
  stableKey: string;
  scope: 'baseline' | 'target' | 'review' | 'truncation';
  code: string;
  message: string;
  paths: string[];
  omittedCount: number;
}

export interface ReviewGraphEvidence {
  nodePaths: string[];
  edges: Array<{
    fromPath: string;
    toPath: string;
    edgeType: EdgeType;
    side: 'baseline' | 'target';
  }>;
}

export type ReviewItem =
  | ReviewGitChange
  | ReviewEdgeChange
  | ReviewFindingChange
  | ReviewArchitectureChange
  | ReviewCycleChange
  | ReviewExportChange
  | ReviewImpactItem
  | ReviewNoKnownTest
  | ReviewLimitation;

export interface ReviewCategoryCount {
  totalCount: number;
  retainedCount: number;
  truncated: boolean;
  truncatedAtDepth: boolean;
}

export interface ReviewFilters {
  changeTypes: ReviewFileChangeType[];
  gitStates: ReviewGitState[];
  findingTypes: FindingType[];
  severities: Severity[];
  deltaDirections: ReviewDeltaDirection[];
  directness: Array<'direct' | 'indirect'>;
  languages: string[];
  folderPrefix: string | null;
  minDepth: number | null;
  maxDepth: number | null;
}

export interface ChangeReviewSummary {
  reviewId: number;
  projectId: number;
  baseCommit: string;
  baseTreeId: string | null;
  workingTreeFingerprint: string;
  userConfigurationFingerprint: string;
  effectiveBaselineFingerprint: string;
  traceDeckVersion: string;
  resultSchemaVersion: number;
  traversalDepth: number;
  completedAt: string;
  counts: Record<ReviewSection, ReviewCategoryCount>;
  categoryAvailability: Record<ReviewSection, boolean>;
  limitations: ReviewLimitation[];
}

export interface ReviewPage {
  reviewId: number;
  section: ReviewSection;
  items: ReviewItem[];
  nextCursor: string | null;
  returnedCount: number;
  retainedCount: number;
  totalCount: number;
  truncated: boolean;
  truncatedAtDepth: boolean;
}

export interface ChangeReviewResult {
  schemaVersion: number;
  baseCommit: string;
  baseTreeId: string | null;
  workingTreeFingerprint: string;
  userConfigurationFingerprint: string;
  effectiveBaselineFingerprint: string;
  workingTreeScanId: number;
  traversalDepth: number;
  fileChanges: ReviewGitChange[];
  edgeChanges: ReviewEdgeChange[];
  findingChanges: ReviewFindingChange[];
  architectureChanges: ReviewArchitectureChange[];
  cycleChanges: ReviewCycleChange[];
  exportChanges: ReviewExportChange[];
  affectedFiles: ReviewImpactItem[];
  candidateTests: ReviewImpactItem[];
  noKnownTests: ReviewNoKnownTest[];
  limitations: ReviewLimitation[];
  graphEvidence: ReviewGraphEvidence;
  counts: Record<ReviewSection, ReviewCategoryCount>;
}
