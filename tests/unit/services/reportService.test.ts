import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataStore } from '@main/db';
import { openDatabase } from '@main/db/connection';
import { runScan } from '@main/analysis/scanner';
import { AnalysisService } from '@main/services/analysisService';
import {
  collectReportData,
  renderHtml,
  renderJson,
  renderMarkdown,
  reportFileExtension,
} from '@main/services/reportService';
import type { Project, ReportConfiguration, ReportSection } from '@shared/types';

const FIXTURE_ROOT = resolve(__dirname, '../../fixtures/sample-project');

const ALL_SECTIONS: ReportSection[] = [
  'summary',
  'top-impact-files',
  'cycles',
  'unused-exports',
  'architecture-violations',
  'unresolved-imports',
  'limitations',
];

let store: DataStore;
let analysis: AnalysisService;
let project: Project;

beforeEach(async () => {
  store = new DataStore(openDatabase({ filePath: ':memory:' }));
  project = store.projects.createOrTouch('sample-project', FIXTURE_ROOT);
  store.rules.upsert({
    projectId: project.id,
    name: 'Components must not import the database layer',
    enabled: true,
    ruleType: 'forbid-import',
    sourcePattern: 'src/components/**',
    targetPattern: 'src/db/**',
    configuration: { severity: 'high', exceptions: [] },
  });
  await runScan(store, { project, fullRescan: true });
  analysis = new AnalysisService(store);
});

afterEach(() => {
  store.close();
});

function bundleFor(overrides: Partial<ReportConfiguration> = {}) {
  const configuration: ReportConfiguration = {
    title: 'Sample report',
    format: 'markdown',
    sections: ALL_SECTIONS,
    scope: { kind: 'project' },
    ...overrides,
  };
  return collectReportData(store, analysis, project, configuration);
}

describe('report data collection', () => {
  it('includes findings of every type for a project-wide scope', () => {
    const bundle = bundleFor();

    expect(bundle.findings['circular-dependency']).toHaveLength(1);
    expect(bundle.findings['architecture-violation']).toHaveLength(1);
    expect(bundle.findings['unused-export-candidate']?.length).toBeGreaterThan(0);
    expect(bundle.stats.totalFiles).toBeGreaterThan(10);
  });

  it('narrows findings to a single finding type', () => {
    const bundle = bundleFor({ scope: { kind: 'finding-type', findingType: 'circular-dependency' } });

    expect(bundle.findings['circular-dependency']).toHaveLength(1);
    expect(bundle.findings['unused-export-candidate']).toHaveLength(0);
  });

  it('narrows findings to a single file', () => {
    const bundle = bundleFor({ scope: { kind: 'file', filePath: 'src/cycle/a.ts' } });

    expect(bundle.findings['circular-dependency']).toHaveLength(1);
  });

  it('carries the scan limitations into the report', () => {
    expect(bundleFor().limitations.join(' ')).toMatch(/export \*/);
  });

  it('leaves out findings the user dismissed', () => {
    const cycle = store.findings.list(project.id, { findingType: 'circular-dependency' })[0];
    store.findings.setDismissed(cycle!.id, true);

    expect(bundleFor().findings['circular-dependency']).toHaveLength(0);
  });
});

describe('Markdown rendering', () => {
  it('renders every requested section', () => {
    const markdown = renderMarkdown(bundleFor());

    expect(markdown).toContain('# Sample report');
    expect(markdown).toContain('## Summary');
    expect(markdown).toContain('## Circular dependencies');
    expect(markdown).toContain('## Unused export candidates');
    expect(markdown).toContain('## Architecture rule violations');
    expect(markdown).toContain('## Analysis limitations');
  });

  it('omits sections that were not requested', () => {
    const markdown = renderMarkdown(bundleFor({ sections: ['summary'] }));

    expect(markdown).toContain('## Summary');
    expect(markdown).not.toContain('## Circular dependencies');
  });

  it('states the analysis disclaimer', () => {
    expect(renderMarkdown(bundleFor())).toMatch(/static analysis results/i);
  });

  it('records the privacy guarantee', () => {
    expect(renderMarkdown(bundleFor())).toContain('Analysis stays on this device.');
  });

  it('escapes pipes so a path cannot break out of a table cell', () => {
    const bundle = bundleFor();
    bundle.stats.topImpactFiles = [
      { ...bundle.stats.topImpactFiles[0]!, path: 'src/we|ird.ts', score: 1 },
    ];

    expect(renderMarkdown(bundle)).toContain('src/we\\|ird.ts');
  });
});

describe('JSON rendering', () => {
  it('produces parseable JSON with the summary and findings', () => {
    const parsed = JSON.parse(renderJson(bundleFor())) as Record<string, unknown>;

    expect(parsed['title']).toBe('Sample report');
    expect(parsed['privacy']).toBe('Analysis stays on this device.');
    expect((parsed['summary'] as Record<string, number>)['cycleCount']).toBe(1);
    expect(parsed['findings']).toBeTypeOf('object');
  });
});

describe('HTML rendering', () => {
  it('produces a complete standalone document', () => {
    const html = renderHtml(bundleFor());

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).toContain('<style>');
  });

  it('references no remote asset of any kind', () => {
    const html = renderHtml(bundleFor());

    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link[^>]+href/i);
    expect(html).not.toMatch(/@import/);
  });

  it('escapes HTML in project-supplied text', () => {
    const bundle = bundleFor();
    bundle.title = '<img src=x onerror=alert(1)>';
    bundle.project.name = '</title><script>bad()</script>';

    const html = renderHtml(bundle);

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>bad()');
    expect(html).toContain('&lt;img src=x');
  });

  it('adapts to the reader light and dark theme', () => {
    const html = renderHtml(bundleFor());

    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('color-scheme: light dark');
  });
});

describe('reportFileExtension', () => {
  it('maps each format to its file extension', () => {
    expect(reportFileExtension('markdown')).toBe('.md');
    expect(reportFileExtension('json')).toBe('.json');
    expect(reportFileExtension('html')).toBe('.html');
  });
});
