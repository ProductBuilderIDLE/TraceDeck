import { useEffect, useState } from 'react';
import { Download, FileJson, FileText, Globe } from 'lucide-react';
import type {
  FindingType,
  ReportFormat,
  ReportScope,
  ReportSection,
  SavedReport,
} from '@shared/types';
import { parseNodeId } from '@shared/nodeIds';
import { useAppStore } from '../../store/appStore';
import { useUiStore } from '../../store/uiStore';
import { invoke } from '../../lib/ipc';
import { Button, Caveat, Card, EmptyState, PathLabel, Spinner } from '../common/ui';

const FORMATS: Array<{ id: ReportFormat; label: string; icon: typeof FileText; hint: string }> = [
  { id: 'markdown', label: 'Markdown', icon: FileText, hint: 'Good for pull requests and wikis.' },
  { id: 'json', label: 'JSON', icon: FileJson, hint: 'Full structured data for other tools.' },
  {
    id: 'html',
    label: 'Standalone HTML',
    icon: Globe,
    hint: 'One self-contained file with no remote assets.',
  },
];

const SECTIONS: Array<{ id: ReportSection; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'top-impact-files', label: 'Files by change impact' },
  { id: 'cycles', label: 'Circular dependencies' },
  { id: 'unused-exports', label: 'Unused export candidates' },
  { id: 'architecture-violations', label: 'Architecture violations' },
  { id: 'unresolved-imports', label: 'Unresolved imports' },
  { id: 'type-errors', label: 'Type errors' },
  { id: 'limitations', label: 'Analysis limitations' },
];

const FINDING_TYPES: Array<{ id: FindingType; label: string }> = [
  { id: 'circular-dependency', label: 'Circular dependencies' },
  { id: 'unused-export-candidate', label: 'Unused export candidates' },
  { id: 'architecture-violation', label: 'Architecture violations' },
  { id: 'unresolved-import', label: 'Unresolved imports' },
  { id: 'type-error', label: 'Type errors' },
];

type ScopeKind = ReportScope['kind'];

export function ReportsView(): JSX.Element {
  const project = useAppStore((state) => state.currentProject);
  const stats = useAppStore((state) => state.stats);
  const selectedNodeId = useUiStore((state) => state.selectedNodeId);

  const [saved, setSaved] = useState<SavedReport[]>([]);
  const [title, setTitle] = useState('TraceDeck report');
  const [format, setFormat] = useState<ReportFormat>('markdown');
  const [scopeKind, setScopeKind] = useState<ScopeKind>('project');
  const [findingType, setFindingType] = useState<FindingType>('circular-dependency');
  const [sections, setSections] = useState<Set<ReportSection>>(
    new Set(SECTIONS.map((section) => section.id)),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const selection = selectedNodeId ? parseNodeId(selectedNodeId) : null;

  const loadSaved = async (): Promise<void> => {
    if (!project) return;
    try {
      setSaved(await invoke('reports:list', { projectId: project.id }));
    } catch {
      setSaved([]);
    }
  };

  useEffect(() => {
    void loadSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  useEffect(() => {
    if (project) setTitle(`${project.name} dependency report`);
  }, [project]);

  const buildScope = (): ReportScope => {
    if (scopeKind === 'file' && selection) return { kind: 'file', filePath: selection.path };
    if (scopeKind === 'symbol' && selection?.symbolName) {
      return { kind: 'symbol', filePath: selection.path, symbolName: selection.symbolName };
    }
    if (scopeKind === 'finding-type') return { kind: 'finding-type', findingType };
    return { kind: 'project' };
  };

  const exportReport = async (): Promise<void> => {
    if (!project) return;
    setBusy(true);
    setMessage(null);

    try {
      const result = await invoke('reports:export', {
        projectId: project.id,
        configuration: {
          title: title.trim() || 'TraceDeck report',
          format,
          sections: [...sections],
          scope: buildScope(),
        },
      });

      setMessage(result.cancelled ? null : `Saved to ${result.filePath}`);
      if (!result.cancelled) await loadSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The report could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  if (!project || !stats || stats.totalFiles === 0) {
    return (
      <EmptyState
        title="Nothing to report yet"
        description="Scan a project before exporting a report."
      />
    );
  }

  return (
    <div className="space-y-4 p-5">
      <Card title="Export a report">
        <div className="space-y-3.5">
          <div>
            <label className="mb-1 block text-[11px] text-ink-muted" htmlFor="report-title">
              Report title
            </label>
            <input
              id="report-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              style={{ userSelect: 'text' }}
              className="w-full rounded border border-edge bg-surface-2 px-2 py-1.5 text-[12px] text-ink focus:border-brand focus:outline-none"
            />
          </div>

          <div>
            <p className="mb-1.5 text-[11px] text-ink-muted">Format</p>
            <div className="grid grid-cols-3 gap-2">
              {FORMATS.map((option) => {
                const Icon = option.icon;
                const active = format === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setFormat(option.id)}
                    className={`rounded-lg border p-2.5 text-left transition-colors ${
                      active
                        ? 'border-brand bg-brand/10'
                        : 'border-edge bg-surface-2 hover:border-ink-faint'
                    }`}
                  >
                    <Icon size={14} className={active ? 'text-brand' : 'text-ink-faint'} />
                    <span className="mt-1 block text-[12px] text-ink">{option.label}</span>
                    <span className="block text-[10px] leading-snug text-ink-faint">
                      {option.hint}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-[11px] text-ink-muted">Scope</p>
            <div className="space-y-1.5">
              {(
                [
                  ['project', 'Whole project'],
                  ['file', selection ? `Selected file: ${selection.path}` : 'Selected file (none)'],
                  [
                    'symbol',
                    selection?.symbolName
                      ? `Selected symbol: ${selection.symbolName}`
                      : 'Selected symbol (none)',
                  ],
                  ['finding-type', 'A single finding type'],
                ] as Array<[ScopeKind, string]>
              ).map(([kind, label]) => {
                const disabled =
                  (kind === 'file' && !selection) || (kind === 'symbol' && !selection?.symbolName);
                return (
                  <label
                    key={kind}
                    className={`flex items-center gap-2 text-[12px] ${
                      disabled ? 'cursor-not-allowed text-ink-faint' : 'cursor-pointer text-ink-muted'
                    }`}
                  >
                    <input
                      type="radio"
                      name="scope"
                      checked={scopeKind === kind}
                      disabled={disabled}
                      onChange={() => setScopeKind(kind)}
                      className="accent-brand"
                    />
                    <span className="truncate">{label}</span>
                  </label>
                );
              })}
            </div>

            {scopeKind === 'finding-type' && (
              <select
                value={findingType}
                onChange={(event) => setFindingType(event.target.value as FindingType)}
                className="mt-1.5 w-full rounded border border-edge bg-surface-2 px-2 py-1.5 text-[12px] text-ink focus:border-brand focus:outline-none"
              >
                {FINDING_TYPES.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <p className="mb-1.5 text-[11px] text-ink-muted">Sections</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {SECTIONS.map((section) => (
                <label
                  key={section.id}
                  className="flex cursor-pointer items-center gap-2 text-[12px] text-ink-muted"
                >
                  <input
                    type="checkbox"
                    checked={sections.has(section.id)}
                    onChange={() =>
                      setSections((current) => {
                        const next = new Set(current);
                        if (next.has(section.id)) next.delete(section.id);
                        else next.add(section.id);
                        return next;
                      })
                    }
                    className="accent-brand"
                  />
                  {section.label}
                </label>
              ))}
            </div>
          </div>

          <Caveat>
            The report is written locally through your operating system&rsquo;s save dialog. It
            contains no remote assets, no tracking, and no network requests.
          </Caveat>

          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => void exportReport()} disabled={busy}>
              {busy ? <Spinner /> : <Download size={12} />}
              Choose destination and export
            </Button>
            {message && <span className="text-[11px] text-ink-muted">{message}</span>}
          </div>
        </div>
      </Card>

      <Card title={`Previously exported (${saved.length})`}>
        {saved.length === 0 ? (
          <p className="text-[12px] text-ink-muted">No reports exported from this project yet.</p>
        ) : (
          <ul className="divide-y divide-edge">
            {saved.map((report) => (
              <li key={report.id} className="flex items-center gap-3 py-1.5">
                <span className="flex-1 truncate text-[12px] text-ink">{report.name}</span>
                <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-muted">
                  {report.reportType}
                </span>
                <PathLabel path={new Date(report.createdAt).toLocaleString()} />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await invoke('reports:delete', { reportId: report.id });
                    await loadSaved();
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
