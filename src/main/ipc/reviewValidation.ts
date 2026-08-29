import { ALL_FINDING_TYPES } from '@shared/types';
import type {
  ReviewCancelRequest,
  ReviewExportRequest,
  ReviewFileDiffRequest,
  ReviewQueryRequest,
  ReviewStartRequest,
  ReviewStatusRequest,
  ReviewSummaryRequest,
} from '@shared/ipc';
import type {
  ReviewDeltaDirection,
  ReviewExportFormat,
  ReviewFileChangeType,
  ReviewFilters,
  ReviewGitState,
  ReviewSection,
} from '@shared/changeReview';
import type { FindingType, Severity } from '@shared/types';
import {
  asObject,
  clampInt,
  requireEnum,
  requireInt,
  requireNonEmptyString,
} from '../utils/validation';
import { ValidationError } from '../utils/validation';
import {
  ChangeReviewQueryError,
  assertReviewFiltersApplicable,
  decodeReviewCursor,
} from '../services/changeReview/query';

const REVIEW_SECTIONS: readonly ReviewSection[] = [
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
const EXPORT_FORMATS: readonly ReviewExportFormat[] = ['text', 'json', 'markdown', 'html'];
const FILE_CHANGE_TYPES: readonly ReviewFileChangeType[] = ['added', 'modified', 'deleted', 'renamed'];
const GIT_STATES: readonly ReviewGitState[] = ['staged', 'unstaged', 'untracked'];
const SEVERITIES: readonly Severity[] = ['info', 'low', 'medium', 'high'];
const DELTA_DIRECTIONS: readonly ReviewDeltaDirection[] = [
  'added',
  'removed',
  'introduced',
  'resolved',
];
const DIRECTNESS = ['direct', 'indirect'] as const;
const FILTER_KEYS: readonly (keyof ReviewFilters)[] = [
  'changeTypes',
  'gitStates',
  'findingTypes',
  'severities',
  'deltaDirections',
  'directness',
  'languages',
  'folderPrefix',
  'minDepth',
  'maxDepth',
];
const MAX_CURSOR_LENGTH = 1024;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rejectUnexpectedFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field = 'payload',
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) {
    throw new ValidationError(`Field "${field}.${unexpected}" is not allowed.`);
  }
}

function requireOwn(value: Record<string, unknown>, field: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    throw new ValidationError(`Field "${field}" is required.`);
  }
  return value[field];
}

function requirePositiveId(value: unknown, field: string): number {
  const id = requireInt(value, field, 1);
  if (!Number.isSafeInteger(id)) {
    throw new ValidationError(`Field "${field}" must be a safe positive integer.`);
  }
  return id;
}

function requireEnumArray<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`Field "${field}" must be an array.`);
  }
  if (value.length > 100) {
    throw new ValidationError(`Field "${field}" must be an array of at most 100 items.`);
  }
  return value.map((item, index) => requireEnum(item, `${field}[${index}]`, allowed));
}

function requireLanguages(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError('Field "filters.languages" must be an array.');
  }
  if (value.length > 100) {
    throw new ValidationError('Field "filters.languages" must be an array of at most 100 items.');
  }
  const normalized = value.map((item, index) => (
    requireNonEmptyString(item, `filters.languages[${index}]`, 64).trim().toLowerCase()
  ));
  return [...new Set(normalized)];
}

function normalizeRelativePath(value: unknown, field: string, allowTrailingSlash: boolean): string {
  const raw = requireNonEmptyString(value, field, 4096);
  if (raw.includes('\0')) {
    throw new ValidationError(`Field "${field}" must be a safe relative path.`);
  }
  let normalized = raw.replaceAll('\\', '/');
  if (
    normalized.startsWith('/')
    || /^[A-Za-z]:($|\/)/.test(normalized)
    || normalized.startsWith('//')
  ) {
    throw new ValidationError(`Field "${field}" must be a relative path.`);
  }
  normalized = normalized.replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  if (allowTrailingSlash) normalized = normalized.replace(/\/+$/, '');
  const parts = normalized.split('/');
  if (normalized.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new ValidationError(`Field "${field}" must be a safe relative path.`);
  }
  return normalized;
}

function requireNullableDepth(value: Record<string, unknown>, field: 'minDepth' | 'maxDepth'): number | null {
  const depth = requireOwn(value, field);
  return depth === null ? null : requireInt(depth, `filters.${field}`, 0);
}

function parseFilters(value: unknown, section: ReviewSection): ReviewFilters {
  const source = asObject(value, 'filters');
  rejectUnexpectedFields(source, FILTER_KEYS, 'filters');
  const folderValue = requireOwn(source, 'folderPrefix');
  const parsed: ReviewFilters = {
    changeTypes: requireEnumArray(
      requireOwn(source, 'changeTypes'),
      'filters.changeTypes',
      FILE_CHANGE_TYPES,
    ),
    gitStates: requireEnumArray(requireOwn(source, 'gitStates'), 'filters.gitStates', GIT_STATES),
    findingTypes: requireEnumArray<FindingType>(
      requireOwn(source, 'findingTypes'),
      'filters.findingTypes',
      ALL_FINDING_TYPES,
    ),
    severities: requireEnumArray(requireOwn(source, 'severities'), 'filters.severities', SEVERITIES),
    deltaDirections: requireEnumArray(
      requireOwn(source, 'deltaDirections'),
      'filters.deltaDirections',
      DELTA_DIRECTIONS,
    ),
    directness: requireEnumArray(requireOwn(source, 'directness'), 'filters.directness', DIRECTNESS),
    languages: requireLanguages(requireOwn(source, 'languages')),
    folderPrefix: folderValue === null
      ? null
      : normalizeRelativePath(folderValue, 'filters.folderPrefix', true),
    minDepth: requireNullableDepth(source, 'minDepth'),
    maxDepth: requireNullableDepth(source, 'maxDepth'),
  };
  if (parsed.minDepth !== null && parsed.maxDepth !== null && parsed.minDepth > parsed.maxDepth) {
    throw new ValidationError('Filter "minDepth" must not exceed "maxDepth".');
  }
  assertReviewFiltersApplicable(section, parsed);
  return parsed;
}

export function parseReviewStatusRequest(payload: unknown): ReviewStatusRequest {
  const value = asObject(payload);
  rejectUnexpectedFields(value, ['projectId']);
  return { projectId: requirePositiveId(value.projectId, 'projectId') };
}

export function parseReviewStartRequest(payload: unknown): ReviewStartRequest {
  const value = asObject(payload);
  rejectUnexpectedFields(value, ['projectId', 'traversalDepth']);
  return {
    projectId: requirePositiveId(value.projectId, 'projectId'),
    traversalDepth: clampInt(requireInt(value.traversalDepth, 'traversalDepth'), 1, 25),
  };
}

export function parseReviewCancelRequest(payload: unknown): ReviewCancelRequest {
  const value = asObject(payload);
  rejectUnexpectedFields(value, ['projectId', 'operationId']);
  const operationId = requireNonEmptyString(value.operationId, 'operationId', 36);
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new ValidationError('Field "operationId" must be a UUID string.');
  }
  return { projectId: requirePositiveId(value.projectId, 'projectId'), operationId };
}

export function parseReviewSummaryRequest(payload: unknown): ReviewSummaryRequest {
  const value = asObject(payload);
  rejectUnexpectedFields(value, ['projectId']);
  return { projectId: requirePositiveId(value.projectId, 'projectId') };
}

export function parseReviewQueryRequest(payload: unknown): ReviewQueryRequest {
  const value = asObject(payload);
  rejectUnexpectedFields(value, ['projectId', 'reviewId', 'section', 'filters', 'cursor', 'pageLimit']);
  const projectId = requirePositiveId(value.projectId, 'projectId');
  const reviewId = requirePositiveId(value.reviewId, 'reviewId');
  const section = requireEnum(value.section, 'section', REVIEW_SECTIONS);
  const parsed: ReviewQueryRequest = {
    projectId,
    reviewId,
    section,
    filters: parseFilters(value.filters, section),
    pageLimit: value.pageLimit === undefined
      ? DEFAULT_PAGE_LIMIT
      : Math.min(requireInt(value.pageLimit, 'pageLimit', 1), MAX_PAGE_LIMIT),
  };
  if (value.cursor !== undefined) {
    const cursor = requireNonEmptyString(value.cursor, 'cursor', MAX_CURSOR_LENGTH);
    const decoded = decodeReviewCursor(cursor);
    if (decoded.reviewId !== reviewId || decoded.section !== section) {
      throw new ChangeReviewQueryError('REVIEW_STALE');
    }
    parsed.cursor = cursor;
  }
  return parsed;
}

export function parseReviewFileDiffRequest(payload: unknown): ReviewFileDiffRequest {
  const value = asObject(payload);
  rejectUnexpectedFields(value, ['projectId', 'reviewId', 'relativePath']);
  return {
    projectId: requirePositiveId(value.projectId, 'projectId'),
    reviewId: requirePositiveId(value.reviewId, 'reviewId'),
    relativePath: normalizeRelativePath(value.relativePath, 'relativePath', false),
  };
}

export function parseReviewExportRequest(payload: unknown): ReviewExportRequest {
  const value = asObject(payload);
  rejectUnexpectedFields(value, ['projectId', 'reviewId', 'format']);
  return {
    projectId: requirePositiveId(value.projectId, 'projectId'),
    reviewId: requirePositiveId(value.reviewId, 'reviewId'),
    format: requireEnum(value.format, 'format', EXPORT_FORMATS),
  };
}
