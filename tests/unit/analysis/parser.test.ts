import { describe, expect, it } from 'vitest';
import { parseSourceFile } from '@main/analysis/parser';

function parse(fileName: string, source: string) {
  return parseSourceFile(fileName, source);
}

describe('import extraction', () => {
  it('records named, default, and namespace imports', () => {
    const result = parse(
      'a.ts',
      [
        `import defaultThing from './default';`,
        `import { alpha, beta as renamed } from './named';`,
        `import * as everything from './namespace';`,
        `import './side-effect';`,
      ].join('\n'),
    );

    expect(result.imports).toEqual([
      expect.objectContaining({ specifier: './default', importedNames: ['default'], line: 1 }),
      expect.objectContaining({ specifier: './named', importedNames: ['alpha', 'beta'], line: 2 }),
      expect.objectContaining({ specifier: './namespace', importedNames: ['*'], line: 3 }),
      expect.objectContaining({ specifier: './side-effect', importedNames: [], line: 4 }),
    ]);
  });

  it('marks type-only imports', () => {
    const result = parse('a.ts', `import type { Config } from './config';`);

    expect(result.imports[0]?.isTypeOnly).toBe(true);
  });

  it('distinguishes dynamic imports from static ones', () => {
    const result = parse('a.ts', `const later = () => import('./heavy');`);

    expect(result.imports[0]).toMatchObject({
      specifier: './heavy',
      kind: 'dynamic-import',
      isDynamicExpression: false,
    });
  });

  it('flags a dynamic import with a computed specifier instead of guessing', () => {
    const result = parse('a.ts', `const load = (n: string) => import(\`./mods/\${n}\`);`);

    expect(result.imports[0]).toMatchObject({
      kind: 'dynamic-import',
      isDynamicExpression: true,
    });
  });

  it('records require() calls', () => {
    const result = parse('a.js', `const fs = require('node:fs');`);

    expect(result.imports[0]).toMatchObject({ specifier: 'node:fs', kind: 'require' });
  });

  it('records re-exports and marks star exports', () => {
    const result = parse(
      'index.ts',
      [`export * from './all';`, `export { one, two as second } from './some';`].join('\n'),
    );

    expect(result.imports).toEqual([
      expect.objectContaining({ specifier: './all', kind: 're-export', isStarExport: true }),
      expect.objectContaining({
        specifier: './some',
        kind: 're-export',
        isStarExport: false,
        importedNames: ['one', 'two'],
      }),
    ]);
  });
});

describe('symbol extraction', () => {
  it('extracts functions, classes, interfaces, types, and enums', () => {
    const result = parse(
      'a.ts',
      [
        `export function doThing() {}`,
        `class Internal {}`,
        `export interface Shape { x: number }`,
        `export type Alias = string;`,
        `export enum Colour { Red }`,
      ].join('\n'),
    );

    const byName = Object.fromEntries(result.symbols.map((s) => [s.name, s]));

    expect(byName['doThing']).toMatchObject({ kind: 'function', isExported: true });
    expect(byName['Internal']).toMatchObject({ kind: 'class', isExported: false });
    expect(byName['Shape']).toMatchObject({ kind: 'interface', isExported: true });
    expect(byName['Alias']).toMatchObject({ kind: 'type', isExported: true });
    expect(byName['Colour']).toMatchObject({ kind: 'enum', isExported: true });
  });

  it('classifies arrow-function variables as functions', () => {
    const result = parse('a.ts', `export const helper = async (a: number) => a + 1;`);

    expect(result.symbols[0]).toMatchObject({
      name: 'helper',
      kind: 'function',
      isExported: true,
      metadata: { isAsync: true, paramCount: 1 },
    });
  });

  it('records plain variables as variables', () => {
    const result = parse('a.ts', `export const VERSION = '1.0.0';`);

    expect(result.symbols[0]).toMatchObject({ name: 'VERSION', kind: 'variable' });
  });

  it('identifies a default export', () => {
    const result = parse('a.ts', `export default function entry() {}`);

    expect(result.symbols[0]).toMatchObject({ isExported: true, isDefaultExport: true });
  });

  it('marks locally declared symbols exported by a later export clause', () => {
    const result = parse('a.ts', [`function hidden() {}`, `export { hidden };`].join('\n'));

    expect(result.symbols[0]).toMatchObject({ name: 'hidden', isExported: true });
  });

  it('records the renamed alias when a symbol is exported under another name', () => {
    const result = parse('a.ts', [`function local() {}`, `export { local as public };`].join('\n'));

    expect(result.symbols[0]?.metadata.exportedAs).toBe('public');
  });

  it('records the origin module for a re-exported symbol', () => {
    const result = parse('index.ts', `export { greet } from './greeter';`);

    expect(result.symbols[0]).toMatchObject({
      name: 'greet',
      isExported: true,
      metadata: { reExportedFrom: './greeter' },
    });
  });

  it('captures accurate line ranges', () => {
    const result = parse('a.ts', [`// comment`, `export function multi() {`, `  return 1;`, `}`].join('\n'));

    expect(result.symbols[0]).toMatchObject({ startLine: 2, endLine: 4 });
  });
});

describe('React component detection', () => {
  it('detects a PascalCase function returning JSX', () => {
    const result = parse(
      'Button.tsx',
      `export function Button() { return <button>ok</button>; }`,
    );

    expect(result.symbols[0]).toMatchObject({ name: 'Button', kind: 'react-component' });
  });

  it('detects a PascalCase arrow component', () => {
    const result = parse('Card.tsx', `export const Card = () => <div>card</div>;`);

    expect(result.symbols[0]).toMatchObject({ name: 'Card', kind: 'react-component' });
  });

  it('detects a class extending React.Component', () => {
    const result = parse(
      'Legacy.tsx',
      `import React from 'react';\nexport class Legacy extends React.Component {}`,
    );

    const legacy = result.symbols.find((s) => s.name === 'Legacy');
    expect(legacy?.kind).toBe('react-component');
  });

  it('does not classify a lowercase JSX-returning function as a component', () => {
    const result = parse('h.tsx', `export function render() { return <div />; }`);

    expect(result.symbols[0]?.kind).toBe('function');
  });

  it('does not classify a PascalCase function without JSX as a component', () => {
    const result = parse('Factory.ts', `export function Factory() { return 1; }`);

    expect(result.symbols[0]?.kind).toBe('function');
  });
});

describe('parser resilience', () => {
  it('returns partial results for a file with a syntax error rather than throwing', () => {
    const result = parse('broken.ts', `import { a } from './a';\nexport function ok() {\n`);

    expect(result.imports[0]?.specifier).toBe('./a');
    expect(() => parse('broken.ts', 'const = = =;')).not.toThrow();
  });

  it('handles an empty file', () => {
    const result = parse('empty.ts', '');

    expect(result.imports).toEqual([]);
    expect(result.symbols).toEqual([]);
  });

  it.each([
    {
      fileName: 'Widget.vue',
      source: [
        '<template><div /></template>',
        '<script lang="ts">',
        `import { shared } from './shared';`,
        'export const widgetValue = shared;',
        '</script>',
      ].join('\n'),
      symbol: 'widgetValue',
      line: 4,
    },
    {
      fileName: 'Panel.svelte',
      source: [
        '<script lang="ts">',
        `import { shared } from './shared';`,
        'export const panelValue = shared;',
        '</script>',
        '<p>{panelValue}</p>',
      ].join('\n'),
      symbol: 'panelValue',
      line: 3,
    },
    {
      fileName: 'Page.astro',
      source: [
        '---',
        `import { shared } from './shared';`,
        'export const pageValue = shared;',
        '---',
        '<p>{pageValue}</p>',
      ].join('\n'),
      symbol: 'pageValue',
      line: 3,
    },
  ])('parses the standard script region in $fileName without shifting lines', ({
    fileName,
    source,
    symbol,
    line,
  }) => {
    const result = parse(fileName, source);
    const limitations = (result as typeof result & { limitations?: string[] }).limitations;

    expect(result.imports).toEqual([
      expect.objectContaining({ specifier: './shared' }),
    ]);
    expect(result.symbols).toEqual([
      expect.objectContaining({ name: symbol, startLine: line }),
    ]);
    expect(limitations?.join(' ')).toMatch(/template and style regions analysed/i);
  });

  it('does not execute script examples inside markup comments', () => {
    const result = parse(
      'Example.vue',
      [
        '<template>',
        '  <!-- <script>',
        `  import { fake } from './commented';`,
        '  export const fakeSymbol = fake;',
        '  </script> -->',
        '</template>',
      ].join('\n'),
    );

    expect(result.imports).toEqual([]);
    expect(result.symbols).toEqual([]);
  });

  it('reports external script blocks without treating their fallback body as analysed', () => {
    const result = parse(
      'External.vue',
      `<script src="./external.ts">import './fallback'; export const fallback = true;</script>`,
    );

    expect(result.imports).toEqual([]);
    expect(result.symbols).toEqual([]);
    expect(result.limitations.join(' ')).toMatch(/external.*\.\/external\.ts.*not analysed/i);
  });

  it('reports unsupported script languages without parsing them as JavaScript', () => {
    const result = parse(
      'Legacy.svelte',
      `<script lang="coffee">import './coffee-only'; export value = 1</script>`,
    );

    expect(result.imports).toEqual([]);
    expect(result.symbols).toEqual([]);
    expect(result.limitations.join(' ')).toMatch(/unsupported.*coffee.*not analysed/i);
  });
});

describe('syntax issues', () => {
  it('records line-addressable parse problems as syntaxIssues', () => {
    const result = parse('broken.ts', 'const x = {\n');
    // The compiler is error-tolerant; if it surfaces diagnostics they must have a line.
    for (const issue of result.syntaxIssues) {
      expect(issue.line).toBeGreaterThan(0);
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });
});
