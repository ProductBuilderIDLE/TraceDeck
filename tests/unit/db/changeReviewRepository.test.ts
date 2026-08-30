import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataStore } from '@main/db';
import { openDatabase } from '@main/db/connection';
import type { ChangeReviewInsertInput } from '@main/db/repositories/changeReviewRepository';
import { REVIEW_RESULT_SCHEMA_VERSION } from '@shared/constants';
import type { ReviewCategoryCount, ReviewSection } from '@shared/changeReview';

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

function emptyCounts(): Record<ReviewSection, ReviewCategoryCount> {
  return Object.fromEntries(
    REVIEW_SECTIONS.map((section) => [
      section,
      { totalCount: 0, retainedCount: 0, truncated: false, truncatedAtDepth: false },
    ]),
  ) as Record<ReviewSection, ReviewCategoryCount>;
}

function categoryAvailability(): Record<ReviewSection, boolean> {
  return Object.fromEntries(REVIEW_SECTIONS.map((section) => [section, true])) as Record<
    ReviewSection,
    boolean
  >;
}

describe('ChangeReviewRepository', () => {
  let store: DataStore;

  beforeEach(() => {
    store = new DataStore(openDatabase({ filePath: ':memory:' }));
  });

  afterEach(() => {
    store.close();
  });

  function seedProject() {
    return store.projects.createOrTouch('demo', '/tmp/demo');
  }

  function reviewInput(projectId: number, baseCommit: string): ChangeReviewInsertInput {
    const workingScan = store.scans.start(projectId, baseCommit);
    const counts = emptyCounts();
    const baseTreeId = `tree-${baseCommit}`;
    const workingTreeFingerprint = `working-${baseCommit}`;
    const userConfigurationFingerprint = 'configuration-fixed';
    const effectiveBaselineFingerprint = `baseline-${baseCommit}`;
    const traceDeckVersion = '0.0.0-test';
    const traversalDepth = 3;

    return {
      projectId,
      baseCommit,
      baseTreeId,
      workingTreeFingerprint,
      userConfigurationFingerprint,
      effectiveBaselineFingerprint,
      workingTreeScanId: workingScan.id,
      traceDeckVersion,
      resultSchemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
      traversalDepth,
      summary: {
        projectId,
        baseCommit,
        baseTreeId,
        workingTreeFingerprint,
        userConfigurationFingerprint,
        effectiveBaselineFingerprint,
        traceDeckVersion,
        resultSchemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
        traversalDepth,
        counts,
        categoryAvailability: categoryAvailability(),
        limitations: [],
      },
      result: {
        schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
        baseCommit,
        baseTreeId,
        workingTreeFingerprint,
        userConfigurationFingerprint,
        effectiveBaselineFingerprint,
        workingTreeScanId: workingScan.id,
        traversalDepth,
        fileChanges: [],
        edgeChanges: [],
        findingChanges: [],
        architectureChanges: [],
        cycleChanges: [],
        exportChanges: [],
        affectedFiles: [],
        candidateTests: [],
        noKnownTests: [],
        limitations: [],
        graphEvidence: { nodePaths: [], edges: [] },
        counts,
      },
    };
  }

  it('looks up the latest completed review for a project', () => {
    const project = seedProject();
    expect(store.changeReviews.latestForProject(project.id)).toBeNull();
    const input = reviewInput(project.id, 'first');

    const inserted = store.changeReviews.replaceLatest(input);

    expect(store.changeReviews.latestForProject(project.id)).toEqual(inserted);
    expect(inserted).toMatchObject({
      projectId: project.id,
      baseCommit: 'first',
      compatible: true,
      result: input.result,
    });
    expect(inserted.summary).toEqual({
      ...input.summary,
      reviewId: inserted.id,
      completedAt: inserted.completedAt,
    });
  });

  it('atomically replaces the project review so only the latest is retained', () => {
    const project = seedProject();
    const first = store.changeReviews.replaceLatest(reviewInput(project.id, 'first'));

    const second = store.changeReviews.replaceLatest(reviewInput(project.id, 'second'));

    expect(second.id).not.toBe(first.id);
    expect(store.changeReviews.latestForProject(project.id)?.baseCommit).toBe('second');
    expect(store.changeReviews.findById(first.id)).toBeNull();
    expect(store.db.prepare('SELECT COUNT(*) FROM change_reviews').pluck().get()).toBe(1);
  });

  it('finds a completed review by ID', () => {
    const project = seedProject();
    const inserted = store.changeReviews.replaceLatest(reviewInput(project.id, 'first'));

    expect(store.changeReviews.findById(inserted.id)).toEqual(inserted);
    expect(store.changeReviews.findById(inserted.id + 1)).toBeNull();
  });

  it('deletes a review when its project is deleted', () => {
    const project = seedProject();
    const inserted = store.changeReviews.replaceLatest(reviewInput(project.id, 'first'));

    store.projects.remove(project.id);

    expect(store.changeReviews.findById(inserted.id)).toBeNull();
  });

  it('keeps a review when its informational working scan is pruned', () => {
    const project = seedProject();
    const input = reviewInput(project.id, 'first');
    const inserted = store.changeReviews.replaceLatest(input);
    const newerScan = store.scans.start(project.id, 'newer');

    store.scans.pruneOlderScans(project.id, newerScan.id);

    expect(store.scans.findById(input.workingTreeScanId)).toBeNull();
    expect(store.changeReviews.findById(inserted.id)).toEqual(inserted);
  });

  it('maps corrupt summary or result JSON as incompatible without inventing data', () => {
    const project = seedProject();
    const input = reviewInput(project.id, 'first');
    const inserted = store.changeReviews.replaceLatest(input);
    const storedSummary = store.db
      .prepare('SELECT summary_json FROM change_reviews WHERE id = ?')
      .pluck()
      .get(inserted.id) as string;

    store.db
      .prepare('UPDATE change_reviews SET summary_json = ? WHERE id = ?')
      .run('{broken', inserted.id);
    const corruptSummary = store.changeReviews.findById(inserted.id);
    expect(corruptSummary).toMatchObject({
      compatible: false,
      summary: null,
      result: input.result,
    });

    store.db
      .prepare('UPDATE change_reviews SET summary_json = ?, retained_result_json = ? WHERE id = ?')
      .run(storedSummary, '{}', inserted.id);
    const corruptResult = store.changeReviews.findById(inserted.id);
    expect(corruptResult).toMatchObject({ compatible: false, result: null });
    expect(corruptResult?.summary).toEqual({
      ...input.summary,
      reviewId: inserted.id,
      completedAt: inserted.completedAt,
    });
  });

  it('preserves a newer result schema but does not expose it as compatible', () => {
    const project = seedProject();
    const input = reviewInput(project.id, 'future');
    input.resultSchemaVersion = REVIEW_RESULT_SCHEMA_VERSION + 1;
    input.summary.resultSchemaVersion = REVIEW_RESULT_SCHEMA_VERSION + 1;
    input.result.schemaVersion = REVIEW_RESULT_SCHEMA_VERSION + 1;

    const inserted = store.changeReviews.replaceLatest(input);

    expect(inserted).toMatchObject({
      resultSchemaVersion: REVIEW_RESULT_SCHEMA_VERSION + 1,
      compatible: false,
      summary: null,
      result: null,
    });
    expect(store.db.prepare('SELECT COUNT(*) FROM change_reviews').pluck().get()).toBe(1);
    expect(store.changeReviews.latestForProject(project.id)?.id).toBe(inserted.id);
  });

  it('removes the retained review for a project', () => {
    const project = seedProject();
    store.changeReviews.replaceLatest(reviewInput(project.id, 'first'));

    expect(store.changeReviews.removeForProject(project.id)).toBe(true);
    expect(store.changeReviews.removeForProject(project.id)).toBe(false);
    expect(store.changeReviews.latestForProject(project.id)).toBeNull();
  });

  it('rolls a rejected replacement back without losing the prior review', () => {
    const project = seedProject();
    const first = store.changeReviews.replaceLatest(reviewInput(project.id, 'first'));
    store.db.exec(`
      CREATE TRIGGER reject_change_review
      BEFORE INSERT ON change_reviews
      WHEN NEW.base_commit = 'reject'
      BEGIN
        SELECT RAISE(ROLLBACK, 'rejected');
      END;
    `);

    expect(() => store.changeReviews.replaceLatest(reviewInput(project.id, 'reject'))).toThrow(
      /rejected/,
    );

    expect(store.changeReviews.latestForProject(project.id)).toEqual(first);
    expect(store.db.prepare('SELECT COUNT(*) FROM change_reviews').pluck().get()).toBe(1);
  });
});
