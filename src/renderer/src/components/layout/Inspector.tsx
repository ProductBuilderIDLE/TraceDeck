import { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Copy,
  ExternalLink,
  FolderOpen,
  PanelRightClose,
} from 'lucide-react';
import type { BlastRadiusEntry, BlastRadiusResult, FileDetail } from '@shared/types';
import { DEFAULT_MAX_TRAVERSAL_DEPTH, MAX_TRAVERSAL_DEPTH } from '@shared/constants';
import { parseNodeId } from '@shared/nodeIds';
import { useUiStore } from '../../store/uiStore';
import { useAppStore } from '../../store/appStore';
import { invoke } from '../../lib/ipc';
import { Button, Caveat, PathLabel, RiskBadge, Spinner, Warning } from '../common/ui';

function Section({
  title,
  count,
  children,
  defaultOpen = true,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="border-b border-edge">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-surface-2"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          {title}
        </span>
        {count !== undefined && (
          <span className="font-mono text-[11px] tabular-nums text-ink-muted">{count}</span>
        )}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </section>
  );
}

function EntryList({
  entries,
  emptyLabel,
}: {
  entries: readonly BlastRadiusEntry[];
  emptyLabel: string;
}): JSX.Element {
  const selectNode = useUiStore((state) => state.selectNode);

  if (entries.length === 0) {
    return <p className="text-[11px] text-ink-faint">{emptyLabel}</p>;
  }

  return (
    <ul className="space-y-0.5">
      {entries.slice(0, 100).map((entry) => (
        <li key={entry.nodeId}>
          <button
            type="button"
            onClick={() => selectNode(entry.nodeId)}
            className="group flex w-full items-start gap-2 rounded px-1.5 py-1 text-left hover:bg-surface-2"
            title={entry.explanationPath.join('  ->  ')}
          >
            <span className="mt-0.5 shrink-0 rounded bg-surface-3 px-1 font-mono text-[9px] tabular-nums text-ink-faint">
              {entry.depth}
            </span>
            <PathLabel path={entry.path} className="flex-1" />
          </button>
        </li>
      ))}
      {entries.length > 100 && (
        <li className="px-1.5 pt-1 text-[10px] text-ink-faint">
          …and {entries.length - 100} more.
        </li>
      )}
    </ul>
  );
}

function ExplanationPaths({ entries }: { entries: readonly BlastRadiusEntry[] }): JSX.Element {
  const deepest = [...entries].sort((a, b) => b.depth - a.depth).slice(0, 5);

  if (deepest.length === 0) {
    return <p className="text-[11px] text-ink-faint">Nothing depends on this yet.</p>;
  }

  return (
    <div className="space-y-2.5">
      <p className="text-[11px] leading-relaxed text-ink-muted">
        The shortest chain from this file to each affected file. This is why a change here could
        reach them.
      </p>
      {deepest.map((entry) => (
        <div key={entry.nodeId} className="rounded border border-edge bg-surface-2 p-2">
          {entry.explanationPath.map((step, index) => (
            <div
              key={`${entry.nodeId}-${step}`}
              className="mono-path flex items-start gap-1.5 text-ink-muted"
              style={{ paddingLeft: `${index * 8}px` }}
            >
              {index > 0 && <span className="text-ink-faint">→</span>}
              <span className={clsx(index === entry.explanationPath.length - 1 && 'text-ink')}>
                {step}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function Inspector(): JSX.Element {
  const selectedNodeId = useUiStore((state) => state.selectedNodeId);
  const toggleInspector = useUiStore((state) => state.toggleInspector);
  const project = useAppStore((state) => state.currentProject);

  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [blast, setBlast] = useState<BlastRadiusResult | null>(null);
  const [depth, setDepth] = useState(DEFAULT_MAX_TRAVERSAL_DEPTH);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!project || !selectedNodeId) {
      setDetail(null);
      setBlast(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setMessage(null);

    Promise.all([
      invoke('graph:file-detail', { projectId: project.id, nodeId: selectedNodeId }).catch(
        () => null,
      ),
      invoke('graph:blast-radius', {
        projectId: project.id,
        nodeId: selectedNodeId,
        maxDepth: depth,
      }).catch(() => null),
    ])
      .then(([fileDetail, blastRadius]) => {
        if (cancelled) return;
        setDetail(fileDetail);
        setBlast(blastRadius);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [project, selectedNodeId, depth]);

  const parsed = selectedNodeId ? parseNodeId(selectedNodeId) : null;

  const copyPath = async (): Promise<void> => {
    if (!parsed) return;
    try {
      await navigator.clipboard.writeText(parsed.path);
      setMessage('Path copied.');
      setTimeout(() => setMessage(null), 1600);
    } catch {
      setMessage('Could not copy the path.');
    }
  };

  const openInEditor = async (): Promise<void> => {
    if (!project || !parsed) return;
    try {
      await invoke('system:open-path', { projectId: project.id, relativePath: parsed.path });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not open the file.');
    }
  };

  const revealInFolder = async (): Promise<void> => {
    if (!project || !parsed) return;
    try {
      await invoke('system:reveal-path', { projectId: project.id, relativePath: parsed.path });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not reveal the file.');
    }
  };

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-edge bg-surface-1">
      <header className="flex items-center justify-between border-b border-edge px-3 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Inspector
        </span>
        <div className="flex items-center gap-1">
          {loading && <Spinner />}
          <button
            type="button"
            onClick={toggleInspector}
            className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
            aria-label="Hide inspector"
          >
            <PanelRightClose size={15} />
          </button>
        </div>
      </header>

      {!selectedNodeId || !parsed ? (
        <div className="flex-1 p-3">
          <p className="text-[11px] leading-relaxed text-ink-faint">
            Select a file or symbol to see its dependencies, dependents, blast radius, and change
            impact score.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-edge px-3 py-2.5">
            <p className="mono-path selectable break-all text-ink">{parsed.path}</p>
            {parsed.symbolName && (
              <p className="mt-0.5 text-[11px] text-brand">{parsed.symbolName}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              <Button size="sm" variant="ghost" onClick={() => void copyPath()}>
                <Copy size={11} />
                Copy path
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void openInEditor()}>
                <ExternalLink size={11} />
                Open
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void revealInFolder()}>
                <FolderOpen size={11} />
                Reveal
              </Button>
            </div>
            {message && <p className="mt-1.5 text-[10px] text-ink-faint">{message}</p>}
          </div>

          {detail?.inCycle && (
            <div className="px-3 pt-3">
              <Warning>
                This file is part of a circular dependency. Changes here can loop back through the
                cycle.
              </Warning>
            </div>
          )}

          {detail && (
            <Section title="Change impact score">
              <div className="mb-2 flex items-baseline gap-2">
                <span className="font-mono text-2xl font-semibold tabular-nums">
                  <RiskBadge score={detail.riskScore.score} />
                </span>
                <span className="text-[11px] text-ink-faint">out of 100</span>
              </div>

              <ul className="space-y-1.5">
                {detail.riskScore.factors.map((factor) => (
                  <li key={factor.key}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] text-ink-muted">{factor.label}</span>
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">
                        {factor.points}/{factor.maxPoints}
                      </span>
                    </div>
                    <div className="mt-0.5 h-0.5 overflow-hidden rounded-full bg-surface-3">
                      <div
                        className="h-full bg-brand/60"
                        style={{ width: `${(factor.points / factor.maxPoints) * 100}%` }}
                      />
                    </div>
                    <p className="mt-0.5 text-[10px] leading-snug text-ink-faint">
                      {factor.explanation}
                    </p>
                  </li>
                ))}
              </ul>

              <div className="mt-2.5 border-t border-edge pt-2">
                <Caveat>{detail.riskScore.formulaDescription}</Caveat>
              </div>
            </Section>
          )}

          <Section title="Blast radius">
            <div className="mb-2.5 flex items-center gap-2">
              <label className="text-[11px] text-ink-muted" htmlFor="depth">
                Max depth
              </label>
              <input
                id="depth"
                type="range"
                min={1}
                max={MAX_TRAVERSAL_DEPTH}
                value={depth}
                onChange={(event) => setDepth(Number(event.target.value))}
                className="flex-1 accent-brand"
              />
              <span className="w-5 text-right font-mono text-[11px] tabular-nums text-ink">
                {depth}
              </span>
            </div>

            {blast ? (
              <>
                <div className="mb-2.5 grid grid-cols-2 gap-2">
                  <div className="rounded border border-edge bg-surface-2 p-2">
                    <div className="font-mono text-lg tabular-nums text-ink">
                      {blast.directDependents.length + blast.transitiveDependents.length}
                    </div>
                    <div className="text-[10px] text-ink-muted">files could be affected</div>
                  </div>
                  <div className="rounded border border-edge bg-surface-2 p-2">
                    <div className="font-mono text-lg tabular-nums text-ink">
                      {blast.directDependencies.length + blast.transitiveDependencies.length}
                    </div>
                    <div className="text-[10px] text-ink-muted">files this depends on</div>
                  </div>
                </div>

                {blast.truncatedAtDepth && (
                  <div className="mb-2">
                    <Warning>
                      More files lie beyond depth {depth}. Raise the limit to see the full radius.
                    </Warning>
                  </div>
                )}

                {blast.partialResultWarnings.map((warning) => (
                  <div key={warning} className="mb-2">
                    <Caveat>{warning}</Caveat>
                  </div>
                ))}
              </>
            ) : (
              <p className="text-[11px] text-ink-faint">No blast radius available.</p>
            )}
          </Section>

          {blast && (
            <>
              <Section
                title="Direct dependents"
                count={blast.directDependents.length}
              >
                <p className="mb-1.5 flex items-center gap-1 text-[10px] text-ink-faint">
                  <ArrowUpRight size={10} /> These import this file directly.
                </p>
                <EntryList entries={blast.directDependents} emptyLabel="Nothing imports this file." />
              </Section>

              <Section
                title="Transitive dependents"
                count={blast.transitiveDependents.length}
                defaultOpen={false}
              >
                <EntryList
                  entries={blast.transitiveDependents}
                  emptyLabel="Nothing reaches this file indirectly."
                />
              </Section>

              <Section title="Direct dependencies" count={blast.directDependencies.length}>
                <p className="mb-1.5 flex items-center gap-1 text-[10px] text-ink-faint">
                  <ArrowDownLeft size={10} /> This file imports these directly.
                </p>
                <EntryList
                  entries={blast.directDependencies}
                  emptyLabel="This file imports nothing inside the project."
                />
              </Section>

              <Section
                title="Transitive dependencies"
                count={blast.transitiveDependencies.length}
                defaultOpen={false}
              >
                <EntryList
                  entries={blast.transitiveDependencies}
                  emptyLabel="No indirect dependencies."
                />
              </Section>

              <Section title="Why these are affected" defaultOpen={false}>
                <ExplanationPaths entries={blast.transitiveDependents} />
              </Section>
            </>
          )}

          {detail && detail.symbols.length > 0 && (
            <Section title="Symbols" count={detail.symbols.length} defaultOpen={false}>
              <ul className="space-y-0.5">
                {detail.symbols.map((symbol) => (
                  <li
                    key={`${symbol.name}-${symbol.startLine}`}
                    className="flex items-baseline gap-2 px-1.5 py-0.5"
                  >
                    <span className="mono-path flex-1 truncate text-ink">{symbol.name}</span>
                    <span className="shrink-0 text-[10px] text-ink-faint">{symbol.kind}</span>
                    {symbol.isExported && (
                      <span className="shrink-0 rounded bg-brand/15 px-1 text-[9px] text-brand">
                        export
                      </span>
                    )}
                    <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                      :{symbol.startLine}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {!detail && !loading && (
            <div className="p-3">
              <Caveat>
                This node is not a file in the last scan. It may be an unresolved import target or
                a symbol whose file was removed.
              </Caveat>
            </div>
          )}
        </div>
      )}

      <div className="border-t border-edge px-3 py-2">
        <p className="text-[10px] leading-snug text-ink-faint">
          Static analysis result. It reflects resolved imports only — verify before changing code.
        </p>
      </div>
    </aside>
  );
}
