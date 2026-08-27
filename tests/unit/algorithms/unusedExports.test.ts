import { describe, expect, it } from 'vitest';
import { GraphIndex } from '@main/analysis/algorithms/graphIndex';
import {
  findUnusedExportCandidates,
  packageEntryPointsFrom,
  type ExportedSymbolInput,
  type UnusedExportOptions,
} from '@main/analysis/algorithms/unusedExports';
import type { AdjacencyEdge } from '@main/db/repositories/edgeRepository';

function reference(from: string, to: string): AdjacencyEdge {
  return { from, to, edgeType: 'reference', unresolved: false, sourceLine: 1, specifier: null };
}

function symbol(overrides: Partial<ExportedSymbolInput> = {}): ExportedSymbolInput {
  return {
    filePath: 'src/util.ts',
    symbolName: 'helper',
    symbolKind: 'function',
    line: 3,
    isDefaultExport: false,
    ...overrides,
  };
}

function options(overrides: Partial<UnusedExportOptions> = {}): UnusedExportOptions {
  return {
    entryPoints: [],
    exclusions: [],
    barrelCaveats: new Map(),
    packageEntryPoints: [],
    ...overrides,
  };
}

describe('findUnusedExportCandidates', () => {
  it('flags an exported symbol with no incoming reference', () => {
    const candidates = findUnusedExportCandidates([symbol()], new GraphIndex([]), options());

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ filePath: 'src/util.ts', symbolName: 'helper' });
  });

  it('does not flag a symbol something imports by name', () => {
    const index = new GraphIndex([reference('file:src/app.ts', 'symbol:src/util.ts#helper')]);

    expect(findUnusedExportCandidates([symbol()], index, options())).toEqual([]);
  });

  it('ignores non-reference edges when deciding usage', () => {
    // An export edge is the file declaring the symbol, not another file consuming it.
    const exportEdge: AdjacencyEdge = {
      from: 'file:src/util.ts',
      to: 'symbol:src/util.ts#helper',
      edgeType: 'export',
      unresolved: false,
      sourceLine: 3,
      specifier: null,
    };

    const index = new GraphIndex([exportEdge], { edgeTypes: ['export', 'reference'] });

    expect(findUnusedExportCandidates([symbol()], index, options())).toHaveLength(1);
  });

  it('excludes configured entry points', () => {
    const candidates = findUnusedExportCandidates(
      [symbol({ filePath: 'src/index.ts' })],
      new GraphIndex([]),
      options({ entryPoints: ['src/index.ts'] }),
    );

    expect(candidates).toEqual([]);
  });

  it('excludes package entry points', () => {
    const candidates = findUnusedExportCandidates(
      [symbol({ filePath: 'src/public.ts' })],
      new GraphIndex([]),
      options({ packageEntryPoints: ['src/public.ts'] }),
    );

    expect(candidates).toEqual([]);
  });

  it('excludes framework convention files', () => {
    const candidates = findUnusedExportCandidates(
      [
        symbol({ filePath: 'pages/about.tsx' }),
        symbol({ filePath: 'app/dashboard/page.tsx' }),
        symbol({ filePath: 'middleware.ts' }),
      ],
      new GraphIndex([]),
      options(),
    );

    expect(candidates).toEqual([]);
  });

  it('honours a whole-file user exclusion pattern', () => {
    const candidates = findUnusedExportCandidates(
      [symbol({ filePath: 'src/generated/api.ts' })],
      new GraphIndex([]),
      options({ exclusions: ['src/generated/**'] }),
    );

    expect(candidates).toEqual([]);
  });

  it('honours a single-symbol user exclusion', () => {
    const candidates = findUnusedExportCandidates(
      [symbol({ symbolName: 'keepMe' }), symbol({ symbolName: 'flagMe' })],
      new GraphIndex([]),
      options({ exclusions: ['src/util.ts#keepMe'] }),
    );

    expect(candidates.map((c) => c.symbolName)).toEqual(['flagMe']);
  });

  it('attaches a caveat when the file has an unresolvable barrel export', () => {
    const candidates = findUnusedExportCandidates(
      [symbol()],
      new GraphIndex([]),
      options({
        barrelCaveats: new Map([['src/util.ts', ['"export * from \'./x\'" could not be resolved.']]]),
      }),
    );

    expect(candidates[0]?.caveats.join(' ')).toMatch(/export \*/);
  });

  it('attaches a caveat to default exports', () => {
    const candidates = findUnusedExportCandidates(
      [symbol({ isDefaultExport: true })],
      new GraphIndex([]),
      options(),
    );

    expect(candidates[0]?.caveats.join(' ')).toMatch(/any name/);
  });

  it('attaches a caveat to React components', () => {
    const candidates = findUnusedExportCandidates(
      [symbol({ symbolKind: 'react-component', symbolName: 'Widget' })],
      new GraphIndex([]),
      options(),
    );

    expect(candidates[0]?.caveats.join(' ')).toMatch(/framework route or registry/);
  });

  it('returns candidates sorted by path then line', () => {
    const candidates = findUnusedExportCandidates(
      [
        symbol({ filePath: 'src/b.ts', line: 5, symbolName: 'second' }),
        symbol({ filePath: 'src/a.ts', line: 9, symbolName: 'later' }),
        symbol({ filePath: 'src/a.ts', line: 2, symbolName: 'earlier' }),
      ],
      new GraphIndex([]),
      options(),
    );

    expect(candidates.map((c) => c.symbolName)).toEqual(['earlier', 'later', 'second']);
  });
});

describe('packageEntryPointsFrom', () => {
  it('reads main, module, types, and browser', () => {
    const entries = packageEntryPointsFrom({
      main: './dist/index.js',
      module: 'dist/index.mjs',
      types: './dist/index.d.ts',
    });

    expect(entries).toEqual(
      expect.arrayContaining(['dist/index.js', 'dist/index.mjs', 'dist/index.d.ts']),
    );
  });

  it('walks a nested exports map', () => {
    const entries = packageEntryPointsFrom({
      exports: {
        '.': { import: './src/index.ts', require: './src/index.cjs' },
        './helpers': './src/helpers.ts',
      },
    });

    expect(entries).toEqual(
      expect.arrayContaining(['src/index.ts', 'src/index.cjs', 'src/helpers.ts']),
    );
  });

  it('reads bin entries in both string and object form', () => {
    expect(packageEntryPointsFrom({ bin: './cli.js' })).toContain('cli.js');
    expect(packageEntryPointsFrom({ bin: { tool: './src/cli.ts' } })).toContain('src/cli.ts');
  });

  it('returns nothing for a manifest without entry points', () => {
    expect(packageEntryPointsFrom({ name: 'x' })).toEqual([]);
    expect(packageEntryPointsFrom(null)).toEqual([]);
    expect(packageEntryPointsFrom('not an object')).toEqual([]);
  });
});
