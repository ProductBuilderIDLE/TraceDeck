import { create } from 'zustand';
import type { ThemeId } from '@shared/theme';
import type { EdgeType } from '@shared/types';
import { parseNodeId } from '@shared/nodeIds';
import { applyTheme, loadStoredTheme, storeTheme } from '../lib/theme';

export type ViewId =
  | 'dashboard'
  | 'graph'
  | 'explorer'
  | 'cycles'
  | 'unused-exports'
  | 'architecture'
  | 'unresolved'
  | 'type-errors'
  | 'syntax-errors'
  | 'merge-conflicts'
  | 'todos'
  | 'duplicates'
  | 'complexity'
  | 'metrics'
  | 'reports'
  | 'settings';

interface UiState {
  activeView: ViewId;
  inspectorOpen: boolean;
  selectedNodeId: string | null;
  theme: ThemeId;
  /** Incremented on every theme change so canvas-based views know to restyle. */
  themeRevision: number;

  /** The source viewer that splits the main area alongside the graph. */
  codeOpen: boolean;
  /** Project-relative path currently shown in the source viewer. */
  codePath: string | null;
  /** Line to scroll to and highlight, when the selection points at one. */
  codeLine: number | null;
  /** Split position as a fraction of the main area given to the graph. */
  codeSplit: number;
  editorTabs: string[];
  recentPaths: string[];
  highlightNodeIds: string[];
  graphSliceEdgeTypes: EdgeType[] | null;

  setActiveView: (view: ViewId) => void;
  toggleInspector: () => void;
  selectNode: (nodeId: string | null) => void;
  setTheme: (theme: ThemeId) => void;

  openCode: (path: string, line?: number | null) => void;
  closeCode: () => void;
  toggleCode: () => void;
  setCodeSplit: (fraction: number) => void;
  closeEditorTab: (path: string) => void;
  setHighlightNodeIds: (nodeIds: string[]) => void;
  setGraphSliceEdgeTypes: (edgeTypes: EdgeType[] | null) => void;
}

const initialTheme = loadStoredTheme();

export const useUiStore = create<UiState>((set, get) => ({
  activeView: 'dashboard',
  inspectorOpen: true,
  selectedNodeId: null,
  theme: initialTheme,
  themeRevision: 0,

  codeOpen: false,
  codePath: null,
  codeLine: null,
  codeSplit: 0.5,
  editorTabs: [],
  recentPaths: [],
  highlightNodeIds: [],
  graphSliceEdgeTypes: null,

  setActiveView: (activeView) => set({ activeView }),
  toggleInspector: () => set((state) => ({ inspectorOpen: !state.inspectorOpen })),

  selectNode: (selectedNodeId) => {
    const parsed = selectedNodeId ? parseNodeId(selectedNodeId) : null;
    set({ selectedNodeId, inspectorOpen: true });

    // While the viewer is open it follows the selection, so clicking around the graph reads
    // like browsing a codebase rather than needing a second action every time.
    if (parsed && parsed.type !== 'folder' && get().codeOpen) {
      set({ codePath: parsed.path, codeLine: null });
    }
  },

  setTheme: (theme) => {
    applyTheme(theme);
    storeTheme(theme);
    set((state) => ({ theme, themeRevision: state.themeRevision + 1 }));
  },

  openCode: (path, line = null) =>
    set((state) => ({
      codeOpen: true,
      codePath: path,
      codeLine: line,
      editorTabs: state.editorTabs.includes(path) ? state.editorTabs : [...state.editorTabs, path].slice(-12),
      recentPaths: [path, ...state.recentPaths.filter((entry) => entry !== path)].slice(0, 12),
    })),
  closeCode: () => set({ codeOpen: false }),
  closeEditorTab: (path) =>
    set((state) => {
      const editorTabs = state.editorTabs.filter((entry) => entry !== path);
      const codePath = state.codePath === path ? (editorTabs[editorTabs.length - 1] ?? null) : state.codePath;
      return { editorTabs, codePath, codeOpen: editorTabs.length > 0 && state.codeOpen };
    }),
  setHighlightNodeIds: (highlightNodeIds) => set({ highlightNodeIds }),
  setGraphSliceEdgeTypes: (graphSliceEdgeTypes) => set({ graphSliceEdgeTypes }),
  toggleCode: () => {
    const { codeOpen, codePath, selectedNodeId } = get();
    if (codeOpen) {
      set({ codeOpen: false });
      return;
    }
    const parsed = selectedNodeId ? parseNodeId(selectedNodeId) : null;
    set({
      codeOpen: true,
      codePath: codePath ?? (parsed && parsed.type !== 'folder' ? parsed.path : null),
    });
  },
  setCodeSplit: (fraction) => set({ codeSplit: Math.min(0.85, Math.max(0.2, fraction)) }),
}));

// Applied before first render so the UI never paints with the wrong palette.
applyTheme(initialTheme);
