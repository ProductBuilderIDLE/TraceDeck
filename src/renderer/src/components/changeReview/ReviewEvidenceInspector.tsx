import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type {
  ReviewArchitectureChange,
  ReviewEdgeChange,
  ReviewCycleChange,
  ReviewExportChange,
  ReviewFindingChange,
  ReviewGitChange,
  ReviewImpactExplanation,
  ReviewImpactItem,
  ReviewItem,
  ReviewNoKnownTest,
  ReviewLimitation,
} from '@shared/changeReview';
import type { ReviewFileDiff } from '@shared/changeReview';
import type { FindingType } from '@shared/types';
import type { ViewId } from '../../store/uiStore';
import { parseNodeId } from '@shared/nodeIds';
import { useAppStore } from '../../store/appStore';
import { useReviewStore } from '../../store/reviewStore';
import { useUiStore } from '../../store/uiStore';
import { invoke } from '../../lib/ipc';
import { Button, Caveat, PathLabel, SeverityBadge, Warning } from '../common/ui';
import { ReviewDiff } from './ReviewDiff';

interface ReviewEvidenceInspectorProps {
  evidence: ReviewItem;
  selectedNodeId?: string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function directionClass(direction: string): string {
  if (direction === 'added' || direction === 'introduced') return 'text-risk-low';
  if (direction === 'removed' || direction === 'resolved') return 'text-risk-crit';
  return 'text-ink';
}

function formatChangeType(changeType: ReviewGitChange['changeType']): string {
  return changeType;
}

function fileDrilldownLabel(item: ReviewGitChange): string {
  if (item.changeType === 'deleted') return 'View diff';
  return 'View source';
}

export function ReviewEvidenceInspector({
  evidence,
  selectedNodeId,
}: ReviewEvidenceInspectorProps): JSX.Element {
  const project = useAppStore((state) => state.currentProject);
  const rules = useAppStore((state) => state.rules);
  const status = useReviewStore((state) => state.status);
  const clearReviewContext = useUiStore((state) => state.clearReviewContext);
  const openCode = useUiStore((state) => state.openCode);
  const focusFinding = useUiStore((state) => state.focusFinding);
  const setActiveView = useUiStore((state) => state.setActiveView);

  const [diff, setDiff] = useState<ReviewFileDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const selectedPath = selectedNodeId ? parseNodeId(selectedNodeId)?.path ?? null : null;
  const current = status?.latestReview?.freshness === 'current';
  const reviewId = status?.latestReview?.reviewId ?? null;

  useEffect(() => {
    setDiff(null);
    setDiffError(null);
    setDiffLoading(false);
  }, [evidence.stableKey]);

  const openDiff = async (relativePath: string): Promise<void> => {
    if (!project || !reviewId) return;
    setDiffLoading(true);
    setDiffError(null);
    try {
      const result = await invoke('review:file-diff', {
        projectId: project.id,
        reviewId,
        relativePath,
      });
      setDiff(result);
    } catch (error) {
      setDiffError(messageOf(error));
    } finally {
      setDiffLoading(false);
    }
  };

  const matchedRule =
    evidence.itemType === 'architecture-violation'
      ? rules.find((rule) => rule.id === evidence.ruleId)
      : undefined;
  const ruleMatches =
    evidence.itemType === 'architecture-violation' &&
    matchedRule !== undefined &&
    matchedRule.enabled &&
    matchedRule.fingerprint === evidence.ruleFingerprint;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-edge px-3 py-2.5">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            Review evidence
          </p>
          <Button size="sm" variant="ghost" onClick={clearReviewContext}>
            Clear
          </Button>
        </div>
        {selectedPath && (
          <p className="mono-path mt-1.5 text-ink">{selectedPath}</p>
        )}
      </div>

      <div className="space-y-3 p-3">
        {current === false && (
          <Caveat>This evidence is from a stale review and cannot be refreshed.</Caveat>
        )}

        <EvidenceBody
          evidence={evidence}
          selectedPath={selectedPath}
          current={current}
          reviewId={reviewId}
          projectId={project?.id ?? null}
          openCode={openCode}
          openDiff={openDiff}
          focusFinding={focusFinding}
          setActiveView={setActiveView}
          ruleMatches={ruleMatches}
          matchedRule={matchedRule}
        />

        {diffLoading && <Caveat>Loading diff…</Caveat>}
        {diffError && (
          <Warning>{diffError}</Warning>
        )}
        {diff && <ReviewDiff diff={diff} />}
      </div>
    </div>
  );
}

interface EvidenceBodyProps {
  evidence: ReviewItem;
  selectedPath: string | null;
  current: boolean;
  reviewId: number | null;
  projectId: number | null;
  openCode: (path: string, line?: number | null) => void;
  openDiff: (relativePath: string) => Promise<void>;
  focusFinding: (fingerprint: string, findingType: FindingType) => void;
  setActiveView: (view: ViewId) => void;
  ruleMatches: boolean;
  matchedRule: { name: string; sourcePattern: string; targetPattern: string; enabled: boolean } | undefined;
}

function EvidenceBody(props: EvidenceBodyProps): JSX.Element {
  const { evidence } = props;

  switch (evidence.itemType) {
    case 'file':
      return <FileBody {...props} evidence={evidence} />;
    case 'edge':
      return <EdgeBody {...props} evidence={evidence} />;
    case 'finding':
      return <FindingBody {...props} evidence={evidence} />;
    case 'architecture-violation':
      return <ArchitectureBody {...props} evidence={evidence} />;
    case 'cycle':
      return <CycleBody {...props} evidence={evidence} />;
    case 'reachable-export':
      return <ExportBody {...props} evidence={evidence} />;
    case 'affected-file':
    case 'candidate-test':
      return <ImpactBody {...props} evidence={evidence} />;
    case 'no-known-test':
      return <NoKnownTestBody {...props} evidence={evidence} />;
    case 'limitation':
      return <LimitationBody {...props} evidence={evidence} />;
    default:
      return <Caveat>Unknown review evidence type.</Caveat>;
  }
}

function FileBody({
  evidence,
  current,
  openCode,
  openDiff,
}: EvidenceBodyProps & { evidence: ReviewGitChange }): JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className={clsx('font-medium', directionClass(evidence.changeType))}>
          {formatChangeType(evidence.changeType)}
        </span>
        <PathLabel path={evidence.relativePath} />
        {evidence.oldPath && evidence.changeType === 'renamed' && (
          <>
            <span className="text-ink-faint">←</span>
            <PathLabel path={evidence.oldPath} />
          </>
        )}
      </div>
      {evidence.language && (
        <p className="text-[11px] text-ink-faint">{evidence.language}</p>
      )}
      <div className="flex flex-wrap gap-1">
        {evidence.changeType === 'deleted' ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={!current}
            onClick={() => void openDiff(evidence.relativePath)}
          >
            {fileDrilldownLabel(evidence)}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={!current}
            onClick={() => openCode(evidence.relativePath)}
          >
            {fileDrilldownLabel(evidence)}
          </Button>
        )}
      </div>
      {!current && (
        <Caveat>This file change is from a stale review and cannot be refreshed.</Caveat>
      )}
    </div>
  );
}

function EdgeBody({
  evidence,
}: EvidenceBodyProps & { evidence: ReviewEdgeChange }): JSX.Element {
  return (
    <div className="space-y-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className={clsx('font-medium', directionClass(evidence.direction))}>
          {evidence.direction}
        </span>
        <PathLabel path={evidence.fromPath} />
        <span className="text-ink-faint">→</span>
        <PathLabel path={evidence.toPath} />
        <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase border border-edge bg-surface-2 text-ink-muted">
          {evidence.edgeType}
        </span>
        {evidence.typeOnly && (
          <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase border border-edge bg-surface-2 text-ink-muted">
            type-only
          </span>
        )}
      </div>
      {evidence.sourceLines.length > 0 && (
        <p className="text-[11px] text-ink-faint">Lines {evidence.sourceLines.join(', ')}</p>
      )}
      {evidence.specifiers.length > 0 && (
        <p className="text-[11px] text-ink-faint">{evidence.specifiers.join(', ')}</p>
      )}
    </div>
  );
}

function FindingBody({
  evidence,
  current,
  focusFinding,
}: EvidenceBodyProps & { evidence: ReviewFindingChange }): JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className={clsx('font-medium', directionClass(evidence.direction))}>
          {evidence.direction}
        </span>
        <SeverityBadge severity={evidence.finding.severity} />
        <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase border border-edge bg-surface-2 text-ink-muted">
          {evidence.finding.findingType}
        </span>
      </div>
      <p className="text-ink">{evidence.finding.title}</p>
      <p className="text-ink-muted">{evidence.finding.description}</p>
      {evidence.finding.relatedNodeIds.length > 0 && (
        <p className="text-[11px] text-ink-faint">
          Related: {evidence.finding.relatedNodeIds.join(', ')}
        </p>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={!current}
        onClick={() => focusFinding(evidence.finding.fingerprint, evidence.finding.findingType)}
      >
        Find in current findings
      </Button>
    </div>
  );
}

function ArchitectureBody({
  evidence,
  current,
  ruleMatches,
  matchedRule,
  setActiveView,
}: EvidenceBodyProps & { evidence: ReviewArchitectureChange }): JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className={clsx('font-medium', directionClass(evidence.direction))}>
          {evidence.direction}
        </span>
        <SeverityBadge severity={evidence.severity} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <PathLabel path={evidence.sourcePath} />
        <span className="text-ink-faint">→</span>
        <PathLabel path={evidence.targetPath} />
      </div>
      {evidence.line !== null && (
        <p className="text-[11px] text-ink-faint">Line {evidence.line}</p>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={!current || !ruleMatches}
        onClick={() => setActiveView('architecture')}
      >
        View rule
      </Button>
      {!ruleMatches && matchedRule && (
        <Caveat>The rule has changed since this violation was captured, so the link is disabled.</Caveat>
      )}
      {!matchedRule && (
        <Caveat>This rule no longer exists in the current project.</Caveat>
      )}
    </div>
  );
}

function CycleBody({
  evidence,
}: EvidenceBodyProps & { evidence: ReviewCycleChange }): JSX.Element {
  return (
    <div className="space-y-2">
      <p className={clsx('font-medium text-[12px]', directionClass(evidence.direction))}>
        {evidence.direction} cycle of {evidence.cyclePath.length} files
      </p>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        {evidence.cyclePath.map((path, index) => (
          <span key={`${path}-${index}`} className="flex items-center gap-1.5">
            <PathLabel path={path} />
            {index < evidence.cyclePath.length - 1 && <span className="text-ink-faint">→</span>}
          </span>
        ))}
      </div>
      {evidence.memberPaths.length > 0 && (
        <p className="text-[11px] text-ink-faint">
          Members: {evidence.memberPaths.join(', ')}
        </p>
      )}
    </div>
  );
}

function ExportBody({
  evidence,
}: EvidenceBodyProps & { evidence: ReviewExportChange }): JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className={clsx('font-medium', directionClass(evidence.direction))}>
          {evidence.direction}
        </span>
        <PathLabel path={evidence.entryPoint} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-medium text-ink">{evidence.exportedName}</span>
        <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase border border-edge bg-surface-2 text-ink-muted">
          {evidence.symbolKind}
        </span>
        {evidence.line !== null && <span className="text-ink-faint">line {evidence.line}</span>}
      </div>
      <div className="flex items-center gap-1.5 text-[12px]">
        <span className="text-ink-faint">origin</span>
        <PathLabel path={evidence.originPath} />
      </div>
    </div>
  );
}

function ImpactBody({
  evidence,
}: EvidenceBodyProps & { evidence: ReviewImpactItem }): JSX.Element {
  const title = evidence.itemType === 'affected-file' ? 'Affected file' : 'Candidate test';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <PathLabel path={evidence.destinationPath} />
        <span className={clsx('font-medium', evidence.direct ? 'text-risk-low' : 'text-risk-high')}>
          {evidence.direct ? 'direct' : 'indirect'}
        </span>
        <span className="text-ink-faint">depth {evidence.depth}</span>
      </div>
      <div className="flex flex-wrap gap-2 text-[11px] text-ink-faint">
        <span>{title}</span>
        <span className={evidence.baselinePresent ? 'text-ink-muted' : 'text-ink-faint'}>
          {evidence.baselinePresent ? 'baseline present' : 'baseline absent'}
        </span>
        <span className={evidence.targetPresent ? 'text-brand' : 'text-ink-faint'}>
          {evidence.targetPresent ? 'target present' : 'target absent'}
        </span>
      </div>
      {evidence.originPaths.length > 0 && (
        <p className="text-[11px] text-ink-faint">
          Origins: {evidence.originPaths.join(', ')}
        </p>
      )}
      {evidence.explanations.map((explanation, index) => (
        <ExplanationPath key={index} explanation={explanation} />
      ))}
    </div>
  );
}

function ExplanationPath({ explanation }: { explanation: ReviewImpactExplanation }): JSX.Element {
  return (
    <div className="rounded border border-edge bg-surface-2 p-2 text-[11px]">
      <p className={clsx('font-medium', explanation.side === 'target' ? 'text-brand' : 'text-ink-muted')}>
        {explanation.side} · from {explanation.originPath}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {explanation.path.map((path, index) => (
          <span key={`${path}-${index}`} className="flex items-center gap-1.5">
            <PathLabel path={path} />
            {index < explanation.path.length - 1 && explanation.edgeTypes[index] && (
              <span className="text-ink-faint">({explanation.edgeTypes[index]}) →</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

function NoKnownTestBody({
  evidence,
}: EvidenceBodyProps & { evidence: ReviewNoKnownTest }): JSX.Element {
  return (
    <div className="space-y-2">
      <PathLabel path={evidence.changedPath} />
      <p className="text-[11px] text-ink-faint">No graph-reachable candidate test was found for this changed file.</p>
    </div>
  );
}

function LimitationBody({
  evidence,
}: EvidenceBodyProps & { evidence: ReviewLimitation }): JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-medium text-ink">{evidence.scope}</span>
        <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase border border-edge bg-surface-2 text-ink-muted">
          {evidence.code}
        </span>
      </div>
      <p className="text-ink-muted">{evidence.message}</p>
      {evidence.paths.length > 0 && (
        <p className="text-[11px] text-ink-faint">{evidence.paths.join(', ')}</p>
      )}
      {evidence.omittedCount > 0 && (
        <p className="text-[11px] text-risk-high">{evidence.omittedCount} items omitted</p>
      )}
    </div>
  );
}
