import { promises as fs } from 'node:fs';
import { BrowserWindow, dialog } from 'electron';
import type { ExportReportResult } from '@shared/ipc';
import type { FindingType, ReportFormat, ReportScope, ReportSection } from '@shared/types';
import type { DataStore } from '../db';
import type { AnalysisService } from '../services/analysisService';
import {
  collectReportData,
  renderReport,
  reportFileExtension,
} from '../services/reportService';
import {
  asObject,
  requireEnum,
  requireInt,
  requireNonEmptyString,
  requireString,
} from '../utils/validation';
import { HandledError, type HandlerMap } from './registry';

const FORMATS: readonly ReportFormat[] = ['markdown', 'json', 'html'];
const SECTIONS: readonly ReportSection[] = [
  'summary',
  'cycles',
  'unused-exports',
  'architecture-violations',
  'unresolved-imports',
  'type-errors',
  'top-impact-files',
  'blast-radius',
  'limitations',
];
const FINDING_TYPES: readonly FindingType[] = [
  'circular-dependency',
  'unused-export-candidate',
  'architecture-violation',
  'unresolved-import',
  'type-error',
];

function parseScope(raw: unknown): ReportScope {
  const value = asObject(raw, 'scope');
  const kind = requireEnum(value['kind'], 'scope.kind', [
    'project',
    'file',
    'symbol',
    'finding-type',
  ] as const);

  if (kind === 'project') return { kind };
  if (kind === 'file') {
    return { kind, filePath: requireNonEmptyString(value['filePath'], 'scope.filePath', 1024) };
  }
  if (kind === 'symbol') {
    return {
      kind,
      filePath: requireNonEmptyString(value['filePath'], 'scope.filePath', 1024),
      symbolName: requireNonEmptyString(value['symbolName'], 'scope.symbolName', 256),
    };
  }
  return {
    kind,
    findingType: requireEnum(value['findingType'], 'scope.findingType', FINDING_TYPES),
  };
}

/** Strips anything that could steer a written file outside the folder the user picked. */
function safeFileName(title: string): string {
  const cleaned = title
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'tracedeck-report';
}

export function reportHandlers(store: DataStore, analysis: AnalysisService): HandlerMap {
  return {
    'reports:list': async (payload) => {
      const value = asObject(payload);
      return store.reports.listByProject(requireInt(value['projectId'], 'projectId', 1));
    },

    'reports:export': async (payload): Promise<ExportReportResult> => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);

      const project = store.projects.findById(projectId);
      if (!project) throw new HandledError('That project no longer exists.', 'NOT_FOUND');

      const raw = asObject(value['configuration'], 'configuration');
      const format = requireEnum(raw['format'], 'configuration.format', FORMATS);
      const title = requireString(raw['title'], 'configuration.title', 200) || 'TraceDeck report';

      const sectionsRaw = raw['sections'];
      if (!Array.isArray(sectionsRaw)) {
        throw new HandledError('configuration.sections must be an array.', 'VALIDATION_ERROR');
      }
      const sections = sectionsRaw.map((section, position) =>
        requireEnum(section, `configuration.sections[${position}]`, SECTIONS),
      );

      const configuration = { title, format, sections, scope: parseScope(raw['scope']) };

      // The destination always comes from a native save dialog. The renderer cannot name a
      // path, so it cannot direct a write anywhere the user did not explicitly choose.
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const defaultName = `${safeFileName(title)}${reportFileExtension(format)}`;
      const result = window
        ? await dialog.showSaveDialog(window, {
            title: 'Save report',
            defaultPath: defaultName,
            buttonLabel: 'Save report',
          })
        : await dialog.showSaveDialog({ defaultPath: defaultName });

      if (result.canceled || !result.filePath) {
        return { filePath: '', cancelled: true };
      }

      const bundle = collectReportData(store, analysis, project, configuration);
      await fs.writeFile(result.filePath, renderReport(bundle, format), 'utf8');

      store.reports.create(projectId, title, configuration);

      return { filePath: result.filePath, cancelled: false };
    },

    'reports:delete': async (payload) => {
      const value = asObject(payload);
      return { deleted: store.reports.remove(requireInt(value['reportId'], 'reportId', 1)) };
    },
  };
}
