import { useEffect, useState } from 'react';
import type {
  ChangeReviewSummary,
  ReviewFileDiff,
  ReviewFilters as ReviewFiltersType,
  ReviewPage,
  ReviewSection,
} from '@shared/changeReview';
import { useReviewStore, type ReviewOperationState, type ReviewWorkspaceTab } from '../../store/reviewStore';
import { useAppStore } from '../../store/appStore';
import { ReviewHeader } from '../changeReview/ReviewHeader';
import { ReviewTabs } from '../changeReview/ReviewTabs';
import { ReviewFilters } from '../changeReview/ReviewFilters';
import { ReviewPage as ReviewPageView } from '../changeReview/ReviewPage';
import { ReviewDiff } from '../changeReview/ReviewDiff';
import { Button, Card, Caveat, EmptyState, StatTile, Warning } from '../common/ui';
import { invoke } from '../../lib/ipc';

const TAB_SECTIONS: Record<ReviewWorkspaceTab, ReviewSection | null> = {
  overview: null,
  'files-and-edges': 'files',
  findings: 'findings',
  'possible-impact': 'affected-files',
  limitations: 'limitations',
};

const SECTION_TITLES: Record<ReviewSection, string> = {
  files: 'Changed files',
  edges: 'Added and removed edges',
  findings: 'Findings',
  'architecture-violations': 'Architecture violations',
  cycles: 'Cycles',
  'reachable-exports': 'Reachable exports',
  'affected-files': 'Affected files',
  'candidate-tests': 'Candidate tests',
  'no-known-tests': 'No known tests',
  limitations: 'Limitations',
};

const FILE_DIFF_PATH_LENGTH_LIMIT = 4096;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

interface PageState {
  section: ReviewSection | null;
  page: ReviewPage | null;
  previousCursors: string[];
  currentCursor: string | undefined;
  loading: boolean;
  error: string | null;
  requestGeneration: number;
}

export function ChangeReview(): JSX.Element {
  const currentProject = useAppStore((state) => state.currentProject);
  const {
    status,
    summary,
    operation,
    selectedTab,
    selectedDepth,
    filters,
    loading,
    error,
    cancellationRequested,
    loadStatus,
    loadPage,
    startReview,
    cancelReview,
    selectTab,
    setFilters,
    setDepth,
    resetForProject,
    markQueryRequestGeneration,
  } = useReviewStore();

  const projectId = currentProject?.id ?? null;
  const reviewId = status?.latestReview?.reviewId ?? null;

  const [pageState, setPageState] = useState<PageState>({
    section: null,
    page: null,
    previousCursors: [],
    currentCursor: undefined,
    loading: false,
    error: null,
    requestGeneration: 0,
  });

  const [diff, setDiff] = useState<{
    path: string;
    data: ReviewFileDiff | null;
    error: string | null;
    loading: boolean;
  } | null>(null);

  const [exportName, setExportName] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const activeSection = TAB_SECTIONS[selectedTab];
  const hasCurrentReview = status?.latestReview?.freshness === 'current' && summary !== null;

  useEffect(() => {
    if (!projectId) {
      resetForProject(0);
      return;
    }
    void loadStatus(projectId);
    return () => {
      resetForProject(projectId);
    };
  }, [projectId, resetForProject, loadStatus]);

  useEffect(() => {
    if (!projectId || !reviewId || !hasCurrentReview || !activeSection) return;
    const generation = markQueryRequestGeneration();
    setPageState({
      section: activeSection,
      page: null,
      previousCursors: [],
      currentCursor: undefined,
      loading: true,
      error: null,
      requestGeneration: generation,
    });
    void loadSection(activeSection, undefined, generation);
  }, [projectId, reviewId, selectedTab, filters, hasCurrentReview, activeSection]);

  async function loadSection(section: ReviewSection, cursor: string | undefined, generation: number): Promise<void> {
    try {
      const nextPage = await loadPage(
        {
          projectId: projectId!,
          reviewId: reviewId!,
          section,
          filters,
          cursor,
          pageLimit: 100,
        },
        generation,
      );
      setPageState((previous) => {
        if (previous.requestGeneration !== generation) return previous;
        return { ...previous, page: nextPage, loading: false, error: null };
      });
    } catch (err) {
      setPageState((previous) => {
        if (previous.requestGeneration !== generation) return previous;
        return { ...previous, loading: false, error: messageOf(err) };
      });
    }
  }

  function handleStart(depth: number) {
    if (!projectId) return;
    setDepth(depth);
    setDiff(null);
    setExportName(null);
    setExportError(null);
    void startReview(projectId, depth);
  }

  function handleCancel(operationId: string) {
    if (!projectId) return;
    void cancelReview(projectId, operationId);
  }

  async function handleExport() {
    if (!projectId || !reviewId) return;
    setExportName(null);
    setExportError(null);
    try {
      const result = await invoke('review:export', {
        projectId,
        reviewId,
        format: 'markdown',
      });
      if (result.cancelled) {
        setExportName(null);
      } else {
        setExportName(result.fileName);
      }
    } catch (err) {
      setExportError(messageOf(err));
    }
  }

  async function handleDiff(relativePath: string) {
    if (!projectId || !reviewId) return;
    if (relativePath.length > FILE_DIFF_PATH_LENGTH_LIMIT) return;
    setDiff({ path: relativePath, data: null, error: null, loading: true });
    try {
      const data = await invoke('review:file-diff', {
        projectId,
        reviewId,
        relativePath,
      });
      setDiff({ path: relativePath, data, error: null, loading: false });
    } catch (err) {
      setDiff({ path: relativePath, data: null, error: messageOf(err), loading: false });
    }
  }

  function handleNext(cursor: string) {
    if (!activeSection) return;
    const generation = markQueryRequestGeneration();
    setPageState((previous) => ({
      ...previous,
      previousCursors: previous.currentCursor === undefined ? previous.previousCursors : [...previous.previousCursors, previous.currentCursor],
      currentCursor: cursor,
      requestGeneration: generation,
      loading: true,
      error: null,
    }));
    void loadSection(activeSection, cursor, generation);
  }

  function handlePrevious() {
    if (!activeSection || pageState.previousCursors.length === 0) return;
    const previousCursor = pageState.previousCursors[pageState.previousCursors.length - 1];
    const generation = markQueryRequestGeneration();
    setPageState((previous) => ({
      ...previous,
      previousCursors: previous.previousCursors.slice(0, -1),
      currentCursor: previousCursor,
      requestGeneration: generation,
      loading: true,
      error: null,
    }));
    void loadSection(activeSection, previousCursor, generation);
  }

  function handleFiltersChange(nextFilters: ReviewFiltersType) {
    setFilters(nextFilters);
    setDiff(null);
  }

  if (!projectId) {
    return (
      <div className="flex h-full flex-col">
        <ReviewHeader
          status={null}
          loading={false}
          cancellationRequested={false}
          selectedDepth={selectedDepth}
          hasCurrentReview={false}
          onStart={() => undefined}
          onCancel={() => undefined}
          onExport={() => undefined}
        />
        <div className="flex-1 p-4">
          <EmptyState
            title="No project open"
            description="Open a project to compare its working tree with HEAD."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" role="region" aria-label="Change review workspace">
      <ReviewHeader
        status={status}
        loading={loading}
        cancellationRequested={cancellationRequested}
        selectedDepth={selectedDepth}
        hasCurrentReview={hasCurrentReview}
        onStart={handleStart}
        onCancel={handleCancel}
        onExport={handleExport}
      />
      {exportName && (
        <div className="border-b border-edge bg-surface-1 px-4 py-2">
          <Caveat>Exported to {exportName}</Caveat>
        </div>
      )}
      {exportError && (
        <div className="border-b border-edge bg-surface-1 px-4 py-2" role="alert">
          <Warning>{exportError}</Warning>
        </div>
      )}
      <ReviewTabs
        selected={selectedTab}
        onSelect={selectTab}
        disabled={!hasCurrentReview}
      />
      <div className="flex-1 overflow-y-auto p-4">
        {error && (
          <p className="mb-3 rounded-md border border-risk-crit/30 bg-risk-crit/10 px-3 py-2 text-[11px] text-risk-crit" role="alert">
            {error}
          </p>
        )}
        {tabContent({
          tab: selectedTab,
          hasCurrentReview,
          operation,
          summary,
          activeSection,
          pageState,
          diff,
          filters,
          onFiltersChange: handleFiltersChange,
          onNext: handleNext,
          onPrevious: handlePrevious,
          onDiff: handleDiff,
          canDiff: hasCurrentReview,
          onCloseDiff: () => setDiff(null),
        })}
      </div>
    </div>
  );
}

interface TabContentProps {
  tab: ReviewWorkspaceTab;
  hasCurrentReview: boolean;
  operation: ReviewOperationState | null;
  summary: ChangeReviewSummary | null;
  activeSection: ReviewSection | null;
  pageState: PageState;
  diff: { path: string; data: ReviewFileDiff | null; error: string | null; loading: boolean } | null;
  filters: ReviewFiltersType;
  onFiltersChange: (filters: ReviewFiltersType) => void;
  onNext: (cursor: string) => void;
  onPrevious: () => void;
  onDiff: (relativePath: string) => void;
  canDiff: boolean;
  onCloseDiff: () => void;
}

function tabContent(props: TabContentProps): JSX.Element {
  const { tab, hasCurrentReview, operation, summary, activeSection, pageState, diff, filters, onFiltersChange, onNext, onPrevious, onDiff, canDiff, onCloseDiff } = props;

  if (!hasCurrentReview) {
    return (
      <EmptyState
        title="No review yet"
        description={operation ? 'A review is running.' : 'Run a review to see structural evidence here.'}
      />
    );
  }

  if (tab === 'overview' && summary) {
    return <OverviewTab summary={summary} />;
  }

  if (!activeSection) {
    return (
      <EmptyState
        title="No section selected"
        description="Choose another tab to see structural evidence."
      />
    );
  }

  return (
    <div className="space-y-4">
      {diff && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-medium text-ink">Diff for {diff.path}</h2>
            <Button size="sm" variant="ghost" onClick={onCloseDiff} aria-label="Close diff">
              Close
            </Button>
          </div>
          {diff.loading && <Caveat>Loading diff…</Caveat>}
          {diff.error && (
            <div role="alert" aria-live="polite">
              <Warning>{diff.error}</Warning>
            </div>
          )}
          {diff.data && <ReviewDiff diff={diff.data} />}
        </div>
      )}
      <ReviewFilters section={activeSection} filters={filters} onChange={onFiltersChange} />
      {pageState.error && (
        <div role="alert" aria-live="polite">
          <Warning>{pageState.error}</Warning>
        </div>
      )}
      {pageState.page && (
        <ReviewPageView
          page={pageState.page}
          previousCursors={pageState.previousCursors}
          onNext={onNext}
          onPrevious={onPrevious}
          onDiff={onDiff}
          canDiff={canDiff}
          loading={pageState.loading}
        />
      )}
    </div>
  );
}

function OverviewTab({ summary }: { summary: ChangeReviewSummary }): JSX.Element {
  const counts = summary.counts ?? {} as Record<ReviewSection, { totalCount: number; retainedCount: number; truncated: boolean }>;
  const limitations = summary.limitations ?? [];
  const availability = summary.categoryAvailability ?? {} as Record<ReviewSection, boolean>;

  return (
    <div className="space-y-4">
      <Card title="Provenance">
        <div className="grid grid-cols-2 gap-2 text-[12px]">
          <div className="text-ink-faint">Base commit</div>
          <div className="font-mono text-ink">{summary.baseCommit.slice(0, 12)}</div>
          <div className="text-ink-faint">Depth</div>
          <div className="text-ink">{summary.traversalDepth}</div>
          <div className="text-ink-faint">Completed</div>
          <div className="text-ink">{new Date(summary.completedAt).toLocaleString()}</div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {Object.entries(counts).map(([section, count]) => (
          <StatTile
            key={section}
            label={SECTION_TITLES[section as ReviewSection]}
            value={`${formatCount(count.retainedCount)} / ${formatCount(count.totalCount)}`}
            tone={count.truncated ? 'warn' : 'neutral'}
          />
        ))}
      </div>

      {Object.entries(availability).some(([ , available]) => !available) && (
        <Warning>Some categories are not available for this review.</Warning>
      )}

      {limitations.length > 0 && (
        <Card title="Limitations">
          <ul className="space-y-2" role="list">
            {limitations.map((limitation) => (
              <li key={limitation.stableKey} className="text-[12px]">
                <span className="font-medium text-ink">{limitation.scope}</span>
                {' '}
                <span className="text-ink-muted">{limitation.message}</span>
                {limitation.omittedCount > 0 && (
                  <span className="ml-2 text-risk-high">({formatCount(limitation.omittedCount)} omitted)</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
