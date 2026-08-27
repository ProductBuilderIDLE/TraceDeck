import { dirname, isAbsolute, resolve } from 'node:path';
import { NON_SOURCE_IMPORT_EXTENSIONS, RESOLUTION_EXTENSIONS } from '@shared/constants';
import { toPosixPath } from '../utils/glob';
import { expandAlias, type ProjectTsConfig } from './tsconfig';
import { EMPTY_MANIFESTS, isNodeBuiltin, packageNameOf, type ProjectManifests } from './packageManifest';

export type UnresolvedReason =
  | 'dynamic-expression'
  | 'alias-not-configured'
  | 'file-not-found'
  | 'external-package'
  | 'non-source-asset';

/** True when the specifier explicitly names a file type outside the JS/TS graph. */
function isNonSourceAsset(specifier: string): boolean {
  const withoutQuery = specifier.split('?')[0] ?? specifier;
  const lower = withoutQuery.toLowerCase();
  return NON_SOURCE_IMPORT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export type ResolutionResult =
  | { status: 'resolved'; absolutePath: string; viaAlias: boolean }
  | { status: 'unresolved'; reason: UnresolvedReason; detail: string };

export interface ResolverContext {
  rootPath: string;
  tsConfig: ProjectTsConfig;
  /** Absolute paths of every file in the scan, in posix form, for existence probing. */
  knownFiles: ReadonlySet<string>;
  /** What the project's package.json files declare, used to identify real dependencies. */
  manifests?: ProjectManifests;
}

/** Extensions a TypeScript ESM import may name while actually referring to a source file. */
const OUTPUT_TO_SOURCE_EXTENSIONS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
  '.jsx': ['.tsx', '.jsx'],
};

function normalise(absolutePath: string): string {
  return toPosixPath(absolutePath);
}

/**
 * Probes a base path for a real source file, mirroring how Node and TypeScript resolve:
 * the exact path, then each known extension, then an index file inside a directory.
 */
function probe(basePath: string, knownFiles: ReadonlySet<string>): string | null {
  const normalised = normalise(basePath);

  if (knownFiles.has(normalised)) return normalised;

  const lastDot = normalised.lastIndexOf('.');
  const lastSlash = normalised.lastIndexOf('/');
  const declaredExtension = lastDot > lastSlash ? normalised.slice(lastDot) : '';

  // `import './foo.js'` in a TypeScript ESM project refers to `foo.ts` on disk.
  const rewrites = OUTPUT_TO_SOURCE_EXTENSIONS[declaredExtension];
  if (rewrites) {
    const withoutExtension = normalised.slice(0, lastDot);
    for (const extension of rewrites) {
      const candidate = `${withoutExtension}${extension}`;
      if (knownFiles.has(candidate)) return candidate;
    }
  }

  for (const extension of RESOLUTION_EXTENSIONS) {
    const candidate = `${normalised}${extension}`;
    if (knownFiles.has(candidate)) return candidate;
  }

  for (const extension of RESOLUTION_EXTENSIONS) {
    const candidate = `${normalised}/index${extension}`;
    if (knownFiles.has(candidate)) return candidate;
  }

  return null;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..';
}

/**
 * Resolves a module specifier to a file inside the project.
 *
 * Anything that resolves outside the project — a package in node_modules, a Node builtin — is
 * reported as `external-package` rather than followed, because TraceDeck maps the user's own
 * code. Unresolvable specifiers are never guessed at; they surface in the UI as limitations.
 */
export function resolveImport(
  specifier: string,
  fromAbsolutePath: string,
  context: ResolverContext,
): ResolutionResult {
  const { tsConfig, knownFiles } = context;
  const manifests = context.manifests ?? EMPTY_MANIFESTS;
  const trimmed = specifier.trim();

  if (trimmed.length === 0) {
    return { status: 'unresolved', reason: 'file-not-found', detail: 'Empty module specifier.' };
  }

  // Checked before any probing: a stylesheet or image import is valid and expected, and
  // calling it a missing file would be wrong.
  if (isNonSourceAsset(trimmed)) {
    return {
      status: 'unresolved',
      reason: 'non-source-asset',
      detail: `"${trimmed}" is not a JavaScript or TypeScript source file, so it is not part of the dependency graph.`,
    };
  }

  if (isRelativeSpecifier(trimmed)) {
    const base = resolve(dirname(fromAbsolutePath), trimmed);
    const hit = probe(base, knownFiles);
    if (hit) return { status: 'resolved', absolutePath: hit, viaAlias: false };
    return {
      status: 'unresolved',
      reason: 'file-not-found',
      detail: `No file matching "${trimmed}" was found relative to this file.`,
    };
  }

  if (isAbsolute(trimmed)) {
    const hit = probe(trimmed, knownFiles);
    if (hit) return { status: 'resolved', absolutePath: hit, viaAlias: false };
    return {
      status: 'unresolved',
      reason: 'file-not-found',
      detail: 'Absolute import path does not point at a file in this project.',
    };
  }

  const aliasCandidates = expandAlias(trimmed, tsConfig);
  for (const candidate of aliasCandidates) {
    const hit = probe(candidate, knownFiles);
    if (hit) return { status: 'resolved', absolutePath: hit, viaAlias: true };
  }

  if (aliasCandidates.length > 0) {
    return {
      status: 'unresolved',
      reason: 'file-not-found',
      detail: `Alias "${trimmed}" is configured but no matching file exists.`,
    };
  }

  if (tsConfig.baseUrl) {
    const hit = probe(resolve(tsConfig.baseUrl, trimmed), knownFiles);
    if (hit) return { status: 'resolved', absolutePath: hit, viaAlias: true };
  }

  // A declared dependency or a Node builtin is a real package, never a broken alias. This
  // check comes first because `@tanstack/react-query` and `@app/db` are indistinguishable by
  // shape alone; only the manifest can tell them apart.
  const packageName = packageNameOf(trimmed);
  if (isNodeBuiltin(trimmed)) {
    return {
      status: 'unresolved',
      reason: 'external-package',
      detail: `"${trimmed}" is a Node.js builtin module.`,
    };
  }
  if (manifests.dependencies.has(packageName)) {
    return {
      status: 'unresolved',
      reason: 'external-package',
      detail: `"${packageName}" is a declared dependency of this project.`,
    };
  }
  if (manifests.workspaceNames.has(packageName)) {
    return {
      status: 'unresolved',
      reason: 'external-package',
      detail: `"${packageName}" is a workspace package; its source is analysed on its own.`,
    };
  }

  // Only now, having ruled out every declared package, is an alias-shaped specifier likely to
  // be a genuine misconfiguration.
  //
  // Shape is the only remaining signal, and it is a weak one. A scoped package is normally two
  // segments (`@tanstack/react-query`), whereas an alias usually reaches further into a tree
  // (`@app/db/client`). That distinction is a heuristic, so it is only ever reached after the
  // manifest has failed to identify the specifier.
  const segments = trimmed.split('/');
  const looksLikeInternalAlias =
    trimmed.startsWith('~') ||
    trimmed.startsWith('#') ||
    (trimmed.startsWith('@') && segments.length >= 3);

  if (looksLikeInternalAlias) {
    return {
      status: 'unresolved',
      reason: 'alias-not-configured',
      detail:
        tsConfig.aliases.length === 0
          ? `"${trimmed}" looks like a path alias, but no path mapping was found in ${
              tsConfig.configKind === 'none' ? 'any tsconfig.json' : 'the project configuration'
            }.`
          : `"${trimmed}" looks like a path alias, but it does not match any configured path mapping.`,
    };
  }

  return {
    status: 'unresolved',
    reason: 'external-package',
    detail: `"${trimmed}" is not declared as a dependency and did not resolve inside the project.`,
  };
}

/** Builds the existence index the resolver probes against. */
export function buildKnownFileIndex(absolutePaths: readonly string[]): Set<string> {
  return new Set(absolutePaths.map(normalise));
}
