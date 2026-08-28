import { useCallback, useEffect, useRef } from 'react';
import { Code2, PanelRightOpen } from 'lucide-react';
import { useUiStore, type ViewId } from '../../store/uiStore';
import { CodePanel } from '../views/CodePanel';
import { Button } from '../common/ui';

const VIEW_TITLES: Record<ViewId, string> = {
  dashboard: 'Dashboard',
  graph: 'Dependency graph',
  explorer: 'Explorer',
  cycles: 'Circular dependencies',
  'unused-exports': 'Unused export candidates',
  architecture: 'Architecture rules',
  unresolved: 'Unresolved imports',
  'type-errors': 'Type errors',
  'syntax-errors': 'Syntax errors',
  'merge-conflicts': 'Merge conflicts',
  reports: 'Reports',
  settings: 'Settings',
};

/** Views where reading source beside the content is useful. */
const CODE_CAPABLE: ReadonlySet<ViewId> = new Set<ViewId>([
  'graph',
  'explorer',
  'cycles',
  'unused-exports',
  'architecture',
  'unresolved',
  'type-errors',
  'syntax-errors',
  'merge-conflicts',
]);

export function MainPanel({ children }: { children: React.ReactNode }): JSX.Element {
  const activeView = useUiStore((state) => state.activeView);
  const inspectorOpen = useUiStore((state) => state.inspectorOpen);
  const toggleInspector = useUiStore((state) => state.toggleInspector);
  const codeOpen = useUiStore((state) => state.codeOpen);
  const codeSplit = useUiStore((state) => state.codeSplit);
  const toggleCode = useUiStore((state) => state.toggleCode);
  const setCodeSplit = useUiStore((state) => state.setCodeSplit);

  const splitRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const showCode = codeOpen && CODE_CAPABLE.has(activeView);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current || !splitRef.current) return;
      const bounds = splitRef.current.getBoundingClientRect();
      setCodeSplit((event.clientX - bounds.left) / bounds.width);
    },
    [setCodeSplit],
  );

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  // Ctrl/Cmd+` mirrors the editor convention for showing a secondary pane.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key === '`') {
        event.preventDefault();
        toggleCode();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleCode]);

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-0">
      <header className="flex shrink-0 items-center justify-between border-b border-edge px-4 py-2.5">
        <h1 className="text-sm font-medium">{VIEW_TITLES[activeView]}</h1>
        <div className="flex items-center gap-1">
          {CODE_CAPABLE.has(activeView) && (
            <Button
              size="sm"
              variant={showCode ? 'primary' : 'ghost'}
              onClick={toggleCode}
              title="Show source alongside (Ctrl+`)"
            >
              <Code2 size={11} />
              Code
            </Button>
          )}
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
        </div>
      </header>

      <div ref={splitRef} className="flex min-h-0 min-w-0 flex-1">
        <div
          className="min-h-0 min-w-0 overflow-y-auto"
          style={showCode ? { width: `${codeSplit * 100}%` } : { width: '100%' }}
        >
          {children}
        </div>

        {showCode && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the code viewer"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              className="w-1 shrink-0 cursor-col-resize bg-edge transition-colors hover:bg-brand"
            />
            <div className="flex min-h-0 min-w-0 flex-1">
              <CodePanel />
            </div>
          </>
        )}
      </div>
    </main>
  );
}
