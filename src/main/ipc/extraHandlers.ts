import { Buffer } from 'node:buffer';
import { promises as fs } from 'node:fs';
import { BrowserWindow, dialog } from 'electron';
import {
  type ArchitectureRule,
} from '@shared/types';
import { ARCHITECTURE_PACKS } from '@shared/rulePacks';
import type { DataStore } from '../db';
import type { AnalysisService } from '../services/analysisService';
import { previewUnsavedBuffer } from '../services/previewService';
import { searchProjectText } from '../services/textSearchService';
import { formatSource } from '../services/formatService';
import {
  gitBlame,
  gitChangedFiles,
  gitChurn,
  gitCoChange,
  gitDiff,
  gitMergetool,
  gitRenames,
  isGitRepo,
} from '../services/gitService';
import {
  asObject,
  optionalInt,
  optionalString,
  requireInt,
  requireNonEmptyString,
  requireString,
  requireStringArray,
} from '../utils/validation';
import { resolveSafeProjectFile } from '../utils/paths';
import { HandledError, type HandlerMap } from './registry';

function requireProject(store: DataStore, projectId: number) {
  const project = store.projects.findById(projectId);
  if (!project) throw new HandledError('That project no longer exists.', 'NOT_FOUND');
  return project;
}

async function requireGit(rootPath: string): Promise<void> {
  if (!(await isGitRepo(rootPath))) {
    throw new HandledError('This folder is not a Git repository.', 'NOT_A_GIT_REPO');
  }
}

export function extraHandlers(store: DataStore, analysis: AnalysisService): HandlerMap {
  return {
    'search:text': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      requireProject(store, projectId);
      return searchProjectText(
        store,
        projectId,
        requireNonEmptyString(value['query'], 'query', 200),
        optionalInt(value['limit'], 'limit', 1) ?? 100,
      );
    },

    'analysis:preview': async (payload) => {
      const value = asObject(payload);
      const project = requireProject(store, requireInt(value['projectId'], 'projectId', 1));
      return previewUnsavedBuffer(
        store,
        project,
        requireNonEmptyString(value['relativePath'], 'relativePath', 4096),
        requireString(value['text'], 'text', 2_000_000),
      );
    },

    'analysis:diff-impact': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      requireProject(store, projectId);
      return analysis.diffImpact(
        projectId,
        requireStringArray(value['changedPaths'] ?? [], 'changedPaths', 2000),
      );
    },

    'analysis:folder-metrics': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      requireProject(store, projectId);
      return analysis.folderMetrics(projectId);
    },

    'git:changed-files': async (payload) => {
      const value = asObject(payload);
      const project = requireProject(store, requireInt(value['projectId'], 'projectId', 1));
      await requireGit(project.rootPath);
      return gitChangedFiles(project.rootPath, optionalString(value['ref'], 'ref', 200) ?? 'HEAD');
    },

    'git:diff': async (payload) => {
      const value = asObject(payload);
      const project = requireProject(store, requireInt(value['projectId'], 'projectId', 1));
      await requireGit(project.rootPath);
      const relativePath = requireNonEmptyString(value['relativePath'], 'relativePath', 4096);
      await resolveSafeProjectFile(project.rootPath, relativePath);
      return {
        diff: await gitDiff(
          project.rootPath,
          relativePath,
          optionalString(value['ref'], 'ref', 200) ?? 'HEAD',
        ),
      };
    },

    'git:blame': async (payload) => {
      const value = asObject(payload);
      const project = requireProject(store, requireInt(value['projectId'], 'projectId', 1));
      await requireGit(project.rootPath);
      const relativePath = requireNonEmptyString(value['relativePath'], 'relativePath', 4096);
      await resolveSafeProjectFile(project.rootPath, relativePath);
      return gitBlame(project.rootPath, relativePath);
    },

    'git:churn': async (payload) => {
      const value = asObject(payload);
      const project = requireProject(store, requireInt(value['projectId'], 'projectId', 1));
      await requireGit(project.rootPath);
      return gitChurn(project.rootPath);
    },

    'git:cochange': async (payload) => {
      const value = asObject(payload);
      const project = requireProject(store, requireInt(value['projectId'], 'projectId', 1));
      await requireGit(project.rootPath);
      const relativePath = requireNonEmptyString(value['relativePath'], 'relativePath', 4096);
      await resolveSafeProjectFile(project.rootPath, relativePath);
      return gitCoChange(project.rootPath, relativePath);
    },

    'git:renames': async (payload) => {
      const value = asObject(payload);
      const project = requireProject(store, requireInt(value['projectId'], 'projectId', 1));
      await requireGit(project.rootPath);
      const relativePath = requireNonEmptyString(value['relativePath'], 'relativePath', 4096);
      await resolveSafeProjectFile(project.rootPath, relativePath);
      return gitRenames(project.rootPath, relativePath);
    },

    'git:mergetool': async (payload) => {
      const value = asObject(payload);
      const project = requireProject(store, requireInt(value['projectId'], 'projectId', 1));
      await requireGit(project.rootPath);
      const relativePath = requireNonEmptyString(value['relativePath'], 'relativePath', 4096);
      await resolveSafeProjectFile(project.rootPath, relativePath);
      await gitMergetool(project.rootPath, relativePath);
      return { started: true };
    },

    'source:format': async (payload) => {
      const value = asObject(payload);
      const project = requireProject(store, requireInt(value['projectId'], 'projectId', 1));
      const relativePath = requireNonEmptyString(value['relativePath'], 'relativePath', 4096);
      await resolveSafeProjectFile(project.rootPath, relativePath, { mustExist: false });
      return formatSource(
        project.rootPath,
        relativePath,
        requireString(value['text'], 'text', 2_000_000),
      );
    },

    'rules:apply-pack': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      requireProject(store, projectId);
      const packId = requireNonEmptyString(value['packId'], 'packId', 64);
      const pack = ARCHITECTURE_PACKS.find((entry) => entry.id === packId);
      if (!pack) throw new HandledError('Unknown architecture pack.', 'NOT_FOUND');

      let created = 0;
      for (const rule of pack.rules) {
        const record: Omit<ArchitectureRule, 'id' | 'createdAt' | 'updatedAt'> = {
          projectId,
          name: rule.name,
          enabled: true,
          ruleType: 'forbid-import',
          sourcePattern: rule.sourcePattern,
          targetPattern: rule.targetPattern,
          configuration: { severity: rule.severity, exceptions: [] },
        };
        store.rules.upsert(record);
        created += 1;
      }
      return { created };
    },

    'system:save-export': async (payload) => {
      const value = asObject(payload);
      const defaultFileName = requireNonEmptyString(value['defaultFileName'], 'defaultFileName', 200);
      const contents = requireString(value['contents'], 'contents', 20_000_000);
      const encoding = requireNonEmptyString(value['encoding'], 'encoding', 16);
      if (encoding !== 'utf8' && encoding !== 'base64') {
        throw new HandledError('Encoding must be utf8 or base64.', 'INVALID_ENCODING');
      }

      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const result = window
        ? await dialog.showSaveDialog(window, { defaultPath: defaultFileName })
        : await dialog.showSaveDialog({ defaultPath: defaultFileName });
      if (result.canceled || !result.filePath) return { filePath: '', cancelled: true };

      const bytes = encoding === 'base64' ? Buffer.from(contents, 'base64') : Buffer.from(contents, 'utf8');
      await fs.writeFile(result.filePath, bytes);
      return { filePath: result.filePath, cancelled: false };
    },
  };
}
