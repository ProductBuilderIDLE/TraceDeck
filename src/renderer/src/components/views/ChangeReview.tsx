import { useEffect } from 'react';
import { useReviewStore, type ReviewOperationState, type ReviewWorkspaceTab } from '../../store/reviewStore';
import { useAppStore } from '../../store/appStore';
import { ReviewHeader } from '../changeReview/ReviewHeader';
import { ReviewTabs } from '../changeReview/ReviewTabs';
import { EmptyState } from '../common/ui';
import { invoke } from '../../lib/ipc';

export function ChangeReview(): JSX.Element {
  const currentProject = useAppStore((state) => state.currentProject);
  const {
    status,
    summary,
    operation,
    selectedTab,
    selectedDepth,
    loading,
    error,
    cancellationRequested,
    loadStatus,
    startReview,
    cancelReview,
    selectTab,
    setDepth,
    resetForProject,
  } = useReviewStore();

  const projectId = currentProject?.id ?? null;

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

  const hasCurrentReview = status?.latestReview?.freshness === 'current' && summary !== null;

  function handleStart(depth: number) {
    if (!projectId) return;
    setDepth(depth);
    void startReview(projectId, depth);
  }

  function handleCancel(operationId: string) {
    if (!projectId) return;
    void cancelReview(projectId, operationId);
  }

  function handleExport() {
    if (!projectId || !status?.latestReview?.reviewId) return;
    void invoke('review:export', {
      projectId,
      reviewId: status.latestReview.reviewId,
      format: 'markdown',
    });
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
      <ReviewTabs
        selected={selectedTab}
        onSelect={selectTab}
        disabled={!hasCurrentReview}
      />
      <div className="flex-1 overflow-y-auto p-4">
        {error && (
          <p className="rounded-md border border-risk-crit/30 bg-risk-crit/10 px-3 py-2 text-[11px] text-risk-crit" role="alert">
            {error}
          </p>
        )}
        {tabContent(selectedTab, hasCurrentReview, operation)}
      </div>
    </div>
  );
}

function tabContent(
  tab: ReviewWorkspaceTab,
  hasCurrentReview: boolean,
  operation: ReviewOperationState | null,
): JSX.Element {
  if (!hasCurrentReview) {
    return (
      <EmptyState
        title="No review yet"
        description={operation ? 'A review is running.' : 'Run a review to see structural evidence here.'}
      />
    );
  }

  return (
    <div className="text-[12px] text-ink-faint">
      <p>{tab} content will appear here in the next task.</p>
    </div>
  );
}
