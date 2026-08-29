import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LicenseEntry } from '@shared/types';
import { packageNameOf } from '../analysis/packageManifest';

export function readRootManifest(rootPath: string): unknown {
  try {
    return JSON.parse(readFileSync(join(rootPath, 'package.json'), 'utf8')) as unknown;
  } catch {
    return null;
  }
}

export function declaredDependencyNames(root: unknown): string[] {
  if (typeof root !== 'object' || root === null) return [];
  const record = root as Record<string, unknown>;
  const names: string[] = [];
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const section = record[field];
    if (typeof section !== 'object' || section === null) continue;
    names.push(...Object.keys(section as Record<string, unknown>));
  }
  return names;
}

export function publicApiFromManifest(root: unknown): string[] {
  if (typeof root !== 'object' || root === null) return [];
  const record = root as Record<string, unknown>;
  const exportsField = record['exports'];
  const main = typeof record['main'] === 'string' ? record['main'] : null;
  const types = typeof record['types'] === 'string' ? record['types'] : null;
  const keys: string[] = [];
  if (typeof exportsField === 'string') keys.push(exportsField);
  else if (typeof exportsField === 'object' && exportsField !== null) {
    keys.push(...Object.keys(exportsField as Record<string, unknown>));
  }
  if (main) keys.push(main);
  if (types) keys.push(types);
  return [...new Set(keys)].slice(0, 50);
}

export function licenseInventory(rootPath: string, specifiers: readonly string[]): LicenseEntry[] {
  const names = [...new Set(specifiers.map(packageNameOf))].sort().slice(0, 400);
  const entries: LicenseEntry[] = [];

  for (const packageName of names) {
    const manifestPath = join(rootPath, 'node_modules', ...packageName.split('/'), 'package.json');
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      entries.push({
        packageName,
        version: typeof raw['version'] === 'string' ? raw['version'] : null,
        license: typeof raw['license'] === 'string' ? raw['license'] : null,
      });
    } catch {
      entries.push({ packageName, version: null, license: null });
    }
  }

  return entries;
}
