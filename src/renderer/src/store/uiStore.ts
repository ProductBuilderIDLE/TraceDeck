import { create } from 'zustand';
import type { ThemeId } from '@shared/theme';
import type { EdgeType, FindingType } from '@shared/types';
import type { ReviewItem } from '@shared/changeReview';
import { parseNodeId } from '@shared/nodeIds';
import { applyTheme, loadStoredTheme, storeTheme } from '../lib/theme';
import { reviewItemToGraphOverlay, type ReviewGraphOverlay } from '../lib/reviewGraph';

export type ViewId =
  | 'dashboard'
  | 'graph'
  | 'explorer'
  | 'change-review'
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
  /**
   * Nodes gathered with ctrl-click, kept separately from `selectedNodeId`.
   *
   * The inspector describes exactly one node, so a multi-selection cannot drive it. Keeping
   * the two apart lets a set be built up for a bulk action without the inspector flickering
   * through every node added to it.
   */
  multiSelectedNodeIds: string[];
  highlightNodeIds: string[];
  graphSliceEdgeTypes: EdgeType[] | null;

  /** Overlay produced from a review evidence item for the dependency graph. */
  reviewGraphOverlay: ReviewGraphOverlay | null;
  /** The review evidence currently shown in the inspector. */
  reviewEvidence: ReviewItem | null;
  /** One-shot state used to focus a specific finding by fingerprint. */
  focusedFindingFingerprint: { fingerprint: string; findingType: FindingType } | null;

  setActiveView: (view: ViewId) => void;
  toggleInspector: () => void;
  selectNode: (nodeId: string | null) => void;
  setTheme: (theme: ThemeId) => void;

  openCode: (path: string, line?: number | null) => void;
  closeCode: () => void;
  toggleCode: () => void;
  setCodeSplit: (fraction: number) => void;
  closeEditorTab: (path: string) => void;
  toggleMultiSelect: (nodeId: string) => void;
  clearMultiSelect: () => void;
  /** Adds a whole batch at once, as a drag-selection does. Existing members are kept. */
  addToMultiSelect: (nodeIds: readonly string[]) => void;
  /** Opens several files at once, focusing the first. Used by the bulk-open shortcut. */
  openPaths: (paths: readonly string[]) => void;
  setHighlightNodeIds: (nodeIds: string[]) => void;
  setGraphSliceEdgeTypes: (edgeTypes: EdgeType[] | null) => void;

  showReviewGraph: (item: ReviewItem) => void;
  showReviewEvidence: (item: ReviewItem) => void;
  focusFinding: (fingerprint: string, findingType: FindingType) => void;
  clearReviewContext: () => void;
}

const FINDING_TYPE_VIEWS: Record<FindingType, ViewId> = {
  'circular-dependency': 'cycles',
  'unused-export-candidate': 'unused-exports',
  'architecture-violation': 'architecture',
  'unresolved-import': 'unresolved',
  'type-error': 'type-errors',
  'syntax-error': 'syntax-errors',
  'merge-conflict': 'merge-conflicts',
  'todo-comment': 'todos',
  'duplicate-code': 'duplicates',
  'complexity-hotspot': 'complexity',
};

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
  multiSelectedNodeIds: [],
  highlightNodeIds: [],
  graphSliceEdgeTypes: null,
  reviewGraphOverlay: null,
  reviewEvidence: null,
  focusedFindingFingerprint: null,

  setActiveView: (activeView) => set({ activeView }),
  toggleInspector: () => set((state) => ({ inspectorOpen: !state.inspectorOpen })),

  selectNode: (selectedNodeId) => {
    const parsed = selectedNodeId ? parseNodeId(selectedNodeId) : null;
    // Only something real opens the panel. Clearing a selection — clicking empty canvas —
    // used to open it too, so a stray click put an empty inspector on screen and stole the
    // space the graph was using.
    set(
      selectedNodeId === null
        ? { selectedNodeId }
        : { selectedNodeId, inspectorOpen: true },
    );

    // While the viewer is open it follows the selection, so clicking around the graph reads
    // like browsing a codebase rather than needing a second action every time.
    // Review evidence may describe baseline-only or deleted files, so the source viewer must not
    // try to read them while the retained inspector is open.
    if (parsed && parsed.type !== 'folder' && get().codeOpen && !get().reviewEvidence) {
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
  toggleMultiSelect: (nodeId) =>
    set((state) => ({
      multiSelectedNodeIds: state.multiSelectedNodeIds.includes(nodeId)
        ? state.multiSelectedNodeIds.filter((entry) => entry !== nodeId)
        : [...state.multiSelectedNodeIds, nodeId],
    })),
  clearMultiSelect: () => set({ multiSelectedNodeIds: [] }),
  addToMultiSelect: (nodeIds) =>
    set((state) => ({
      multiSelectedNodeIds: [
        ...state.multiSelectedNodeIds,
        ...nodeIds.filter((id) => !state.multiSelectedNodeIds.includes(id)),
      ],
    })),

  openPaths: (paths) =>
    set((state) => {
      const wanted = [...new Set(paths)];
      if (wanted.length === 0) return {};

      // Same cap as opening one file at a time. A bulk open of forty files would otherwise
      // bury the tab strip, so the most recently added win.
      const editorTabs = [
        ...state.editorTabs.filter((entry) => !wanted.includes(entry)),
        ...wanted,
      ].slice(-12);

      return {
        codeOpen: true,
        codePath: wanted[0] ?? state.codePath,
        codeLine: null,
        editorTabs,
        recentPaths: [
          ...wanted,
          ...state.recentPaths.filter((entry) => !wanted.includes(entry)),
        ].slice(0, 12),
      };
    }),

  setHighlightNodeIds: (highlightNodeIds) => set({ highlightNodeIds }),
  setGraphSliceEdgeTypes: (graphSliceEdgeTypes) => set({ graphSliceEdgeTypes }),

  showReviewGraph: (item) => {
    const overlay = reviewItemToGraphOverlay(item);
    set({
      activeView: 'graph',
      reviewGraphOverlay: overlay,
      reviewEvidence: item,
      focusedFindingFingerprint: null,
      inspectorOpen: true,
    });
  },

  showReviewEvidence: (item) => {
    set({
      reviewGraphOverlay: null,
      reviewEvidence: item,
      focusedFindingFingerprint: null,
      inspectorOpen: true,
    });
  },

  focusFinding: (fingerprint, findingType) => {
    set({
      activeView: FINDING_TYPE_VIEWS[findingType],
      reviewGraphOverlay: null,
      reviewEvidence: null,
      focusedFindingFingerprint: { fingerprint, findingType },
    });
  },

  clearReviewContext: () =>
    set({
      reviewGraphOverlay: null,
      reviewEvidence: null,
      focusedFindingFingerprint: null,
    }),

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
