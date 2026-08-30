import type {
  ChangeReviewResult,
  ReviewCategoryCount,
  ReviewExportFormat,
  ReviewFreshness,
  ReviewImpactItem,
  ReviewSection,
} from '@shared/changeReview';

export interface ChangeReviewRenderContext {
  freshness: ReviewFreshness;
  staleReasons: string[];
  generatedAt: string;
}

interface ReviewCategoryReport extends ReviewCategoryCount {
  section: ReviewSection;
  available: boolean;
}

interface ChangeReviewReportModel {
  reportVersion: 1;
  metadata: { generatedAt: string };
  review: {
    freshness: ReviewFreshness;
    staleReasons: string[];
    warning: string | null;
    base: { label: 'HEAD'; commit: string; tree: string | null };
    target: { label: 'working tree'; fingerprint: string };
    traversalDepth: number;
    guidance: string;
  };
  categories: ReviewCategoryReport[];
  fileChanges: Array<Record<string, unknown>>;
  edgeChanges: Array<Record<string, unknown>>;
  findingChanges: Array<Record<string, unknown>>;
  architectureChanges: Array<Record<string, unknown>>;
  cycleChanges: Array<Record<string, unknown>>;
  exportChanges: Array<Record<string, unknown>>;
  affectedFiles: Array<Record<string, unknown>>;
  candidateTests: Array<Record<string, unknown>>;
  noKnownTests: Array<Record<string, unknown>>;
  limitations: Array<Record<string, unknown>>;
}

const REPORT_VERSION = 1 as const;
const REVIEW_SECTIONS: readonly ReviewSection[] = [
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
const GUIDANCE =
  'This static analysis result describes possible impact only. Candidate tests and structural ' +
  'changes require human review; they do not establish runtime behavior or test sufficiency.';
const INVALID_RELATIVE_PATH = '[invalid relative path]';

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finiteCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, 'g');
// Intentionally removes ASCII control characters from rendered reports.
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Removes machine paths, URLs, controls, and common credential assignments from prose. */
function sanitizeText(value: string): string {
  return value
    .replace(ANSI_PATTERN, '')
    .replace(/https?:\/\/[^\s<>'"]+/gi, '[remote URL removed]')
    .replace(/\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '[credential removed]')
    .replace(/\b[A-Za-z]:[\\/][^\s<>'"),;]*/g, '[absolute path removed]')
    .replace(/(^|[\s("'=])\/(?:[^\s<>'"),;]+\/?)+/g, '$1[absolute path removed]')
    .replace(CONTROL_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function relativePath(value: string): string {
  const withoutControls = value
    .replace(CONTROL_PATTERN, ' ')
    .trim()
    .replaceAll('\\', '/');
  if (
    withoutControls.length === 0
    || withoutControls.startsWith('/')
    || withoutControls.startsWith('//')
    || /^[A-Za-z]:($|\/)/.test(withoutControls)
    || /^https?:\/\//i.test(withoutControls)
  ) {
    return INVALID_RELATIVE_PATH;
  }
  const parts = withoutControls.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    return INVALID_RELATIVE_PATH;
  }
  return sanitizeText(withoutControls) || INVALID_RELATIVE_PATH;
}

function relativePaths(values: readonly string[]): string[] {
  return values.map(relativePath);
}

function stableItems<T extends { stableKey: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => compareCodePoints(left.stableKey, right.stableKey));
}

function identifier(value: string): string {
  return sanitizeText(value);
}

function optionalPath(value: string | null): string | null {
  return value === null ? null : relativePath(value);
}

function categoryReports(result: ChangeReviewResult): ReviewCategoryReport[] {
  const partialCounts = result.counts as Partial<Record<ReviewSection, ReviewCategoryCount>>;
  return REVIEW_SECTIONS.map((section) => {
    const count = partialCounts[section];
    return {
      section,
      available: count !== undefined,
      totalCount: finiteCount(count?.totalCount ?? 0),
      retainedCount: finiteCount(count?.retainedCount ?? 0),
      truncated: count?.truncated ?? false,
      truncatedAtDepth: count?.truncatedAtDepth ?? false,
    };
  });
}

function impactItems(items: readonly ReviewImpactItem[]): Array<Record<string, unknown>> {
  return stableItems(items).map((item) => ({
    stableKey: identifier(item.stableKey),
    destinationPath: relativePath(item.destinationPath),
    depth: finiteCount(item.depth),
    direct: item.direct,
    originPaths: relativePaths(item.originPaths),
    baselinePresent: item.baselinePresent,
    targetPresent: item.targetPresent,
    explanations: item.explanations.map((explanation) => ({
      side: explanation.side,
      originPath: relativePath(explanation.originPath),
      path: relativePaths(explanation.path),
      edgeTypes: explanation.edgeTypes.map(identifier),
    })),
  }));
}

function reportModel(
  result: ChangeReviewResult,
  context: ChangeReviewRenderContext,
): ChangeReviewReportModel {
  const staleReasons = [...new Set(context.staleReasons.map(identifier).filter(Boolean))]
    .sort(compareCodePoints);
  const warning = context.freshness === 'current'
    ? null
    : context.freshness === 'stale'
      ? `WARNING: This review is stale (${staleReasons.join(', ') || 'reason unavailable'}). ` +
        'It does not describe the current working tree.'
      : 'WARNING: This review is incompatible and must not be exported.';

  return {
    reportVersion: REPORT_VERSION,
    metadata: { generatedAt: sanitizeText(context.generatedAt) },
    review: {
      freshness: context.freshness,
      staleReasons,
      warning,
      base: {
        label: 'HEAD',
        commit: identifier(result.baseCommit),
        tree: result.baseTreeId === null ? null : identifier(result.baseTreeId),
      },
      target: {
        label: 'working tree',
        fingerprint: identifier(result.workingTreeFingerprint),
      },
      traversalDepth: finiteCount(result.traversalDepth),
      guidance: GUIDANCE,
    },
    categories: categoryReports(result),
    fileChanges: stableItems(result.fileChanges).map((item) => ({
      stableKey: identifier(item.stableKey),
      path: relativePath(item.relativePath),
      oldPath: optionalPath(item.oldPath),
      copiedFrom: optionalPath(item.copiedFrom),
      changeType: item.changeType,
      staged: item.staged,
      unstaged: item.unstaged,
      untracked: item.untracked,
      similarity: item.similarity,
      language: item.language === null ? null : identifier(item.language),
    })),
    edgeChanges: stableItems(result.edgeChanges).map((item) => ({
      stableKey: identifier(item.stableKey),
      direction: item.direction,
      fromPath: relativePath(item.fromPath),
      toPath: relativePath(item.toPath),
      edgeType: item.edgeType,
      typeOnly: item.typeOnly,
      sourceLines: item.sourceLines.map(finiteCount),
      specifiers: item.specifiers.map(identifier),
    })),
    findingChanges: stableItems(result.findingChanges).map((item) => ({
      stableKey: identifier(item.stableKey),
      direction: item.direction,
      findingType: item.finding.findingType,
      severity: item.finding.severity,
      title: sanitizeText(item.finding.title),
    })),
    architectureChanges: stableItems(result.architectureChanges).map((item) => ({
      stableKey: identifier(item.stableKey),
      direction: item.direction,
      sourcePath: relativePath(item.sourcePath),
      targetPath: relativePath(item.targetPath),
      severity: item.severity,
      line: item.line,
    })),
    cycleChanges: stableItems(result.cycleChanges).map((item) => ({
      stableKey: identifier(item.stableKey),
      direction: item.direction,
      memberPaths: relativePaths(item.memberPaths),
      cyclePath: relativePaths(item.cyclePath),
    })),
    exportChanges: stableItems(result.exportChanges).map((item) => ({
      stableKey: identifier(item.stableKey),
      direction: item.direction,
      entryPoint: relativePath(item.entryPoint),
      exportedName: sanitizeText(item.exportedName),
      symbolKind: item.symbolKind,
      originPath: relativePath(item.originPath),
      line: item.line,
    })),
    affectedFiles: impactItems(result.affectedFiles),
    candidateTests: impactItems(result.candidateTests),
    noKnownTests: stableItems(result.noKnownTests).map((item) => ({
      stableKey: identifier(item.stableKey),
      changedPath: relativePath(item.changedPath),
    })),
    limitations: stableItems(result.limitations).map((item) => ({
      stableKey: identifier(item.stableKey),
      scope: item.scope,
      code: identifier(item.code),
      message: sanitizeText(item.message),
      paths: relativePaths(item.paths),
      omittedCount: finiteCount(item.omittedCount),
    })),
  };
}

function display(value: unknown): string {
  if (value === null) return 'not recorded';
  if (Array.isArray(value)) return value.map((item) => display(item)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function renderText(model: ChangeReviewReportModel): string {
  const lines = [
    'TraceDeck change review',
    `Generated: ${model.metadata.generatedAt}`,
    `Freshness: ${model.review.freshness}`,
  ];
  if (model.review.warning) lines.push(model.review.warning);
  lines.push(
    `Stale reasons: ${model.review.staleReasons.join(', ') || 'none'}`,
    `Base HEAD commit: ${model.review.base.commit}`,
    `Base HEAD tree: ${model.review.base.tree ?? 'not recorded'}`,
    `Target: ${model.review.target.label}`,
    `Working tree fingerprint: ${model.review.target.fingerprint}`,
    `Traversal depth: ${model.review.traversalDepth}`,
    `Guidance: ${model.review.guidance}`,
    '',
    'Categories:',
  );
  for (const category of model.categories) {
    lines.push(
      `Category ${category.section}: availability=${category.available ? 'available' : 'unavailable'} ` +
      `total=${category.totalCount} retained=${category.retainedCount} ` +
      `truncated=${category.truncated} truncated-at-depth=${category.truncatedAtDepth}`,
    );
  }

  const sections: Array<[string, Array<Record<string, unknown>>]> = [
    ['files', model.fileChanges],
    ['edges', model.edgeChanges],
    ['findings', model.findingChanges],
    ['architecture-violations', model.architectureChanges],
    ['cycles', model.cycleChanges],
    ['reachable-exports', model.exportChanges],
    ['affected-files (possible impact)', model.affectedFiles],
    ['candidate-tests', model.candidateTests],
    ['no-known-tests', model.noKnownTests],
    ['limitations', model.limitations],
  ];
  for (const [name, items] of sections) {
    lines.push('', `${name}:`);
    if (items.length === 0) {
      lines.push('- No retained static analysis result is available for this category.');
      continue;
    }
    for (const item of items) {
      lines.push(`- ${Object.entries(item).map(([key, value]) => `${key}=${display(value)}`).join(' | ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function escapeMarkdownCell(value: unknown): string {
  return display(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function markdownTable(headers: string[], rows: unknown[][]): string[] {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];
  if (rows.length === 0) {
    lines.push(`| ${headers.map((_header, index) => (
      index === 0 ? 'No retained static analysis result' : '—'
    )).join(' | ')} |`);
  } else {
    for (const row of rows) {
      lines.push(`| ${row.map(escapeMarkdownCell).join(' | ')} |`);
    }
  }
  return lines;
}

function objectRows(items: Array<Record<string, unknown>>): unknown[][] {
  return items.map((item) => [item.stableKey, Object.entries(item)
    .filter(([key]) => key !== 'stableKey')
    .map(([key, value]) => `${key}=${display(value)}`)
    .join('; ')]);
}

function renderMarkdown(model: ChangeReviewReportModel): string {
  const lines = [
    '# TraceDeck change review',
    '',
    `- **Generated:** ${escapeMarkdownCell(model.metadata.generatedAt)}`,
    `- **Freshness:** ${model.review.freshness}`,
    `- **Stale reasons:** ${model.review.staleReasons.map(escapeMarkdownCell).join(', ') || 'none'}`,
    `- **Base HEAD commit:** \`${escapeMarkdownCell(model.review.base.commit)}\``,
    `- **Base HEAD tree:** \`${escapeMarkdownCell(model.review.base.tree ?? 'not recorded')}\``,
    `- **Target:** ${model.review.target.label}`,
    `- **Working tree fingerprint:** \`${escapeMarkdownCell(model.review.target.fingerprint)}\``,
    `- **Traversal depth:** ${model.review.traversalDepth}`,
    '',
  ];
  if (model.review.warning) lines.push(`> **${escapeMarkdownCell(model.review.warning)}**`, '');
  lines.push(`> ${model.review.guidance}`, '', '## Category availability and retention', '');
  lines.push(...markdownTable(
    ['Category', 'Availability', 'Total', 'Retained', 'Truncated', 'Truncated at depth'],
    model.categories.map((category) => [
      category.section,
      category.available ? 'available' : 'unavailable',
      category.totalCount,
      category.retainedCount,
      category.truncated,
      category.truncatedAtDepth,
    ]),
  ));

  const sections: Array<[string, string, Array<Record<string, unknown>>]> = [
    ['File deltas', 'files', model.fileChanges],
    ['Edge deltas', 'edges', model.edgeChanges],
    ['Finding deltas', 'findings', model.findingChanges],
    ['Architecture deltas', 'architecture-violations', model.architectureChanges],
    ['Cycle deltas', 'cycles', model.cycleChanges],
    ['Reachable export deltas', 'reachable-exports', model.exportChanges],
    ['Affected files (possible impact)', 'affected-files', model.affectedFiles],
    ['Candidate tests', 'candidate-tests', model.candidateTests],
    ['Changed files with no known tests', 'no-known-tests', model.noKnownTests],
    ['Limitations', 'limitations', model.limitations],
  ];
  for (const [title, category, items] of sections) {
    lines.push('', `## ${title}`, '', `Category: ${category}`, '');
    lines.push(...markdownTable(['Stable key', 'Static analysis result'], objectRows(items)));
  }
  return `${lines.join('\n')}\n`;
}

function escapeHtml(value: unknown): string {
  return display(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlTable(headers: string[], rows: unknown[][]): string {
  const bodyRows = rows.length === 0
    ? `<tr><td>${escapeHtml('No retained static analysis result')}</td>${headers
      .slice(1).map(() => '<td>—</td>').join('')}</tr>`
    : rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
      .join('');
  return '<table><thead><tr>' + headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('') +
    `</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

function renderHtml(model: ChangeReviewReportModel): string {
  const sections: Array<[string, string, Array<Record<string, unknown>>]> = [
    ['File deltas', 'files', model.fileChanges],
    ['Edge deltas', 'edges', model.edgeChanges],
    ['Finding deltas', 'findings', model.findingChanges],
    ['Architecture deltas', 'architecture-violations', model.architectureChanges],
    ['Cycle deltas', 'cycles', model.cycleChanges],
    ['Reachable export deltas', 'reachable-exports', model.exportChanges],
    ['Affected files (possible impact)', 'affected-files', model.affectedFiles],
    ['Candidate tests', 'candidate-tests', model.candidateTests],
    ['Changed files with no known tests', 'no-known-tests', model.noKnownTests],
    ['Limitations', 'limitations', model.limitations],
  ];
  const warning = model.review.warning
    ? `<aside class="warning">${escapeHtml(model.review.warning)}</aside>`
    : '';
  const sectionHtml = sections.map(([title, category, items]) => (
    `<section><h2>${escapeHtml(title)}</h2><p class="category">Category: ${escapeHtml(category)}</p>` +
    `${htmlTable(['Stable key', 'Static analysis result'], objectRows(items))}</section>`
  )).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TraceDeck change review</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --panel: #f4f6f8; --text: #18202b; --border: #ccd3dc; --warning: #8a3500; }
@media (prefers-color-scheme: dark) { :root { --bg: #101419; --panel: #181e26; --text: #e8edf3; --border: #3b4654; --warning: #ffb06f; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; }
main { max-width: 76rem; margin: 0 auto; }
section, aside { margin: 1.25rem 0; padding: 1rem; background: var(--panel); border: 1px solid var(--border); border-radius: .4rem; }
table { width: 100%; border-collapse: collapse; overflow-wrap: anywhere; }
th, td { padding: .45rem; border: 1px solid var(--border); text-align: left; vertical-align: top; }
.warning { color: var(--warning); font-weight: 700; }
.category { font-weight: 600; }
code { overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
<h1>TraceDeck change review</h1>
<p>Generated: ${escapeHtml(model.metadata.generatedAt)}</p>
<p>Freshness: ${escapeHtml(model.review.freshness)}</p>
${warning}
<p>Stale reasons: ${escapeHtml(model.review.staleReasons.join(', ') || 'none')}</p>
<dl>
<dt>Base HEAD commit</dt><dd><code>${escapeHtml(model.review.base.commit)}</code></dd>
<dt>Base HEAD tree</dt><dd><code>${escapeHtml(model.review.base.tree ?? 'not recorded')}</code></dd>
<dt>Target</dt><dd>${escapeHtml(model.review.target.label)}</dd>
<dt>Working tree fingerprint</dt><dd><code>${escapeHtml(model.review.target.fingerprint)}</code></dd>
<dt>Traversal depth</dt><dd>${escapeHtml(model.review.traversalDepth)}</dd>
</dl>
<p>${escapeHtml(model.review.guidance)}</p>
<section><h2>Category availability and retention</h2>${htmlTable(
    ['Category', 'Availability', 'Total', 'Retained', 'Truncated', 'Truncated at depth'],
    model.categories.map((category) => [
      category.section,
      category.available ? 'available' : 'unavailable',
      category.totalCount,
      category.retainedCount,
      category.truncated,
      category.truncatedAtDepth,
    ]),
  )}</section>
${sectionHtml}
</main>
</body>
</html>
`;
}

export function renderChangeReview(
  result: ChangeReviewResult,
  context: ChangeReviewRenderContext,
  format: ReviewExportFormat,
): string {
  const model = reportModel(result, context);
  switch (format) {
    case 'text':
      return renderText(model);
    case 'markdown':
      return renderMarkdown(model);
    case 'json':
      return `${JSON.stringify(model, null, 2)}\n`;
    case 'html':
      return renderHtml(model);
  }
}

export function reviewFileExtension(
  format: ReviewExportFormat,
): '.txt' | '.json' | '.md' | '.html' {
  switch (format) {
    case 'text':
      return '.txt';
    case 'json':
      return '.json';
    case 'markdown':
      return '.md';
    case 'html':
      return '.html';
  }
}
