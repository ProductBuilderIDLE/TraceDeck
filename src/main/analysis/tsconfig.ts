import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { toPosixPath } from '../utils/glob';

export interface PathAlias {
  /** The alias as written, e.g. "@app/*". */
  pattern: string;
  /** Absolute directory or file targets the alias expands to. */
  targets: string[];
  hasWildcard: boolean;
}

export interface ProjectTsConfig {
  /** Absolute path to the config that was loaded, or null when none was found. */
  configPath: string | null;
  configKind: 'tsconfig' | 'jsconfig' | 'none';
  baseUrl: string | null;
  aliases: PathAlias[];
  /** Reported to the user when a config exists but could not be fully understood. */
  warnings: string[];
}

const CONFIG_FILENAMES: Array<{ name: string; kind: 'tsconfig' | 'jsconfig' }> = [
  { name: 'tsconfig.json', kind: 'tsconfig' },
  { name: 'jsconfig.json', kind: 'jsconfig' },
];

export const NO_TSCONFIG: ProjectTsConfig = {
  configPath: null,
  configKind: 'none',
  baseUrl: null,
  aliases: [],
  warnings: [],
};

/**
 * Loads the project's TypeScript or JavaScript configuration so that path aliases can be
 * resolved the same way the compiler would.
 *
 * `extends` chains are followed by the compiler's own parser, so a config that inherits its
 * paths from a shared base still yields the right aliases. When no config is present the
 * project is analysed with relative-import resolution only, and that limitation is reported
 * rather than guessed around.
 */
export function loadProjectTsConfig(rootPath: string): ProjectTsConfig {
  const warnings: string[] = [];

  for (const candidate of CONFIG_FILENAMES) {
    const configPath = join(rootPath, candidate.name);
    if (!ts.sys.fileExists(configPath)) continue;

    const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
    if (readResult.error) {
      warnings.push(
        `${candidate.name} could not be read: ` +
          ts.flattenDiagnosticMessageText(readResult.error.messageText, ' '),
      );
      continue;
    }

    const parsed = ts.parseJsonConfigFileContent(
      readResult.config,
      ts.sys,
      dirname(configPath),
      undefined,
      configPath,
    );

    for (const diagnostic of parsed.errors) {
      // Missing-input-files is expected for solution-style configs and is not actionable.
      if (diagnostic.code === 18003) continue;
      warnings.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
    }

    const options = parsed.options;
    const baseUrl = options.baseUrl ? resolve(options.baseUrl) : null;
    const aliases = extractAliases(options.paths, baseUrl ?? dirname(configPath));

    if (options.paths && !baseUrl) {
      // TypeScript 5 allows paths without baseUrl, resolving them against the config's folder.
      warnings.push(
        'Path aliases are declared without "baseUrl"; they are resolved relative to the ' +
          'configuration file.',
      );
    }

    return {
      configPath,
      configKind: candidate.kind,
      baseUrl,
      aliases,
      warnings,
    };
  }

  return {
    ...NO_TSCONFIG,
    warnings: [
      'No tsconfig.json or jsconfig.json was found. Only relative imports can be resolved.',
    ],
  };
}

function extractAliases(
  paths: ts.MapLike<string[]> | undefined,
  basePath: string,
): PathAlias[] {
  if (!paths) return [];

  return Object.entries(paths).map(([pattern, targets]) => ({
    pattern,
    hasWildcard: pattern.includes('*'),
    targets: targets.map((target) => resolve(basePath, target)),
  }));
}

/**
 * Expands a module specifier through the configured aliases.
 *
 * Longest-prefix-wins matches the compiler's behaviour when several patterns could apply.
 * Returns absolute path candidates without extensions; the caller probes the filesystem.
 */
export function expandAlias(specifier: string, config: ProjectTsConfig): string[] {
  if (config.aliases.length === 0) return [];

  const exact = config.aliases.find((alias) => !alias.hasWildcard && alias.pattern === specifier);
  if (exact) return exact.targets;

  let best: { alias: PathAlias; captured: string; prefixLength: number } | null = null;

  for (const alias of config.aliases) {
    if (!alias.hasWildcard) continue;

    const starIndex = alias.pattern.indexOf('*');
    const prefix = alias.pattern.slice(0, starIndex);
    const suffix = alias.pattern.slice(starIndex + 1);

    if (!specifier.startsWith(prefix)) continue;
    if (suffix.length > 0 && !specifier.endsWith(suffix)) continue;
    if (specifier.length < prefix.length + suffix.length) continue;

    const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
    if (best === null || prefix.length > best.prefixLength) {
      best = { alias, captured, prefixLength: prefix.length };
    }
  }

  if (!best) return [];

  return best.alias.targets.map((target) =>
    toPosixPath(target).replace('*', best.captured),
  );
}
