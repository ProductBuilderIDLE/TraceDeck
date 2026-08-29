import clsx from 'clsx';
import type {
  ReviewImpactExplanation,
  ReviewItem,
  ReviewPage as ReviewPageData,
  ReviewSection,
} from '@shared/changeReview';
import { parseNodeId } from '@shared/nodeIds';
import { Button, Card, Caveat, PathLabel, SeverityBadge, StatTile, Warning } from '../common/ui';

interface ReviewPageProps {
  page: ReviewPageData;
  previousCursors?: string[];
  onNext?: (cursor: string) => void;
  onPrevious?: () => void;
  onDiff?: (relativePath: string) => void;
  canDiff?: boolean;
  onDrillDown?: (item: ReviewItem) => void;
  loading?: boolean;
}

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

const EMPTY_IMPACT_COPY = 'No additional affected files were found within the analyzed dependency graph and configured limits.';
const EMPTY_TEST_COPY = 'No graph-reachable candidate test was found within the analyzed files and traversal limits. This does not mean no test exercises the change.';

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function directionTone(direction: 'added' | 'removed' | 'introduced' | 'resolved' | string): string {
  if (direction === 'added' || direction === 'introduced' || direction === 'resolved') return 'text-risk-low';
  if (direction === 'removed') return 'text-risk-crit';
  return 'text-ink';
}

function directnessTone(direct: boolean): string {
  return direct ? 'text-risk-low' : 'text-risk-high';
}

function fileChangeTone(changeType: string): string {
  if (changeType === 'added') return 'text-risk-low';
  if (changeType === 'modified') return 'text-risk-med';
  if (changeType === 'deleted') return 'text-risk-crit';
  if (changeType === 'renamed') return 'text-ink';
  return 'text-ink';
}

function sideTone(side: 'baseline' | 'target'): string {
  return side === 'target' ? 'text-risk-low' : 'text-ink-muted';
}

function nodePath(nodeId: string): { path: string; symbolName?: string } | null {
  const parsed = parseNodeId(nodeId);
  if (!parsed) return null;
  return { path: parsed.path, symbolName: parsed.symbolName };
}

export function ReviewPage({
  page,
  previousCursors = [],
  onNext,
  onPrevious,
  onDiff,
  canDiff = true,
  onDrillDown,
  loading = false,
}: ReviewPageProps): JSX.Element {
  const items = page.items ?? [];
  const retainedLabel = page.truncated ? 'matching retained details' : 'matching';

  return (
    <Card
      title={SECTION_TITLES[page.section]}
      actions={(
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="default"
            disabled={previousCursors.length === 0 || loading}
            onClick={onPrevious}
            aria-label="Previous page"
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="default"
            disabled={page.nextCursor === null || loading}
            onClick={() => page.nextCursor && onNext?.(page.nextCursor)}
            aria-label="Next page"
          >
            Next
          </Button>
        </div>
      )}
    >
      <div className="mb-3 grid grid-cols-3 gap-2">
        <StatTile label="returned" value={formatCount(page.returnedCount)} tone="neutral" />
        <StatTile label={retainedLabel} value={formatCount(page.retainedCount)} tone="neutral" />
        <StatTile label="total" value={formatCount(page.totalCount)} tone="neutral" />
      </div>
      <div className="mb-3">
        <Caveat>
          {formatCount(page.retainedCount)} {retainedLabel} of {formatCount(page.totalCount)} total; {formatCount(page.returnedCount)} returned.
        </Caveat>
      </div>
      {page.truncatedAtDepth && (
        <div className="mb-3">
          <Warning>
            Results were truncated at the configured traversal depth. Deeper matches were not explored.
          </Warning>
        </div>
      )}
      {loading && items.length === 0 && (
        <Caveat>Loading…</Caveat>
      )}
      {!loading && items.length === 0 && page.section === 'affected-files' && (
        <Caveat>{EMPTY_IMPACT_COPY}</Caveat>
      )}
      {!loading && items.length === 0 && page.section === 'candidate-tests' && (
        <Caveat>{EMPTY_TEST_COPY}</Caveat>
      )}
      {!loading && items.length === 0 && page.section === 'no-known-tests' && (
        <Caveat>Every changed file has a reachable candidate test within the analyzed limits.</Caveat>
      )}
      {!loading && items.length === 0 && page.section !== 'affected-files' && page.section !== 'candidate-tests' && page.section !== 'no-known-tests' && (
        <Caveat>No items match the current filters in this section.</Caveat>
      )}
      <ul className="space-y-2" role="list">
        {items.map((item) => (
          <li
            key={item.stableKey}
            data-review-stable-key={item.stableKey}
            tabIndex={-1}
            className="rounded-md border border-edge bg-surface-0 p-2.5"
          >
            <ReviewItemRow
              item={item}
              onDiff={onDiff}
              canDiff={canDiff}
              onDrillDown={onDrillDown}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}

interface ReviewItemRowProps {
  item: ReviewItem;
  onDiff?: (relativePath: string) => void;
  canDiff: boolean;
  onDrillDown?: (item: ReviewItem) => void;
}

function drilldownLabel(item: ReviewItem): string {
  switch (item.itemType) {
    case 'edge':
    case 'cycle':
    case 'affected-file':
    case 'candidate-test':
    case 'reachable-export':
      return 'Graph';
    case 'finding':
      return 'Find';
    case 'architecture-violation':
      return 'Rule';
    default:
      return 'Details';
  }
}

function ReviewItemRow({ item, onDiff, canDiff, onDrillDown }: ReviewItemRowProps): JSX.Element {
  return (
    <div className="space-y-1.5">
      <ReviewItemContent item={item} onDiff={onDiff} canDiff={canDiff} />
      {onDrillDown && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onDrillDown(item)}
          aria-label={`${drilldownLabel(item)} for ${item.stableKey}`}
        >
          {drilldownLabel(item)}
        </Button>
      )}
    </div>
  );
}

function ReviewItemContent({
  item,
  onDiff,
  canDiff,
}: {
  item: ReviewItem;
  onDiff?: (relativePath: string) => void;
  canDiff: boolean;
}): JSX.Element {
  switch (item.itemType) {
    case 'file':
      return (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {item.oldPath && item.changeType === 'renamed' ? (
              <div className="flex items-center gap-1.5 text-[12px]">
                <PathLabel path={item.oldPath} />
                <span className="text-ink-faint">→</span>
                <PathLabel path={item.relativePath} />
              </div>
            ) : (
              <PathLabel path={item.relativePath} />
            )}
            <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', 'border border-edge bg-surface-2', fileChangeTone(item.changeType))}>
              {item.changeType}
            </span>
            {item.staged && <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase border border-edge bg-surface-2 text-risk-low">staged</span>}
            {item.unstaged && <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase border border-edge bg-surface-2 text-risk-med">unstaged</span>}
            {item.untracked && <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase border border-edge bg-surface-2 text-ink-muted">untracked</span>}
            {item.similarity !== null && item.similarity !== undefined && (
              <span className="text-[11px] text-ink-faint">({Math.round(item.similarity)}% similar)</span>
            )}
            {onDiff && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!canDiff}
                onClick={() => canDiff && onDiff(item.relativePath)}
                aria-label={`Show diff for ${item.relativePath}`}
              >
                Diff
              </Button>
            )}
          </div>
          {item.language && <span className="text-[11px] text-ink-faint">{item.language}</span>}
        </div>
      );
    case 'edge':
      return (
        <div className="space-y-1.5 text-[12px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className={clsx('font-medium', directionTone(item.direction))}>{item.direction}</span>
            <PathLabel path={item.fromPath} />
            <span className="text-ink-faint">→</span>
            <PathLabel path={item.toPath} />
            <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase border border-edge bg-surface-2 text-ink-muted">{item.edgeType}</span>
            {item.typeOnly && <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase border border-edge bg-surface-2 text-ink-muted">type-only</span>}
          </div>
          {(item.sourceLines ?? []).length > 0 && (
            <div className="text-[11px] text-ink-faint">Lines {(item.sourceLines ?? []).join(', ')}</div>
          )}
          {(item.specifiers ?? []).length > 0 && (
            <div className="text-[11px] text-ink-faint">{(item.specifiers ?? []).join(', ')}</div>
          )}
        </div>
      );
    case 'finding':
      return (
        <div className="space-y-1.5 text-[12px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className={clsx('font-medium', directionTone(item.direction))}>{item.direction}</span>
            <SeverityBadge severity={item.finding.severity} />
            <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase border border-edge bg-surface-2 text-ink-muted">{item.finding.findingType}</span>
          </div>
          <div className="font-medium text-ink">{item.finding.title}</div>
          <div className="text-ink-muted">{item.finding.description}</div>
          {(item.finding.relatedNodeIds ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {(item.finding.relatedNodeIds ?? []).map((nodeId) => {
                const parsed = nodePath(nodeId);
                if (!parsed) return <span key={nodeId} className="text-ink-faint">{nodeId}</span>;
                return (
                  <span key={nodeId} className="flex items-center gap-1">
                    <PathLabel path={parsed.path} />
                    {parsed.symbolName && <span className="text-ink-faint">#{parsed.symbolName}</span>}
                  </span>
                );
              })}
            </div>
          )}
          {item.finding.dismissed && <span className="text-[11px] text-ink-faint">dismissed</span>}
        </div>
      );
    case 'architecture-violation':
      return (
        <div className="space-y-1.5 text-[12px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className={clsx('font-medium', directionTone(item.direction))}>{item.direction}</span>
            <SeverityBadge severity={item.severity} />
            <span className="text-ink-faint">rule {item.ruleFingerprint}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <PathLabel path={item.sourcePath} />
            <span className="text-ink-faint">→</span>
            <PathLabel path={item.targetPath} />
          </div>
          {item.line !== null && <span className="text-[11px] text-ink-faint">line {item.line}</span>}
        </div>
      );
    case 'cycle':
      return (
        <div className="space-y-1.5 text-[12px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className={clsx('font-medium', directionTone(item.direction))}>{item.direction}</span>
            <span className="text-ink-faint">cycle of {(item.cyclePath ?? []).length} files</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {(item.cyclePath ?? []).map((path, index) => (
              <span key={`${path}-${index}`} className="flex items-center gap-1.5">
                <PathLabel path={path} />
                {index < (item.cyclePath ?? []).length - 1 && <span className="text-ink-faint">→</span>}
              </span>
            ))}
          </div>
          {(item.memberPaths ?? []).length > 0 && (
            <div className="text-[11px] text-ink-faint">Members: {(item.memberPaths ?? []).join(', ')}</div>
          )}
        </div>
      );
    case 'reachable-export':
      return (
        <div className="space-y-1.5 text-[12px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className={clsx('font-medium', directionTone(item.direction))}>{item.direction}</span>
            <PathLabel path={item.entryPoint} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{item.exportedName}</span>
            <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase border border-edge bg-surface-2 text-ink-muted">{item.symbolKind}</span>
            {item.line !== null && <span className="text-[11px] text-ink-faint">line {item.line}</span>}
          </div>
          <PathLabel path={item.originPath} />
        </div>
      );
    case 'affected-file':
    case 'candidate-test':
      return <ImpactRow item={item} />;
    case 'no-known-test':
      return (
        <div className="text-[12px]">
          <PathLabel path={item.changedPath} />
          <span className="ml-2 text-ink-faint">no known candidate test</span>
        </div>
      );
    case 'limitation':
      return (
        <div className="space-y-1 text-[12px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{item.scope}</span>
            <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase border border-edge bg-surface-2 text-ink-muted">{item.code}</span>
          </div>
          <div className="text-ink-muted">{item.message}</div>
          {(item.paths ?? []).length > 0 && <div className="text-[11px] text-ink-faint">{(item.paths ?? []).join(', ')}</div>}
          {item.omittedCount > 0 && <div className="text-[11px] text-risk-high">{formatCount(item.omittedCount)} items omitted</div>}
        </div>
      );
    default:
      return <Caveat>Unknown item type.</Caveat>;
  }
}

function ImpactRow({ item }: { item: { itemType: 'affected-file' | 'candidate-test'; stableKey: string; destinationPath: string; depth: number; direct: boolean; originPaths: string[]; baselinePresent: boolean; targetPresent: boolean; explanations: ReviewImpactExplanation[] } }): JSX.Element {
  const title = item.itemType === 'affected-file' ? 'Affected' : 'Candidate test';
  return (
    <div className="space-y-1.5 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <PathLabel path={item.destinationPath} />
        <span className={clsx('font-medium', directnessTone(item.direct))}>{item.direct ? 'direct' : 'indirect'}</span>
        <span className="text-ink-faint">depth {item.depth}</span>
      </div>
      <div className="flex flex-wrap gap-2 text-[11px] text-ink-faint">
        <span>{title}</span>
        <span className={sideTone('baseline')}>{item.baselinePresent ? 'baseline present' : 'baseline absent'}</span>
        <span className={sideTone('target')}>{item.targetPresent ? 'target present' : 'target absent'}</span>
      </div>
      {(item.originPaths ?? []).length > 0 && (
        <div className="text-[11px] text-ink-faint">Origins: {(item.originPaths ?? []).join(', ')}</div>
      )}
      {(item.explanations ?? []).map((explanation, index) => (
        <ExplanationPath key={index} explanation={explanation} />
      ))}
    </div>
  );
}

function ExplanationPath({ explanation }: { explanation: ReviewImpactExplanation }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className={clsx('font-medium', sideTone(explanation.side))}>{explanation.side}</span>
      <span className="text-ink-faint">from</span>
      <PathLabel path={explanation.originPath} />
      <span className="text-ink-faint">via</span>
      {(explanation.path ?? []).map((path, index) => (
        <span key={`${path}-${index}`} className="flex items-center gap-1.5">
          <PathLabel path={path} />
          {index < (explanation.path ?? []).length - 1 && (explanation.edgeTypes ?? [])[index] && (
            <span className="text-ink-faint">({(explanation.edgeTypes ?? [])[index]}) →</span>
          )}
        </span>
      ))}
    </div>
  );
}


