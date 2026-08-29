import { describe, expect, it } from 'vitest';
import {
  renderChangeReview,
  reviewFileExtension,
  type ChangeReviewRenderContext,
} from '@main/services/changeReview/report';
import type {
  ChangeReviewResult,
  ReviewExportFormat,
  ReviewSection,
} from '@shared/changeReview';

const BASE_COMMIT = 'a'.repeat(40);
const BASE_TREE = 'b'.repeat(40);
const FORMATS: ReviewExportFormat[] = ['text', 'markdown', 'json', 'html'];
const SECTIONS: ReviewSection[] = [
  'files',
  'edges',
  'findings',
  'architecture-violations',
  'cycles',
  'reachable-exports',
  'affected-files',
  'candidate-tests',
  'no-known-tests',
  'limitations',
];

function resultFixture(): ChangeReviewResult {
  const counts = Object.fromEntries(SECTIONS.map((section) => [section, {
    totalCount: 1,
    retainedCount: 1,
    truncated: false,
    truncatedAtDepth: false,
  }])) as ChangeReviewResult['counts'];

  return {
    schemaVersion: 1,
    baseCommit: BASE_COMMIT,
    baseTreeId: BASE_TREE,
    workingTreeFingerprint: 'c'.repeat(64),
    userConfigurationFingerprint: 'd'.repeat(64),
    effectiveBaselineFingerprint: 'e'.repeat(64),
    workingTreeScanId: 41,
    traversalDepth: 5,
    fileChanges: [{
      itemType: 'file',
      stableKey: 'file-1',
      relativePath: 'core.ts',
      oldPath: null,
      copiedFrom: null,
      changeType: 'modified',
      staged: true,
      unstaged: true,
      untracked: false,
      similarity: null,
      language: 'typescript',
    }],
    edgeChanges: [{
      itemType: 'edge',
      stableKey: 'edge-1',
      direction: 'added',
      fromPath: 'core.ts',
      toPath: 'feature.ts',
      edgeType: 'import',
      typeOnly: false,
      sourceLines: [2],
      specifiers: ['./feature'],
    }],
    findingChanges: [{
      itemType: 'finding',
      stableKey: 'finding-1',
      direction: 'introduced',
      finding: {
        findingType: 'complexity-hotspot',
        severity: 'medium',
        title: 'Possible complexity impact',
        description: 'Project-controlled description is deliberately not report source.',
        relatedNodeIds: ['file:feature.ts'],
        details: {} as never,
        fingerprint: 'finding-fingerprint',
        dismissed: false,
      },
    }],
    architectureChanges: [{
      itemType: 'architecture-violation',
      stableKey: 'architecture-1',
      direction: 'introduced',
      ruleId: 9,
      ruleFingerprint: 'rule-fingerprint',
      sourcePath: 'feature.ts',
      targetPath: 'core.ts',
      severity: 'high',
      line: 4,
    }],
    cycleChanges: [{
      itemType: 'cycle',
      stableKey: 'cycle-1',
      direction: 'added',
      memberPaths: ['core.ts', 'feature.ts'],
      cyclePath: ['core.ts', 'feature.ts', 'core.ts'],
    }],
    exportChanges: [{
      itemType: 'reachable-export',
      stableKey: 'export-1',
      direction: 'added',
      entryPoint: 'core.ts',
      exportedName: 'feature',
      symbolKind: 'function',
      originPath: 'feature.ts',
      line: 3,
    }],
    affectedFiles: [{
      itemType: 'affected-file',
      stableKey: 'affected-1',
      destinationPath: 'feature.ts',
      depth: 1,
      direct: true,
      originPaths: ['core.ts'],
      baselinePresent: true,
      targetPresent: true,
      explanations: [{
        side: 'target',
        originPath: 'core.ts',
        path: ['core.ts', 'feature.ts'],
        edgeTypes: ['import'],
      }],
    }],
    candidateTests: [{
      itemType: 'candidate-test',
      stableKey: 'candidate-test-1',
      destinationPath: 'app.test.ts',
      depth: 2,
      direct: false,
      originPaths: ['core.ts'],
      baselinePresent: false,
      targetPresent: true,
      explanations: [{
        side: 'target',
        originPath: 'core.ts',
        path: ['core.ts', 'feature.ts', 'app.test.ts'],
        edgeTypes: ['import', 'import'],
      }],
    }],
    noKnownTests: [{
      itemType: 'no-known-test',
      stableKey: 'no-test-1',
      changedPath: 'orphan.ts',
    }],
    limitations: [{
      itemType: 'limitation',
      stableKey: 'limitation-1',
      scope: 'review',
      code: 'STATIC_ANALYSIS_ONLY',
      message: 'Runtime behavior was not evaluated.',
      paths: ['feature.ts'],
      omittedCount: 0,
    }],
    graphEvidence: {
      nodePaths: ['app.test.ts', 'core.ts', 'feature.ts'],
      edges: [
        { fromPath: 'core.ts', toPath: 'feature.ts', edgeType: 'import', side: 'target' },
        { fromPath: 'feature.ts', toPath: 'app.test.ts', edgeType: 'import', side: 'target' },
      ],
    },
    counts,
  };
}

function context(overrides: Partial<ChangeReviewRenderContext> = {}): ChangeReviewRenderContext {
  return {
    freshness: 'current',
    staleReasons: [],
    generatedAt: '2026-08-29T12:34:56.000Z',
    ...overrides,
  };
}

function allRendered(result = resultFixture(), renderContext = context()): Record<ReviewExportFormat, string> {
  return Object.fromEntries(FORMATS.map((format) => [
    format,
    renderChangeReview(result, renderContext, format),
  ])) as Record<ReviewExportFormat, string>;
}

describe('renderChangeReview', () => {
  it('reports equivalent base, target, counts, categories, deltas, and shortest paths in every format', () => {
    const rendered = allRendered();

    for (const output of Object.values(rendered)) {
      expect(output).toContain(BASE_COMMIT);
      expect(output).toContain(BASE_TREE);
      expect(output.toLowerCase()).toContain('working tree');
      expect(output).toContain('core.ts');
      expect(output).toContain('feature.ts');
      expect(output).toContain('app.test.ts');
      expect(output).toContain('STATIC_ANALYSIS_ONLY');
      for (const section of SECTIONS) expect(output).toContain(section);
      expect(output.toLowerCase()).toContain('candidate test');
      expect(output.toLowerCase()).toContain('possible impact');
      expect(output.toLowerCase()).toContain('static analysis result');
    }

    const parsed = JSON.parse(rendered.json) as {
      reportVersion: number;
      metadata: { generatedAt: string };
      review: { freshness: string; traversalDepth: number };
      categories: Array<{ section: string; totalCount: number; retainedCount: number }>;
      candidateTests: Array<{ explanations: Array<{ path: string[] }> }>;
    };
    expect(parsed.reportVersion).toBe(1);
    expect(parsed.metadata.generatedAt).toBe(context().generatedAt);
    expect(parsed.review).toMatchObject({ freshness: 'current', traversalDepth: 5 });
    expect(parsed.categories).toHaveLength(10);
    expect(parsed.categories.every((category) => (
      category.totalCount === 1 && category.retainedCount === 1
    ))).toBe(true);
    expect(parsed.candidateTests[0]?.explanations[0]?.path).toEqual([
      'core.ts', 'feature.ts', 'app.test.ts',
    ]);
  });

  it('orders JSON object fields and retained arrays deterministically by stable key', () => {
    const result = resultFixture();
    result.fileChanges.push({
      ...result.fileChanges[0]!,
      stableKey: 'aaa-file',
      relativePath: 'alpha.ts',
    });
    result.fileChanges[0] = { ...result.fileChanges[0]!, stableKey: 'zzz-file' };
    result.counts.files = {
      totalCount: 2, retainedCount: 2, truncated: false, truncatedAtDepth: false,
    };

    const first = renderChangeReview(result, context(), 'json');
    const second = renderChangeReview(result, context(), 'json');
    const parsed = JSON.parse(first) as { fileChanges: Array<{ stableKey: string }> };

    expect(first).toBe(second);
    expect(Object.keys(JSON.parse(first) as object)).toEqual([
      'reportVersion', 'metadata', 'review', 'categories', 'fileChanges', 'edgeChanges',
      'findingChanges', 'architectureChanges', 'cycleChanges', 'exportChanges',
      'affectedFiles', 'candidateTests', 'noKnownTests', 'limitations',
    ]);
    expect(parsed.fileChanges.map((item) => item.stableKey)).toEqual(['aaa-file', 'zzz-file']);
    expect(first).not.toContain('reviewId');
    expect(first).not.toContain('completedAt');
  });

  it('distinguishes current output from unavoidable stale warnings with reason codes', () => {
    for (const output of Object.values(allRendered())) {
      expect(output).toMatch(/freshness[^\n<]*current/i);
      expect(output).not.toMatch(/warning[^\n<]*stale/i);
    }

    const stale = allRendered(resultFixture(), context({
      freshness: 'stale',
      staleReasons: ['WORKING_TREE_CHANGED', 'BASE_COMMIT_CHANGED'],
    }));
    for (const output of Object.values(stale)) {
      expect(output).toMatch(/warning/i);
      expect(output).toMatch(/stale/i);
      expect(output).toContain('WORKING_TREE_CHANGED');
      expect(output).toContain('BASE_COMMIT_CHANGED');
    }
  });

  it('reports unavailable and truncated categories without optimistic empty claims', () => {
    const result = resultFixture();
    delete (result.counts as Partial<ChangeReviewResult['counts']>).edges;
    result.counts.findings = {
      totalCount: 8,
      retainedCount: 1,
      truncated: true,
      truncatedAtDepth: true,
    };

    for (const output of Object.values(allRendered(result))) {
      expect(output).toMatch(/edges.{0,80}(unavailable|false)/is);
      expect(output).toMatch(/findings.{0,160}8.{0,160}1/is);
      expect(output).toMatch(/truncat/is);
      expect(output.toLowerCase()).not.toContain('safe');
      expect(output.toLowerCase()).not.toContain('sufficient');
    }
  });

  it('emits relative analysis evidence only and never includes source or injected roots', () => {
    const result = resultFixture() as ChangeReviewResult & { sourceText?: string; rootPath?: string };
    result.sourceText = 'DO_NOT_RENDER_SOURCE_TEXT';
    result.rootPath = 'C:\\private\\absolute-root';
    result.fileChanges[0] = { ...result.fileChanges[0]!, relativePath: 'C:\\private\\core.ts' };
    result.limitations[0] = {
      ...result.limitations[0]!,
      message: 'See /tmp/private-review and token=secret-value',
    };

    for (const output of Object.values(allRendered(result))) {
      expect(output).not.toContain('DO_NOT_RENDER_SOURCE_TEXT');
      expect(output).not.toContain('C:\\private');
      expect(output).not.toContain('/tmp/private-review');
      expect(output).not.toContain('secret-value');
    }
  });

  it('escapes pipes and newlines in Markdown table cells', () => {
    const result = resultFixture();
    result.findingChanges[0]!.finding.title = 'Finding | title\ncontinued';
    result.affectedFiles[0]!.destinationPath = 'feature|part\n.ts';

    const markdown = renderChangeReview(result, context(), 'markdown');

    expect(markdown).toContain('Finding \\| title continued');
    expect(markdown).toContain('feature\\|part .ts');
  });

  it('escapes hostile HTML strings and includes no executable or remote assets', () => {
    const result = resultFixture();
    result.findingChanges[0]!.finding.title = '</title><script>bad()</script>';
    result.affectedFiles[0]!.destinationPath = 'feature<script>.ts';
    result.limitations[0] = {
      ...result.limitations[0]!,
      message: '<img src=x onerror=bad()> https://example.invalid/style.css',
    };

    const html = renderChangeReview(result, context(), 'html');

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('feature&lt;script&gt;.ts');
    expect(html).toContain('&lt;img src=x onerror=bad()&gt;');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link[^>]+href/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).toContain('color-scheme: light dark');
    expect(html).toContain('prefers-color-scheme: dark');
  });
});

describe('reviewFileExtension', () => {
  it('returns the exact extension for every review format', () => {
    expect(reviewFileExtension('text')).toBe('.txt');
    expect(reviewFileExtension('json')).toBe('.json');
    expect(reviewFileExtension('markdown')).toBe('.md');
    expect(reviewFileExtension('html')).toBe('.html');
  });
});
