import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverFiles, folderSegments, isTestFile } from '@main/analysis/discovery';

const FIXTURE_ROOT = resolve(__dirname, '../../fixtures/sample-project');

function fixture(name: string): string {
  return resolve(__dirname, `../../fixtures/${name}`);
}

async function discover(overrides: Partial<Parameters<typeof discoverFiles>[0]> = {}) {
  return discoverFiles({
    rootPath: FIXTURE_ROOT,
    respectGitignore: true,
    includeTestFiles: true,
    excludePatterns: [],
    ...overrides,
  });
}

describe('discoverFiles', () => {
  it('finds every source file in the fixture project', async () => {
    const { files } = await discover();
    const paths = files.map((file) => file.relativePath);

    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/app.ts');
    expect(paths).toContain('src/components/Button.tsx');
    expect(paths).toContain('src/cycle/a.ts');
    expect(paths).toContain('src/lazy/loader.ts');
  });

  it('returns files in a stable sorted order', async () => {
    const first = await discover();
    const second = await discover();

    expect(first.files.map((f) => f.relativePath)).toEqual(
      second.files.map((f) => f.relativePath),
    );
    expect(first.files.map((f) => f.relativePath)).toEqual(
      [...first.files.map((f) => f.relativePath)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('respects .gitignore', async () => {
    const { files } = await discover();

    expect(files.map((f) => f.relativePath)).not.toContain('generated/should-be-ignored.ts');
  });

  it('includes gitignored files when the option is off', async () => {
    const { files } = await discover({ respectGitignore: false });

    expect(files.map((f) => f.relativePath)).toContain('generated/should-be-ignored.ts');
  });

  it('applies user exclude patterns', async () => {
    const { files } = await discover({ excludePatterns: ['src/cycle/**'] });
    const paths = files.map((f) => f.relativePath);

    expect(paths).not.toContain('src/cycle/a.ts');
    expect(paths).toContain('src/index.ts');
  });

  it('records file metadata needed for incremental rescans', async () => {
    const { files } = await discover();
    const index = files.find((f) => f.relativePath === 'src/index.ts');

    expect(index).toBeDefined();
    expect(index?.extension).toBe('.ts');
    expect(index?.sizeBytes).toBeGreaterThan(0);
    expect(Date.parse(index?.modifiedAt ?? '')).not.toBeNaN();
  });

  it('never walks into an always-excluded directory', async () => {
    const { files } = await discover();

    expect(files.every((f) => !f.relativePath.includes('node_modules'))).toBe(true);
  });

  it('reports the concrete extensions omitted from an asset-heavy project', async () => {
    const result = await discover({ rootPath: fixture('asset-heavy-project') });
    const diagnostics = (
      result as typeof result & {
        diagnostics?: {
          exclusions: Array<{ relativePath: string; kind: string; detail: string }>;
        };
      }
    ).diagnostics;

    expect(result.files.map((file) => file.relativePath)).toEqual(['app.js']);
    expect(diagnostics).toBeDefined();
    expect(diagnostics?.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: 'index.html', detail: '.html' }),
        expect.objectContaining({ relativePath: 'style.css', detail: '.css' }),
      ]),
    );
  });

  it('inventories every policy-visible asset while keeping files graph-source-only', async () => {
    const result = await discover({ rootPath: fixture('asset-heavy-project') });

    expect(result.inventory.map((entry) => entry.relativePath)).toEqual([
      '.gitignore',
      'app.js',
      'index.html',
      'package.json',
      'README.md',
      'style.css',
    ]);
    expect(result.files.map((file) => file.relativePath)).toEqual(['app.js']);
    expect(result.inventory.find((entry) => entry.relativePath === 'index.html')).toEqual(
      expect.objectContaining({
        entryKind: 'regular',
        contentKind: 'text',
        encoding: 'utf-8',
        analysisStatus: 'text-only',
        isGitIgnored: false,
        isUserExcluded: false,
      }),
    );
  });

  it('retains a gitignored source in inventory with the final matching rule', async () => {
    const result = await discover({ rootPath: fixture('ignore-precedence-project') });
    const ignoredSource = result.inventory.find(
      (entry) => entry.relativePath === 'src/drop.ts',
    );

    expect(result.inventory.map((entry) => entry.relativePath)).toEqual([
      '.gitignore',
      'src/.gitignore',
      'src/drop.ts',
      'src/keep.ts',
    ]);
    expect(ignoredSource).toEqual(
      expect.objectContaining({
        isGitIgnored: true,
        gitignoreRule: '.gitignore: *.ts',
        analysisStatus: 'excluded',
      }),
    );
    expect(result.files.map((file) => file.relativePath)).toEqual(['src/keep.ts']);
  });

  it('lets a child .gitignore negation override a parent file rule', async () => {
    const result = await discover({ rootPath: fixture('ignore-precedence-project') });

    expect(result.files.map((file) => file.relativePath)).toEqual(['src/keep.ts']);
  });

  it('returns identical discovery diagnostics across runs', async () => {
    const first = await discover({ rootPath: fixture('asset-heavy-project') });
    const second = await discover({ rootPath: fixture('asset-heavy-project') });
    const firstDiagnostics = (first as typeof first & { diagnostics?: unknown }).diagnostics;
    const secondDiagnostics = (second as typeof second & { diagnostics?: unknown }).diagnostics;

    expect(firstDiagnostics).toBeDefined();
    expect(secondDiagnostics).toEqual(firstDiagnostics);
    expect(second.inventory).toEqual(first.inventory);
  });

  it('discovers Vue, Svelte, and Astro files that contain JavaScript or TypeScript', async () => {
    const result = await discover({ rootPath: fixture('source-containers-project') });

    expect(result.files.map((file) => file.relativePath)).toEqual([
      'src/Page.astro',
      'src/Panel.svelte',
      'src/shared.ts',
      'src/Widget.vue',
    ]);
  });
});

describe('isTestFile', () => {
  it('recognises common test file conventions', () => {
    expect(isTestFile('src/app.test.ts')).toBe(true);
    expect(isTestFile('src/app.spec.tsx')).toBe(true);
    expect(isTestFile('src/__tests__/app.ts')).toBe(true);
    expect(isTestFile('tests/unit/app.ts')).toBe(true);
    expect(isTestFile('src/app.ts')).toBe(false);
  });
});

describe('folderSegments', () => {
  it('lists each ancestor folder of a file', () => {
    expect(folderSegments('src/components/ui/Button.tsx')).toEqual([
      'src',
      'src/components',
      'src/components/ui',
    ]);
  });

  it('returns nothing for a file at the root', () => {
    expect(folderSegments('index.ts')).toEqual([]);
  });
});
