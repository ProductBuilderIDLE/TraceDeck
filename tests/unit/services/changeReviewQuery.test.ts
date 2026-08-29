import { describe, expect, it } from 'vitest';
import type { ChangeReviewRecord } from '@main/db';
import {
  ChangeReviewQueryError,
  decodeReviewCursor,
  encodeReviewCursor,
  queryReview,
} from '@main/services/changeReview/query';
import { ValidationError } from '@main/utils/validation';
import type {
  ChangeReviewResult,
  ReviewCategoryCount,
  ReviewFilters,
  ReviewItem,
  ReviewSection,
} from '@shared/changeReview';
import { REVIEW_RESULT_SCHEMA_VERSION } from '@shared/constants';

const SECTIONS: ReviewSection[] = [
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

function count(retainedCount = 1): ReviewCategoryCount {
  return { totalCount: retainedCount, retainedCount, truncated: false, truncatedAtDepth: false };
}

function fixture(): ChangeReviewRecord {
  const counts = Object.fromEntries(SECTIONS.map((section) => [section, count()])) as Record<
    ReviewSection,
    ReviewCategoryCount
  >;
  const result: ChangeReviewResult = {
    schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
    baseCommit: 'a'.repeat(40),
    baseTreeId: 'b'.repeat(40),
    workingTreeFingerprint: 'working',
    userConfigurationFingerprint: 'configuration',
    effectiveBaselineFingerprint: 'baseline',
    workingTreeScanId: 1,
    traversalDepth: 5,
    fileChanges: [{
      itemType: 'file', stableKey: 'file', relativePath: 'src/app.ts', oldPath: null,
      copiedFrom: null, changeType: 'modified', staged: true, unstaged: false,
      untracked: false, similarity: null, language: null,
    }],
    edgeChanges: [{
      itemType: 'edge', stableKey: 'edge', direction: 'added', fromPath: 'src/app.ts',
      toPath: 'lib/target.js', edgeType: 'import', typeOnly: false, sourceLines: [1], specifiers: ['./target'],
    }],
    findingChanges: [{
      itemType: 'finding', stableKey: 'finding', direction: 'introduced',
      finding: {
        findingType: 'syntax-error', severity: 'high', title: 'Syntax error', description: 'bad',
        relatedNodeIds: ['file:src/app.ts'], details: {}, fingerprint: 'finding', dismissed: false,
      },
    }],
    architectureChanges: [{
      itemType: 'architecture-violation', stableKey: 'architecture', direction: 'resolved',
      ruleId: 1, ruleFingerprint: 'rule', sourcePath: 'src/app.ts', targetPath: 'lib/target.js',
      severity: 'medium', line: 4,
    }],
    cycleChanges: [{
      itemType: 'cycle', stableKey: 'cycle', direction: 'removed',
      memberPaths: ['src/app.ts', 'lib/target.js'], cyclePath: ['src/app.ts', 'lib/target.js', 'src/app.ts'],
    }],
    exportChanges: [{
      itemType: 'reachable-export', stableKey: 'export', direction: 'added',
      entryPoint: 'src/index.ts', exportedName: 'run', symbolKind: 'function', originPath: 'src/app.ts', line: 1,
    }],
    affectedFiles: [{
      itemType: 'affected-file', stableKey: 'affected', destinationPath: 'src/consumer.ts', depth: 2,
      direct: false, originPaths: ['src/app.ts'], baselinePresent: true, targetPresent: true, explanations: [],
    }],
    candidateTests: [{
      itemType: 'candidate-test', stableKey: 'test', destinationPath: 'test/app.test.ts', depth: 1,
      direct: true, originPaths: ['src/app.ts'], baselinePresent: true, targetPresent: true, explanations: [],
    }],
    noKnownTests: [{ itemType: 'no-known-test', stableKey: 'no-test', changedPath: 'src/orphan.py' }],
    limitations: [{
      itemType: 'limitation', stableKey: 'limitation', scope: 'review', code: 'LIMITED',
      message: 'Limited evidence', paths: [], omittedCount: 0,
    }],
    graphEvidence: { nodePaths: [], edges: [] },
    counts,
  };
  return {
    id: 7,
    projectId: 3,
    baseCommit: result.baseCommit,
    baseTreeId: result.baseTreeId,
    workingTreeFingerprint: result.workingTreeFingerprint,
    userConfigurationFingerprint: result.userConfigurationFingerprint,
    effectiveBaselineFingerprint: result.effectiveBaselineFingerprint,
    workingTreeScanId: result.workingTreeScanId,
    traceDeckVersion: 'test',
    resultSchemaVersion: result.schemaVersion,
    traversalDepth: result.traversalDepth,
    completedAt: '2026-08-29T00:00:00.000Z',
    compatible: true,
    summary: null,
    result,
  };
}

function request(section: ReviewSection, reviewFilters: ReviewFilters) {
  return { reviewId: 7, section, filters: reviewFilters };
}

describe('review cursor', () => {
  it('round-trips canonical base64url JSON', () => {
    const cursor = encodeReviewCursor(7, 'files', 100);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeReviewCursor(cursor)).toEqual({ reviewId: 7, section: 'files', offset: 100 });
    expect(Buffer.from(cursor, 'base64url').toString('utf8')).toBe(
      '{"offset":100,"reviewId":7,"section":"files"}',
    );
  });

  it('rejects malformed, non-canonical, and negative cursors', () => {
    for (const cursor of [
      'not-json',
      Buffer.from('{}').toString('base64url'),
      Buffer.from('{"offset":-1,"reviewId":7,"section":"files"}').toString('base64url'),
      `${encodeReviewCursor(7, 'files', 0)}=`,
    ]) {
      expect(() => decodeReviewCursor(cursor)).toThrow(ValidationError);
    }
  });
});

describe('queryReview', () => {
  it.each([
    ['files', filters({ changeTypes: ['modified'], gitStates: ['staged'], languages: ['typescript'], folderPrefix: 'src' }), 'file'],
    ['edges', filters({ deltaDirections: ['added'], languages: ['typescript'], folderPrefix: 'src' }), 'edge'],
    ['findings', filters({ deltaDirections: ['introduced'], findingTypes: ['syntax-error'], severities: ['high'], languages: ['typescript'], folderPrefix: 'src' }), 'finding'],
    ['architecture-violations', filters({ deltaDirections: ['resolved'], severities: ['medium'], languages: ['typescript'], folderPrefix: 'src' }), 'architecture'],
    ['cycles', filters({ deltaDirections: ['removed'], folderPrefix: 'src' }), 'cycle'],
    ['reachable-exports', filters({ deltaDirections: ['added'], languages: ['typescript'], folderPrefix: 'src' }), 'export'],
    ['affected-files', filters({ directness: ['indirect'], languages: ['typescript'], folderPrefix: 'src', minDepth: 2, maxDepth: 2 }), 'affected'],
    ['candidate-tests', filters({ directness: ['direct'], languages: ['typescript'], folderPrefix: 'test', minDepth: 1, maxDepth: 1 }), 'test'],
    ['no-known-tests', filters({ languages: ['python'], folderPrefix: 'src' }), 'no-test'],
    ['limitations', filters(), 'limitation'],
  ] as const)('maps and filters the %s section', (section, reviewFilters, stableKey) => {
    const page = queryReview(fixture(), request(section, reviewFilters));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.stableKey).toBe(stableKey);
    expect(page).toMatchObject({ reviewId: 7, section, returnedCount: 1, retainedCount: 1, totalCount: 1 });
  });

  it('uses normalized folder prefix boundaries and derives language from the primary path', () => {
    const record = fixture();
    record.result!.fileChanges = [
      { ...record.result!.fileChanges[0]!, stableKey: 'inside', relativePath: 'src/nested/a.ts', language: null },
      { ...record.result!.fileChanges[0]!, stableKey: 'sibling', relativePath: 'src-old/a.ts', language: 'typescript' },
      { ...record.result!.fileChanges[0]!, stableKey: 'wrong-language', relativePath: 'src/a.py', language: 'typescript' },
    ];
    record.result!.counts.files = count(3);

    const page = queryReview(record, request('files', filters({
      folderPrefix: 'src/',
      languages: ['typescript'],
    })));

    expect(page.items.map((item) => item.stableKey)).toEqual(['inside']);
  });

  it('applies directness and inclusive depth bounds', () => {
    const record = fixture();
    const first = record.result!.affectedFiles[0]!;
    record.result!.affectedFiles = [
      { ...first, stableKey: 'too-shallow', depth: 1 },
      { ...first, stableKey: 'kept', depth: 2 },
      { ...first, stableKey: 'direct', depth: 2, direct: true },
      { ...first, stableKey: 'too-deep', depth: 3 },
    ];
    record.result!.counts['affected-files'] = count(4);

    const page = queryReview(record, request('affected-files', filters({
      directness: ['indirect'], minDepth: 2, maxDepth: 2,
    })));

    expect(page.items.map((item) => item.stableKey)).toEqual(['kept']);
  });

  it('preserves retained array order and treats empty filter arrays as no filter', () => {
    const record = fixture();
    const first = record.result!.fileChanges[0]!;
    record.result!.fileChanges = ['z-last', 'A-first', 'm-middle'].map((stableKey) => ({ ...first, stableKey }));
    record.result!.counts.files = count(3);

    expect(queryReview(record, request('files', filters())).items.map((item) => item.stableKey)).toEqual([
      'z-last', 'A-first', 'm-middle',
    ]);
  });

  it('defaults pages to 100, caps them at 500, and isolates cursors by review and section', () => {
    const record = fixture();
    const first = record.result!.fileChanges[0]!;
    record.result!.fileChanges = Array.from({ length: 510 }, (_, index) => ({
      ...first,
      stableKey: `file-${String(index).padStart(3, '0')}`,
    }));
    record.result!.counts.files = count(510);

    const firstPage = queryReview(record, request('files', filters()));
    expect(firstPage.items).toHaveLength(100);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = queryReview(record, {
      ...request('files', filters()),
      cursor: firstPage.nextCursor!,
      pageLimit: 999,
    });
    expect(secondPage.items).toHaveLength(410);
    expect(secondPage.items[0]?.stableKey).toBe('file-100');
    expect(secondPage.nextCursor).toBeNull();

    expect(() => queryReview(record, {
      ...request('files', filters()),
      cursor: encodeReviewCursor(8, 'files', 0),
    })).toThrow(expect.objectContaining({ code: 'REVIEW_STALE' }));
    expect(() => queryReview(record, {
      ...request('files', filters()),
      cursor: encodeReviewCursor(7, 'edges', 0),
    })).toThrow(expect.objectContaining({ code: 'REVIEW_STALE' }));
  });

  it('reports complete totals while filtering only retained details from a truncated category', () => {
    const record = fixture();
    const first = record.result!.fileChanges[0]!;
    record.result!.fileChanges = [
      { ...first, stableKey: 'kept', changeType: 'modified' },
      { ...first, stableKey: 'filtered', changeType: 'added' },
    ];
    record.result!.counts.files = {
      totalCount: 10,
      retainedCount: 2,
      truncated: true,
      truncatedAtDepth: true,
    };

    const page = queryReview(record, request('files', filters({ changeTypes: ['modified'] })));

    expect(page).toMatchObject({
      totalCount: 10,
      retainedCount: 1,
      returnedCount: 1,
      truncated: true,
      truncatedAtDepth: true,
    });
    expect(page.items.map((item) => item.stableKey)).toEqual(['kept']);
  });

  it('returns empty pages without inventing retained details', () => {
    const record = fixture();
    record.result!.noKnownTests = [];
    record.result!.counts['no-known-tests'] = count(0);
    expect(queryReview(record, request('no-known-tests', filters()))).toMatchObject({
      items: [], nextCursor: null, returnedCount: 0, retainedCount: 0, totalCount: 0,
    });
  });

  it('rejects missing and incompatible review records', () => {
    expect(() => queryReview(null as unknown as ChangeReviewRecord, request('files', filters())))
      .toThrow(new ChangeReviewQueryError('REVIEW_NOT_FOUND'));
    const incompatible = fixture();
    incompatible.compatible = false;
    incompatible.result = null;
    expect(() => queryReview(incompatible, request('files', filters())))
      .toThrow(new ChangeReviewQueryError('REVIEW_INCOMPATIBLE'));
  });

  it('does not mutate the stored result, request, filters, or retained items', () => {
    const record = fixture();
    const query = { ...request('files', filters({ changeTypes: ['modified'] })), pageLimit: 1 };
    const beforeRecord = structuredClone(record);
    const beforeQuery = structuredClone(query);

    const page = queryReview(record, query);
    (page.items as ReviewItem[]).splice(0, 1);

    expect(record).toEqual(beforeRecord);
    expect(query).toEqual(beforeQuery);
  });
});
