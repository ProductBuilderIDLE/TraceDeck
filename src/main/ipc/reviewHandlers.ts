import { basename } from 'node:path';
import type { DataStore } from '../db';
import {
  ChangeReviewCoordinatorError,
  type ChangeReviewCoordinator,
} from '../services/changeReview/coordinator';
import { ChangeReviewQueryError, queryReview } from '../services/changeReview/query';
import { renderChangeReview, reviewFileExtension } from '../services/changeReview/report';
import { HandledError, type HandlerMap } from './registry';
import {
  parseReviewCancelRequest,
  parseReviewExportRequest,
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

export interface ReviewExportDependencies {
  showSaveDialog(defaultFileName: string): Promise<{ canceled: boolean; filePath?: string }>;
  writeFile(filePath: string, contents: string, encoding: 'utf8'): Promise<void>;
  generatedAt(): string;
}

function noopExportDependencies(): ReviewExportDependencies {
  return {
    showSaveDialog: async () => ({ canceled: true }),
    writeFile: async () => undefined,
    generatedAt: () => new Date().toISOString(),
  };
}

/** Strips anything that could steer a written file outside the folder the user picked. */
function safeFileName(value: string): string {
  const cleaned = value
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'tracedeck-review';
}

export function reviewHandlers(
  store: DataStore,
  coordinator: ChangeReviewCoordinator,
  dependencies: ReviewExportDependencies = noopExportDependencies(),
): HandlerMap {
  async function exportReview(
    projectId: number,
    reviewId: number,
    format: import('@shared/changeReview').ReviewExportFormat,
  ): Promise<import('@shared/ipc').ReviewExportResult> {
    const record = store.changeReviews.findById(reviewId);
    if (!record || record.projectId !== projectId) {
      throw new ChangeReviewQueryError('REVIEW_NOT_FOUND');
    }
    if (!record.compatible || !record.result) {
      throw new ChangeReviewQueryError('REVIEW_INCOMPATIBLE');
    }

    const project = store.projects.findById(projectId);
    if (!project) throw new ChangeReviewCoordinatorError('NOT_FOUND', '');

    const status = await coordinator.status(projectId);
    const latest = status.latestReview?.reviewId === record.id ? status.latestReview : null;
    const freshness = latest?.freshness ?? 'stale';
    const staleReasons = latest?.staleReasons ?? ['REVIEW_NOT_CURRENT'];

    const defaultName = `${safeFileName(project.name)}-change-review${reviewFileExtension(format)}`;
    const result = await dependencies.showSaveDialog(defaultName);
    if (result.canceled || !result.filePath) {
      return { cancelled: true, fileName: null };
    }

    const rendered = renderChangeReview(record.result, {
      freshness,
      staleReasons,
      generatedAt: dependencies.generatedAt(),
    }, format);

    await dependencies.writeFile(result.filePath, rendered, 'utf8');
    return { cancelled: false, fileName: basename(result.filePath) };
  }

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

    'review:export': (payload) => handleReview(async () => {
      const { projectId, reviewId, format } = parseReviewExportRequest(payload);
      return exportReview(projectId, reviewId, format);
    }),
  };
}
