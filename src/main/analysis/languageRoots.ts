import { promises as fs } from 'node:fs';
import { join, posix } from 'node:path';
import type { ParsedImport } from './parser';
import { toPosixPath } from '../utils/glob';

export interface PythonPackageRoot {
  name: string;
  root: string;
}

export interface LanguageRoots {
  goModule: string | null;
  pythonPackages: PythonPackageRoot[];
  rustCrate: string | null;
}

function posixRelative(fromFile: string, target: string): string {
  const fromDir = posix.dirname(toPosixPath(fromFile));
  let rewritten = posix.relative(fromDir === '.' ? '' : fromDir, target);
  if (rewritten.length === 0) rewritten = '.';
  if (!rewritten.startsWith('.')) rewritten = `./${rewritten}`;
  return rewritten;
}

function namesFromManifest(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/^name\s*=\s*["']([^"']+)["']/gm)) {
    const raw = match[1];
    if (!raw) continue;
    names.push(raw.replaceAll('-', '_'));
  }
  return names;
}

async function pythonPackageRoots(rootPath: string): Promise<PythonPackageRoot[]> {
  const names = new Set<string>();
  for (const file of ['pyproject.toml', 'setup.cfg']) {
    try {
      const text = await fs.readFile(join(rootPath, file), 'utf8');
      for (const name of namesFromManifest(text)) names.add(name);
    } catch {
      // Manifest is optional.
    }
  }

  const found: PythonPackageRoot[] = [];
  for (const name of names) {
    for (const candidate of [`src/${name}`, name]) {
      try {
        await fs.access(join(rootPath, candidate, '__init__.py'));
        found.push({ name, root: candidate.replaceAll('\\', '/') });
        break;
      } catch {
        // Not a local package at this layout.
      }
    }
  }
  return found;
}

export async function readLanguageRoots(rootPath: string): Promise<LanguageRoots> {
  let goModule: string | null = null;
  try {
    const contents = await fs.readFile(join(rootPath, 'go.mod'), 'utf8');
    goModule = /^module\s+(\S+)/m.exec(contents)?.[1] ?? null;
  } catch {
    goModule = null;
  }

  let rustCrate: string | null = null;
  try {
    const contents = await fs.readFile(join(rootPath, 'Cargo.toml'), 'utf8');
    rustCrate = /^name\s*=\s*"([^"]+)"/m.exec(contents)?.[1] ?? null;
  } catch {
    rustCrate = null;
  }

  return {
    goModule,
    pythonPackages: await pythonPackageRoots(rootPath),
    rustCrate,
  };
}

/**
 * Rewrites in-module Go import paths to file-relative specifiers so the existing resolver
 * can follow them. Third-party module paths are left unchanged.
 */
export function rewriteGoImports(
  relativePath: string,
  imports: ParsedImport[],
  goModule: string | null,
): void {
  if (!goModule || !relativePath.replaceAll('\\', '/').endsWith('.go')) return;
  const prefix = goModule.endsWith('/') ? goModule : `${goModule}/`;

  for (const record of imports) {
    let target: string | null = null;
    if (record.specifier === goModule) target = '.';
    else if (record.specifier.startsWith(prefix)) target = record.specifier.slice(prefix.length);
    if (target === null) continue;
    record.specifier = posixRelative(relativePath, target);
  }
}

/**
 * Rewrites absolute imports of this repo's own Python packages into relative paths the
 * resolver can probe. Third-party packages stay as module names.
 */
export function rewritePythonImports(
  relativePath: string,
  imports: ParsedImport[],
  packages: readonly PythonPackageRoot[],
): void {
  if (packages.length === 0 || !relativePath.replaceAll('\\', '/').endsWith('.py')) return;

  for (const record of imports) {
    if (record.specifier.startsWith('.')) continue;
    const dotted = record.specifier.replaceAll('/', '.');
    for (const pkg of packages) {
      if (dotted !== pkg.name && !dotted.startsWith(`${pkg.name}.`)) continue;
      const rest = dotted === pkg.name ? '' : dotted.slice(pkg.name.length + 1).replaceAll('.', '/');
      const target = rest.length > 0 ? posix.join(pkg.root, rest) : pkg.root;
      record.specifier = posixRelative(relativePath, target);
      break;
    }
  }
}

function rustCrateDir(relativePath: string): string {
  const path = toPosixPath(relativePath);
  const marker = '/src/';
  const index = path.lastIndexOf(marker);
  if (index >= 0) return path.slice(0, index + 4).replace(/\/$/, '');
  if (path.startsWith('src/')) return 'src';
  const directory = posix.dirname(path);
  return directory === '.' ? '' : directory;
}

/**
 * Rewrites `use mycrate::…` onto the local crate root when Cargo.toml names this package.
 * `crate::` / `super::` / `self::` are already rewritten by the Rust extractor.
 */
export function rewriteRustCrateImports(
  relativePath: string,
  imports: ParsedImport[],
  rustCrate: string | null,
): void {
  if (!rustCrate || !relativePath.replaceAll('\\', '/').endsWith('.rs')) return;
  const crateDir = rustCrateDir(relativePath);

  for (const record of imports) {
    const spec = record.specifier.replaceAll('/', '::');
    if (spec !== rustCrate && !spec.startsWith(`${rustCrate}::`)) continue;
    const rest = spec === rustCrate ? '' : spec.slice(rustCrate.length + 2).split('::')[0] ?? '';
    const target =
      rest.length > 0 && crateDir.length > 0
        ? posix.join(crateDir, rest)
        : rest.length > 0
          ? rest
          : crateDir;
    if (target.length === 0) continue;
    record.specifier = posixRelative(relativePath, target);
  }
}

export function rewriteLanguageImports(
  relativePath: string,
  imports: ParsedImport[],
  roots: LanguageRoots,
): void {
  rewriteGoImports(relativePath, imports, roots.goModule);
  rewritePythonImports(relativePath, imports, roots.pythonPackages);
  rewriteRustCrateImports(relativePath, imports, roots.rustCrate);
}
