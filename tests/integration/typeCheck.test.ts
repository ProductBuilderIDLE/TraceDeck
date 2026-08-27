import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataStore } from '@main/db';
import { openDatabase } from '@main/db/connection';
import { runScan } from '@main/analysis/scanner';
import { AnalysisService } from '@main/services/analysisService';
import {
  collectReportData,
  renderHtml,
  renderMarkdown,
} from '@main/services/reportService';
import type { Project, TypeErrorDetails } from '@shared/types';

const BROKEN_ROOT = resolve(__dirname, '../fixtures/type-errors-project');

let store: DataStore;
let project: Project;

beforeEach(() => {
  store = new DataStore(openDatabase({ filePath: ':memory:' }));
  project = store.projects.createOrTouch('type-errors-project', BROKEN_ROOT);
});

afterEach(() => {
  store.close();
});

function enableTypeCheck(enabled: boolean): Project {
  return store.projects.updateConfiguration(project.id, {
    ...project.configuration,
    typeCheck: enabled,
  }) as Project;
}

describe('type checking during a scan', () => {
  it('is off by default, so a scan reports no type errors', async () => {
    const scan = await runScan(store, { project, fullRescan: true });

    expect(scan.summary?.typeCheck).toBeNull();
    expect(store.findings.countByType(project.id, 'type-error')).toBe(0);
  });

  it('reports real compile errors when enabled', async () => {
    const scan = await runScan(store, { project: enableTypeCheck(true), fullRescan: true });

    expect(scan.summary?.typeCheck?.ran).toBe(true);
    expect(scan.summary?.typeCheck?.errorCount).toBeGreaterThanOrEqual(3);

    const findings = store.findings.list(project.id, { findingType: 'type-error' });
    expect(findings.length).toBeGreaterThanOrEqual(3);

    const codes = findings.map((finding) => (finding.details as TypeErrorDetails).code);
    expect(codes).toContain(2322);
    expect(codes).toContain(2554);
    expect(codes).toContain(2339);
  });

  it('records the file and line for each error', async () => {
    await runScan(store, { project: enableTypeCheck(true), fullRescan: true });

    const finding = store.findings
      .list(project.id, { findingType: 'type-error' })
      .find((item) => (item.details as TypeErrorDetails).code === 2322);
    const details = finding?.details as TypeErrorDetails;

    expect(details.filePath).toBe('src/broken.ts');
    expect(details.line).toBeGreaterThan(0);
    expect(finding?.severity).toBe('high');
    expect(finding?.title).toMatch(/^TS2322:/);
  });

  it('links each error to its file node so it can be focused in the graph', async () => {
    await runScan(store, { project: enableTypeCheck(true), fullRescan: true });

    const finding = store.findings.list(project.id, { findingType: 'type-error' })[0];
    expect(finding?.relatedNodeIds[0]).toBe('file:src/broken.ts');
  });

  it('clears type errors when the option is turned back off', async () => {
    await runScan(store, { project: enableTypeCheck(true), fullRescan: true });
    expect(store.findings.countByType(project.id, 'type-error')).toBeGreaterThan(0);

    await runScan(store, { project: enableTypeCheck(false), fullRescan: true });
    expect(store.findings.countByType(project.id, 'type-error')).toBe(0);
  });

  it('produces the same errors on a rescan', async () => {
    const enabled = enableTypeCheck(true);
    await runScan(store, { project: enabled, fullRescan: true });
    const first = store.findings.list(project.id, { findingType: 'type-error' }).map((f) => f.title);

    await runScan(store, { project: enabled, fullRescan: true });
    const second = store.findings.list(project.id, { findingType: 'type-error' }).map((f) => f.title);

    expect(second).toEqual(first);
  });

  it('keeps a dismissed error dismissed across a rescan', async () => {
    const enabled = enableTypeCheck(true);
    await runScan(store, { project: enabled, fullRescan: true });

    const finding = store.findings.list(project.id, { findingType: 'type-error' })[0]!;
    const before = store.findings.countByType(project.id, 'type-error');
    store.findings.setDismissed(finding.id, true);

    await runScan(store, { project: enabled, fullRescan: true });

    expect(store.findings.countByType(project.id, 'type-error')).toBe(before - 1);
  });

  it('falls back to default compiler options when no tsconfig covers the files', async () => {
    const noConfig = store.projects.createOrTouch('no-config', resolve(BROKEN_ROOT, 'src'));
    const configured = store.projects.updateConfiguration(noConfig.id, {
      ...noConfig.configuration,
      typeCheck: true,
    }) as Project;

    const scan = await runScan(store, { project: configured, fullRescan: true });

    // Checking with defaults is more useful than refusing, but the difference from the
    // project's real build settings has to be stated rather than glossed over.
    expect(scan.status).toBe('completed');
    expect(scan.summary?.typeCheck?.ran).toBe(true);
    expect(scan.summary?.limitations.join(' ')).toMatch(/default compiler options/i);
  });
});

describe('type errors in reports', () => {
  it('appears in Markdown and HTML output', async () => {
    await runScan(store, { project: enableTypeCheck(true), fullRescan: true });

    const analysis = new AnalysisService(store);
    const bundle = collectReportData(store, analysis, enableTypeCheck(true), {
      title: 'Type check report',
      format: 'markdown',
      sections: ['summary', 'type-errors'],
      scope: { kind: 'project' },
    });

    const markdown = renderMarkdown(bundle);
    expect(markdown).toContain('## Type errors');
    expect(markdown).toContain('TS2322');

    const html = renderHtml(bundle);
    expect(html).toContain('Type errors');
    expect(html).toContain('TS2322');
    // The standalone HTML guarantee must still hold with the new section.
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('can be scoped to type errors alone', async () => {
    await runScan(store, { project: enableTypeCheck(true), fullRescan: true });

    const bundle = collectReportData(store, new AnalysisService(store), enableTypeCheck(true), {
      title: 'Only type errors',
      format: 'markdown',
      sections: ['type-errors'],
      scope: { kind: 'finding-type', findingType: 'type-error' },
    });

    expect(bundle.findings['type-error']?.length).toBeGreaterThan(0);
    expect(bundle.findings['unused-export-candidate']).toHaveLength(0);
  });
});
