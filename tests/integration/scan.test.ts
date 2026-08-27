import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataStore } from '@main/db';
import { openDatabase } from '@main/db/connection';
import { runScan } from '@main/analysis/scanner';
import type { CycleDetails, Project, UnusedExportDetails } from '@shared/types';

const FIXTURE_ROOT = resolve(__dirname, '../fixtures/sample-project');

let store: DataStore;
let project: Project;

beforeEach(() => {
  store = new DataStore(openDatabase({ filePath: ':memory:' }));
  project = store.projects.createOrTouch('sample-project', FIXTURE_ROOT);
});

afterEach(() => {
  store.close();
});

async function scan(fullRescan = false) {
  return runScan(store, { project: store.projects.findById(project.id) as Project, fullRescan });
}

describe('end-to-end scan', () => {
  it('completes and records a summary', async () => {
    const result = await scan();

    expect(result.status).toBe('completed');
    expect(result.totalFiles).toBeGreaterThan(10);
    expect(result.summary?.totalEdges).toBeGreaterThan(0);
    expect(result.summary?.totalSymbols).toBeGreaterThan(0);
  });

  it('persists files, symbols, and edges', async () => {
    await scan();

    expect(store.files.countByProject(project.id)).toBeGreaterThan(10);
    expect(store.symbols.countByProject(project.id)).toBeGreaterThan(10);
    expect(store.edges.countByProject(project.id)).toBeGreaterThan(10);
  });

  it('detects the fixture circular dependency', async () => {
    await scan();

    const cycles = store.findings.list(project.id, { findingType: 'circular-dependency' });
    expect(cycles).toHaveLength(1);

    const details = cycles[0]?.details as CycleDetails;
    expect(details.cyclePath).toEqual(
      expect.arrayContaining(['src/cycle/a.ts', 'src/cycle/b.ts']),
    );
  });

  it('flags genuinely unused exports but not used ones', async () => {
    await scan();

    const candidates = store.findings
      .list(project.id, { findingType: 'unused-export-candidate' })
      .map((finding) => (finding.details as UnusedExportDetails).symbolName);

    expect(candidates).toContain('UNUSED_GREETING');
    expect(candidates).toContain('multiply');
    expect(candidates).toContain('UnusedBadge');

    // These are imported somewhere in the fixture, so they must not be flagged.
    expect(candidates).not.toContain('greet');
    expect(candidates).not.toContain('add');
    expect(candidates).not.toContain('renderApp');
  });

  it('does not flag a symbol reached only through a barrel file', async () => {
    await scan();

    const candidates = store.findings
      .list(project.id, { findingType: 'unused-export-candidate' })
      .map((finding) => (finding.details as UnusedExportDetails).symbolName);

    // app.ts imports Button via the components barrel, never from Button.tsx directly.
    expect(candidates).not.toContain('Button');
  });

  it('records unresolved imports without inventing targets', async () => {
    await scan();

    const unresolved = store.findings.list(project.id, { findingType: 'unresolved-import' });
    const specifiers = unresolved.map((finding) => finding.title);

    expect(specifiers.join(' ')).toMatch(/does-not-exist/);
    expect(specifiers.join(' ')).toMatch(/dynamically imported module/);
  });

  it('reports architecture violations for a configured rule', async () => {
    store.rules.upsert({
      projectId: project.id,
      name: 'Components must not import the database layer',
      enabled: true,
      ruleType: 'forbid-import',
      sourcePattern: 'src/components/**',
      targetPattern: 'src/db/**',
      configuration: { severity: 'high', exceptions: [] },
    });

    await scan();

    const violations = store.findings.list(project.id, { findingType: 'architecture-violation' });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.description).toMatch(/src\/components\/Button\.tsx/);
  });

  it('records honest limitations in the summary', async () => {
    const result = await scan();

    expect(result.summary?.limitations.join(' ')).toMatch(/export \*/);
  });

  it('produces identical findings when scanned twice', async () => {
    await scan();
    const first = store.findings.list(project.id).map((f) => f.title).sort();

    await scan();
    const second = store.findings.list(project.id).map((f) => f.title).sort();

    expect(second).toEqual(first);
  });
});

describe('incremental rescan', () => {
  it('skips unchanged files on the second scan', async () => {
    const first = await scan();
    expect(first.summary?.skippedUnchangedFiles).toBe(0);

    const second = await scan();
    expect(second.summary?.parsedFiles).toBe(0);
    expect(second.summary?.skippedUnchangedFiles).toBe(first.summary?.totalFiles);
  });

  it('re-parses every file when a full rescan is requested', async () => {
    await scan();
    const full = await scan(true);

    expect(full.summary?.skippedUnchangedFiles).toBe(0);
    expect(full.summary?.parsedFiles).toBe(full.summary?.totalFiles);
  });

  it('keeps the edge count stable across an incremental rescan', async () => {
    await scan();
    const edgesAfterFirst = store.edges.countByProject(project.id);

    await scan();

    expect(store.edges.countByProject(project.id)).toBe(edgesAfterFirst);
  });

  it('picks up a newly added file and its edges', async () => {
    await scan();
    const before = store.files.countByProject(project.id);

    const newFile = join(FIXTURE_ROOT, 'src/services/extra.ts');
    await fs.writeFile(newFile, `import { add } from './math';\nexport const sum = add(1, 2);\n`);

    try {
      const result = await scan();

      expect(store.files.countByProject(project.id)).toBe(before + 1);
      expect(result.summary?.parsedFiles).toBe(1);
      expect(
        store.edges
          .listFrom(project.id, 'file:src/services/extra.ts')
          .some((edge) => edge.toNodeId === 'file:src/services/math.ts'),
      ).toBe(true);
    } finally {
      await fs.rm(newFile, { force: true });
    }
  });

  it('removes records for a file deleted from disk', async () => {
    const tempFile = join(FIXTURE_ROOT, 'src/services/temporary.ts');
    await fs.writeFile(tempFile, `export const temporary = 1;\n`);
    await scan();
    expect(store.files.findByPath(project.id, 'src/services/temporary.ts')).not.toBeNull();

    await fs.rm(tempFile, { force: true });
    const result = await scan();

    expect(store.files.findByPath(project.id, 'src/services/temporary.ts')).toBeNull();
    expect(result.summary?.removedFiles).toBe(1);
  });

  it('keeps only the most recent scan', async () => {
    await scan();
    await scan();
    await scan();

    const scanCount = store.db
      .prepare<[number], { count: number }>(`SELECT COUNT(*) AS count FROM scans WHERE project_id = ?`)
      .get(project.id);

    expect(scanCount?.count).toBe(1);
  });
});

describe('scan cancellation', () => {
  it('marks a cancelled scan without leaving it running', async () => {
    const signal = { cancelled: true };

    await expect(
      runScan(store, {
        project: store.projects.findById(project.id) as Project,
        fullRescan: false,
        signal,
      }),
    ).rejects.toThrow(/cancelled/i);

    expect(store.scans.latestForProject(project.id)?.status).toBe('cancelled');
  });
});
