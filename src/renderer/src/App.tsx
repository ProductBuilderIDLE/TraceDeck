import { useEffect } from 'react';
import { X } from 'lucide-react';
import { Sidebar } from './components/layout/Sidebar';
import { MainPanel } from './components/layout/MainPanel';
import { Inspector } from './components/layout/Inspector';
import { Dashboard } from './components/views/Dashboard';
import { Explorer } from './components/views/Explorer';
import { GraphView } from './components/views/GraphView';
import {
  CyclesView,
  TypeErrorsView,
  UnresolvedImportsView,
  UnusedExportsView,
  SyntaxErrorsView,
  MergeConflictsView,
  TodosView,
  DuplicatesView,
  ComplexityView,
} from './components/views/Findings';
import { ArchitectureRulesView } from './components/views/ArchitectureRules';
import { MetricsView } from './components/views/Metrics';
import { ReportsView } from './components/views/Reports';
import { SettingsView } from './components/views/Settings';
import { useUiStore, type ViewId } from './store/uiStore';
import { useAppStore } from './store/appStore';
import { invoke, subscribeToScanProgress } from './lib/ipc';
import { ErrorBoundary } from './components/common/ErrorBoundary';

const VIEWS: Record<ViewId, () => JSX.Element> = {
  dashboard: Dashboard,
  graph: GraphView,
  explorer: Explorer,
  cycles: CyclesView,
  'unused-exports': UnusedExportsView,
  architecture: ArchitectureRulesView,
  unresolved: UnresolvedImportsView,
  'type-errors': TypeErrorsView,
  'syntax-errors': SyntaxErrorsView,
  'merge-conflicts': MergeConflictsView,
  todos: TodosView,
  duplicates: DuplicatesView,
  complexity: ComplexityView,
  metrics: MetricsView,
  reports: ReportsView,
  settings: SettingsView,
};

function ErrorBanner(): JSX.Element | null {
  const error = useAppStore((state) => state.error);
  const setError = useAppStore((state) => state.setError);

  if (!error) return null;

  return (
    <div className="flex items-start gap-2 border-b border-risk-crit/30 bg-risk-crit/10 px-4 py-2">
      <p className="flex-1 text-[11px] leading-relaxed text-risk-crit">{error}</p>
      <button
        type="button"
        onClick={() => setError(null)}
        className="shrink-0 rounded p-0.5 text-risk-crit hover:bg-risk-crit/15"
        aria-label="Dismiss error"
      >
        <X size={13} />
      </button>
    </div>
  );
}

export function App(): JSX.Element {
  const activeView = useUiStore((state) => state.activeView);
  const inspectorOpen = useUiStore((state) => state.inspectorOpen);
  const setScanProgress = useAppStore((state) => state.setScanProgress);
  const theme = useUiStore((state) => state.theme);

  useEffect(() => subscribeToScanProgress(setScanProgress), [setScanProgress]);

  // Keeps the native window background and title bar in step with the in-app theme.
  useEffect(() => {
    invoke('system:set-theme', { theme }).catch(() => undefined);
  }, [theme]);

  const lastScan = useAppStore((state) => state.lastScan);
  const View = VIEWS[activeView];

  return (
    <div className="flex h-full w-full overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <ErrorBanner />
        <div className="flex min-h-0 flex-1">
          <MainPanel>
            <ErrorBoundary key={`${activeView}:${lastScan?.id ?? 'none'}`}>
              <View />
            </ErrorBoundary>
          </MainPanel>
          {inspectorOpen && <Inspector />}
        </div>
      </div>
    </div>
  );
}
