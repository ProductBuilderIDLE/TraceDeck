import { ShieldCheck } from 'lucide-react';
import { PRIVACY_NOTICE } from '@shared/constants';
import { useAppStore } from '../../store/appStore';
import { useUiStore } from '../../store/uiStore';
import { Button, Caveat, Card, EmptyState, PathLabel, RiskBadge, StatTile } from '../common/ui';

function PrivacyBanner(): JSX.Element {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-risk-low/25 bg-risk-low/[0.07] px-3.5 py-3">
      <ShieldCheck size={15} className="mt-0.5 shrink-0 text-risk-low" />
      <div>
        <p className="text-[12px] font-medium text-risk-low">{PRIVACY_NOTICE}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
          TraceDeck parses your code locally and stores results in a database on this computer.
          It makes no network requests and never uploads source code, paths, or reports.
        </p>
      </div>
    </div>
  );
}

function LimitationsCard({ limitations }: { limitations: readonly string[] }): JSX.Element | null {
  if (limitations.length === 0) return null;

  return (
    <Card title={`Analysis limitations (${limitations.length})`}>
      <p className="mb-2 text-[11px] leading-relaxed text-ink-muted">
        These are things this scan could not determine. Results elsewhere in the app should be read
        with them in mind.
      </p>
      <ul className="max-h-56 space-y-1 overflow-y-auto">
        {limitations.slice(0, 60).map((limitation) => (
          <li key={limitation} className="mono-path text-ink-faint">
            {limitation}
          </li>
        ))}
      </ul>
      {limitations.length > 60 && (
        <p className="mt-2 text-[11px] text-ink-faint">
          …and {limitations.length - 60} more.
        </p>
      )}
    </Card>
  );
}

export function Dashboard(): JSX.Element {
  const project = useAppStore((state) => state.currentProject);
  const stats = useAppStore((state) => state.stats);
  const lastScan = useAppStore((state) => state.lastScan);
  const scanning = useAppStore((state) => state.scanning);
  const startScan = useAppStore((state) => state.startScan);
  const openProjectDialog = useAppStore((state) => state.openProjectDialog);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const selectNode = useUiStore((state) => state.selectNode);

  if (!project) {
    return (
      <EmptyState
        title="No project open"
        description="Open a local JavaScript or TypeScript project folder to map its dependency graph. Nothing leaves this computer."
        action={
          <Button variant="primary" onClick={() => void openProjectDialog()}>
            Open a project folder
          </Button>
        }
      />
    );
  }

  if (!lastScan || !stats) {
    return (
      <EmptyState
        title="This project has not been scanned yet"
        description="Run a scan to discover source files, parse them with the TypeScript compiler, and build the dependency graph."
        action={
          <Button variant="primary" disabled={scanning} onClick={() => void startScan(false)}>
            {scanning ? 'Scanning…' : 'Scan project'}
          </Button>
        }
      />
    );
  }

  if (stats.totalFiles === 0) {
    const explanation =
      lastScan.summary?.limitations.find((limitation) =>
        limitation.startsWith('No supported source files'),
      ) ??
      'The completed scan did not find a source file supported by the dependency graph.';

    return (
      <div className="space-y-4 p-5">
        <PrivacyBanner />
        <EmptyState
          title="No supported source files found"
          description={explanation}
          action={
            <Button variant="primary" disabled={scanning} onClick={() => void startScan(false)}>
              {scanning ? 'Scanning…' : 'Scan again'}
            </Button>
          }
        />
        <LimitationsCard limitations={lastScan.summary?.limitations ?? []} />
      </div>
    );
  }

  const summary = lastScan.summary;

  return (
    <div className="space-y-4 p-5">
      <PrivacyBanner />

      <div>
        <h2 className="text-[15px] font-semibold text-ink">{project.name}</h2>
        <p className="mono-path mt-0.5 text-ink-faint">{project.rootPath}</p>
        <p className="mt-1 text-[11px] text-ink-muted">
          Last scanned{' '}
          {lastScan.completedAt ? new Date(lastScan.completedAt).toLocaleString() : 'never'}
          {summary && ` · ${summary.parsedFiles} file(s) parsed, ${summary.skippedUnchangedFiles} unchanged`}
          {summary && ` · ${(summary.durationMs / 1000).toFixed(1)}s`}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        <StatTile label="Files scanned" value={stats.totalFiles} />
        <StatTile label="Symbols" value={stats.totalSymbols} />
        <StatTile label="Graph edges" value={stats.totalEdges} />
        <StatTile
          label="Circular dependencies"
          value={stats.cycleCount}
          tone={stats.cycleCount > 0 ? 'bad' : 'good'}
          onClick={() => setActiveView('cycles')}
        />
        <StatTile
          label="Unused export candidates"
          value={stats.unusedExportCandidateCount}
          tone={stats.unusedExportCandidateCount > 0 ? 'warn' : 'good'}
          onClick={() => setActiveView('unused-exports')}
        />
        <StatTile
          label="Architecture violations"
          value={stats.architectureViolationCount}
          tone={stats.architectureViolationCount > 0 ? 'bad' : 'good'}
          onClick={() => setActiveView('architecture')}
        />
        <StatTile
          label="Unresolved imports"
          value={stats.unresolvedImportCount}
          tone={stats.unresolvedImportCount > 0 ? 'warn' : 'good'}
          onClick={() => setActiveView('unresolved')}
        />
        <StatTile
          label={summary?.typeCheck?.ran ? 'Type errors' : 'Type errors (off)'}
          value={summary?.typeCheck?.ran ? stats.typeErrorCount : '—'}
          tone={stats.typeErrorCount > 0 ? 'bad' : summary?.typeCheck?.ran ? 'good' : 'neutral'}
          onClick={() => setActiveView('type-errors')}
        />
        <StatTile label="External packages" value={summary?.externalDependencies ?? 0} />
      </div>

      <Card title="Files by change impact score">
        {stats.topImpactFiles.length === 0 ? (
          <p className="text-[12px] text-ink-muted">No files to rank yet.</p>
        ) : (
          <>
            <ul className="divide-y divide-edge">
              {stats.topImpactFiles.map((entry) => (
                <li key={entry.nodeId}>
                  <button
                    type="button"
                    onClick={() => selectNode(entry.nodeId)}
                    className="flex w-full items-center gap-3 py-1.5 text-left hover:text-ink"
                  >
                    <RiskBadge score={entry.score} />
                    <PathLabel path={entry.path} className="flex-1" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-3 border-t border-edge pt-2.5">
              <Caveat>
                {stats.topImpactFiles[0]?.formulaDescription}
                {' Select a file to see its full score breakdown.'}
              </Caveat>
            </div>
          </>
        )}
      </Card>

      {summary && <LimitationsCard limitations={summary.limitations} />}
    </div>
  );
}
