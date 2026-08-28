import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isNodeBuiltin,
  packageNameOf,
  readProjectManifests,
} from '@main/analysis/packageManifest';
import { buildKnownFileIndex, resolveImport, type ResolverContext } from '@main/analysis/resolver';
import { NO_TSCONFIG, loadProjectTsConfig } from '@main/analysis/tsconfig';
import { toPosixPath } from '@main/utils/glob';

const FIXTURE_ROOT = resolve(__dirname, '../../fixtures/sample-project');

function abs(relativePath: string): string {
  return toPosixPath(resolve(FIXTURE_ROOT, relativePath));
}

describe('packageNameOf', () => {
  it('extracts the package from a plain specifier', () => {
    expect(packageNameOf('react')).toBe('react');
    expect(packageNameOf('react-dom/client')).toBe('react-dom');
  });

  it('keeps both segments of a scoped package', () => {
    expect(packageNameOf('@tanstack/react-query')).toBe('@tanstack/react-query');
    expect(packageNameOf('@scope/pkg/sub/path')).toBe('@scope/pkg');
  });
});

describe('isNodeBuiltin', () => {
  it('recognises prefixed and bare builtins', () => {
    expect(isNodeBuiltin('node:path')).toBe(true);
    expect(isNodeBuiltin('node:fs/promises')).toBe(true);
    expect(isNodeBuiltin('fs')).toBe(true);
    expect(isNodeBuiltin('crypto')).toBe(true);
  });

  it('does not treat ordinary packages as builtins', () => {
    expect(isNodeBuiltin('react')).toBe(false);
    expect(isNodeBuiltin('@tanstack/react-query')).toBe(false);
  });
});

describe('readProjectManifests', () => {
  it('reads the root manifest', async () => {
    const manifests = await readProjectManifests(FIXTURE_ROOT);

    expect(manifests.root).not.toBeNull();
    expect(manifests.workspaceNames.has('sample-project')).toBe(true);
  });
});

/**
 * These pin the behaviour that a real project exposed: dozens of ordinary npm packages were
 * being reported as unresolved imports, and a scoped package was being called a broken alias.
 */
describe('dependency classification', () => {
  function context(dependencies: string[], withAliases = true): ResolverContext {
    return {
      rootPath: FIXTURE_ROOT,
      tsConfig: withAliases ? loadProjectTsConfig(FIXTURE_ROOT) : NO_TSCONFIG,
      knownFiles: buildKnownFileIndex([abs('src/app.ts')]),
      manifests: {
        root: null,
        dependencies: new Set(dependencies),
        workspaceNames: new Set(['@acme/api']),
      },
    };
  }

  it('classifies a declared dependency as an external package', () => {
    const result = resolveImport('react', abs('src/app.ts'), context(['react']));

    expect(result).toMatchObject({ status: 'unresolved', reason: 'external-package' });
  });

  it('classifies a scoped declared dependency as an external package, not a broken alias', () => {
    const result = resolveImport(
      '@tanstack/react-query',
      abs('src/app.ts'),
      context(['@tanstack/react-query'], false),
    );

    expect(result).toMatchObject({ status: 'unresolved', reason: 'external-package' });
  });

  it('classifies a subpath import of a declared dependency as external', () => {
    const result = resolveImport('react-dom/client', abs('src/app.ts'), context(['react-dom']));

    expect(result).toMatchObject({ reason: 'external-package' });
  });

  it('classifies a Node builtin as external even with no manifest', () => {
    expect(resolveImport('node:path', abs('src/app.ts'), context([]))).toMatchObject({
      reason: 'external-package',
    });
    expect(resolveImport('fs', abs('src/app.ts'), context([]))).toMatchObject({
      reason: 'external-package',
    });
  });

  it('treats a workspace package as external rather than unresolvable', () => {
    const result = resolveImport('@acme/api', abs('src/app.ts'), context([]));

    expect(result).toMatchObject({ reason: 'external-package' });
  });

  it('still reports a genuine alias-shaped specifier when no aliases are configured', () => {
    const result = resolveImport('~/components/Button', abs('src/app.ts'), context([], false));

    expect(result).toMatchObject({ reason: 'alias-not-configured' });
  });

  it('resolves a CSS file that is a graph source', () => {
    const result = resolveImport('./styles/tokens.css', abs('src/app.ts'), {
      rootPath: FIXTURE_ROOT,
      tsConfig: NO_TSCONFIG,
      knownFiles: buildKnownFileIndex([abs('src/app.ts'), abs('src/styles/tokens.css')]),
    });

    expect(result).toMatchObject({
      status: 'resolved',
      absolutePath: abs('src/styles/tokens.css'),
    });
  });

  it('reports a missing CSS file as missing, not as a non-source asset', () => {
    const result = resolveImport('./styles/tokens.css', abs('src/app.ts'), context([]));

    expect(result).toMatchObject({ reason: 'file-not-found' });
  });

  it('still treats a preprocessor stylesheet as a non-source asset', () => {
    const result = resolveImport('./styles/tokens.scss', abs('src/app.ts'), context([]));

    expect(result).toMatchObject({ reason: 'non-source-asset' });
  });

  it('treats image and JSON imports the same way', () => {
    for (const specifier of ['./logo.svg', './data.json', '../assets/hero.png', './doc.md']) {
      expect(resolveImport(specifier, abs('src/app.ts'), context([])), specifier).toMatchObject({
        reason: 'non-source-asset',
      });
    }
  });

  it('ignores a bundler query suffix on an asset import', () => {
    expect(resolveImport('./icon.svg?react', abs('src/app.ts'), context([]))).toMatchObject({
      reason: 'non-source-asset',
    });
  });

  it('still reports a genuinely missing source file', () => {
    const result = resolveImport('./db/schema.js', abs('src/app.ts'), context([]));

    expect(result).toMatchObject({ reason: 'file-not-found' });
  });

  it('does not blame the alias config for an undeclared scoped package', () => {
    // Not declared anywhere and not alias-shaped: reported as external, not as a config error.
    const result = resolveImport('@vendor/widget', abs('src/app.ts'), context([], false));

    expect(result).toMatchObject({ reason: 'external-package' });
  });
});
