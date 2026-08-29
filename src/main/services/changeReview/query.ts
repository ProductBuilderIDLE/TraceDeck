import { Buffer } from 'node:buffer';
import type { ChangeReviewRecord } from '../../db';
import { ValidationError } from '../../utils/validation';
import type { ReviewQueryRequest } from '@shared/ipc';
import { parseNodeId } from '@shared/nodeIds';
import { sourceLanguage } from '@shared/sourceLanguage';
import type {
  ReviewArchitectureChange,
  ReviewCycleChange,
  ReviewDeltaDirection,
  ReviewEdgeChange,
  ReviewExportChange,
  ReviewFilters,
  ReviewFindingChange,
  ReviewGitChange,
  ReviewImpactItem,
  ReviewItem,
  ReviewNoKnownTest,
  ReviewPage,
  ReviewSection,
} from '@shared/changeReview';
import { canonicalStringify } from './canonical';

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
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;

const FILTER_FIELDS = [
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
] as const satisfies readonly (keyof ReviewFilters)[];

const APPLICABLE_FILTERS: Record<ReviewSection, readonly (keyof ReviewFilters)[]> = {
  files: ['changeTypes', 'gitStates', 'languages', 'folderPrefix'],
  edges: ['deltaDirections', 'languages', 'folderPrefix'],
  findings: ['deltaDirections', 'findingTypes', 'severities', 'languages', 'folderPrefix'],
  'architecture-violations': ['deltaDirections', 'severities', 'languages', 'folderPrefix'],
  cycles: ['deltaDirections', 'folderPrefix'],
  'reachable-exports': ['deltaDirections', 'languages', 'folderPrefix'],
  'affected-files': ['directness', 'languages', 'folderPrefix', 'minDepth', 'maxDepth'],
  'candidate-tests': ['directness', 'languages', 'folderPrefix', 'minDepth', 'maxDepth'],
  'no-known-tests': ['languages', 'folderPrefix'],
  limitations: [],
};

const DIRECTIONS_BY_SECTION: Partial<Record<ReviewSection, readonly ReviewDeltaDirection[]>> = {
  edges: ['added', 'removed'],
  findings: ['introduced', 'resolved'],
  'architecture-violations': ['introduced', 'resolved'],
  cycles: ['added', 'removed'],
  'reachable-exports': ['added', 'removed'],
};

const QUERY_ERROR_MESSAGES = {
  REVIEW_NOT_FOUND: 'That change review no longer exists.',
  REVIEW_INCOMPATIBLE: 'That change review was created by an incompatible version.',
  REVIEW_STALE: 'That change review is no longer current.',
} as const;

export type ChangeReviewQueryErrorCode = keyof typeof QUERY_ERROR_MESSAGES;

export class ChangeReviewQueryError extends Error {
  constructor(readonly code: ChangeReviewQueryErrorCode) {
    super(QUERY_ERROR_MESSAGES[code]);
    this.name = 'ChangeReviewQueryError';
  }
}

function invalidCursor(): never {
  throw new ValidationError('Field "cursor" must be a valid review cursor.');
}

function isReviewSection(value: unknown): value is ReviewSection {
  return typeof value === 'string' && (REVIEW_SECTIONS as readonly string[]).includes(value);
}

export function encodeReviewCursor(
  reviewId: number,
  section: ReviewSection,
  offset: number,
): string {
  if (!Number.isSafeInteger(reviewId) || reviewId < 1 || !isReviewSection(section)) invalidCursor();
  if (!Number.isSafeInteger(offset) || offset < 0) invalidCursor();
  return Buffer.from(canonicalStringify({ reviewId, section, offset }), 'utf8').toString('base64url');
}

export function decodeReviewCursor(
  cursor: string,
): { reviewId: number; section: ReviewSection; offset: number } {
  if (typeof cursor !== 'string' || cursor.length === 0 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    invalidCursor();
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    invalidCursor();
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) invalidCursor();
  const value = decoded as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes('reviewId') || !keys.includes('section') || !keys.includes('offset')) {
    invalidCursor();
  }
  if (!Number.isSafeInteger(value.reviewId) || (value.reviewId as number) < 1) invalidCursor();
  if (!isReviewSection(value.section)) invalidCursor();
  if (!Number.isSafeInteger(value.offset) || (value.offset as number) < 0) invalidCursor();

  const result = {
    reviewId: value.reviewId as number,
    section: value.section,
    offset: value.offset as number,
  };
  if (encodeReviewCursor(result.reviewId, result.section, result.offset) !== cursor) invalidCursor();
  return result;
}

function filterHasValue(filters: ReviewFilters, field: keyof ReviewFilters): boolean {
  const value = filters[field];
  return Array.isArray(value) ? value.length > 0 : value !== null;
}

/** Ensures a typed filter cannot silently affect a section where it has no meaning. */
export function assertReviewFiltersApplicable(section: ReviewSection, filters: ReviewFilters): void {
  const applicable = new Set<keyof ReviewFilters>(APPLICABLE_FILTERS[section]);
  for (const field of FILTER_FIELDS) {
    if (!applicable.has(field) && filterHasValue(filters, field)) {
      throw new ValidationError(`Filter "${field}" is not applicable to section "${section}".`);
    }
  }

  const allowedDirections = DIRECTIONS_BY_SECTION[section];
  if (allowedDirections) {
    for (const direction of filters.deltaDirections) {
      if (!allowedDirections.includes(direction)) {
        throw new ValidationError(
          `Filter "deltaDirections" contains a direction not applicable to section "${section}".`,
        );
      }
    }
  }
}

function normalizedPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function primaryPath(item: ReviewItem): string | null {
  switch (item.itemType) {
    case 'file': return item.relativePath;
    case 'edge': return item.fromPath;
    case 'finding': {
      for (const nodeId of item.finding.relatedNodeIds) {
        const parsed = parseNodeId(nodeId);
        if (parsed) return parsed.path;
      }
      return null;
    }
    case 'architecture-violation': return item.sourcePath;
    case 'cycle': return item.memberPaths[0] ?? null;
    case 'reachable-export': return item.originPath;
    case 'affected-file':
    case 'candidate-test': return item.destinationPath;
    case 'no-known-test': return item.changedPath;
    case 'limitation': return item.paths[0] ?? null;
  }
}

function matchesPathFilters(item: ReviewItem, filters: ReviewFilters): boolean {
  if (filters.languages.length === 0 && filters.folderPrefix === null) return true;
  const itemPath = primaryPath(item);
  if (itemPath === null) return false;
  const path = normalizedPath(itemPath);
  if (filters.languages.length > 0 && !filters.languages.includes(sourceLanguage(path))) return false;
  if (filters.folderPrefix !== null) {
    const prefix = normalizedPath(filters.folderPrefix);
    if (path !== prefix && !path.startsWith(`${prefix}/`)) return false;
  }
  return true;
}

function matchesFile(item: ReviewGitChange, filters: ReviewFilters): boolean {
  if (filters.changeTypes.length > 0 && !filters.changeTypes.includes(item.changeType)) return false;
  if (filters.gitStates.length > 0 && !filters.gitStates.some((state) => item[state])) return false;
  return matchesPathFilters(item, filters);
}

function matchesDirection(
  item: ReviewEdgeChange | ReviewFindingChange | ReviewArchitectureChange | ReviewCycleChange | ReviewExportChange,
  filters: ReviewFilters,
): boolean {
  return filters.deltaDirections.length === 0 || filters.deltaDirections.includes(item.direction);
}

function matchesFinding(item: ReviewFindingChange, filters: ReviewFilters): boolean {
  return matchesDirection(item, filters)
    && (filters.findingTypes.length === 0 || filters.findingTypes.includes(item.finding.findingType))
    && (filters.severities.length === 0 || filters.severities.includes(item.finding.severity))
    && matchesPathFilters(item, filters);
}

function matchesArchitecture(item: ReviewArchitectureChange, filters: ReviewFilters): boolean {
  return matchesDirection(item, filters)
    && (filters.severities.length === 0 || filters.severities.includes(item.severity))
    && matchesPathFilters(item, filters);
}

function matchesImpact(item: ReviewImpactItem, filters: ReviewFilters): boolean {
  if (
    filters.directness.length > 0
    && !filters.directness.includes(item.direct ? 'direct' : 'indirect')
  ) return false;
  if (filters.minDepth !== null && item.depth < filters.minDepth) return false;
  if (filters.maxDepth !== null && item.depth > filters.maxDepth) return false;
  return matchesPathFilters(item, filters);
}

function retainedItems(record: ChangeReviewRecord, section: ReviewSection): ReviewItem[] {
  const result = record.result;
  if (!result) return [];
  switch (section) {
    case 'files': return result.fileChanges;
    case 'edges': return result.edgeChanges;
    case 'findings': return result.findingChanges;
    case 'architecture-violations': return result.architectureChanges;
    case 'cycles': return result.cycleChanges;
    case 'reachable-exports': return result.exportChanges;
    case 'affected-files': return result.affectedFiles;
    case 'candidate-tests': return result.candidateTests;
    case 'no-known-tests': return result.noKnownTests;
    case 'limitations': return result.limitations;
  }
}

function filteredItems(
  items: readonly ReviewItem[],
  section: ReviewSection,
  filters: ReviewFilters,
): ReviewItem[] {
  switch (section) {
    case 'files':
      return (items as readonly ReviewGitChange[]).filter((item) => matchesFile(item, filters));
    case 'edges':
      return (items as readonly ReviewEdgeChange[]).filter((item) => (
        matchesDirection(item, filters) && matchesPathFilters(item, filters)
      ));
    case 'findings':
      return (items as readonly ReviewFindingChange[]).filter((item) => matchesFinding(item, filters));
    case 'architecture-violations':
      return (items as readonly ReviewArchitectureChange[])
        .filter((item) => matchesArchitecture(item, filters));
    case 'cycles':
      return (items as readonly ReviewCycleChange[]).filter((item) => matchesDirection(item, filters));
    case 'reachable-exports':
      return (items as readonly ReviewExportChange[]).filter((item) => (
        matchesDirection(item, filters) && matchesPathFilters(item, filters)
      ));
    case 'affected-files':
    case 'candidate-tests':
      return (items as readonly ReviewImpactItem[]).filter((item) => matchesImpact(item, filters));
    case 'no-known-tests':
      return (items as readonly ReviewNoKnownTest[]).filter((item) => matchesPathFilters(item, filters));
    case 'limitations':
      return [...items];
  }
}

function normalizedPageLimit(pageLimit: number | undefined): number {
  if (pageLimit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(pageLimit) || pageLimit < 1) {
    throw new ValidationError('Field "pageLimit" must be an integer >= 1.');
  }
  return Math.min(pageLimit, MAX_PAGE_LIMIT);
}

export function queryReview(
  record: ChangeReviewRecord,
  request: Omit<ReviewQueryRequest, 'projectId'>,
): ReviewPage {
  if (!record || record.id !== request.reviewId) throw new ChangeReviewQueryError('REVIEW_NOT_FOUND');
  if (!record.compatible || !record.result) throw new ChangeReviewQueryError('REVIEW_INCOMPATIBLE');
  assertReviewFiltersApplicable(request.section, request.filters);

  const cursor = request.cursor === undefined
    ? { reviewId: request.reviewId, section: request.section, offset: 0 }
    : decodeReviewCursor(request.cursor);
  if (cursor.reviewId !== request.reviewId || cursor.section !== request.section) {
    throw new ChangeReviewQueryError('REVIEW_STALE');
  }

  const pageLimit = normalizedPageLimit(request.pageLimit);
  const retained = filteredItems(retainedItems(record, request.section), request.section, request.filters);
  const items = retained.slice(cursor.offset, cursor.offset + pageLimit);
  const nextOffset = cursor.offset + items.length;
  const category = record.result.counts[request.section];

  return {
    reviewId: record.id,
    section: request.section,
    items,
    nextCursor: nextOffset < retained.length
      ? encodeReviewCursor(record.id, request.section, nextOffset)
      : null,
    returnedCount: items.length,
    retainedCount: retained.length,
    totalCount: category.totalCount,
    truncated: category.truncated,
    truncatedAtDepth: category.truncatedAtDepth,
  };
}
