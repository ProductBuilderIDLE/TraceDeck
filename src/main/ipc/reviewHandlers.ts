import type { DataStore } from '../db';
import {
  ChangeReviewCoordinatorError,
  type ChangeReviewCoordinator,
} from '../services/changeReview/coordinator';
import { ChangeReviewQueryError, queryReview } from '../services/changeReview/query';
import { HandledError, type HandlerMap } from './registry';
import {
  parseReviewCancelRequest,
  parseReviewFileDiffRequest,
  parseReviewQueryRequest,
  parseReviewStartRequest,
  parseReviewStatusRequest,
  parseReviewSummaryRequest,
} from './reviewValidation';

const REVIEW_ERROR_MESSAGES: Record<string, string> = {
  NOT_FOUND: 'That project no longer exists.',
  NOT_A_GIT_REPO: 'The selected project is not a Git repository.',
  HEAD_UNBORN: 'The Git repository does not have a commit yet.',
  SCAN_IN_PROGRESS: 'A scan is already running for this project.',
  REVIEW_IN_PROGRESS: 'A change review is already running for this project.',
  REVIEW_CANCELLED: 'Change review cancelled.',
  REVIEW_STALE: 'That change review is no longer current.',
  REVIEW_GIT_TIMEOUT: 'Git did not finish in time while reading the change review.',
  INVALID_GIT_PATH_ENCODING: 'A Git path cannot be reviewed safely.',
  REVIEW_GIT_FAILED: 'Git review data could not be read.',
  REVIEW_INCOMPATIBLE: 'That change review was created by an incompatible version.',
  REVIEW_NOT_FOUND: 'That change review item no longer exists.',
  REVIEW_FAILED: 'The change review could not be completed.',
};

function mapReviewError(error: unknown): never {
  if (error instanceof HandledError) throw error;
  if (error instanceof ChangeReviewQueryError || error instanceof ChangeReviewCoordinatorError) {
    const message = REVIEW_ERROR_MESSAGES[error.code] ?? 'The change review request could not be completed.';
    throw new HandledError(message, error.code);
  }
  throw error;
}

async function handleReview<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return mapReviewError(error);
  }
}

export function reviewHandlers(
  store: DataStore,
  coordinator: ChangeReviewCoordinator,
): HandlerMap {
  return {
    'review:status': (payload) => handleReview(async () => {
      const { projectId } = parseReviewStatusRequest(payload);
      return coordinator.status(projectId);
    }),

    'review:start': (payload) => handleReview(() => {
      const { projectId, traversalDepth } = parseReviewStartRequest(payload);
      return coordinator.start(projectId, traversalDepth);
    }),

    'review:cancel': (payload) => handleReview(() => {
      const { projectId, operationId } = parseReviewCancelRequest(payload);
      return { requested: coordinator.cancel(projectId, operationId) };
    }),

    'review:summary': (payload) => handleReview(async () => {
      const { projectId } = parseReviewSummaryRequest(payload);
      return coordinator.summary(projectId);
    }),

    'review:query': (payload) => handleReview(() => {
      const request = parseReviewQueryRequest(payload);
      const record = store.changeReviews.findById(request.reviewId);
      if (!record || record.projectId !== request.projectId) {
        throw new ChangeReviewQueryError('REVIEW_NOT_FOUND');
      }
      return queryReview(record, request);
    }),

    'review:file-diff': (payload) => handleReview(async () => {
      const request = parseReviewFileDiffRequest(payload);
      const record = store.changeReviews.findById(request.reviewId);
      if (!record || record.projectId !== request.projectId) {
        throw new ChangeReviewQueryError('REVIEW_NOT_FOUND');
      }
      if (!record.compatible || !record.result) {
        throw new ChangeReviewQueryError('REVIEW_INCOMPATIBLE');
      }
      return coordinator.fileDiff(record, request.relativePath);
    }),
  };
}
