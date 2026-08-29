import { diagnoseJson, findMergeConflicts, isJsonPath } from '../analysis/textDiagnostics';
import { parseSourceFile } from '../analysis/parser';
import { parseContainerMarkup, parseWithTreeSitter } from '../analysis/treeSitter';
import { buildKnownFileIndex, resolveImport, type ResolverContext } from '../analysis/resolver';
import { readLanguageRoots, rewriteLanguageImports } from '../analysis/languageRoots';
import { loadProjectTsConfig, discoverProjectTsConfigs } from '../analysis/tsconfig';
import { readProjectManifests } from '../analysis/packageManifest';
import { toPosixPath } from '../utils/glob';
import type { LanguageRoots } from '../analysis/languageRoots';
import type { DataStore } from '../db';
import type { PreviewFinding, Project } from '@shared/types';

interface PreviewContext {
  /** The completed scan this context was built from; a newer scan invalidates it. */
  scanId: number;
  resolver: ResolverContext;
  languageRoots: LanguageRoots;
  absoluteByRelative: Map<string, string>;
}

/**
 * Preview runs on every keystroke in the open buffer, but the inputs it resolves against —
 * the file list, tsconfig tree, package manifests, and language roots — only change when a
 * scan does. Rebuilding them per call meant walking the project for tsconfigs and reading
 * every package.json in the repository while the user typed, which on a monorepo dominates
 * the cost of a single character.
 *
 * The context is therefore cached per project and keyed by the latest completed scan id, so
 * a finished scan invalidates it without any cross-module wiring. The lookup that replaces
 * the rebuild is a single indexed row read.
 */
const contextsByProject = new Map<number, PreviewContext>();

async function previewContextFor(store: DataStore, project: Project): Promise<PreviewContext> {
  const scanId = store.scans.latestCompletedForProject(project.id)?.id ?? 0;
  const cached = contextsByProject.get(project.id);
  if (cached && cached.scanId === scanId) return cached;

  const files = store.files.listByProject(project.id);
  const context: PreviewContext = {
    scanId,
    resolver: {
      rootPath: project.rootPath,
      tsConfig: loadProjectTsConfig(project.rootPath),
      tsConfigs: discoverProjectTsConfigs(project.rootPath).configs,
      knownFiles: buildKnownFileIndex(files.map((file) => toPosixPath(file.absolutePath))),
      manifests: await readProjectManifests(project.rootPath),
    },
    languageRoots: await readLanguageRoots(project.rootPath),
    absoluteByRelative: new Map(files.map((file) => [file.relativePath, file.absolutePath])),
  };

  contextsByProject.set(project.id, context);
  return context;
}

/** Drops a project's cached context, for a project being closed or reconfigured. */
export function forgetPreviewContext(projectId: number): void {
  contextsByProject.delete(projectId);
}

export async function previewUnsavedBuffer(
  store: DataStore,
  project: Project,
  relativePath: string,
  text: string,
): Promise<PreviewFinding[]> {
  const findings: PreviewFinding[] = [];

  for (const conflict of findMergeConflicts(text)) {
    findings.push({
      findingType: 'merge-conflict',
      severity: 'high',
      title: 'Unresolved merge conflict in the unsaved buffer',
      line: conflict.startLine,
      message: conflict.complete
        ? `Conflict block starting at line ${conflict.startLine}`
        : `Unclosed conflict marker at line ${conflict.startLine}`,
    });
  }

  if (isJsonPath(relativePath)) {
    for (const diagnostic of diagnoseJson(relativePath, text)) {
      findings.push({
        findingType: 'syntax-error',
        severity: 'high',
        title: 'Invalid JSON in the unsaved buffer',
        line: diagnostic.line,
        message: diagnostic.message,
      });
    }
  }

  const parsed =
    (await parseWithTreeSitter(relativePath, text)) ??
    parseSourceFile(relativePath, text);
  if (/\.(vue|svelte|astro)$/i.test(relativePath)) {
    const extra = await parseContainerMarkup(relativePath, text);
    parsed.imports.push(...extra.imports);
    parsed.syntaxIssues.push(...extra.syntaxIssues);
  }
  const preview = await previewContextFor(store, project);
  rewriteLanguageImports(relativePath, parsed.imports, preview.languageRoots);

  for (const issue of parsed.syntaxIssues) {
    findings.push({
      findingType: 'syntax-error',
      severity: 'high',
      title: 'Syntax error in the unsaved buffer',
      line: issue.line,
      message: issue.message,
    });
  }

  const context = preview.resolver;
  const absolute = preview.absoluteByRelative.get(relativePath)
    ?? `${project.rootPath.replace(/[\\/]+$/, '')}/${relativePath}`;

  for (const record of parsed.imports) {
    if (record.isDynamicExpression) {
      findings.push({
        findingType: 'unresolved-import',
        severity: 'info',
        title: 'Dynamic import in the unsaved buffer',
        line: record.line,
        message: record.specifier,
      });
      continue;
    }
    const resolution = resolveImport(record.specifier, absolute, context);
    if (resolution.status === 'resolved') continue;
    if (resolution.reason === 'external-package' || resolution.reason === 'non-source-asset') continue;
    findings.push({
      findingType: 'unresolved-import',
      severity: 'info',
      title: `Could not resolve "${record.specifier}"`,
      line: record.line,
      message: resolution.detail,
    });
  }

  return findings;
}
