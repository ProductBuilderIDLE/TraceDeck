import { create } from 'zustand';
import type {
  ChangeReviewSummary,
  ReviewFilters,
  ReviewOperationPhase,
  ReviewStatus,
} from '@shared/changeReview';
import { invoke } from '../lib/ipc';

export type ReviewWorkspaceTab =
  | 'overview'
  | 'files-and-edges'
  | 'findings'
  | 'possible-impact'
  | 'limitations';

export interface ReviewOperationState {
  operationId: string;
  phase: ReviewOperationPhase;
  processed: number;
  total: number;
  message: string;
  cancellationRequested: boolean;
}

interface ReviewState {
  status: ReviewStatus | null;
  summary: ChangeReviewSummary | null;
  operation: ReviewOperationState | null;
  selectedTab: ReviewWorkspaceTab;
  filters: ReviewFilters;
  selectedDepth: number;
  requestGeneration: number;
  loading: boolean;
  error: string | null;
  cancellationRequested: boolean;

  loadStatus: (projectId: number) => Promise<void>;
  loadSummary: (projectId: number) => Promise<void>;
  startReview: (projectId: number, traversalDepth: number) => Promise<void>;
  cancelReview: (projectId: number, operationId: string) => Promise<void>;
  selectTab: (tab: ReviewWorkspaceTab) => void;
  setFilters: (filters: ReviewFilters) => void;
  setDepth: (depth: number) => void;
  resetForProject: (projectId: number) => void;
  markRequestGeneration: () => number;
}

const POLL_INTERVAL_MS = 500;

const DEFAULT_FILTERS: ReviewFilters = {
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
};

function clampDepth(value: number): number {
  return Math.min(25, Math.max(1, Math.round(value)));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export const useReviewStore = create<ReviewState>((set, get) => {
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  function clearPoll(): void {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function scheduleNext(projectId: number, generation: number): void {
    clearPoll();
    pollTimer = setTimeout(() => {
      if (get().requestGeneration !== generation) return;
      void get().loadStatus(projectId);
    }, POLL_INTERVAL_MS);
  }

  return {
    status: null,
    summary: null,
    operation: null,
    selectedTab: 'overview',
    filters: DEFAULT_FILTERS,
    selectedDepth: 5,
    requestGeneration: 0,
    loading: false,
    error: null,
    cancellationRequested: false,

    markRequestGeneration: () => {
      const next = get().requestGeneration + 1;
      set({ requestGeneration: next });
      return next;
    },

    resetForProject: () => {
      clearPoll();
      const next = get().requestGeneration + 1;
      set({
        status: null,
        summary: null,
        operation: null,
        selectedTab: 'overview',
        filters: DEFAULT_FILTERS,
        selectedDepth: 5,
        requestGeneration: next,
        loading: false,
        error: null,
        cancellationRequested: false,
      });
    },

    loadStatus: async (projectId) => {
      const generation = get().markRequestGeneration();
      set({ loading: true, error: null });
      try {
        const next = await invoke('review:status', { projectId });
        if (generation !== get().requestGeneration) return;
        const wasActive = get().operation !== null;
        set({
          status: next,
          operation: next.activeOperation,
          loading: false,
        });
        if (next.activeOperation) {
          scheduleNext(projectId, generation);
        } else {
          clearPoll();
          // Once the operation is gone, refresh the summary. If a review completed,
          // this will fetch it; otherwise it returns null at minimal cost.
          if (wasActive) {
            await get().loadSummary(projectId);
          }
        }
      } catch (error) {
        if (generation !== get().requestGeneration) return;
        set({ error: messageOf(error), loading: false });
        clearPoll();
      }
    },

    loadSummary: async (projectId) => {
      const generation = get().markRequestGeneration();
      try {
        const next = await invoke('review:summary', { projectId });
        if (generation !== get().requestGeneration) return;
        set({ summary: next ?? null });
      } catch (error) {
        if (generation !== get().requestGeneration) return;
        set({ error: messageOf(error) });
      }
    },

    startReview: async (projectId, traversalDepth) => {
      const depth = clampDepth(traversalDepth);
      set({ error: null, cancellationRequested: false, summary: null });
      try {
        const { operationId } = await invoke('review:start', { projectId, traversalDepth: depth });
        set({ operation: { operationId, phase: 'capturing', processed: 0, total: 0, message: 'Starting review…', cancellationRequested: false } });
        await get().loadStatus(projectId);
      } catch (error) {
        set({ error: messageOf(error), loading: false });
      }
    },

    cancelReview: async (projectId, operationId) => {
      set({ cancellationRequested: true });
      try {
        await invoke('review:cancel', { projectId, operationId });
      } catch (error) {
        set({ error: messageOf(error), cancellationRequested: false });
      }
    },

    selectTab: (selectedTab) => set({ selectedTab }),

    setFilters: (filters) => set({ filters }),

    setDepth: (selectedDepth) => set({ selectedDepth: clampDepth(selectedDepth) }),
  };
});
