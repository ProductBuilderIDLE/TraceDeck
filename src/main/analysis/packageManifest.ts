import { promises as fs } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { ALWAYS_EXCLUDED_DIRS } from '@shared/constants';

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

const excludedDirNames = new Set(ALWAYS_EXCLUDED_DIRS);
const nodeBuiltins = new Set(builtinModules);

export interface ProjectManifests {
  /** The root package.json, used for entry-point inference. */
  root: unknown;
  /** Every declared dependency name across the project, including workspace packages. */
  dependencies: Set<string>;
  /** Names declared by workspace package.json files, which are internal, not third-party. */
  workspaceNames: Set<string>;
}

/**
 * Extracts the package name from a module specifier.
 *
 *   "react"                    -> "react"
 *   "react-dom/client"         -> "react-dom"
 *   "@tanstack/react-query"    -> "@tanstack/react-query"
 *   "@scope/pkg/sub/path"      -> "@scope/pkg"
 */
export function packageNameOf(specifier: string): string {
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : specifier;
  }
  return segments[0] ?? specifier;
}

export function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  return nodeBuiltins.has(packageNameOf(specifier));
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function collectDependencyNames(manifest: unknown, into: Set<string>): void {
  if (typeof manifest !== 'object' || manifest === null) return;
  const record = manifest as Record<string, unknown>;

  for (const field of DEPENDENCY_FIELDS) {
    const section = record[field];
    if (typeof section !== 'object' || section === null) continue;
    for (const name of Object.keys(section as Record<string, unknown>)) into.add(name);
  }
}

/**
 * Reads every package.json in the project so an import can be checked against what the project
 * actually declares.
 *
 * Without this, telling a third-party package apart from a misconfigured path alias is
 * guesswork — `@tanstack/react-query` and `@app/db` look identical to a pattern match. Reading
 * the manifests replaces that guess with a fact. Monorepos are handled by walking to a shallow
 * depth so workspace packages are picked up too.
 */
export async function readProjectManifests(
  rootPath: string,
  maxDepth = 4,
): Promise<ProjectManifests> {
  const dependencies = new Set<string>();
  const workspaceNames = new Set<string>();
  const root = await readJson(join(rootPath, 'package.json'));

  collectDependencyNames(root, dependencies);
  if (typeof root === 'object' && root !== null) {
    const name = (root as Record<string, unknown>)['name'];
    if (typeof name === 'string') workspaceNames.add(name);
  }

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (excludedDirNames.has(entry.name)) continue;

      const child = join(directory, entry.name);
      const manifest = await readJson(join(child, 'package.json'));

      if (manifest !== null) {
        collectDependencyNames(manifest, dependencies);
        const name = (manifest as Record<string, unknown>)['name'];
        if (typeof name === 'string') workspaceNames.add(name);
      }

      await walk(child, depth + 1);
    }
  }

  await walk(rootPath, 1);

  return { root, dependencies, workspaceNames };
}

export const EMPTY_MANIFESTS: ProjectManifests = {
  root: null,
  dependencies: new Set(),
  workspaceNames: new Set(),
};
