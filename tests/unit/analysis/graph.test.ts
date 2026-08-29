import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { discoverFiles } from '@main/analysis/discovery';
import { parseSourceFile } from '@main/analysis/parser';
import { buildKnownFileIndex, type ResolverContext } from '@main/analysis/resolver';
import { loadProjectTsConfig } from '@main/analysis/tsconfig';
import { buildGraph, type BuiltGraph, type FileToBuild } from '@main/analysis/graph';
import { toPosixPath } from '@main/utils/glob';

const FIXTURE_ROOT = resolve(__dirname, '../../fixtures/sample-project');

let graph: BuiltGraph;
let files: FileToBuild[];

beforeAll(async () => {
  const { files: discovered } = await discoverFiles({
    rootPath: FIXTURE_ROOT,
    respectGitignore: true,
    includeTestFiles: true,
    excludePatterns: [],
  });

  files = await Promise.all(
    discovered.map(async (file) => ({
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
      parsed: parseSourceFile(file.absolutePath, await fs.readFile(file.absolutePath, 'utf8')),
    })),
  );

  const context: ResolverContext = {
    rootPath: FIXTURE_ROOT,
    tsConfig: loadProjectTsConfig(FIXTURE_ROOT),
    knownFiles: buildKnownFileIndex(discovered.map((f) => toPosixPath(f.absolutePath))),
  };

  graph = buildGraph(files, context);
});

function edgesOfType(type: string) {
  return graph.edges.filter((edge) => edge.edgeType === type);
}

function hasEdge(from: string, to: string, type: string): boolean {
  return graph.edges.some(
    (edge) => edge.fromNodeId === from && edge.toNodeId === to && edge.edgeType === type,
  );
}

describe('import edges', () => {
  it('connects a file to each file it imports', () => {
    expect(hasEdge('file:src/index.ts', 'file:src/app.ts', 'import')).toBe(true);
    expect(hasEdge('file:src/index.ts', 'file:src/services/index.ts', 'import')).toBe(true);
    expect(hasEdge('file:src/app.ts', 'file:src/services/math.ts', 'import')).toBe(true);
  });

  it('resolves an import through a path alias', () => {
    expect(hasEdge('file:src/components/Button.tsx', 'file:src/db/client.ts', 'import')).toBe(true);
  });

  it('records a dynamic import with its own edge type', () => {
    expect(hasEdge('file:src/lazy/loader.ts', 'file:src/lazy/heavy.ts', 'dynamic-import')).toBe(
      true,
    );
  });

  it('records the circular pair in both directions', () => {
    expect(hasEdge('file:src/cycle/a.ts', 'file:src/cycle/b.ts', 'import')).toBe(true);
    expect(hasEdge('file:src/cycle/b.ts', 'file:src/cycle/a.ts', 'import')).toBe(true);
  });

  it('stores the source line and specifier on each edge', () => {
    const edge = graph.edges.find(
      (candidate) =>
        candidate.fromNodeId === 'file:src/index.ts' && candidate.toNodeId === 'file:src/app.ts',
    );

    expect(edge?.sourceLine).toBe(1);
    expect(edge?.metadata.specifier).toBe('./app');
    expect(edge?.metadata.importedNames).toEqual(['renderApp']);
  });
});

describe('unresolved imports', () => {
  it('reports a missing relative file without inventing an edge target', () => {
    const record = graph.unresolved.find((entry) => entry.specifier === './does-not-exist');

    expect(record).toMatchObject({ filePath: 'src/utils/missing-import.ts', reason: 'file-not-found' });
  });

  it('reports an external package rather than treating it as project code', () => {
    const record = graph.unresolved.find((entry) => entry.specifier === 'express');

    expect(record?.reason).toBe('external-package');
  });

  it('reports a computed dynamic import as unresolvable', () => {
    const record = graph.unresolved.find((entry) => entry.reason === 'dynamic-expression');

    expect(record?.filePath).toBe('src/lazy/loader.ts');
  });

  it('marks unresolved edges in their metadata', () => {
    const unresolvedEdges = graph.edges.filter((edge) => edge.metadata.unresolved === true);

    expect(unresolvedEdges.length).toBeGreaterThan(0);
    expect(unresolvedEdges.every((edge) => edge.toNodeId.startsWith('file:'))).toBe(true);
  });
});

describe('export edges', () => {
  it('links a file to each symbol it exports', () => {
    expect(hasEdge('file:src/services/math.ts', 'symbol:src/services/math.ts#add', 'export')).toBe(
      true,
    );
    expect(
      hasEdge('file:src/services/math.ts', 'symbol:src/services/math.ts#multiply', 'export'),
    ).toBe(true);
  });

  it('does not create export edges for unexported declarations', () => {
    const buttonExports = edgesOfType('export').filter(
      (edge) => edge.fromNodeId === 'file:src/components/Button.tsx',
    );

    expect(buttonExports.map((edge) => edge.toNodeId)).not.toContain(
      'symbol:src/components/Button.tsx#ButtonProps',
    );
  });
});

describe('reference edges through barrel files', () => {
  it('attributes a named import to the symbol it actually declares', () => {
    expect(
      hasEdge('file:src/app.ts', 'symbol:src/services/math.ts#add', 'reference'),
    ).toBe(true);
  });

  it('follows an explicit re-export to the declaring file', () => {
    // index.ts imports { greet } from './services', which re-exports it from ./greeter.
    expect(
      hasEdge('file:src/index.ts', 'symbol:src/services/greeter.ts#greet', 'reference'),
    ).toBe(true);
  });

  it('follows an export * barrel to the declaring file', () => {
    // app.ts imports { Button } from './components', a barrel that stars in Button.tsx.
    expect(
      hasEdge('file:src/app.ts', 'symbol:src/components/Button.tsx#Button', 'reference'),
    ).toBe(true);
  });

  it('records a caveat for each export * barrel', () => {
    const caveats = graph.barrelCaveats.get('src/components/index.ts') ?? [];

    expect(caveats.join(' ')).toMatch(/export \*/);
  });
});

describe('graph determinism', () => {
  it('produces identical edges when built twice from the same input', () => {
    const context: ResolverContext = {
      rootPath: FIXTURE_ROOT,
      tsConfig: loadProjectTsConfig(FIXTURE_ROOT),
      knownFiles: buildKnownFileIndex(files.map((f) => toPosixPath(f.absolutePath))),
    };

    const rebuilt = buildGraph(files, context);

    expect(rebuilt.edges).toEqual(graph.edges);
    expect(rebuilt.unresolved).toEqual(graph.unresolved);
  });
});

describe('call edges', () => {
  const SYNTHETIC_ROOT = resolve(__dirname, '../../fixtures/synthetic-calls');

  /**
   * Builds a graph from source text alone. The resolver reads no filesystem, working only
   * from the known-file index, so these paths never need to exist on disk.
   */
  function buildFrom(sources: Record<string, string>): BuiltGraph {
    const built: FileToBuild[] = Object.entries(sources).map(([relativePath, source]) => {
      const absolutePath = resolve(SYNTHETIC_ROOT, relativePath);
      return { relativePath, absolutePath, parsed: parseSourceFile(absolutePath, source) };
    });

    return buildGraph(built, {
      rootPath: SYNTHETIC_ROOT,
      tsConfig: loadProjectTsConfig(SYNTHETIC_ROOT),
      knownFiles: buildKnownFileIndex(built.map((file) => toPosixPath(file.absolutePath))),
    });
  }

  function callEdges(built: BuiltGraph) {
    return built.edges.filter((edge) => edge.edgeType === 'call');
  }

  const API = `export function send(message: string) {\n  return message;\n}\n`;

  it('does not attribute a method call to an import that shares its name', () => {
    // The regression: `logger.send()` and the imported `send` share a member name and
    // nothing else, but name-only matching produced an edge into the imported module.
    const built = buildFrom({
      'src/api.ts': API,
      'src/app.ts': `import { send } from './api';\nconst logger = { send(_m: string) {} };\nexport function run() {\n  logger.send('hi');\n}\n`,
    });

    expect(
      callEdges(built).some((edge) => edge.toNodeId === 'symbol:src/api.ts#send'),
    ).toBe(false);
  });

  it('still records a direct call to an imported function', () => {
    const built = buildFrom({
      'src/api.ts': API,
      'src/app.ts': `import { send } from './api';\nexport function run() {\n  send('hi');\n}\n`,
    });

    expect(
      callEdges(built).some(
        (edge) =>
          edge.fromNodeId === 'file:src/app.ts' && edge.toNodeId === 'symbol:src/api.ts#send',
      ),
    ).toBe(true);
  });

  it('follows a call made through a namespace import', () => {
    // `api.send()` names exactly one target, because `api` can only be the imported module.
    const built = buildFrom({
      'src/api.ts': API,
      'src/app.ts': `import * as api from './api';\nexport function run() {\n  api.send('hi');\n}\n`,
    });

    const edge = callEdges(built).find((item) => item.toNodeId === 'symbol:src/api.ts#send');

    expect(edge).toBeDefined();
    expect(edge?.metadata).toMatchObject({ callee: 'send', calleeReceiver: 'api' });
  });

  it('does not attribute a method call to a local function of the same name', () => {
    const built = buildFrom({
      'src/app.ts': `export function step() {}\nexport class Runner {\n  run() {\n    this.step();\n  }\n  step() {}\n}\n`,
    });

    expect(
      callEdges(built).some((edge) => edge.toNodeId === 'symbol:src/app.ts#step'),
    ).toBe(false);
  });

  it('ignores a namespace-shaped call whose receiver is not an import', () => {
    const built = buildFrom({
      'src/api.ts': API,
      'src/app.ts': `import './api';\nconst api = { send(_m: string) {} };\nexport function run() {\n  api.send('hi');\n}\n`,
    });

    expect(callEdges(built)).toHaveLength(0);
  });
});
