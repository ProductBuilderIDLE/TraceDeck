import { describe, expect, it } from 'vitest';
import {
  discoverReachableExports,
  type ExportLinkFact,
  type ExportModuleFact,
  type ExportSymbolFact,
} from '@main/analysis/algorithms/reachableExports';
import type { SymbolKind } from '@shared/types';

function symbol(overrides: Partial<ExportSymbolFact> = {}): ExportSymbolFact {
  return {
    name: 'value',
    exportedName: 'value',
    kind: 'function',
    line: 1,
    isDefault: false,
    reExportedFrom: null,
    ...overrides,
  };
}

function link(overrides: Partial<ExportLinkFact> = {}): ExportLinkFact {
  return {
    targetPath: 'src/origin.ts',
    specifier: './origin',
    isStar: false,
    ...overrides,
  };
}

function moduleFact(
  path: string,
  symbols: ExportSymbolFact[] = [],
  links: ExportLinkFact[] = [],
): ExportModuleFact {
  return { path, symbols, links };
}

function own(
  exportedName: string,
  kind: SymbolKind = 'function',
  line = 1,
): ExportSymbolFact {
  return symbol({
    name: exportedName === 'default' ? 'implementation' : exportedName,
    exportedName,
    kind,
    line,
    isDefault: exportedName === 'default',
  });
}

describe('discoverReachableExports', () => {
  it('records own named and default declarations at their declaration origins', () => {
    const result = discoverReachableExports(['src/index.ts'], [
      moduleFact('src/index.ts', [own('named', 'function', 2), own('default', 'class', 8)]),
    ]);

    expect(result.exports).toEqual([
      {
        entryPoint: 'src/index.ts',
        exportedName: 'default',
        symbolKind: 'class',
        originPath: 'src/index.ts',
        line: 8,
      },
      {
        entryPoint: 'src/index.ts',
        exportedName: 'named',
        symbolKind: 'function',
        originPath: 'src/index.ts',
        line: 2,
      },
    ]);
    expect(result.limitations).toEqual([]);
  });

  it('resolves named and aliased re-exports to the original declaration', () => {
    const result = discoverReachableExports(['src/index.ts'], [
      moduleFact(
        'src/index.ts',
        [
          symbol({ name: 'original', exportedName: 'renamed', reExportedFrom: './origin', line: 3 }),
          symbol({ name: 'other', exportedName: 'other', reExportedFrom: './origin', line: 4 }),
        ],
        [link()],
      ),
      moduleFact('src/origin.ts', [own('original', 'interface', 11), own('other', 'variable', 14)]),
    ]);

    expect(result.exports).toEqual([
      {
        entryPoint: 'src/index.ts',
        exportedName: 'other',
        symbolKind: 'variable',
        originPath: 'src/origin.ts',
        line: 14,
      },
      {
        entryPoint: 'src/index.ts',
        exportedName: 'renamed',
        symbolKind: 'interface',
        originPath: 'src/origin.ts',
        line: 11,
      },
    ]);
  });

  it('accepts a unique star origin, follows chains, and never forwards default', () => {
    const result = discoverReachableExports(['src/index.ts'], [
      moduleFact('src/index.ts', [], [link({ targetPath: 'src/barrel.ts', specifier: './barrel', isStar: true })]),
      moduleFact('src/barrel.ts', [], [link({ isStar: true })]),
      moduleFact('src/origin.ts', [own('default', 'class', 1), own('value', 'type', 6)]),
    ]);

    expect(result.exports).toEqual([
      {
        entryPoint: 'src/index.ts',
        exportedName: 'value',
        symbolKind: 'type',
        originPath: 'src/origin.ts',
        line: 6,
      },
    ]);
  });

  it('lets own and named declarations override star exports', () => {
    const result = discoverReachableExports(['src/index.ts'], [
      moduleFact(
        'src/index.ts',
        [own('value', 'class', 2), symbol({ name: 'named', exportedName: 'alias', reExportedFrom: './named' })],
        [
          link({ targetPath: 'src/star.ts', specifier: './star', isStar: true }),
          link({ targetPath: 'src/named.ts', specifier: './named' }),
        ],
      ),
      moduleFact('src/star.ts', [own('value', 'function', 20), own('alias', 'function', 21)]),
      moduleFact('src/named.ts', [own('named', 'enum', 7)]),
    ]);

    expect(result.exports).toEqual([
      expect.objectContaining({ exportedName: 'alias', symbolKind: 'enum', originPath: 'src/named.ts' }),
      expect.objectContaining({ exportedName: 'value', symbolKind: 'class', originPath: 'src/index.ts' }),
    ]);
  });

  it('does not invent an origin for conflicting star exports', () => {
    const result = discoverReachableExports(['index.ts'], [
      moduleFact('index.ts', [], [
        link({ targetPath: 'a.ts', specifier: './a', isStar: true }),
        link({ targetPath: 'b.ts', specifier: './b', isStar: true }),
      ]),
      moduleFact('a.ts', [own('value', 'function', 1)]),
      moduleFact('b.ts', [own('value', 'function', 1)]),
    ]);

    expect(result.exports).toEqual([]);
    expect(result.limitations).toEqual([
      expect.objectContaining({
        code: 'AMBIGUOUS_STAR_REEXPORT',
        scope: 'review',
        paths: ['index.ts'],
      }),
    ]);
  });

  it('reports an unresolved re-export target without inventing an export', () => {
    const result = discoverReachableExports(['src/index.ts'], [
      moduleFact(
        'src/index.ts',
        [symbol({ name: 'missing', exportedName: 'publicName', reExportedFrom: './missing' })],
        [link({ targetPath: null, specifier: './missing' })],
      ),
    ]);

    expect(result.exports).toEqual([]);
    expect(result.limitations).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_REEXPORT_TARGET',
        paths: ['src/index.ts'],
      }),
    ]);
  });

  it('does not report limitations from modules outside the entry-point surface', () => {
    const result = discoverReachableExports(['entry.ts'], [
      moduleFact('entry.ts', [own('publicName')]),
      moduleFact(
        'unreachable.ts',
        [symbol({ name: 'missing', exportedName: 'missing', reExportedFrom: './missing' })],
        [link({ targetPath: null, specifier: './missing' })],
      ),
    ]);

    expect(result.exports).toEqual([
      expect.objectContaining({ entryPoint: 'entry.ts', exportedName: 'publicName' }),
    ]);
    expect(result.limitations).toEqual([]);
  });

  it('guards star and named cycles by module and exported name', () => {
    const result = discoverReachableExports(['a.ts'], [
      moduleFact(
        'a.ts',
        [symbol({ name: 'fromB', exportedName: 'fromB', reExportedFrom: './b' })],
        [
          link({ targetPath: 'b.ts', specifier: './b' }),
          link({ targetPath: 'b.ts', specifier: './b', isStar: true }),
        ],
      ),
      moduleFact(
        'b.ts',
        [
          own('stable', 'variable', 9),
          symbol({ name: 'fromB', exportedName: 'fromB', reExportedFrom: './a' }),
        ],
        [link({ targetPath: 'a.ts', specifier: './a' })],
      ),
    ]);

    expect(result.exports).toEqual([
      {
        entryPoint: 'a.ts',
        exportedName: 'stable',
        symbolKind: 'variable',
        originPath: 'b.ts',
        line: 9,
      },
    ]);
  });

  it('isolates entry-point surfaces and ignores unreachable modules', () => {
    const result = discoverReachableExports(['entry-b.ts', 'entry-a.ts'], [
      moduleFact('entry-a.ts', [own('a', 'function', 1)]),
      moduleFact('entry-b.ts', [own('b', 'class', 2)]),
      moduleFact('not-public.ts', [own('hidden', 'variable', 3)]),
    ]);

    expect(result.exports.map((record) => [record.entryPoint, record.exportedName])).toEqual([
      ['entry-a.ts', 'a'],
      ['entry-b.ts', 'b'],
    ]);
  });

  it('is independent of entry-point, module, symbol, and link input order', () => {
    const modules = [
      moduleFact('index.ts', [own('local', 'class', 3)], [
        link({ targetPath: 'origin.ts', specifier: './origin', isStar: true }),
      ]),
      moduleFact('other.ts', [own('other', 'enum', 8)]),
      moduleFact('origin.ts', [own('zeta', 'variable', 5), own('alpha', 'type', 1)]),
    ];
    const reversed = [...modules]
      .reverse()
      .map((fact) => ({ ...fact, symbols: [...fact.symbols].reverse(), links: [...fact.links].reverse() }));

    expect(discoverReachableExports(['other.ts', 'index.ts'], modules)).toEqual(
      discoverReachableExports(['index.ts', 'other.ts'], reversed),
    );
  });
});
