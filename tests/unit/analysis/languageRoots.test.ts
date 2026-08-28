import { describe, expect, it } from 'vitest';
import {
  rewriteGoImports,
  rewritePythonImports,
  rewriteRustCrateImports,
} from '@main/analysis/languageRoots';
import type { ParsedImport } from '@main/analysis/parser';

function record(specifier: string): ParsedImport {
  return {
    specifier,
    line: 1,
    kind: 'import',
    isTypeOnly: false,
    importedNames: [],
    isStarExport: false,
    isDynamicExpression: false,
  };
}

describe('language package-root rewrites', () => {
  it('rewrites in-module Go imports against go.mod', () => {
    const imports = [record('example.com/app/internal/util'), record('fmt')];
    rewriteGoImports('cmd/app/main.go', imports, 'example.com/app');
    expect(imports[0]?.specifier).toBe('../../internal/util');
    expect(imports[1]?.specifier).toBe('fmt');
  });

  it('rewrites this repo’s Python package onto a relative path', () => {
    const imports = [record('mypkg.util'), record('os.path')];
    rewritePythonImports('src/mypkg/cli.py', imports, [{ name: 'mypkg', root: 'src/mypkg' }]);
    expect(imports[0]?.specifier).toBe('./util');
    expect(imports[1]?.specifier).toBe('os.path');
  });

  it('rewrites this crate’s name onto the local src tree', () => {
    const imports = [record('mycrate'), record('serde')];
    rewriteRustCrateImports('src/foo.rs', imports, 'mycrate');
    expect(imports[0]?.specifier).toBe('.');
    expect(imports[1]?.specifier).toBe('serde');
  });
});
