import { create } from 'zustand';
import type { ThemeId } from '@shared/theme';
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
  | 'reports'
  | 'settings';

interface UiState {
  activeView: ViewId;
  inspectorOpen: boolean;
  selectedNodeId: string | null;
  theme: ThemeId;
  /** Incremented on every theme change so canvas-based views know to restyle. */
  themeRevision: number;
  setActiveView: (view: ViewId) => void;
  toggleInspector: () => void;
  selectNode: (nodeId: string | null) => void;
  setTheme: (theme: ThemeId) => void;
}

const initialTheme = loadStoredTheme();

export const useUiStore = create<UiState>((set) => ({
  activeView: 'dashboard',
  inspectorOpen: true,
  selectedNodeId: null,
  theme: initialTheme,
  themeRevision: 0,

  setActiveView: (activeView) => set({ activeView }),
  toggleInspector: () => set((state) => ({ inspectorOpen: !state.inspectorOpen })),
  selectNode: (selectedNodeId) => set({ selectedNodeId, inspectorOpen: true }),

  setTheme: (theme) => {
    applyTheme(theme);
    storeTheme(theme);
    set((state) => ({ theme, themeRevision: state.themeRevision + 1 }));
  },
}));

// Applied before first render so the UI never paints with the wrong palette.
applyTheme(initialTheme);
