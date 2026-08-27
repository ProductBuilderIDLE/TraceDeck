import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { ALWAYS_EXCLUDED_DIRS, MAX_TYPE_DIAGNOSTICS } from '@shared/constants';
import { toPosixPath } from '../utils/glob';
import type { ProjectTsConfig } from './tsconfig';

export type DiagnosticCategory = 'error' | 'warning' | 'suggestion' | 'message';

export interface TypeDiagnostic {
  /** Project-relative posix path, or null for a project-wide diagnostic. */
  filePath: string | null;
  line: number | null;
  column: number | null;
  /** The TypeScript error number, e.g. 2322. */
  code: number;
  category: DiagnosticCategory;
  message: string;
}

export interface DiagnosticsResult {
  diagnostics: TypeDiagnostic[];
  errorCount: number;
  warningCount: number;
  durationMs: number;
  /** True when the check could not run at all; `skippedReason` explains why. */
  skipped: boolean;
  skippedReason: string | null;
  /** Project-relative paths of the compiler configurations that were checked. */
  configsChecked: string[];
  /** Honest notes about what the check could and could not cover. */
  limitations: string[];
  truncated: boolean;
}

const CATEGORY_MAP: Record<ts.DiagnosticCategory, DiagnosticCategory> = {
  [ts.DiagnosticCategory.Error]: 'error',
  [ts.DiagnosticCategory.Warning]: 'warning',
  [ts.DiagnosticCategory.Suggestion]: 'suggestion',
  [ts.DiagnosticCategory.Message]: 'message',
};

const CONFIG_FILENAMES = ['tsconfig.json', 'jsconfig.json'];
const excludedDirNames = new Set(ALWAYS_EXCLUDED_DIRS);

/** How many compiler configurations one scan will check before stopping. */
const MAX_CONFIGS = 12;

export interface DiagnosticsOptions {
  rootPath: string;
  tsConfig: ProjectTsConfig;
  /** Absolute paths discovered by the scan, used when no configuration lists files. */
  fallbackFileNames: readonly string[];
  signal?: { cancelled: boolean };
}

function isInsideProject(fileName: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, fileName);
  if (relativePath.startsWith('..') || relativePath.length === 0) return false;
  return !toPosixPath(relativePath).includes('node_modules/');
}

/**
 * Finds every compiler configuration in the project.
 *
 * A monorepo commonly has no `tsconfig.json` at its root at all — the root holds a
 * `tsconfig.base.json` that packages extend, and the real configurations live one or two
 * levels down in each app. Looking only at the root silently skips type checking for exactly
 * the projects that need it most.
 */
export function discoverTsConfigs(rootPath: string, maxDepth = 3): string[] {
  const found: string[] = [];

  const walk = (directory: string, depth: number): void => {
    if (depth > maxDepth || found.length >= MAX_CONFIGS) return;

    for (const name of CONFIG_FILENAMES) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) {
        found.push(candidate);
        // One configuration per directory is enough; tsconfig wins over jsconfig.
        break;
      }
    }

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (excludedDirNames.has(entry.name)) continue;
      walk(join(directory, entry.name), depth + 1);
    }
  };

  walk(rootPath, 0);
  return found;
}

interface ResolvedConfig {
  configPath: string;
  fileNames: string[];
  options: ts.CompilerOptions;
}

function parseConfig(configPath: string): ResolvedConfig | null {
  const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
  if (readResult.error) return null;

  // The base path must be the directory holding the configuration, not the project root.
  // Relative options such as `rootDir` and `outDir` are resolved against it, so passing the
  // repository root makes every path in a nested package resolve outside its own rootDir.
  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );

  if (parsed.fileNames.length === 0) return null;
  return { configPath, fileNames: parsed.fileNames, options: parsed.options };
}

/**
 * Runs the real TypeScript type checker over the project and returns its diagnostics.
 *
 * This is the one part of TraceDeck that reports genuine compile errors rather than graph
 * structure. It is opt-in because it is an order of magnitude more expensive than the import
 * scan: building a `ts.Program` resolves and parses every declaration file the project pulls
 * in, where the dependency scan only reads the project's own sources.
 *
 * Diagnostics from outside the project — errors inside `node_modules` type definitions — are
 * dropped. They are almost never actionable by the person running this, and including them
 * would bury the errors that are.
 */
export function runTypeScriptDiagnostics(options: DiagnosticsOptions): DiagnosticsResult {
  const { rootPath, tsConfig, fallbackFileNames, signal } = options;
  const startedAt = Date.now();
  const limitations: string[] = [];

  const finish = (extra: Partial<DiagnosticsResult>): DiagnosticsResult => ({
    diagnostics: [],
    errorCount: 0,
    warningCount: 0,
    durationMs: Date.now() - startedAt,
    skipped: false,
    skippedReason: null,
    configsChecked: [],
    limitations,
    truncated: false,
    ...extra,
  });

  if (signal?.cancelled) {
    return finish({ skipped: true, skippedReason: 'The scan was cancelled before type checking started.' });
  }

  // The root configuration wins when it actually lists files; otherwise every configuration
  // found in the project is checked, which is what a monorepo needs.
  const configs: ResolvedConfig[] = [];
  const rootConfig = tsConfig.configPath ? parseConfig(tsConfig.configPath) : null;

  if (rootConfig) {
    configs.push(rootConfig);
  } else {
    const discovered = discoverTsConfigs(rootPath);
    for (const configPath of discovered) {
      const parsed = parseConfig(configPath);
      if (parsed) configs.push(parsed);
    }

    if (configs.length > 1) {
      limitations.push(
        `No root compiler configuration listed files, so each of the ${configs.length} ` +
          'configurations found in the project was checked separately.',
      );
    }
    if (discovered.length >= MAX_CONFIGS) {
      limitations.push(
        `Only the first ${MAX_CONFIGS} compiler configurations were checked.`,
      );
    }
  }

  if (configs.length === 0) {
    if (fallbackFileNames.length === 0) {
      return finish({
        skipped: true,
        skippedReason:
          'No tsconfig.json or jsconfig.json was found. Type checking needs a compiler ' +
          'configuration to know which files and options to use.',
      });
    }

    limitations.push(
      'No compiler configuration listed any files, so the type check used the files found by ' +
        'the dependency scan with default compiler options. Results may differ from your build.',
    );
    configs.push({
      configPath: join(rootPath, '(default options)'),
      fileNames: [...fallbackFileNames],
      options: {},
    });
  }

  const collected: TypeDiagnostic[] = [];
  const seen = new Set<string>();
  const configsChecked: string[] = [];
  let errorCount = 0;
  let warningCount = 0;
  let droppedOutsideProject = 0;
  let totalReported = 0;

  for (const config of configs) {
    if (signal?.cancelled) {
      return finish({ skipped: true, skippedReason: 'The scan was cancelled during type checking.' });
    }

    let program: ts.Program;
    try {
      program = ts.createProgram({
        rootNames: config.fileNames,
        options: {
          ...config.options,
          // Nothing is ever written to disk; only the diagnostics are wanted.
          noEmit: true,
          emitDeclarationOnly: false,
          incremental: false,
          tsBuildInfoFile: undefined,
        },
      });
    } catch (error) {
      limitations.push(
        `${toPosixPath(relative(rootPath, config.configPath))} could not be type checked: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      continue;
    }

    configsChecked.push(toPosixPath(relative(rootPath, config.configPath)));

    for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
      const category = CATEGORY_MAP[diagnostic.category];
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');

      if (diagnostic.file && !isInsideProject(diagnostic.file.fileName, rootPath)) {
        droppedOutsideProject += 1;
        continue;
      }

      const filePath = diagnostic.file
        ? toPosixPath(relative(rootPath, diagnostic.file.fileName))
        : null;

      let line: number | null = null;
      let column: number | null = null;
      if (diagnostic.file && diagnostic.start !== undefined) {
        const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        line = position.line + 1;
        column = position.character + 1;
      }

      // Overlapping configurations can include the same file, so the same error can surface
      // more than once. Identity is the location plus the message.
      const key = `${filePath}|${line}|${column}|${diagnostic.code}|${message}`;
      if (seen.has(key)) continue;
      seen.add(key);

      totalReported += 1;
      if (category === 'error') errorCount += 1;
      if (category === 'warning') warningCount += 1;

      if (collected.length >= MAX_TYPE_DIAGNOSTICS) continue;
      collected.push({ filePath, line, column, code: diagnostic.code, category, message });
    }
  }

  if (droppedOutsideProject > 0) {
    limitations.push(
      `${droppedOutsideProject} type diagnostic(s) originated outside the project, most likely ` +
        'in dependency type definitions, and were not reported.',
    );
  }

  const truncated = totalReported > collected.length;
  if (truncated) {
    limitations.push(
      `Only the first ${MAX_TYPE_DIAGNOSTICS} type diagnostics were stored. Fix some and ` +
        'rescan to see the rest.',
    );
  }

  if (configsChecked.length === 0) {
    return finish({
      skipped: true,
      skippedReason: 'No compiler configuration could be loaded, so nothing was type checked.',
    });
  }

  // Sorted so a rescan of unchanged code produces an identical, stable list.
  collected.sort(
    (a, b) =>
      (a.filePath ?? '').localeCompare(b.filePath ?? '') ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0) ||
      a.code - b.code,
  );

  return finish({ diagnostics: collected, errorCount, warningCount, configsChecked, truncated });
}
