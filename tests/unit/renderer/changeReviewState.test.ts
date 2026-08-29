import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewFilters, ReviewStatus } from '@shared/changeReview';
// @ts-expect-error renderer module is not in the node tsconfig include list
import { useReviewStore } from '../../../src/renderer/src/store/reviewStore';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/src/lib/ipc', () => ({
  invoke: invokeMock,
}));

const BASE_COMMIT = 'a'.repeat(40);
const OPERATION_ID = '123e4567-e89b-42d3-a456-426614174000';

function status(overrides: Partial<ReviewStatus> = {}): ReviewStatus {
  return {
    projectId: 7,
    repositoryState: 'ready',
    baseCommit: BASE_COMMIT,
    baseTreeId: 'b'.repeat(40),
    branchName: 'main',
    gitChanges: [],
    latestReview: null,
    activeOperation: null,
    lastOutcome: null,
    ...overrides,
  };
}

describe('review store', () => {
  beforeEach(() => {
    useReviewStore.setState({ ...useReviewStore.getState() });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    invokeMock.mockReset();
    useReviewStore.getState().resetForProject(0);
  });

  it('loads status for a project and does not start a review while doing so', async () => {
    invokeMock.mockResolvedValueOnce(status());
    await useReviewStore.getState().loadStatus(7);
    expect(invokeMock).toHaveBeenCalledWith('review:status', { projectId: 7 });
    expect(invokeMock).not.toHaveBeenCalledWith('review:start', expect.anything());
    expect(useReviewStore.getState().status?.projectId).toBe(7);
  });

  it('resets state for a new project and clears any active poll timer', async () => {
    invokeMock.mockResolvedValueOnce(status({ activeOperation: {
      operationId: OPERATION_ID,
      phase: 'capturing',
      processed: 0,
      total: 10,
      message: 'Capturing…',
      cancellationRequested: false,
    } }));
    await useReviewStore.getState().loadStatus(7);
    useReviewStore.getState().resetForProject(9);
    expect(useReviewStore.getState().status).toBeNull();
    expect(useReviewStore.getState().loading).toBe(false);
  });

  it('polls status while an operation is active and stops when it completes', async () => {
    invokeMock
      .mockResolvedValueOnce(status({ activeOperation: {
        operationId: OPERATION_ID,
        phase: 'capturing',
        processed: 0,
        total: 10,
        message: 'Capturing…',
        cancellationRequested: false,
      } }))
      .mockResolvedValueOnce(status({ activeOperation: {
        operationId: OPERATION_ID,
        phase: 'comparing',
        processed: 5,
        total: 10,
        message: 'Comparing…',
        cancellationRequested: false,
      } }))
      .mockResolvedValueOnce(status());

    await useReviewStore.getState().loadStatus(7);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(invokeMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(500);
    // The third poll sees the operation complete, then fetches the summary.
    expect(invokeMock).toHaveBeenCalledTimes(4);
    expect(invokeMock).toHaveBeenLastCalledWith('review:summary', { projectId: 7 });

    await vi.advanceTimersByTimeAsync(500);
    expect(invokeMock).toHaveBeenCalledTimes(4);
    expect(useReviewStore.getState().status?.activeOperation).toBeNull();
  });

  it('loads summary after the active operation disappears', async () => {
    const summary = {
      reviewId: 7,
      projectId: 7,
      baseCommit: BASE_COMMIT,
      baseTreeId: 'b'.repeat(40),
      workingTreeFingerprint: 'working',
      userConfigurationFingerprint: 'config',
      effectiveBaselineFingerprint: 'baseline',
      traceDeckVersion: 'test',
      resultSchemaVersion: 1,
      traversalDepth: 5,
      completedAt: '2026-08-29T00:00:00.000Z',
      counts: {} as never,
      categoryAvailability: {} as never,
      limitations: [],
    };
    invokeMock
      .mockResolvedValueOnce(status({ activeOperation: {
        operationId: OPERATION_ID,
        phase: 'persisting',
        processed: 9,
        total: 10,
        message: 'Persisting…',
        cancellationRequested: false,
      } }))
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(summary);

    await useReviewStore.getState().loadStatus(7);
    await vi.advanceTimersByTimeAsync(500);
    expect(invokeMock).toHaveBeenLastCalledWith('review:summary', { projectId: 7 });
    expect(useReviewStore.getState().summary).toEqual(summary);
  });

  it('starts a review with the requested traversal depth and begins polling', async () => {
    invokeMock
      .mockResolvedValueOnce({ operationId: OPERATION_ID })
      .mockResolvedValueOnce(status({ activeOperation: {
        operationId: OPERATION_ID,
        phase: 'capturing',
        processed: 0,
        total: 10,
        message: 'Capturing…',
        cancellationRequested: false,
      } }));
    await useReviewStore.getState().startReview(7, 12);
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'review:start', { projectId: 7, traversalDepth: 12 });
    expect(useReviewStore.getState().operation?.operationId).toBe(OPERATION_ID);
  });

  it('requests cancellation and reflects the requested state', async () => {
    invokeMock.mockResolvedValueOnce({ requested: true });
    await useReviewStore.getState().cancelReview(7, OPERATION_ID);
    expect(invokeMock).toHaveBeenCalledWith('review:cancel', { projectId: 7, operationId: OPERATION_ID });
    expect(useReviewStore.getState().cancellationRequested).toBe(true);
  });

  it('ignores status responses from an older project generation after reset', async () => {
    invokeMock
      .mockResolvedValueOnce(status({ repositoryState: 'not-git' }))
      .mockResolvedValueOnce(status({ projectId: 9 }));
    const first = useReviewStore.getState().loadStatus(7);
    useReviewStore.getState().resetForProject(9);
    const second = useReviewStore.getState().loadStatus(9);
    await first;
    await second;
    expect(useReviewStore.getState().status?.projectId).toBe(9);
    expect(useReviewStore.getState().status?.repositoryState).toBe('ready');
  });

  it('marks a stale request generation and exposes it through state', () => {
    const first = useReviewStore.getState().markRequestGeneration();
    const second = useReviewStore.getState().markRequestGeneration();
    expect(second).toBeGreaterThan(first);
    expect(useReviewStore.getState().requestGeneration).toBe(second);
  });

  it('updates filters and retains them when changing tabs', () => {
    const filters: ReviewFilters = {
      changeTypes: ['modified'],
      gitStates: [],
      findingTypes: [],
      severities: [],
      deltaDirections: [],
      directness: [],
      languages: ['typescript'],
      folderPrefix: null,
      minDepth: null,
      maxDepth: null,
    };
    useReviewStore.getState().setFilters(filters);
    useReviewStore.getState().selectTab('files-and-edges');
    expect(useReviewStore.getState().filters).toEqual(filters);
    expect(useReviewStore.getState().selectedTab).toBe('files-and-edges');
  });

  it('clamps selected depth between 1 and 25', () => {
    useReviewStore.getState().setDepth(0);
    expect(useReviewStore.getState().selectedDepth).toBe(1);
    useReviewStore.getState().setDepth(99);
    expect(useReviewStore.getState().selectedDepth).toBe(25);
    useReviewStore.getState().setDepth(12);
    expect(useReviewStore.getState().selectedDepth).toBe(12);
  });
});
