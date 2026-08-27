import { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  ChevronDown,
  FileText,
  FolderOpen,
  FolderTree,
  GitBranch,
  LayoutDashboard,
  PackageX,
  Play,
  RefreshCcw,
  Settings,
  ShieldAlert,
  TriangleAlert,
  Square,
  Unlink,
} from 'lucide-react';
import { PRIVACY_NOTICE } from '@shared/constants';
import { useUiStore, type ViewId } from '../../store/uiStore';
import { useAppStore } from '../../store/appStore';
import { Button, Spinner } from '../common/ui';

interface NavItem {
  id: ViewId;
  label: string;
  icon: typeof LayoutDashboard;
  count?: number;
}

function NavButton({ item }: { item: NavItem }): JSX.Element {
  const activeView = useUiStore((state) => state.activeView);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const Icon = item.icon;
  const isActive = activeView === item.id;

  return (
    <button
      type="button"
      onClick={() => setActiveView(item.id)}
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors',
        isActive ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
      )}
    >
      <Icon size={14} strokeWidth={1.75} className="shrink-0" />
      <span className="flex-1 truncate">{item.label}</span>
      {item.count !== undefined && item.count > 0 && (
        <span className="rounded bg-surface-4 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-ink-muted">
          {item.count}
        </span>
      )}
    </button>
  );
}

function ProjectPicker(): JSX.Element {
  const projects = useAppStore((state) => state.projects);
  const currentProject = useAppStore((state) => state.currentProject);
  const selectProject = useAppStore((state) => state.selectProject);
  const openProjectDialog = useAppStore((state) => state.openProjectDialog);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative border-b border-edge p-2.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-md border border-edge bg-surface-2 px-2.5 py-2 text-left hover:bg-surface-3"
      >
        <FolderOpen size={14} className="shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium text-ink">
            {currentProject?.name ?? 'No project open'}
          </span>
          {currentProject && (
            <span className="mono-path block truncate text-ink-faint" title={currentProject.rootPath}>
              {currentProject.rootPath}
            </span>
          )}
        </span>
        <ChevronDown size={13} className="shrink-0 text-ink-faint" />
      </button>

      {open && (
        <div className="absolute inset-x-2.5 top-full z-20 mt-1 overflow-hidden rounded-md border border-edge bg-surface-2 shadow-xl">
          <div className="max-h-64 overflow-y-auto">
            {projects.length === 0 && (
              <p className="px-2.5 py-2 text-[11px] text-ink-faint">No projects yet.</p>
            )}
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => {
                  void selectProject(project.id);
                  setOpen(false);
                }}
                className={clsx(
                  'block w-full px-2.5 py-1.5 text-left hover:bg-surface-3',
                  project.id === currentProject?.id && 'bg-surface-3',
                )}
              >
                <span className="block truncate text-[12px] text-ink">{project.name}</span>
                <span className="mono-path block truncate text-ink-faint">{project.rootPath}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              void openProjectDialog();
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 border-t border-edge px-2.5 py-2 text-[12px] text-brand hover:bg-surface-3"
          >
            <FolderOpen size={13} />
            Open a project folder…
          </button>
        </div>
      )}
    </div>
  );
}

function ScanControls(): JSX.Element | null {
  const currentProject = useAppStore((state) => state.currentProject);
  const scanning = useAppStore((state) => state.scanning);
  const progress = useAppStore((state) => state.scanProgress);
  const startScan = useAppStore((state) => state.startScan);
  const cancelScan = useAppStore((state) => state.cancelScan);
  const lastScan = useAppStore((state) => state.lastScan);

  if (!currentProject) return null;

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
      : null;

  return (
    <div className="space-y-2 border-b border-edge p-2.5">
      {scanning ? (
        <>
          <div className="flex items-center gap-2 text-[11px] text-ink-muted">
            <Spinner />
            <span className="truncate">{progress?.message ?? 'Scanning…'}</span>
          </div>
          {percent !== null && (
            <div className="h-1 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full bg-brand transition-all" style={{ width: `${percent}%` }} />
            </div>
          )}
          <Button onClick={() => void cancelScan()} size="sm" variant="ghost" className="w-full">
            <Square size={11} />
            Cancel scan
          </Button>
        </>
      ) : (
        <div className="flex gap-1.5">
          <Button onClick={() => void startScan(false)} variant="primary" size="sm" className="flex-1">
            <Play size={11} />
            Scan
          </Button>
          <Button
            onClick={() => void startScan(true)}
            size="sm"
            title="Re-parse every file, ignoring cached hashes"
          >
            <RefreshCcw size={11} />
            Full
          </Button>
        </div>
      )}

      {!scanning && lastScan?.completedAt && (
        <p className="text-[10px] text-ink-faint">
          Last scan {new Date(lastScan.completedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}

export function Sidebar(): JSX.Element {
  const stats = useAppStore((state) => state.stats);
  const loadProjects = useAppStore((state) => state.loadProjects);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const primary: NavItem[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'graph', label: 'Dependency graph', icon: GitBranch },
    { id: 'explorer', label: 'Explorer', icon: FolderTree },
  ];

  const findings: NavItem[] = [
    {
      id: 'cycles',
      label: 'Circular dependencies',
      icon: RefreshCcw,
      count: stats?.cycleCount,
    },
    {
      id: 'unused-exports',
      label: 'Unused exports',
      icon: PackageX,
      count: stats?.unusedExportCandidateCount,
    },
    {
      id: 'architecture',
      label: 'Architecture rules',
      icon: ShieldAlert,
      count: stats?.architectureViolationCount,
    },
    {
      id: 'unresolved',
      label: 'Unresolved imports',
      icon: Unlink,
      count: stats?.unresolvedImportCount,
    },
    {
      id: 'type-errors',
      label: 'Type errors',
      icon: TriangleAlert,
      count: stats?.typeErrorCount,
    },
  ];

  const output: NavItem[] = [
    { id: 'reports', label: 'Reports', icon: FileText },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-edge bg-surface-1">
      <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
        <GitBranch size={17} className="text-brand" strokeWidth={2} />
        <span className="text-sm font-semibold tracking-tight">TraceDeck</span>
      </div>

      <ProjectPicker />
      <ScanControls />

      <nav className="flex-1 space-y-4 overflow-y-auto p-2">
        <div className="space-y-0.5">
          {primary.map((item) => (
            <NavButton key={item.id} item={item} />
          ))}
        </div>

        <div className="space-y-0.5">
          <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            Findings
          </p>
          {findings.map((item) => (
            <NavButton key={item.id} item={item} />
          ))}
        </div>

        <div className="space-y-0.5">
          {output.map((item) => (
            <NavButton key={item.id} item={item} />
          ))}
        </div>
      </nav>

      <div className="border-t border-edge px-3 py-2.5">
        <p className="text-[10px] leading-snug text-ink-faint">{PRIVACY_NOTICE}</p>
      </div>
    </aside>
  );
}
