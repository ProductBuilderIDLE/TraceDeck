import { describe, expect, it } from 'vitest';
import {
  parseReviewCancelRequest,
  parseReviewFileDiffRequest,
  parseReviewQueryRequest,
  parseReviewStartRequest,
  parseReviewStatusRequest,
  parseReviewSummaryRequest,
} from '@main/ipc/reviewValidation';
import { encodeReviewCursor } from '@main/services/changeReview/query';
import { ValidationError } from '@main/utils/validation';
import type { ReviewFilters, ReviewSection } from '@shared/changeReview';

const OPERATION_ID = '123e4567-e89b-42d3-a456-426614174000';

function filters(overrides: Partial<ReviewFilters> = {}): ReviewFilters {
  return {
    changeTypes: [],
    gitStates: [],
    findingTypes: [],
    severities: [],
    deltaDirections: [],
    directness: [],
    languages: [],
    folderPrefix: null,
    minDepth: null,
    maxDepth: null,
    ...overrides,
  };
}

function query(section: ReviewSection = 'files', overrides: Partial<ReviewFilters> = {}) {
  return { projectId: 2, reviewId: 7, section, filters: filters(overrides) };
}

describe('review IPC request validation', () => {
  it('rejects non-object payloads for every channel before use', () => {
    const parsers = [
      parseReviewStatusRequest,
      parseReviewStartRequest,
      parseReviewCancelRequest,
      parseReviewSummaryRequest,
      parseReviewQueryRequest,
      parseReviewFileDiffRequest,
    ];
    for (const parse of parsers) {
      for (const payload of [null, undefined, 'payload', 1, []]) {
        expect(() => parse(payload)).toThrow(ValidationError);
      }
    }
  });

  it('requires positive integer project and review IDs', () => {
    expect(parseReviewStatusRequest({ projectId: 1 })).toEqual({ projectId: 1 });
    expect(parseReviewSummaryRequest({ projectId: 3 })).toEqual({ projectId: 3 });
    for (const projectId of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseReviewStatusRequest({ projectId })).toThrow(ValidationError);
    }
    for (const reviewId of [0, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseReviewQueryRequest({ ...query(), reviewId })).toThrow(ValidationError);
    }
  });

  it('requires an integer start depth and clamps it to 1-25', () => {
    expect(parseReviewStartRequest({ projectId: 2, traversalDepth: -9 })).toEqual({
      projectId: 2,
      traversalDepth: 1,
    });
    expect(parseReviewStartRequest({ projectId: 2, traversalDepth: 99 })).toEqual({
      projectId: 2,
      traversalDepth: 25,
    });
    expect(() => parseReviewStartRequest({ projectId: 2, traversalDepth: 2.5 })).toThrow(
      ValidationError,
    );
  });

  it('accepts only a bounded UUID operation ID string', () => {
    expect(parseReviewCancelRequest({ projectId: 2, operationId: OPERATION_ID })).toEqual({
      projectId: 2,
      operationId: OPERATION_ID,
    });
    for (const operationId of [7, '', 'not-an-operation', `${OPERATION_ID}extra`]) {
      expect(() => parseReviewCancelRequest({ projectId: 2, operationId })).toThrow(ValidationError);
    }
  });

  it('validates known section and filter enum values', () => {
    expect(parseReviewQueryRequest(query('files', {
      changeTypes: ['renamed'],
      gitStates: ['unstaged'],
      languages: ['typescript'],
    }))).toMatchObject({
      section: 'files',
      filters: { changeTypes: ['renamed'], gitStates: ['unstaged'], languages: ['typescript'] },
    });
    expect(() => parseReviewQueryRequest({ ...query(), section: 'unknown' })).toThrow(ValidationError);
    expect(() => parseReviewQueryRequest(query('files', {
      changeTypes: ['invalid' as 'added'],
    }))).toThrow(ValidationError);
    expect(() => parseReviewQueryRequest(query('findings', {
      findingTypes: ['invalid' as 'syntax-error'],
    }))).toThrow(ValidationError);
    expect(() => parseReviewQueryRequest(query('findings', {
      severities: ['critical' as 'high'],
    }))).toThrow(ValidationError);
  });

  it('requires every closed filter array and validates all array members', () => {
    const arrayFields = [
      'changeTypes',
      'gitStates',
      'findingTypes',
      'severities',
      'deltaDirections',
      'directness',
      'languages',
    ] as const;
    for (const field of arrayFields) {
      const missing = filters() as unknown as Record<string, unknown>;
      delete missing[field];
      expect(() => parseReviewQueryRequest({ ...query(), filters: missing })).toThrow(ValidationError);
      expect(() => parseReviewQueryRequest({ ...query(), filters: { ...filters(), [field]: null } }))
        .toThrow(ValidationError);
    }
    expect(() => parseReviewQueryRequest(query('files', {
      languages: ['typescript', ''],
    }))).toThrow(ValidationError);
  });

  it('requires nullable folder and depth fields and normalizes their values', () => {
    expect(parseReviewQueryRequest(query('affected-files', {
      folderPrefix: './src\\nested/',
      minDepth: 0,
      maxDepth: 4,
    })).filters).toMatchObject({
      folderPrefix: 'src/nested',
      minDepth: 0,
      maxDepth: 4,
    });
    for (const field of ['folderPrefix', 'minDepth', 'maxDepth'] as const) {
      const missing = filters() as unknown as Record<string, unknown>;
      delete missing[field];
      expect(() => parseReviewQueryRequest({ ...query(), filters: missing })).toThrow(ValidationError);
    }
    expect(() => parseReviewQueryRequest(query('affected-files', { minDepth: 4, maxDepth: 2 })))
      .toThrow(ValidationError);
  });

  it('rejects filters and direction values that are not applicable to the selected section', () => {
    expect(() => parseReviewQueryRequest(query('files', { directness: ['direct'] })))
      .toThrow(ValidationError);
    expect(() => parseReviewQueryRequest(query('edges', { deltaDirections: ['introduced'] })))
      .toThrow(ValidationError);
    expect(() => parseReviewQueryRequest(query('limitations', { folderPrefix: 'src' })))
      .toThrow(ValidationError);
    expect(() => parseReviewQueryRequest(query('no-known-tests', { severities: ['high'] })))
      .toThrow(ValidationError);
  });

  it('normalizes safe relative paths and rejects absolute or traversal paths', () => {
    expect(parseReviewFileDiffRequest({
      projectId: 2,
      reviewId: 7,
      relativePath: 'src\\renamed.ts',
    })).toEqual({ projectId: 2, reviewId: 7, relativePath: 'src/renamed.ts' });
    for (const relativePath of [
      '',
      '../outside.ts',
      'src/../../outside.ts',
      '/etc/passwd',
      'C:\\private\\file.ts',
      '\\\\server\\share\\file.ts',
    ]) {
      expect(() => parseReviewFileDiffRequest({ projectId: 2, reviewId: 7, relativePath }))
        .toThrow(ValidationError);
    }
  });

  it('rejects undeclared fields such as arbitrary refs on every closed request', () => {
    expect(() => parseReviewFileDiffRequest({
      projectId: 2,
      reviewId: 7,
      relativePath: 'src/app.ts',
      ref: 'other-branch',
    })).toThrow(ValidationError);
    expect(() => parseReviewStartRequest({ projectId: 2, traversalDepth: 5, command: 'git reset' }))
      .toThrow(ValidationError);
    expect(() => parseReviewQueryRequest({ ...query(), destination: 'C:\\private' }))
      .toThrow(ValidationError);
  });

  it('bounds cursors and defaults/clamps page limits consistently', () => {
    expect(parseReviewQueryRequest(query())).toMatchObject({ pageLimit: 100 });
    expect(parseReviewQueryRequest({ ...query(), pageLimit: 900 })).toMatchObject({ pageLimit: 500 });
    expect(() => parseReviewQueryRequest({ ...query(), pageLimit: 0 })).toThrow(ValidationError);
    expect(() => parseReviewQueryRequest({ ...query(), cursor: 'x'.repeat(1025) })).toThrow(
      ValidationError,
    );
    const cursor = encodeReviewCursor(7, 'files', 25);
    expect(parseReviewQueryRequest({ ...query(), cursor, pageLimit: 25 }))
      .toMatchObject({ cursor, pageLimit: 25 });
  });
});
