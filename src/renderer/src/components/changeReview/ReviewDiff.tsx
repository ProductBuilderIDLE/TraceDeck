import type { ReviewFileDiff } from '@shared/changeReview';
import { Card, Caveat, PathLabel, Warning } from '../common/ui';

interface ReviewDiffProps {
  diff: ReviewFileDiff;
  stale?: boolean;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function ReviewDiff({ diff, stale = false }: ReviewDiffProps): JSX.Element {
  return (
    <Card title="Diff">
      <div className="mb-3 space-y-2 text-[12px]">
        {diff.oldPath && diff.newPath && diff.oldPath !== diff.newPath && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-ink">Renamed</span>
            <PathLabel path={diff.oldPath} />
            <span className="text-ink-faint">→</span>
            <PathLabel path={diff.newPath} />
          </div>
        )}
        {!diff.oldPath && diff.newPath && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-risk-low">Added</span>
            <PathLabel path={diff.newPath} />
          </div>
        )}
        {diff.oldPath && !diff.newPath && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-risk-crit">Deleted</span>
            <PathLabel path={diff.oldPath} />
          </div>
        )}
        {diff.oldPath && diff.newPath && diff.oldPath === diff.newPath && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-ink">Modified</span>
            <PathLabel path={diff.newPath} />
          </div>
        )}
      </div>

      {stale && (
        <div className="mb-3">
          <Warning>This diff is from a stale review and cannot be refreshed.</Warning>
        </div>
      )}

      {diff.truncated && (
        <div className="mb-3">
          <Warning>
            The diff was bounded and may be incomplete. {formatCount(diff.omittedBytes)} bytes and {formatCount(diff.omittedLines)} lines were omitted.
          </Warning>
        </div>
      )}

      {!diff.truncated && (diff.omittedBytes > 0 || diff.omittedLines > 0) && (
        <div className="mb-3">
          <Caveat>
            {formatCount(diff.omittedBytes)} bytes and {formatCount(diff.omittedLines)} lines were omitted.
          </Caveat>
        </div>
      )}

      <pre className="max-h-96 overflow-auto rounded border border-edge bg-surface-0 p-3 font-mono text-[12px] leading-snug text-ink">
        {diff.diffText}
      </pre>
    </Card>
  );
}
