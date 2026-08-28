import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Crosshair, Eye, EyeOff } from 'lucide-react';
import type {
  ArchitectureViolationDetails,
  CycleDetails,
  Finding,
  FindingType,
  TypeErrorDetails,
  UnresolvedImportDetails,
  UnusedExportDetails,
  SyntaxErrorDetails,
  MergeConflictDetails,
} from '@shared/types';
import { fileNodeId, symbolNodeId } from '@shared/nodeIds';
import { useAppStore } from '../../store/appStore';
import { useUiStore } from '../../store/uiStore';
import { invoke } from '../../lib/ipc';
import { Button, Caveat, EmptyState, PathLabel, SeverityBadge, Spinner } from '../common/ui';

interface FindingsViewProps {
  findingType: FindingType;
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
}

function CycleBody({ finding }: { finding: Finding }): JSX.Element {
  const details = finding.details as CycleDetails;
  const selectNode = useUiStore((state) => state.selectNode);

  return (
    <div className="space-y-1.5">
      <div className="rounded border border-edge bg-surface-2 p-2">
        {details.cyclePath.map((path, index) => (
          <div
            key={`${path}-${index}`}
            className="flex items-center gap-1.5"
            style={{ paddingLeft: `${Math.min(index, 8) * 10}px` }}
          >
            {index > 0 && <span className="text-ink-faint">→</span>}
            <button
              type="button"
              onClick={() => selectNode(fileNodeId(path))}
              className="mono-path truncate text-left text-ink-muted hover:text-brand"
            >
              {path}
            </button>
            {details.edges[index]?.line && (
              <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                :{details.edges[index]?.line}
              </span>
            )}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-ink-faint">
        {details.cyclePath.length - 1} file(s) in this cycle. The last import closes the loop back
        to the first file.
      </p>
    </div>
  );
}

function UnusedExportBody({ finding }: { finding: Finding }): JSX.Element {
  const details = finding.details as UnusedExportDetails;
  const selectNode = useUiStore((state) => state.selectNode);

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => selectNode(symbolNodeId(details.filePath, details.symbolName))}
        className="flex items-baseline gap-2 text-left hover:text-brand"
      >
        <span className="mono-path text-ink">{details.symbolName}</span>
        <span className="text-[10px] text-ink-faint">{details.symbolKind}</span>
        <PathLabel path={`${details.filePath}:${details.line}`} />
      </button>
      {details.caveats.map((caveat) => (
        <Caveat key={caveat}>{caveat}</Caveat>
      ))}
    </div>
  );
}

function ViolationBody({ finding }: { finding: Finding }): JSX.Element {
  const details = finding.details as ArchitectureViolationDetails;
  const selectNode = useUiStore((state) => state.selectNode);

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => selectNode(fileNodeId(details.sourcePath))}
          className="mono-path text-ink hover:text-brand"
        >
          {details.sourcePath}
        </button>
        <span className="text-[11px] text-ink-faint">must not import</span>
        <button
          type="button"
          onClick={() => selectNode(fileNodeId(details.targetPath))}
          className="mono-path text-ink hover:text-brand"
        >
          {details.targetPath}
        </button>
      </div>
      <p className="text-[11px] text-ink-faint">
        {details.specifier && <span className="font-mono">{details.specifier}</span>}
        {details.line !== null && ` at line ${details.line}`}
      </p>
    </div>
  );
}

function UnresolvedBody({ finding }: { finding: Finding }): JSX.Element {
  const details = finding.details as UnresolvedImportDetails;
  const selectNode = useUiStore((state) => state.selectNode);

  const REASONS: Record<UnresolvedImportDetails['reason'], string> = {
    'dynamic-expression':
      'The module specifier is built at runtime, so static analysis cannot know the target.',
    'alias-not-configured':
      'This looks like a path alias, but no matching mapping was found in the project configuration.',
    'file-not-found': 'No file matching this specifier exists in the scanned folder.',
    'external-package': 'This resolves to a dependency outside the project, which is not mapped.',
    'non-source-asset':
      'This imports a stylesheet, image, or other non-JavaScript file, which is expected and sits outside the graph.',
  };

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => selectNode(fileNodeId(details.filePath))}
        className="flex items-baseline gap-2 text-left hover:text-brand"
      >
        <PathLabel path={details.filePath} />
        {details.line !== null && (
          <span className="font-mono text-[10px] text-ink-faint">:{details.line}</span>
        )}
      </button>
      <p className="mono-path text-ink-muted">{details.specifier}</p>
      <Caveat>{REASONS[details.reason]}</Caveat>
    </div>
  );
}

function TypeErrorBody({ finding }: { finding: Finding }): JSX.Element {
  const details = finding.details as TypeErrorDetails;
  const selectNode = useUiStore((state) => state.selectNode);

  return (
    <div className="space-y-1">
      {details.filePath ? (
        <button
          type="button"
          onClick={() => selectNode(fileNodeId(details.filePath as string))}
          className="flex items-baseline gap-2 text-left hover:text-brand"
        >
          <PathLabel path={details.filePath} />
          {details.line !== null && (
            <span className="font-mono text-[10px] text-ink-faint">
              :{details.line}
              {details.column !== null && `:${details.column}`}
            </span>
          )}
        </button>
      ) : (
        <p className="text-[11px] text-ink-muted">Reported against the project configuration.</p>
      )}
      <p className="text-[11px] leading-relaxed text-ink-muted">{details.message}</p>
      <p className="font-mono text-[10px] text-ink-faint">TS{details.code}</p>
    </div>
  );
}

function SyntaxErrorBody({ finding }: { finding: Finding }): JSX.Element {
  const details = finding.details as SyntaxErrorDetails;
  const openCode = useUiStore((state) => state.openCode);

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => openCode(details.filePath, details.line)}
        className="flex items-baseline gap-2 text-left hover:text-brand"
      >
        <PathLabel path={details.filePath} />
        <span className="font-mono text-[10px] text-ink-faint">
          :{details.line}:{details.column}
        </span>
      </button>
      <p className="text-[11px] leading-relaxed text-ink-muted">{details.message}</p>
    </div>
  );
}

function MergeConflictBody({ finding }: { finding: Finding }): JSX.Element {
  const details = finding.details as MergeConflictDetails;
  const openCode = useUiStore((state) => state.openCode);

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => openCode(details.filePath, details.startLine)}
        className="flex items-baseline gap-2 text-left hover:text-brand"
      >
        <PathLabel path={details.filePath} />
        <span className="font-mono text-[10px] text-ink-faint">
          :{details.startLine}
          {details.endLine !== null ? `-${details.endLine}` : ''}
        </span>
      </button>
      {details.label && (
        <p className="mono-path text-ink-muted">Conflicting side: {details.label}</p>
      )}
      {!details.complete && (
        <Caveat>
          This marker group is not properly closed, so the file is still mid-merge.
        </Caveat>
      )}
    </div>
  );
}

function FindingBody({ finding }: { finding: Finding }): JSX.Element {
  switch (finding.findingType) {
    case 'circular-dependency':
      return <CycleBody finding={finding} />;
    case 'unused-export-candidate':
      return <UnusedExportBody finding={finding} />;
    case 'architecture-violation':
      return <ViolationBody finding={finding} />;
    case 'unresolved-import':
      return <UnresolvedBody finding={finding} />;
    case 'type-error':
      return <TypeErrorBody finding={finding} />;
    case 'syntax-error':
      return <SyntaxErrorBody finding={finding} />;
    case 'merge-conflict':
      return <MergeConflictBody finding={finding} />;
  }
}

export function FindingsView({
  findingType,
  title,
  description,
  emptyTitle,
  emptyDescription,
}: FindingsViewProps): JSX.Element {
  const project = useAppStore((state) => state.currentProject);
  const stats = useAppStore((state) => state.stats);
  const dismissFinding = useAppStore((state) => state.dismissFinding);
  const selectNode = useUiStore((state) => state.selectNode);
  const setActiveView = useUiStore((state) => state.setActiveView);

  const [findings, setFindings] = useState<Finding[]>([]);
  const [showDismissed, setShowDismissed] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    setLoading(true);

    invoke('findings:list', {
      projectId: project.id,
      findingType,
      includeDismissed: showDismissed,
    })
      .then((result) => {
        if (!cancelled) setFindings(result);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [project, findingType, showDismissed, stats]);

  const visible = useMemo(
    () => (showDismissed ? findings : findings.filter((finding) => !finding.dismissedAt)),
    [findings, showDismissed],
  );

  const dismissedCount = findings.filter((finding) => finding.dismissedAt).length;

  const handleDismiss = async (finding: Finding): Promise<void> => {
    await dismissFinding(finding.id, finding.dismissedAt === null);
    setFindings((current) =>
      current.map((item) =>
        item.id === finding.id
          ? { ...item, dismissedAt: item.dismissedAt ? null : new Date().toISOString() }
          : item,
      ),
    );
  };

  if (!project || !stats || stats.totalFiles === 0) {
    return (
      <EmptyState
        title="Nothing analysed yet"
        description="Scan a project to see findings."
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-edge px-5 py-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[13px] font-medium text-ink">
              {title} <span className="text-ink-faint">({visible.length})</span>
            </h2>
            <p className="mt-0.5 max-w-2xl text-[11px] leading-relaxed text-ink-muted">
              {description}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {loading && <Spinner />}
            <Button size="sm" variant="ghost" onClick={() => setShowDismissed((value) => !value)}>
              {showDismissed ? <EyeOff size={11} /> : <Eye size={11} />}
              {showDismissed ? 'Hide dismissed' : `Show dismissed (${dismissedCount})`}
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <EmptyState title={emptyTitle} description={emptyDescription} />
        ) : (
          <ul className="divide-y divide-edge">
            {visible.map((finding) => (
              <li
                key={finding.id}
                className={clsx('px-5 py-3', finding.dismissedAt && 'opacity-45')}
              >
                <div className="mb-1.5 flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <SeverityBadge severity={finding.severity} />
                    <h3 className="truncate text-[12px] font-medium text-ink">{finding.title}</h3>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {finding.relatedNodeIds[0] && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Focus this in the dependency graph"
                        onClick={() => {
                          selectNode(finding.relatedNodeIds[0] as string);
                          setActiveView('graph');
                        }}
                      >
                        <Crosshair size={11} />
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => void handleDismiss(finding)}>
                      {finding.dismissedAt ? 'Restore' : 'Dismiss'}
                    </Button>
                  </div>
                </div>

                <p className="mb-2 text-[11px] leading-relaxed text-ink-muted">
                  {finding.description}
                </p>

                <FindingBody finding={finding} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function CyclesView(): JSX.Element {
  return (
    <FindingsView
      findingType="circular-dependency"
      title="Circular dependencies"
      description="Groups of files that import each other, directly or through a chain. Detected with Tarjan's strongly connected components algorithm over resolved imports only."
      emptyTitle="No import cycles detected"
      emptyDescription="No group of files in this project imports itself through a chain of resolved imports."
    />
  );
}

export function UnusedExportsView(): JSX.Element {
  return (
    <FindingsView
      findingType="unused-export-candidate"
      title="Unused export candidates"
      description="Exported symbols with no resolved import anywhere in this project. These are candidates for review, not confirmed dead code — a consumer outside the scanned folder, a namespace import, or a framework convention can all use a symbol invisibly."
      emptyTitle="No unused export candidates"
      emptyDescription="Every exported symbol has at least one resolved import inside the project."
    />
  );
}

export function TypeErrorsView(): JSX.Element {
  return (
    <FindingsView
      findingType="type-error"
      title="Type errors"
      description="Reported by the TypeScript compiler itself, not by TraceDeck's own analysis. These are real compile errors. Enable type checking in Settings and rescan to refresh them."
      emptyTitle="No type errors reported"
      emptyDescription="Either the project type checks cleanly, or type checking is turned off for this project. Turn it on in Settings and rescan."
    />
  );
}

export function UnresolvedImportsView(): JSX.Element {
  return (
    <FindingsView
      findingType="unresolved-import"
      title="Unresolved imports"
      description="Imports this scan could not follow to a file. Each one is a gap in the graph, so dependency and blast-radius results involving these files may be incomplete."
      emptyTitle="Every import resolved"
      emptyDescription="All import specifiers in this project resolved to a file or a known external package."
    />
  );
}

export function SyntaxErrorsView(): JSX.Element {
  return (
    <FindingsView
      findingType="syntax-error"
      title="Syntax errors"
      description="Files the parser could not read as valid syntax. Reported for every inventoried text file, not only dependency-graph sources."
      emptyTitle="No syntax errors"
      emptyDescription="Every parsed file in this project is syntactically valid."
    />
  );
}

export function MergeConflictsView(): JSX.Element {
  return (
    <FindingsView
      findingType="merge-conflict"
      title="Merge conflicts"
      description="Unresolved Git conflict markers left in project files."
      emptyTitle="No merge conflicts"
      emptyDescription="No file in this project contains unresolved conflict markers."
    />
  );
}
