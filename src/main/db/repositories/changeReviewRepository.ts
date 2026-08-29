import type { Db } from '../connection';
import { nowIso, type ChangeReviewRow } from '../rows';
import type {
  ChangeReviewResult,
  ChangeReviewSummary,
  ReviewCategoryCount,
  ReviewLimitation,
  ReviewSection,
} from '@shared/changeReview';
import { REVIEW_RESULT_SCHEMA_VERSION } from '@shared/constants';

const REVIEW_SECTIONS: ReviewSection[] = [
  'files',
  'edges',
  'findings',
  'architecture-violations',
  'cycles',
  'reachable-exports',
  'affected-files',
  'candidate-tests',
  'no-known-tests',
  'limitations',
];

const RESULT_ARRAY_KEYS = [
  'fileChanges',
  'edgeChanges',
  'findingChanges',
  'architectureChanges',
  'cycleChanges',
  'exportChanges',
  'affectedFiles',
  'candidateTests',
  'noKnownTests',
  'limitations',
] as const;

type StoredChangeReviewSummary = Omit<ChangeReviewSummary, 'reviewId' | 'completedAt'>;

export interface ChangeReviewInsertInput {
  projectId: number;
  baseCommit: string;
  baseTreeId: string | null;
  workingTreeFingerprint: string;
  userConfigurationFingerprint: string;
  effectiveBaselineFingerprint: string;
  workingTreeScanId: number;
  traceDeckVersion: string;
  resultSchemaVersion: number;
  traversalDepth: number;
  summary: StoredChangeReviewSummary;
  result: ChangeReviewResult;
}

export interface ChangeReviewRecord {
  id: number;
  projectId: number;
  baseCommit: string;
  baseTreeId: string | null;
  workingTreeFingerprint: string;
  userConfigurationFingerprint: string;
  effectiveBaselineFingerprint: string;
  workingTreeScanId: number;
  traceDeckVersion: string;
  resultSchemaVersion: number;
  traversalDepth: number;
  completedAt: string;
  compatible: boolean;
  summary: ChangeReviewSummary | null;
  result: ChangeReviewResult | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isCategoryCount(value: unknown): value is ReviewCategoryCount {
  return (
    isRecord(value) &&
    isInteger(value.totalCount) &&
    isInteger(value.retainedCount) &&
    typeof value.truncated === 'boolean' &&
    typeof value.truncatedAtDepth === 'boolean'
  );
}

function isCounts(value: unknown): value is Record<ReviewSection, ReviewCategoryCount> {
  return isRecord(value) && REVIEW_SECTIONS.every((section) => isCategoryCount(value[section]));
}

function isAvailability(value: unknown): value is Record<ReviewSection, boolean> {
  return isRecord(value) && REVIEW_SECTIONS.every((section) => typeof value[section] === 'boolean');
}

function isLimitation(value: unknown): value is ReviewLimitation {
  return (
    isRecord(value) &&
    value.itemType === 'limitation' &&
    typeof value.stableKey === 'string' &&
    (value.scope === 'baseline' ||
      value.scope === 'target' ||
      value.scope === 'review' ||
      value.scope === 'truncation') &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    Array.isArray(value.paths) &&
    value.paths.every((path) => typeof path === 'string') &&
    isInteger(value.omittedCount)
  );
}

function isStoredSummary(value: unknown): value is StoredChangeReviewSummary {
  return (
    isRecord(value) &&
    isInteger(value.projectId) &&
    typeof value.baseCommit === 'string' &&
    isStringOrNull(value.baseTreeId) &&
    typeof value.workingTreeFingerprint === 'string' &&
    typeof value.userConfigurationFingerprint === 'string' &&
    typeof value.effectiveBaselineFingerprint === 'string' &&
    typeof value.traceDeckVersion === 'string' &&
    isInteger(value.resultSchemaVersion) &&
    isInteger(value.traversalDepth) &&
    isCounts(value.counts) &&
    isAvailability(value.categoryAvailability) &&
    Array.isArray(value.limitations) &&
    value.limitations.every(isLimitation)
  );
}

function isGraphEvidence(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.nodePaths) || !Array.isArray(value.edges)) {
    return false;
  }
  return (
    value.nodePaths.every((path) => typeof path === 'string') &&
    value.edges.every(
      (edge) =>
        isRecord(edge) &&
        typeof edge.fromPath === 'string' &&
        typeof edge.toPath === 'string' &&
        typeof edge.edgeType === 'string' &&
        (edge.side === 'baseline' || edge.side === 'target'),
    )
  );
}

function isChangeReviewResult(value: unknown): value is ChangeReviewResult {
  return (
    isRecord(value) &&
    isInteger(value.schemaVersion) &&
    typeof value.baseCommit === 'string' &&
    isStringOrNull(value.baseTreeId) &&
    typeof value.workingTreeFingerprint === 'string' &&
    typeof value.userConfigurationFingerprint === 'string' &&
    typeof value.effectiveBaselineFingerprint === 'string' &&
    isInteger(value.workingTreeScanId) &&
    isInteger(value.traversalDepth) &&
    RESULT_ARRAY_KEYS.every((key) => Array.isArray(value[key])) &&
    (value.limitations as unknown[]).every(isLimitation) &&
    isGraphEvidence(value.graphEvidence) &&
    isCounts(value.counts)
  );
}

function decodeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function mapChangeReview(row: ChangeReviewRow): ChangeReviewRecord {
  const base = {
    id: row.id,
    projectId: row.project_id,
    baseCommit: row.base_commit,
    baseTreeId: row.base_tree_id,
    workingTreeFingerprint: row.working_tree_fingerprint,
    userConfigurationFingerprint: row.user_configuration_fingerprint,
    effectiveBaselineFingerprint: row.effective_baseline_fingerprint,
    workingTreeScanId: row.working_tree_scan_id,
    traceDeckVersion: row.tracedeck_version,
    resultSchemaVersion: row.result_schema_version,
    traversalDepth: row.traversal_depth,
    completedAt: row.completed_at,
  };

  if (row.result_schema_version > REVIEW_RESULT_SCHEMA_VERSION) {
    return { ...base, compatible: false, summary: null, result: null };
  }

  const decodedSummary = decodeJson(row.summary_json);
  const decodedResult = decodeJson(row.retained_result_json);
  const summary =
    isStoredSummary(decodedSummary) &&
    decodedSummary.resultSchemaVersion === row.result_schema_version
      ? { ...decodedSummary, reviewId: row.id, completedAt: row.completed_at }
      : null;
  const result =
    isChangeReviewResult(decodedResult) && decodedResult.schemaVersion === row.result_schema_version
      ? decodedResult
      : null;

  return { ...base, compatible: summary !== null && result !== null, summary, result };
}

function serialize(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Change review data could not be serialized.');
  }
  return serialized;
}

export class ChangeReviewRepository {
  constructor(private readonly db: Db) {}

  latestForProject(projectId: number): ChangeReviewRecord | null {
    const row = this.db
      .prepare<[number], ChangeReviewRow>(
        `SELECT * FROM change_reviews WHERE project_id = ? LIMIT 1`,
      )
      .get(projectId);
    return row ? mapChangeReview(row) : null;
  }

  findById(id: number): ChangeReviewRecord | null {
    const row = this.db
      .prepare<[number], ChangeReviewRow>(`SELECT * FROM change_reviews WHERE id = ?`)
      .get(id);
    return row ? mapChangeReview(row) : null;
  }

  replaceLatest(input: ChangeReviewInsertInput): ChangeReviewRecord {
    // Serialization can invoke user-defined toJSON methods, so finish it before opening the
    // delete/insert transaction. A serialization failure must leave the retained row untouched.
    const summaryJson = serialize(input.summary);
    const resultJson = serialize(input.result);

    const replace = this.db.transaction(() => {
      const completedAt = nowIso();
      this.db.prepare(`DELETE FROM change_reviews WHERE project_id = ?`).run(input.projectId);
      const inserted = this.db
        .prepare(
          `INSERT INTO change_reviews (
             project_id, base_commit, base_tree_id, working_tree_fingerprint,
             user_configuration_fingerprint, effective_baseline_fingerprint,
             working_tree_scan_id, tracedeck_version, result_schema_version,
             traversal_depth, completed_at, summary_json, retained_result_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.projectId,
          input.baseCommit,
          input.baseTreeId,
          input.workingTreeFingerprint,
          input.userConfigurationFingerprint,
          input.effectiveBaselineFingerprint,
          input.workingTreeScanId,
          input.traceDeckVersion,
          input.resultSchemaVersion,
          input.traversalDepth,
          completedAt,
          summaryJson,
          resultJson,
        );
      return Number(inserted.lastInsertRowid);
    });

    const id = replace();
    const record = this.findById(id);
    if (!record) throw new Error(`Inserted change review ${id} could not be read back.`);
    return record;
  }

  removeForProject(projectId: number): boolean {
    return (
      this.db.prepare(`DELETE FROM change_reviews WHERE project_id = ?`).run(projectId).changes > 0
    );
  }
}
