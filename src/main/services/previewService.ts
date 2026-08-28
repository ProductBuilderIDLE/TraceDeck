import { diagnoseJson, findMergeConflicts, isJsonPath } from '../analysis/textDiagnostics';
import { parseSourceFile } from '../analysis/parser';
import { parseContainerMarkup, parseWithTreeSitter } from '../analysis/treeSitter';
import { buildKnownFileIndex, resolveImport, type ResolverContext } from '../analysis/resolver';
import { readLanguageRoots, rewriteLanguageImports } from '../analysis/languageRoots';
import { loadProjectTsConfig, discoverProjectTsConfigs } from '../analysis/tsconfig';
import { readProjectManifests } from '../analysis/packageManifest';
import { toPosixPath } from '../utils/glob';
import type { DataStore } from '../db';
import type { PreviewFinding, Project } from '@shared/types';

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
  rewriteLanguageImports(relativePath, parsed.imports, await readLanguageRoots(project.rootPath));

  for (const issue of parsed.syntaxIssues) {
    findings.push({
      findingType: 'syntax-error',
      severity: 'high',
      title: 'Syntax error in the unsaved buffer',
      line: issue.line,
      message: issue.message,
    });
  }

  const files = store.files.listByProject(project.id);
  const tsConfig = loadProjectTsConfig(project.rootPath);
  const context: ResolverContext = {
    rootPath: project.rootPath,
    tsConfig,
    tsConfigs: discoverProjectTsConfigs(project.rootPath).configs,
    knownFiles: buildKnownFileIndex(files.map((file) => toPosixPath(file.absolutePath))),
    manifests: await readProjectManifests(project.rootPath),
  };

  const absolute = files.find((file) => file.relativePath === relativePath)?.absolutePath
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
