import { Play, Square, Download } from 'lucide-react';
import type { ReviewStatus } from '@shared/changeReview';
import { Button, Warning } from '../common/ui';

interface ReviewHeaderProps {
  status: ReviewStatus | null;
  loading: boolean;
  cancellationRequested: boolean;
  selectedDepth: number;
  hasCurrentReview: boolean;
  onStart: (depth: number) => void;
  onCancel: (operationId: string) => void;
  onExport: () => void;
}

export function ReviewHeader({
  status,
  loading,
  cancellationRequested,
  selectedDepth,
  hasCurrentReview,
  onStart,
  onCancel,
  onExport,
}: ReviewHeaderProps): JSX.Element {
  const running = status?.activeOperation ?? null;
  const canRun = status?.repositoryState === 'ready' && !running;

  return (
    <header className="space-y-3 border-b border-edge bg-surface-1 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-sm font-medium">Change review</h1>
          <p className="text-[11px] text-ink-faint" aria-live="polite">
            {summaryText(status, running, cancellationRequested)}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {!running && canRun && (
            <>
              <label className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                Depth
                <input
                  type="number"
                  min={1}
                  max={25}
                  value={selectedDepth}
                  onChange={(event) => onStart(Number(event.target.value))}
                  disabled={!canRun || loading}
                  className="w-14 rounded border border-edge bg-surface-0 px-1.5 py-1 text-[11px] text-ink"
                  aria-label="Traversal depth"
                />
              </label>
              <Button
                onClick={() => onStart(selectedDepth)}
                disabled={!canRun || loading}
                variant="primary"
                size="sm"
                aria-label="Run review"
                title="Compare the working tree with HEAD"
              >
                <Play size={11} />
                Run review
              </Button>
            </>
          )}

          {running && (
            <Button
              onClick={() => onCancel(running.operationId)}
              disabled={cancellationRequested}
              variant="danger"
              size="sm"
              aria-label="Cancel review"
            >
              <Square size={11} />
              {cancellationRequested ? 'Cancelling…' : 'Cancel'}
            </Button>
          )}

          {!running && hasCurrentReview && (
            <Button onClick={onExport} size="sm" variant="ghost" aria-label="Export review" title="Export the current review">
              <Download size={11} />
              Export
            </Button>
          )}
        </div>
      </div>

      {status?.latestReview?.freshness === 'stale' && (
        <Warning>
          This review is stale.
          {' '}
          {status.latestReview.staleReasons.join(', ')}
        </Warning>
      )}

      {status?.latestReview?.freshness === 'incompatible' && (
        <Warning>This review was created by an incompatible version of TraceDeck.</Warning>
      )}
    </header>
  );
}

function summaryText(
  status: ReviewStatus | null,
  running: ReviewStatus['activeOperation'],
  cancellationRequested: boolean,
): string {
  if (!status) return 'Open a project to compare its working tree with HEAD.';
  if (status.repositoryState === 'not-git') return 'The selected project is not a Git repository.';
  if (status.repositoryState === 'unborn-head') return 'The Git repository does not have a commit yet.';
  if (running) {
    if (cancellationRequested) return `Cancelling: ${running.message}`;
    return `${running.phase}: ${running.message}`;
  }
  if (status.latestReview?.freshness === 'stale') return 'The latest review is stale.';
  if (status.latestReview?.freshness === 'incompatible') return 'The latest review is incompatible.';
  if (status.latestReview?.freshness === 'current') return 'The latest review is current.';
  return 'Ready to compare the working tree with HEAD.';
}
