import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverFiles, folderSegments, isTestFile } from '@main/analysis/discovery';

const FIXTURE_ROOT = resolve(__dirname, '../../fixtures/sample-project');

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
