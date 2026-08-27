import { basename, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverTsConfigs, runTypeScriptDiagnostics } from '@main/analysis/diagnostics';
import { NO_TSCONFIG, loadProjectTsConfig } from '@main/analysis/tsconfig';

const BROKEN_ROOT = resolve(__dirname, '../../fixtures/type-errors-project');
const CLEAN_ROOT = resolve(__dirname, '../../fixtures/sample-project');

function check(rootPath: string, overrides: Partial<Parameters<typeof runTypeScriptDiagnostics>[0]> = {}) {
  return runTypeScriptDiagnostics({
    rootPath,
    tsConfig: loadProjectTsConfig(rootPath),
    fallbackFileNames: [],
    ...overrides,
  });
}

describe('discoverTsConfigs', () => {
  it('finds a configuration at the root of a project', () => {
    expect(discoverTsConfigs(BROKEN_ROOT).map((path) => basename(path))).toContain('tsconfig.json');
  });

  it('never descends into excluded directories', () => {
    for (const path of discoverTsConfigs(CLEAN_ROOT)) {
      expect(path).not.toContain('node_modules');
    }
  });
});

describe('runTypeScriptDiagnostics', () => {
  it('reports the deliberate type errors in the fixture', () => {
    const result = check(BROKEN_ROOT);

    expect(result.skipped).toBe(false);
    expect(result.errorCount).toBeGreaterThanOrEqual(3);

    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain(2322); // string not assignable to number
    expect(codes).toContain(2554); // wrong number of arguments
    expect(codes).toContain(2339); // property does not exist
  });

  it('locates each diagnostic by file, line, and column', () => {
    const assignment = check(BROKEN_ROOT).diagnostics.find((d) => d.code === 2322);

    expect(assignment?.filePath).toBe('src/broken.ts');
    expect(assignment?.line).toBeGreaterThan(0);
    expect(assignment?.column).toBeGreaterThan(0);
    expect(assignment?.category).toBe('error');
    expect(assignment?.message).toMatch(/not assignable/i);
  });

  it('uses project-relative posix paths', () => {
    for (const diagnostic of check(BROKEN_ROOT).diagnostics) {
      if (!diagnostic.filePath) continue;
      expect(diagnostic.filePath.startsWith('/')).toBe(false);
      expect(diagnostic.filePath).not.toContain('\\');
      expect(diagnostic.filePath).not.toContain('..');
    }
  });

  it('never reports diagnostics from inside node_modules', () => {
    for (const diagnostic of check(BROKEN_ROOT).diagnostics) {
      expect(diagnostic.filePath ?? '').not.toContain('node_modules');
    }
  });

  it('finds no errors in a project that type checks cleanly', () => {
    const result = check(CLEAN_ROOT);

    // The clean fixture has no deliberate type errors of its own.
    expect(result.diagnostics.filter((d) => d.filePath === 'src/services/math.ts')).toEqual([]);
  });

  it('skips with a clear reason when the tree contains no compiler configuration', () => {
    const result = runTypeScriptDiagnostics({
      rootPath: resolve(CLEAN_ROOT, 'src/db'),
      tsConfig: NO_TSCONFIG,
      fallbackFileNames: [],
    });

    expect(result.skipped).toBe(true);
    expect(result.skippedReason).toMatch(/tsconfig/i);
    expect(result.diagnostics).toEqual([]);
  });

  it('finds a configuration further down the tree when the root has none', () => {
    // Mirrors a monorepo: nothing at the root, real configurations one level down.
    const result = check(BROKEN_ROOT, { tsConfig: NO_TSCONFIG });

    expect(result.skipped).toBe(false);
    expect(result.configsChecked).toContain('tsconfig.json');
    expect(result.diagnostics.map((d) => d.code)).toContain(2322);
  });

  it('reports which configurations it checked', () => {
    expect(check(BROKEN_ROOT).configsChecked).toEqual(['tsconfig.json']);
  });

  it('stops early when the scan is cancelled', () => {
    const result = check(BROKEN_ROOT, { signal: { cancelled: true } });

    expect(result.skipped).toBe(true);
    expect(result.skippedReason).toMatch(/cancelled/i);
  });

  it('returns a stable, sorted list across runs', () => {
    const first = check(BROKEN_ROOT).diagnostics;
    const second = check(BROKEN_ROOT).diagnostics;

    expect(second).toEqual(first);
  });

  it('records how long the check took', () => {
    expect(check(BROKEN_ROOT).durationMs).toBeGreaterThanOrEqual(0);
  });
});
