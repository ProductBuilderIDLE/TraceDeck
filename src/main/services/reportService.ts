import type {
  ArchitectureViolationDetails,
  CycleDetails,
  DashboardStats,
  Finding,
  Project,
  ReportConfiguration,
  ReportSection,
  TypeErrorDetails,
  UnresolvedImportDetails,
  UnusedExportDetails,
} from '@shared/types';
import { PRIVACY_NOTICE } from '@shared/constants';
import type { DataStore } from '../db';
import type { AnalysisService } from './analysisService';

export interface ReportBundle {
  title: string;
  generatedAt: string;
  project: { name: string; rootPath: string };
  scope: ReportConfiguration['scope'];
  sections: ReportSection[];
  stats: DashboardStats;
  findings: Record<string, Finding[]>;
  limitations: string[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escapes the characters that would break out of a Markdown table cell. */
function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function matchesScope(finding: Finding, scope: ReportConfiguration['scope']): boolean {
  if (scope.kind === 'project') return true;
  if (scope.kind === 'finding-type') return finding.findingType === scope.findingType;

  if (scope.kind === 'file') {
    return finding.relatedNodeIds.some((id) => id.includes(scope.filePath));
  }

  return finding.relatedNodeIds.some((id) => id === `symbol:${scope.filePath}#${scope.symbolName}`);
}

export function collectReportData(
  store: DataStore,
  analysis: AnalysisService,
  project: Project,
  configuration: ReportConfiguration,
): ReportBundle {
  const stats = analysis.dashboardStats(project);
  const all = store.findings.list(project.id, { includeDismissed: false });
  const scoped = all.filter((finding) => matchesScope(finding, configuration.scope));

  const grouped: Record<string, Finding[]> = {
    'circular-dependency': [],
    'unused-export-candidate': [],
    'architecture-violation': [],
    'unresolved-import': [],
    'type-error': [],
  };
  for (const finding of scoped) {
    grouped[finding.findingType]?.push(finding);
  }

  return {
    title: configuration.title,
    generatedAt: new Date().toISOString(),
    project: { name: project.name, rootPath: project.rootPath },
    scope: configuration.scope,
    sections: configuration.sections,
    stats,
    findings: grouped,
    limitations: stats.lastScan?.summary?.limitations ?? [],
  };
}

function describeScope(scope: ReportConfiguration['scope']): string {
  switch (scope.kind) {
    case 'project':
      return 'Whole project';
    case 'file':
      return `File: ${scope.filePath}`;
    case 'symbol':
      return `Symbol: ${scope.filePath}#${scope.symbolName}`;
    case 'finding-type':
      return `Finding type: ${scope.findingType}`;
  }
}

const DISCLAIMER =
  'These are static analysis results produced locally on this machine. They describe what ' +
  'the import graph shows, not what the code does at runtime. Results marked as candidates ' +
  'need human review before any code is removed or changed.';

export function renderMarkdown(bundle: ReportBundle): string {
  const lines: string[] = [];
  const has = (section: ReportSection): boolean => bundle.sections.includes(section);

  lines.push(`# ${bundle.title}`, '');
  lines.push(`- **Project:** ${bundle.project.name}`);
  lines.push(`- **Root:** \`${bundle.project.rootPath}\``);
  lines.push(`- **Scope:** ${describeScope(bundle.scope)}`);
  lines.push(`- **Generated:** ${bundle.generatedAt}`);
  lines.push(`- **Privacy:** ${PRIVACY_NOTICE}`);
  lines.push('', `> ${DISCLAIMER}`, '');

  if (has('summary')) {
    const stats = bundle.stats;
    lines.push('## Summary', '');
    lines.push('| Metric | Value |', '| --- | ---: |');
    lines.push(`| Project files | ${stats.totalFiles} |`);
    lines.push(`| Graph source files | ${stats.graphEligibleFiles} |`);
    lines.push(`| Symbols | ${stats.totalSymbols} |`);
    lines.push(`| Graph edges | ${stats.totalEdges} |`);
    lines.push(`| Circular dependencies | ${stats.cycleCount} |`);
    lines.push(`| Unused export candidates | ${stats.unusedExportCandidateCount} |`);
    lines.push(`| Architecture violations | ${stats.architectureViolationCount} |`);
    lines.push(`| Unresolved imports | ${stats.unresolvedImportCount} |`);
    lines.push('');
  }

  if (has('top-impact-files') && bundle.stats.topImpactFiles.length > 0) {
    lines.push('## Files by change impact score', '');
    lines.push('| File | Score |', '| --- | ---: |');
    for (const entry of bundle.stats.topImpactFiles) {
      lines.push(`| \`${escapeMarkdownCell(entry.path)}\` | ${entry.score} |`);
    }
    lines.push('', `_${bundle.stats.topImpactFiles[0]?.formulaDescription ?? ''}_`, '');
  }

  if (has('cycles')) {
    const cycles = bundle.findings['circular-dependency'] ?? [];
    lines.push(`## Circular dependencies (${cycles.length})`, '');
    if (cycles.length === 0) {
      lines.push('No import cycles were detected among resolved imports.', '');
    }
    for (const finding of cycles) {
      const details = finding.details as CycleDetails;
      lines.push(`### ${finding.title}`, '');
      lines.push('```');
      lines.push(details.cyclePath.join('\n  -> '));
      lines.push('```', '');
    }
  }

  if (has('unused-exports')) {
    const candidates = bundle.findings['unused-export-candidate'] ?? [];
    lines.push(`## Unused export candidates (${candidates.length})`, '');
    lines.push(
      'Static analysis found no resolved import of these exported symbols inside the project. ' +
        'They may still be used by consumers this scan cannot see.',
      '',
    );
    if (candidates.length > 0) {
      lines.push('| Symbol | Kind | Location | Caveats |', '| --- | --- | --- | --- |');
      for (const finding of candidates) {
        const details = finding.details as UnusedExportDetails;
        lines.push(
          `| \`${escapeMarkdownCell(details.symbolName)}\` | ${details.symbolKind} | ` +
            `\`${escapeMarkdownCell(details.filePath)}:${details.line}\` | ` +
            `${escapeMarkdownCell(details.caveats.join(' ') || '—')} |`,
        );
      }
      lines.push('');
    }
  }

  if (has('architecture-violations')) {
    const violations = bundle.findings['architecture-violation'] ?? [];
    lines.push(`## Architecture rule violations (${violations.length})`, '');
    if (violations.length > 0) {
      lines.push('| Rule | From | To | Line |', '| --- | --- | --- | ---: |');
      for (const finding of violations) {
        const details = finding.details as ArchitectureViolationDetails;
        lines.push(
          `| ${escapeMarkdownCell(details.ruleName)} | \`${escapeMarkdownCell(details.sourcePath)}\` | ` +
            `\`${escapeMarkdownCell(details.targetPath)}\` | ${details.line ?? '—'} |`,
        );
      }
      lines.push('');
    } else {
      lines.push('No enabled rule was violated.', '');
    }
  }

  if (has('unresolved-imports')) {
    const unresolved = bundle.findings['unresolved-import'] ?? [];
    lines.push(`## Unresolved imports (${unresolved.length})`, '');
    if (unresolved.length > 0) {
      lines.push('| File | Specifier | Reason |', '| --- | --- | --- |');
      for (const finding of unresolved) {
        const details = finding.details as UnresolvedImportDetails;
        lines.push(
          `| \`${escapeMarkdownCell(details.filePath)}\` | \`${escapeMarkdownCell(details.specifier)}\` | ` +
            `${details.reason} |`,
        );
      }
      lines.push('');
    }
  }

  if (has('type-errors')) {
    const typeErrors = bundle.findings['type-error'] ?? [];
    lines.push(`## Type errors (${typeErrors.length})`, '');
    lines.push(
      'Reported by the TypeScript compiler itself. Unlike the rest of this report, these are ' +
        'real compile errors rather than observations about the dependency graph.',
      '',
    );
    if (typeErrors.length > 0) {
      lines.push('| Code | Location | Message |', '| --- | --- | --- |');
      for (const finding of typeErrors) {
        const details = finding.details as TypeErrorDetails;
        const location = details.filePath
          ? `${details.filePath}${details.line !== null ? `:${details.line}` : ''}`
          : 'project';
        lines.push(
          `| TS${details.code} | \`${escapeMarkdownCell(location)}\` | ` +
            `${escapeMarkdownCell(details.message)} |`,
        );
      }
      lines.push('');
    } else {
      lines.push('No type errors were reported, or type checking was not enabled.', '');
    }
  }

  if (has('blast-radius') && bundle.stats.topImpactFiles.length > 0) {
    lines.push('## Blast radius of high-impact files', '');
    lines.push(
      'These scores count dependents, cycles, and missing tests. They rank connectivity in this ' +
        'repository; they are not a measurement of defect risk.',
      '',
    );
    lines.push('| File | Score | Percentile |', '| --- | ---: | ---: |');
    for (const entry of bundle.stats.topImpactFiles) {
      lines.push(
        `| \`${escapeMarkdownCell(entry.path)}\` | ${entry.score} | ${entry.percentile} |`,
      );
    }
    lines.push('');
  }

  if (has('changed-since-scan')) {
    const comparison = bundle.stats.scanComparison;
    lines.push('## Impact of findings changed since the previous scan', '');
    if (!comparison || comparison.previousScanId === null) {
      lines.push('No previous scan is stored to compare against.', '');
    } else {
      lines.push(
        `${comparison.added} finding(s) appeared, ${comparison.removed} disappeared, and ` +
          `${comparison.persisted} stayed the same.`,
        '',
      );
      if (comparison.addedTitles.length > 0) {
        lines.push('Newly reported:', '');
        for (const title of comparison.addedTitles) lines.push(`- ${title}`);
        lines.push('');
      }
      if (comparison.removedTitles.length > 0) {
        lines.push('No longer reported:', '');
        for (const title of comparison.removedTitles) lines.push(`- ${title}`);
        lines.push('');
      }
    }
  }

  if (has('limitations')) {
    lines.push('## Analysis limitations', '');
    if (bundle.limitations.length === 0) {
      lines.push('No limitations were recorded for this scan.', '');
    } else {
      for (const limitation of bundle.limitations) lines.push(`- ${limitation}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function renderJson(bundle: ReportBundle): string {
  return JSON.stringify(
    {
      title: bundle.title,
      generatedAt: bundle.generatedAt,
      privacy: PRIVACY_NOTICE,
      disclaimer: DISCLAIMER,
      project: bundle.project,
      scope: bundle.scope,
      summary: {
        totalFiles: bundle.stats.totalFiles,
        graphEligibleFiles: bundle.stats.graphEligibleFiles,
        totalSymbols: bundle.stats.totalSymbols,
        totalEdges: bundle.stats.totalEdges,
        cycleCount: bundle.stats.cycleCount,
        unusedExportCandidateCount: bundle.stats.unusedExportCandidateCount,
        architectureViolationCount: bundle.stats.architectureViolationCount,
        unresolvedImportCount: bundle.stats.unresolvedImportCount,
        typeErrorCount: bundle.stats.typeErrorCount,
      },
      topImpactFiles: bundle.stats.topImpactFiles,
      findings: bundle.findings,
      limitations: bundle.limitations,
      scanComparison: bundle.stats.scanComparison,
    },
    null,
    2,
  );
}

/**
 * Renders a standalone HTML report.
 *
 * Everything is inlined: no stylesheet link, no script, no font or image URL. The file can be
 * opened from disk or emailed to a colleague without ever reaching the network, which is the
 * same guarantee the app itself makes.
 */
export function renderHtml(bundle: ReportBundle): string {
  const has = (section: ReportSection): boolean => bundle.sections.includes(section);
  const parts: string[] = [];

  const table = (headers: string[], rows: string[][]): string => {
    if (rows.length === 0) return '<p class="empty">Nothing to report.</p>';
    return [
      '<table>',
      `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`,
      '<tbody>',
      ...rows.map(
        (row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`,
      ),
      '</tbody></table>',
    ].join('');
  };

  if (has('summary')) {
    const s = bundle.stats;
    parts.push('<section><h2>Summary</h2>');
    parts.push(
      '<div class="grid">' +
        [
          ['Project files', s.totalFiles],
          ['Graph source files', s.graphEligibleFiles],
          ['Symbols', s.totalSymbols],
          ['Graph edges', s.totalEdges],
          ['Circular dependencies', s.cycleCount],
          ['Unused export candidates', s.unusedExportCandidateCount],
          ['Architecture violations', s.architectureViolationCount],
          ['Unresolved imports', s.unresolvedImportCount],
        ]
          .map(
            ([label, value]) =>
              `<div class="stat"><span class="value">${escapeHtml(String(value))}</span>` +
              `<span class="label">${escapeHtml(String(label))}</span></div>`,
          )
          .join('') +
        '</div></section>',
    );
  }

  if (has('top-impact-files')) {
    parts.push('<section><h2>Files by change impact score</h2>');
    parts.push(
      table(
        ['File', 'Score'],
        bundle.stats.topImpactFiles.map((entry) => [entry.path, String(entry.score)]),
      ),
    );
    parts.push(
      `<p class="note">${escapeHtml(bundle.stats.topImpactFiles[0]?.formulaDescription ?? '')}</p>`,
    );
    parts.push('</section>');
  }

  if (has('cycles')) {
    const cycles = bundle.findings['circular-dependency'] ?? [];
    parts.push(`<section><h2>Circular dependencies (${cycles.length})</h2>`);
    for (const finding of cycles) {
      const details = finding.details as CycleDetails;
      parts.push(
        `<h3>${escapeHtml(finding.title)}</h3><pre>${escapeHtml(details.cyclePath.join('\n  -> '))}</pre>`,
      );
    }
    if (cycles.length === 0) parts.push('<p class="empty">No import cycles were detected.</p>');
    parts.push('</section>');
  }

  if (has('unused-exports')) {
    const candidates = bundle.findings['unused-export-candidate'] ?? [];
    parts.push(`<section><h2>Unused export candidates (${candidates.length})</h2>`);
    parts.push(
      '<p class="note">Static analysis found no resolved import of these exported symbols ' +
        'inside the project. They may still be used by consumers this scan cannot see.</p>',
    );
    parts.push(
      table(
        ['Symbol', 'Kind', 'Location', 'Caveats'],
        candidates.map((finding) => {
          const details = finding.details as UnusedExportDetails;
          return [
            details.symbolName,
            details.symbolKind,
            `${details.filePath}:${details.line}`,
            details.caveats.join(' ') || '—',
          ];
        }),
      ),
    );
    parts.push('</section>');
  }

  if (has('architecture-violations')) {
    const violations = bundle.findings['architecture-violation'] ?? [];
    parts.push(`<section><h2>Architecture rule violations (${violations.length})</h2>`);
    parts.push(
      table(
        ['Rule', 'From', 'To', 'Line'],
        violations.map((finding) => {
          const details = finding.details as ArchitectureViolationDetails;
          return [
            details.ruleName,
            details.sourcePath,
            details.targetPath,
            String(details.line ?? '—'),
          ];
        }),
      ),
    );
    parts.push('</section>');
  }

  if (has('unresolved-imports')) {
    const unresolved = bundle.findings['unresolved-import'] ?? [];
    parts.push(`<section><h2>Unresolved imports (${unresolved.length})</h2>`);
    parts.push(
      table(
        ['File', 'Specifier', 'Reason'],
        unresolved.map((finding) => {
          const details = finding.details as UnresolvedImportDetails;
          return [details.filePath, details.specifier, details.reason];
        }),
      ),
    );
    parts.push('</section>');
  }

  if (has('type-errors')) {
    const typeErrors = bundle.findings['type-error'] ?? [];
    parts.push(`<section><h2>Type errors (${typeErrors.length})</h2>`);
    parts.push(
      '<p class="note">Reported by the TypeScript compiler itself. Unlike the rest of this ' +
        'report, these are real compile errors rather than observations about the dependency ' +
        'graph.</p>',
    );
    parts.push(
      table(
        ['Code', 'Location', 'Message'],
        typeErrors.map((finding) => {
          const details = finding.details as TypeErrorDetails;
          const location = details.filePath
            ? `${details.filePath}${details.line !== null ? `:${details.line}` : ''}`
            : 'project';
          return [`TS${details.code}`, location, details.message];
        }),
      ),
    );
    parts.push('</section>');
  }

  if (has('blast-radius') && bundle.stats.topImpactFiles.length > 0) {
    parts.push('<section><h2>Blast radius of high-impact files</h2>');
    parts.push(
      '<p class="note">These scores count dependents, cycles, and missing tests. They rank ' +
        'connectivity in this repository; they are not a measurement of defect risk.</p>',
    );
    parts.push(
      table(
        ['File', 'Score', 'Percentile'],
        bundle.stats.topImpactFiles.map((entry) => [
          entry.path,
          String(entry.score),
          String(entry.percentile),
        ]),
      ),
    );
    parts.push('</section>');
  }

  if (has('changed-since-scan')) {
    const comparison = bundle.stats.scanComparison;
    parts.push('<section><h2>Impact of findings changed since the previous scan</h2>');
    if (!comparison || comparison.previousScanId === null) {
      parts.push('<p class="empty">No previous scan is stored to compare against.</p>');
    } else {
      parts.push(
        `<p>${escapeHtml(String(comparison.added))} finding(s) appeared, ` +
          `${escapeHtml(String(comparison.removed))} disappeared, and ` +
          `${escapeHtml(String(comparison.persisted))} stayed the same.</p>`,
      );
      if (comparison.addedTitles.length > 0) {
        parts.push(
          `<p class="note">Newly reported</p><ul>${comparison.addedTitles
            .map((title) => `<li>${escapeHtml(title)}</li>`)
            .join('')}</ul>`,
        );
      }
      if (comparison.removedTitles.length > 0) {
        parts.push(
          `<p class="note">No longer reported</p><ul>${comparison.removedTitles
            .map((title) => `<li>${escapeHtml(title)}</li>`)
            .join('')}</ul>`,
        );
      }
    }
    parts.push('</section>');
  }

  if (has('limitations')) {
    parts.push('<section><h2>Analysis limitations</h2>');
    parts.push(
      bundle.limitations.length === 0
        ? '<p class="empty">No limitations were recorded for this scan.</p>'
        : `<ul>${bundle.limitations.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
    );
    parts.push('</section>');
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(bundle.title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --panel: #f6f7f9; --border: #e2e5ea;
    --text: #1a1d23; --muted: #5b6472; --accent: #2f6fc4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0e14; --panel: #11151d; --border: #2c3442;
      --text: #e6e9ef; --muted: #9aa4b5; --accent: #4f9cf9;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.5rem; background: var(--bg); color: var(--text);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 68rem; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 0.5rem; }
  h2 { font-size: 1.1rem; margin: 2.5rem 0 0.75rem; padding-bottom: 0.4rem;
       border-bottom: 1px solid var(--border); }
  h3 { font-size: 0.95rem; margin: 1.25rem 0 0.4rem; }
  dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 1rem; margin: 0 0 1.25rem; }
  dl.meta dt { color: var(--muted); }
  dl.meta dd { margin: 0; }
  .disclaimer { background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
                padding: 0.85rem 1rem; color: var(--muted); margin: 0 0 1rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: 0.75rem; }
  .stat { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 0.85rem; }
  .stat .value { display: block; font-size: 1.5rem; font-weight: 600; }
  .stat .label { display: block; color: var(--muted); font-size: 0.8rem; }
  table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; font-size: 0.86rem; }
  th, td { text-align: left; padding: 0.5rem 0.65rem; border-bottom: 1px solid var(--border);
           vertical-align: top; word-break: break-word; }
  th { color: var(--muted); font-weight: 600; }
  pre { background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
        padding: 0.85rem; overflow-x: auto; font-size: 0.82rem; }
  code, pre, td:first-child { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .note, .empty { color: var(--muted); font-size: 0.86rem; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border);
           color: var(--muted); font-size: 0.8rem; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(bundle.title)}</h1>
<dl class="meta">
  <dt>Project</dt><dd>${escapeHtml(bundle.project.name)}</dd>
  <dt>Root</dt><dd><code>${escapeHtml(bundle.project.rootPath)}</code></dd>
  <dt>Scope</dt><dd>${escapeHtml(describeScope(bundle.scope))}</dd>
  <dt>Generated</dt><dd>${escapeHtml(bundle.generatedAt)}</dd>
</dl>
<p class="disclaimer">${escapeHtml(DISCLAIMER)}</p>
${parts.join('\n')}
<footer>${escapeHtml(PRIVACY_NOTICE)} This report was generated locally and contains no remote assets.</footer>
</main>
</body>
</html>`;
}

export function renderReport(bundle: ReportBundle, format: ReportConfiguration['format']): string {
  if (format === 'markdown') return renderMarkdown(bundle);
  if (format === 'json') return renderJson(bundle);
  return renderHtml(bundle);
}

export function reportFileExtension(format: ReportConfiguration['format']): string {
  if (format === 'markdown') return '.md';
  if (format === 'json') return '.json';
  return '.html';
}
