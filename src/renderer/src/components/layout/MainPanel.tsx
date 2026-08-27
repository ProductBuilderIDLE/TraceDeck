import { PanelRightOpen } from 'lucide-react';
import { useUiStore, type ViewId } from '../../store/uiStore';

const VIEW_TITLES: Record<ViewId, string> = {
  dashboard: 'Dashboard',
  graph: 'Dependency graph',
  explorer: 'Explorer',
  cycles: 'Circular dependencies',
  'unused-exports': 'Unused export candidates',
  architecture: 'Architecture rules',
  unresolved: 'Unresolved imports',
  'type-errors': 'Type errors',
  reports: 'Reports',
  settings: 'Settings',
};

export function MainPanel({ children }: { children: React.ReactNode }): JSX.Element {
  const activeView = useUiStore((state) => state.activeView);
  const inspectorOpen = useUiStore((state) => state.inspectorOpen);
  const toggleInspector = useUiStore((state) => state.toggleInspector);

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-0">
      <header className="flex items-center justify-between border-b border-edge px-4 py-2.5">
        <h1 className="text-sm font-medium">{VIEW_TITLES[activeView]}</h1>
        {!inspectorOpen && (
          <button
            type="button"
            onClick={toggleInspector}
            className="rounded p-1 text-ink-faint hover:bg-surface-2 hover:text-ink"
            aria-label="Show inspector"
          >
            <PanelRightOpen size={15} />
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </main>
  );
}
