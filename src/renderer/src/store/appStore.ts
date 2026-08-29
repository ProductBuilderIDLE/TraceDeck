import { create } from 'zustand';
import type {
  ArchitectureRule,
  DashboardStats,
  Finding,
  FindingType,
  Project,
  Scan,
  ScanProgress,
} from '@shared/types';
import { invoke } from '../lib/ipc';
import { ruleFingerprint } from '../lib/ruleFingerprint';

interface AppState {
  projects: Project[];
  currentProject: Project | null;
  stats: DashboardStats | null;
  lastScan: Scan | null;
  findings: Finding[];
  rules: ArchitectureRule[];

  scanning: boolean;
  scanProgress: ScanProgress | null;
  loading: boolean;
  error: string | null;

  loadProjects: () => Promise<void>;
  openProjectDialog: () => Promise<Project | null>;
  selectProject: (projectId: number) => Promise<void>;
  removeProject: (projectId: number) => Promise<void>;
  updateConfiguration: (configuration: Project['configuration']) => Promise<void>;

  startScan: (fullRescan: boolean) => Promise<void>;
  cancelScan: () => Promise<void>;
  setScanProgress: (progress: ScanProgress | null) => void;

  refreshAnalysis: () => Promise<void>;
  loadFindings: (findingType?: FindingType) => Promise<void>;
  dismissFinding: (findingId: number, dismissed: boolean) => Promise<void>;

  loadRules: () => Promise<void>;
  saveRule: (rule: Parameters<typeof invoke<'rules:upsert'>>[1]) => Promise<void>;
  deleteRule: (ruleId: number) => Promise<void>;
  evaluateRules: () => Promise<number>;

  setError: (error: string | null) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  currentProject: null,
  stats: null,
  lastScan: null,
  findings: [],
  rules: [],

  scanning: false,
  scanProgress: null,
  loading: false,
  error: null,

  setError: (error) => set({ error }),
  setScanProgress: (scanProgress) => {
    set({ scanProgress });
    if (!scanProgress) return;
    if (scanProgress.phase === 'done') {
      set({ scanning: false });
      void get().refreshAnalysis();
    } else if (scanProgress.phase === 'failed') {
      set({ scanning: false });
    } else {
      set({ scanning: true });
    }
  },

  loadProjects: async () => {
    try {
      set({ loading: true });
      const projects = await invoke('project:list', undefined);
      set({ projects, loading: false });

      // Reopening the most recent project makes the app resume where the user left off.
      const current = get().currentProject;
      const first = projects[0];
      if (!current && first) {
        await get().selectProject(first.id);
      }
    } catch (error) {
      set({ error: messageOf(error), loading: false });
    }
  },

  openProjectDialog: async () => {
    try {
      const result = await invoke('project:open-dialog', undefined);
      if (result.cancelled || !result.project) return null;

      set({ currentProject: result.project });
      await get().loadProjects();
      await get().refreshAnalysis();
      return result.project;
    } catch (error) {
      set({ error: messageOf(error) });
      return null;
    }
  },

  selectProject: async (projectId) => {
    try {
      const project = await invoke('project:select', { projectId });
      set({ currentProject: project, stats: null, findings: [], rules: [] });
      await get().refreshAnalysis();
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  removeProject: async (projectId) => {
    try {
      await invoke('project:remove', { projectId });
      const wasCurrent = get().currentProject?.id === projectId;
      if (wasCurrent) set({ currentProject: null, stats: null, findings: [], rules: [] });
      await get().loadProjects();
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  updateConfiguration: async (configuration) => {
    const project = get().currentProject;
    if (!project) return;
    try {
      const updated = await invoke('project:update-config', {
        projectId: project.id,
        configuration,
      });
      set({ currentProject: updated });
      await get().loadProjects();
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  startScan: async (fullRescan) => {
    const project = get().currentProject;
    if (!project || get().scanning) return;

    set({ scanning: true, error: null, scanProgress: null });
    try {
      await invoke('scan:start', { projectId: project.id, fullRescan });
      await get().refreshAnalysis();
    } catch (error) {
      const message = messageOf(error);
      // A cancellation is a user action, not a failure worth surfacing as an error.
      set({ error: message.toLowerCase().includes('cancel') ? null : message });
    } finally {
      set({ scanning: false, scanProgress: null });
    }
  },

  cancelScan: async () => {
    const project = get().currentProject;
    if (!project) return;
    try {
      await invoke('scan:cancel', { projectId: project.id });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  refreshAnalysis: async () => {
    const project = get().currentProject;
    if (!project) return;

    try {
      set({ loading: true });
      const [stats, lastScan, findings, rules] = await Promise.all([
        invoke('dashboard:stats', { projectId: project.id }),
        invoke('scan:latest', { projectId: project.id }),
        invoke('findings:list', { projectId: project.id }),
        invoke('rules:list', { projectId: project.id }),
      ]);
      set({ stats, lastScan, findings, rules, loading: false });
    } catch (error) {
      set({ error: messageOf(error), loading: false });
    }
  },

  loadFindings: async (findingType) => {
    const project = get().currentProject;
    if (!project) return;
    try {
      const findings = await invoke('findings:list', {
        projectId: project.id,
        ...(findingType ? { findingType } : {}),
      });
      set({ findings });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  dismissFinding: async (findingId, dismissed) => {
    try {
      await invoke('findings:dismiss', { findingId, dismissed });
      await get().refreshAnalysis();
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  loadRules: async () => {
    const project = get().currentProject;
    if (!project) return;
    try {
      const rules = await invoke('rules:list', { projectId: project.id });
      const rulesWithFingerprint = await Promise.all(
        rules.map(async (rule) => ({ ...rule, fingerprint: await ruleFingerprint(rule) })),
      );
      set({ rules: rulesWithFingerprint });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  saveRule: async (rule) => {
    try {
      await invoke('rules:upsert', rule);
      await get().loadRules();
      await get().evaluateRules();
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  deleteRule: async (ruleId) => {
    try {
      await invoke('rules:delete', { ruleId });
      await get().loadRules();
      await get().evaluateRules();
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  evaluateRules: async () => {
    const project = get().currentProject;
    if (!project) return 0;
    try {
      const { violationCount } = await invoke('rules:evaluate', { projectId: project.id });
      await get().refreshAnalysis();
      return violationCount;
    } catch (error) {
      const message = messageOf(error);
      // Evaluating before a first scan is an expected state, not an error to shout about.
      if (!message.includes('Scan this project')) set({ error: message });
      return 0;
    }
  },
}));
