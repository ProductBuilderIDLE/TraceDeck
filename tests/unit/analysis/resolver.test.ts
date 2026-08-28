import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildKnownFileIndex, resolveImport, type ResolverContext } from '@main/analysis/resolver';
import { loadProjectTsConfig, NO_TSCONFIG, expandAlias } from '@main/analysis/tsconfig';
import { toPosixPath } from '@main/utils/glob';

const FIXTURE_ROOT = resolve(__dirname, '../../fixtures/sample-project');
const CONTAINER_ROOT = resolve(__dirname, '../../fixtures/source-containers-project');
const MONOREPO_ROOT = resolve(__dirname, '../../fixtures/monorepo-project');

function abs(relativePath: string): string {
  return toPosixPath(resolve(FIXTURE_ROOT, relativePath));
}

const FIXTURE_FILES = [
  'src/index.ts',
  'src/app.ts',
  'src/components/Button.tsx',
  'src/components/index.ts',
  'src/services/index.ts',
  'src/services/greeter.ts',
  'src/services/math.ts',
  'src/cycle/a.ts',
  'src/cycle/b.ts',
  'src/db/client.ts',
  'src/lazy/heavy.ts',
  'src/lazy/loader.ts',
  'src/utils/missing-import.ts',
].map(abs);

function context(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    rootPath: FIXTURE_ROOT,
    tsConfig: loadProjectTsConfig(FIXTURE_ROOT),
    knownFiles: buildKnownFileIndex(FIXTURE_FILES),
    ...overrides,
  };
}

describe('relative import resolution', () => {
  it('resolves a sibling file without an extension', () => {
    const result = resolveImport('./app', abs('src/index.ts'), context());

    expect(result).toEqual({ status: 'resolved', absolutePath: abs('src/app.ts'), viaAlias: false });
  });

  it('resolves a directory import to its index file', () => {
    const result = resolveImport('./services', abs('src/index.ts'), context());

    expect(result).toMatchObject({ status: 'resolved', absolutePath: abs('src/services/index.ts') });
  });

  it('resolves a parent-directory import', () => {
    const result = resolveImport('../services/math', abs('src/components/Button.tsx'), context());

    expect(result).toMatchObject({ status: 'resolved', absolutePath: abs('src/services/math.ts') });
  });

  it('resolves a .tsx file from an extensionless specifier', () => {
    const result = resolveImport('./Button', abs('src/components/index.ts'), context());

    expect(result).toMatchObject({ absolutePath: abs('src/components/Button.tsx') });
  });

  it('maps a .js specifier onto the .ts file that produces it', () => {
    const result = resolveImport('./app.js', abs('src/index.ts'), context());

    expect(result).toMatchObject({ status: 'resolved', absolutePath: abs('src/app.ts') });
  });

  it('reports a missing relative file rather than inventing one', () => {
    const result = resolveImport('./does-not-exist', abs('src/utils/missing-import.ts'), context());

    expect(result).toMatchObject({ status: 'unresolved', reason: 'file-not-found' });
  });

  it('resolves extensionless imports to Vue, Svelte, and Astro source containers', () => {
    const knownFiles = buildKnownFileIndex(
      ['src/shared.ts', 'src/Widget.vue', 'src/Panel.svelte', 'src/Page.astro'].map((path) =>
        toPosixPath(resolve(CONTAINER_ROOT, path)),
      ),
    );
    const containerContext: ResolverContext = {
      rootPath: CONTAINER_ROOT,
      tsConfig: NO_TSCONFIG,
      knownFiles,
    };
    const from = toPosixPath(resolve(CONTAINER_ROOT, 'src/shared.ts'));

    for (const [specifier, fileName] of [
      ['./Widget', 'Widget.vue'],
      ['./Panel', 'Panel.svelte'],
      ['./Page', 'Page.astro'],
    ] as const) {
      expect(resolveImport(specifier, from, containerContext), specifier).toMatchObject({
        status: 'resolved',
        absolutePath: toPosixPath(resolve(CONTAINER_ROOT, 'src', fileName)),
      });
    }
  });
});

describe('path alias resolution', () => {
  it('resolves an alias declared in tsconfig paths', () => {
    const result = resolveImport('@app/db/client', abs('src/components/Button.tsx'), context());

    expect(result).toEqual({
      status: 'resolved',
      absolutePath: abs('src/db/client.ts'),
      viaAlias: true,
    });
  });

  it('resolves an alias that lands on a directory index', () => {
    const result = resolveImport('@app/services', abs('src/index.ts'), context());

    expect(result).toMatchObject({ absolutePath: abs('src/services/index.ts'), viaAlias: true });
  });

  it('reports an alias-shaped specifier when no aliases are configured', () => {
    const result = resolveImport('@app/db/client', abs('src/app.ts'), context({ tsConfig: NO_TSCONFIG }));

    expect(result).toMatchObject({ status: 'unresolved', reason: 'alias-not-configured' });
  });

  it('reports a configured alias whose target does not exist', () => {
    const result = resolveImport('@app/not/here', abs('src/app.ts'), context());

    expect(result).toMatchObject({ status: 'unresolved', reason: 'file-not-found' });
  });

  it('prefers the longest matching alias prefix', () => {
    const tsConfig = {
      ...NO_TSCONFIG,
      aliases: [
        { pattern: '@app/*', targets: [`${toPosixPath(FIXTURE_ROOT)}/src/*`], hasWildcard: true },
        {
          pattern: '@app/db/*',
          targets: [`${toPosixPath(FIXTURE_ROOT)}/src/db/*`],
          hasWildcard: true,
        },
      ],
    };

    expect(expandAlias('@app/db/client', tsConfig)).toEqual([abs('src/db/client')]);
  });

  it('uses the nearest nested workspace config for the importing file', () => {
    const importer = toPosixPath(resolve(MONOREPO_ROOT, 'apps/web/src/index.ts'));
    const target = toPosixPath(resolve(MONOREPO_ROOT, 'apps/web/src/lib/value.ts'));
    const nestedConfig = loadProjectTsConfig(resolve(MONOREPO_ROOT, 'apps/web'));
    const workspaceContext = {
      rootPath: MONOREPO_ROOT,
      tsConfig: NO_TSCONFIG,
      tsConfigs: [nestedConfig],
      knownFiles: buildKnownFileIndex([importer, target]),
    } as ResolverContext & { tsConfigs: ReturnType<typeof loadProjectTsConfig>[] };

    expect(resolveImport('@web/lib/value', importer, workspaceContext)).toEqual({
      status: 'resolved',
      absolutePath: target,
      viaAlias: true,
    });
  });
});

describe('external and unresolvable specifiers', () => {
  it('classifies a bare package specifier as external', () => {
    const result = resolveImport('express', abs('src/utils/missing-import.ts'), context());

    expect(result).toMatchObject({ status: 'unresolved', reason: 'external-package' });
  });

  it('classifies a Node builtin as external', () => {
    const result = resolveImport('node:fs', abs('src/app.ts'), context());

    expect(result).toMatchObject({ status: 'unresolved', reason: 'external-package' });
  });

  it('rejects an empty specifier', () => {
    const result = resolveImport('   ', abs('src/app.ts'), context());

    expect(result.status).toBe('unresolved');
  });
});

describe('loadProjectTsConfig', () => {
  it('reads baseUrl and path aliases from the fixture tsconfig', () => {
    const config = loadProjectTsConfig(FIXTURE_ROOT);

    expect(config.configKind).toBe('tsconfig');
    expect(config.aliases).toHaveLength(1);
    expect(config.aliases[0]?.pattern).toBe('@app/*');
    expect(config.baseUrl).not.toBeNull();
  });

  it('reports the limitation when no configuration exists', () => {
    const config = loadProjectTsConfig(resolve(FIXTURE_ROOT, 'src/db'));

    expect(config.configKind).toBe('none');
    expect(config.warnings.join(' ')).toMatch(/Only relative imports can be resolved/);
  });
});

/**
 * A declaration file is a type sidecar, not the module. Resolving to it would drop every
 * runtime edge the implementation contributes.
 */
describe('declaration files never shadow an implementation', () => {
  it('resolves to the implementation when a .d.ts sits beside it', () => {
    const context: ResolverContext = {
      rootPath: FIXTURE_ROOT,
      tsConfig: NO_TSCONFIG,
      knownFiles: buildKnownFileIndex([abs('src/pair/foo.js'), abs('src/pair/foo.d.ts')]),
    };

    const result = resolveImport('./pair/foo', abs('src/app.ts'), context);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('expected resolved');
    expect(result.absolutePath.endsWith('foo.js')).toBe(true);
  });

  it('still resolves to the declaration when there is no implementation', () => {
    const context: ResolverContext = {
      rootPath: FIXTURE_ROOT,
      tsConfig: NO_TSCONFIG,
      knownFiles: buildKnownFileIndex([abs('src/types/only.d.ts')]),
    };

    const result = resolveImport('./types/only', abs('src/app.ts'), context);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('expected resolved');
    expect(result.absolutePath.endsWith('only.d.ts')).toBe(true);
  });
});
