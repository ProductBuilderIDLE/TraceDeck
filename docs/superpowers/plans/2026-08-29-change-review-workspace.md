# Change Review Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit, cancellable, evidence-backed workspace that compares the current on-disk working tree with `HEAD` and explains structural deltas, possible impact, candidate tests, and analysis limits.

**Architecture:** The Electron main process captures canonical Git status, refreshes the working-tree scan, materializes regular `HEAD` blobs into a verified OS-temporary root, scans that baseline into temporary SQLite, compares normalized snapshots, and atomically persists only the latest completed result. The renderer polls typed `review:*` IPC, requests paginated evidence, and reuses current graph/source/finding destinations only after freshness validation.

**Tech Stack:** Electron 38, Node.js/TypeScript, React 18, Zustand, Tailwind, Cytoscape, SQLite through main-process-only `better-sqlite3`, Vitest, and Playwright 1.62.1 for the new Electron end-to-end harness.

**Spec:** `docs/superpowers/specs/2026-08-29-change-review-workspace-design.md`

## Global Constraints

- Compare only the current on-disk working tree with resolved `HEAD`; accept no arbitrary ref.
- Start only from explicit **Run Review**; opening the workspace performs read-only status work.
- Keep only the latest completed review per project; failed, cancelled, stale, or partial candidates never replace it.
- Never run checkout, reset, clean, worktree, submodule initialization, hooks, smudge filters, external diff, or text-conversion commands.
- Never create or follow symlinks. Reject invalid UTF-8 Git paths and deterministic lowercase path collisions.
- Keep inventory evidence separate from graph-eligible files.
- Keep `better-sqlite3`, Git, filesystem, and temporary paths in the main process.
- Preserve the closed `IpcContract`, preload allowlist, renderer sandbox, guarded source writes, explicit editor unlock, and no-auto-save rule.
- Use code-point-stable ordering before fingerprinting, truncation, pagination, and report rendering.
- Use SHA-256 canonical fingerprints; timestamps and database row IDs are not semantic identity.
- Default traversal depth is 5; maximum is 25.
- Retain at most 2,000 details per category; compute and expose the complete total first.
- Default IPC page size is 100; maximum is 500.
- Bound unified diffs to 2 MiB and 20,000 lines.
- Abort baseline analysis before writing blobs above 100,000 tree entries or 2 GiB total regular-blob content.
- Preserve existing 2 MiB source-analysis and 500 scan-limitation caps.
- Baseline type checking is always disabled in Task 1. Current type errors are context only, never introduced/resolved review evidence.
- Every response array is declared but renderer consumers still use `?? []`.
- Errors crossing IPC contain no project or temporary absolute path.
- Reports contain relative paths and no source text, credentials, remote URLs, or external assets.
- Empty impact/test sets never claim safety or sufficiency.
- No AI, network service, telemetry, test execution, linter behavior, vulnerability analysis, refactoring, or source write is added.
- Every production behavior starts with a focused failing test, then minimal implementation, then focused and broader verification.
- Use `@playwright/test@1.62.1` and `playwright@1.62.1`; both were published more than seven days before this plan.

## File Structure

### Shared contracts

- Create `src/shared/changeReview.ts`: structure-clone-safe review enums, records, result items, status, summary, filters, and pages.
- Modify `src/shared/constants.ts`: review schema, paging, diff, materialization, and temporary-cleanup limits.
- Modify `src/shared/ipc.ts`: exact seven `review:*` request/response mappings and allowlist entries.

### Main-process persistence and infrastructure

- Create `src/main/db/repositories/changeReviewRepository.ts`: latest-only transactional review persistence.
- Modify `src/main/db/migrations.ts`, `src/main/db/rows.ts`, and `src/main/db/index.ts`: migration 4 and repository wiring.
- Create `src/main/services/changeReview/canonical.ts`: code-point comparator, canonical object-key serialization, and SHA-256 helpers.
- Create `src/main/services/changeReview/gitProcess.ts`: cancellable streaming Git process runner with command timeouts.
- Create `src/main/services/changeReview/gitStatus.ts`: porcelain-v2 parser, HEAD resolution, working-tree hashing, and bounded diff.
- Create `src/main/services/changeReview/materializer.ts`: tree preflight, batch blob extraction, marker verification, and safe cleanup.
- Create `src/main/services/changeReview/snapshot.ts`: normalized inventory/graph/finding/cycle/export snapshot extraction.
- Create `src/main/analysis/algorithms/reachableExports.ts`: deterministic configured/manifest entry-point export surface.
- Create `src/main/analysis/algorithms/reviewComparator.ts`: stable structural deltas and category truncation.
- Create `src/main/analysis/algorithms/reviewImpact.ts`: provenance-preserving baseline/target multi-source BFS.
- Create `src/main/services/projectOperations.ts`: shared scan/review project-operation lease and deferred watcher state.
- Create `src/main/services/changeReview/coordinator.ts`: complete review state machine and freshness validation.
- Create `src/main/services/changeReview/report.ts`: Markdown, JSON, HTML, and text renderers.
- Create `src/main/services/changeReview/query.ts`: typed filtering, opaque cursors, pagination, graph-slice evidence, and freshness checks.
- Create `src/main/ipc/reviewValidation.ts` and `src/main/ipc/reviewHandlers.ts`: pure payload parsing and Electron handlers.
- Modify `src/main/ipc/scanHandlers.ts`, `src/main/services/watchService.ts`, `src/main/ipc/index.ts`, and `src/main/index.ts`: shared operation coordination, handler construction, and verified temporary cleanup.
- Create `src/cli/options.ts`; modify `src/cli/main.ts`: backward-compatible review flags and output.

### Renderer

- Create `src/renderer/src/store/reviewStore.ts`: status/summary/operation/filter state and stale-request generations; never stores the full result.
- Create `src/renderer/src/components/views/ChangeReview.tsx`: workspace orchestration and status polling.
- Create focused components under `src/renderer/src/components/changeReview/`: `ReviewHeader.tsx`, `ReviewTabs.tsx`, `ReviewFilters.tsx`, `ReviewPage.tsx`, `ReviewDiff.tsx`, and `ReviewEvidenceInspector.tsx`.
- Create `src/renderer/src/lib/reviewGraph.ts`: derive a bounded `GraphPayload` from one retained delta or explanation path.
- Modify `src/renderer/src/store/uiStore.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/components/layout/Sidebar.tsx`, `src/renderer/src/components/layout/MainPanel.tsx`, `src/renderer/src/components/layout/Inspector.tsx`, `src/renderer/src/components/views/GraphView.tsx`, `src/renderer/src/components/views/Findings.tsx`, and `src/renderer/src/components/views/Dashboard.tsx`: navigation and freshness-safe drill-down.

### Tests and documentation

- Add focused tests under `tests/unit/{utils,db,services,algorithms,ipc,renderer}/` and `tests/integration/changeReview.test.ts`.
- Add `playwright.config.ts` and `tests/e2e/changeReview.spec.ts`.
- Modify `package.json` and `package-lock.json` only through `npm install` and script additions.
- Update `README.md`, `DEVELOPMENT-SPEC.md`, and `docs/AGENT-BRIEFING.md` after behavior passes.

## Execution Rules

- Complete tasks in order; later interface blocks assume earlier names exactly.
- Run every RED command before production edits and record that the failure is the expected missing behavior.
- Do not weaken or delete an existing test.
- Before every task commit, run the focused tests named in that task and `npm run typecheck:node` or `npm run typecheck:web` for the changed layer.
- Do not push. Implementation begins only after the user approves this plan.

### Task 1: Define the review domain model and deterministic primitives

**Files:**

- Create: `src/shared/changeReview.ts`
- Create: `src/main/services/changeReview/canonical.ts`
- Modify: `src/shared/constants.ts:110-126`
- Create: `tests/unit/utils/changeReviewCanonical.test.ts`

**Interfaces:**

- Produces `ReviewRepositoryState`, `ReviewOperationPhase`, `ReviewFileChangeType`, `ReviewGitState`, `ReviewDeltaDirection`, `ReviewSection`, `ReviewExportFormat`, and `ReviewFreshness`.
- Produces `ReviewGitChange`, `ReviewEdgeChange`, `ReviewFindingEvidence`, `ReviewFindingChange`, `ReviewArchitectureChange`, `ReviewCycleChange`, `ReviewExportChange`, `ReviewImpactExplanation`, `ReviewImpactItem`, `ReviewNoKnownTest`, `ReviewLimitation`, `ReviewGraphEvidence`, `ReviewItem`, `ReviewFilters`, `ReviewPage`, `ReviewStatus`, `ChangeReviewSummary`, and `ChangeReviewResult`.
- Produces `compareCodePoints(left, right)`, `canonicalStringify(value)`, `canonicalSha256(value)`, and `stableBy(items, keyOf)`.
- Arrays retain semantic order during canonical serialization; callers sort set-like arrays before hashing.

- [ ] **Step 1: Write failing canonical-order tests.**

```ts
import { describe, expect, it } from 'vitest';
import {
  canonicalSha256,
  canonicalStringify,
  compareCodePoints,
  stableBy,
} from '@main/services/changeReview/canonical';

describe('change review canonical values', () => {
  it('sorts by Unicode code point without host locale', () => {
    expect(stableBy(['z', 'a', 'ä'], (value) => value)).toEqual(['a', 'z', 'ä']);
    expect(compareCodePoints('a', 'a')).toBe(0);
  });

  it('sorts object keys but preserves semantic array order', () => {
    expect(canonicalStringify({ b: 2, a: ['second', 'first'] })).toBe(
      '{"a":["second","first"],"b":2}',
    );
  });

  it('hashes equivalent key order identically', () => {
    expect(canonicalSha256({ b: 2, a: 1 })).toBe(canonicalSha256({ a: 1, b: 2 }));
  });
});
```

- [ ] **Step 2: Run `npx vitest run tests/unit/utils/changeReviewCanonical.test.ts`.**

Expected: FAIL because `changeReview/canonical` does not exist.

- [ ] **Step 3: Implement canonical primitives without sorting arrays.**

```ts
import { createHash } from 'node:crypto';

export function compareCodePoints(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCode = left.codePointAt(leftIndex) as number;
    const rightCode = right.codePointAt(rightIndex) as number;
    if (leftCode !== rightCode) return leftCode - rightCode;
    leftIndex += leftCode > 0xffff ? 2 : 1;
    rightIndex += rightCode > 0xffff ? 2 : 1;
  }
  return left.length - right.length;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(compareCodePoints))
    target[key] = canonicalize(source[key]);
  return target;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

export function stableBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  return [...items].sort((left, right) => compareCodePoints(keyOf(left), keyOf(right)));
}
```

- [ ] **Step 4: Add the exact limits from Global Constraints to `src/shared/constants.ts` and define the structure-clone-safe review types in `src/shared/changeReview.ts`.** Use discriminant `itemType` on every `ReviewItem`; use `reviewId: number`, `operationId: string`, nullable old/new paths, and `Record<ReviewSection, ReviewCategoryCount>` for totals.

```ts
import type { EdgeType, FindingDetails, FindingType, Severity, SymbolKind } from './types';

export type ReviewRepositoryState = 'ready' | 'not-git' | 'unborn-head';
export type ReviewFreshness = 'current' | 'stale' | 'incompatible';
export type ReviewFileChangeType = 'added' | 'modified' | 'deleted' | 'renamed';
export type ReviewGitState = 'staged' | 'unstaged' | 'untracked';
export type ReviewDeltaDirection = 'added' | 'removed' | 'introduced' | 'resolved';
export type ReviewExportFormat = 'text' | 'json' | 'markdown' | 'html';
export type ReviewOperationPhase =
  | 'capturing'
  | 'refreshing-target'
  | 'materializing-baseline'
  | 'analyzing-baseline'
  | 'comparing'
  | 'validating'
  | 'persisting'
  | 'cleanup';

export type ReviewSection =
  | 'files'
  | 'edges'
  | 'findings'
  | 'architecture-violations'
  | 'cycles'
  | 'reachable-exports'
  | 'affected-files'
  | 'candidate-tests'
  | 'no-known-tests'
  | 'limitations';

export interface ReviewGitChange {
  itemType: 'file';
  stableKey: string;
  relativePath: string;
  oldPath: string | null;
  copiedFrom: string | null;
  changeType: ReviewFileChangeType;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  similarity: number | null;
  language: string | null;
}

export interface ReviewStatus {
  projectId: number;
  repositoryState: ReviewRepositoryState;
  baseCommit: string | null;
  baseTreeId: string | null;
  branchName: string | null;
  gitChanges: ReviewGitChange[];
  latestReview: { reviewId: number; freshness: ReviewFreshness; staleReasons: string[] } | null;
  activeOperation: {
    operationId: string;
    phase: ReviewOperationPhase;
    processed: number;
    total: number;
    message: string;
    cancellationRequested: boolean;
  } | null;
}

export interface ReviewEdgeChange {
  itemType: 'edge';
  stableKey: string;
  direction: 'added' | 'removed';
  fromPath: string;
  toPath: string;
  edgeType: EdgeType;
  typeOnly: boolean;
  sourceLines: number[];
  specifiers: string[];
}

export interface ReviewFindingEvidence {
  findingType: FindingType;
  severity: Severity;
  title: string;
  description: string;
  relatedNodeIds: string[];
  details: FindingDetails;
  fingerprint: string;
  dismissed: boolean;
}

export interface ReviewFindingChange {
  itemType: 'finding';
  stableKey: string;
  direction: 'introduced' | 'resolved';
  finding: ReviewFindingEvidence;
}

export interface ReviewArchitectureChange {
  itemType: 'architecture-violation';
  stableKey: string;
  direction: 'introduced' | 'resolved';
  ruleId: number;
  ruleFingerprint: string;
  sourcePath: string;
  targetPath: string;
  severity: Severity;
  line: number | null;
}

export interface ReviewCycleChange {
  itemType: 'cycle';
  stableKey: string;
  direction: 'added' | 'removed';
  memberPaths: string[];
  cyclePath: string[];
}

export interface ReviewExportChange {
  itemType: 'reachable-export';
  stableKey: string;
  direction: 'added' | 'removed';
  entryPoint: string;
  exportedName: string;
  symbolKind: SymbolKind;
  originPath: string;
  line: number | null;
}

export interface ReviewImpactExplanation {
  side: 'baseline' | 'target';
  originPath: string;
  path: string[];
  edgeTypes: EdgeType[];
}

export interface ReviewImpactItem {
  itemType: 'affected-file' | 'candidate-test';
  stableKey: string;
  destinationPath: string;
  depth: number;
  direct: boolean;
  originPaths: string[];
  baselinePresent: boolean;
  targetPresent: boolean;
  explanations: ReviewImpactExplanation[];
}

export interface ReviewNoKnownTest {
  itemType: 'no-known-test';
  stableKey: string;
  changedPath: string;
}

export interface ReviewLimitation {
  itemType: 'limitation';
  stableKey: string;
  scope: 'baseline' | 'target' | 'review' | 'truncation';
  code: string;
  message: string;
  paths: string[];
  omittedCount: number;
}

export interface ReviewGraphEvidence {
  nodePaths: string[];
  edges: Array<{
    fromPath: string;
    toPath: string;
    edgeType: EdgeType;
    side: 'baseline' | 'target';
  }>;
}

export type ReviewItem =
  | ReviewGitChange
  | ReviewEdgeChange
  | ReviewFindingChange
  | ReviewArchitectureChange
  | ReviewCycleChange
  | ReviewExportChange
  | ReviewImpactItem
  | ReviewNoKnownTest
  | ReviewLimitation;

export interface ReviewCategoryCount {
  totalCount: number;
  retainedCount: number;
  truncated: boolean;
  truncatedAtDepth: boolean;
}

export interface ReviewFilters {
  changeTypes: ReviewFileChangeType[];
  gitStates: ReviewGitState[];
  findingTypes: FindingType[];
  severities: Severity[];
  deltaDirections: ReviewDeltaDirection[];
  directness: Array<'direct' | 'indirect'>;
  languages: string[];
  folderPrefix: string | null;
  minDepth: number | null;
  maxDepth: number | null;
}

export interface ChangeReviewSummary {
  reviewId: number;
  projectId: number;
  baseCommit: string;
  baseTreeId: string | null;
  workingTreeFingerprint: string;
  userConfigurationFingerprint: string;
  effectiveBaselineFingerprint: string;
  traceDeckVersion: string;
  resultSchemaVersion: number;
  traversalDepth: number;
  completedAt: string;
  counts: Record<ReviewSection, ReviewCategoryCount>;
  categoryAvailability: Record<ReviewSection, boolean>;
  limitations: ReviewLimitation[];
}

export interface ReviewPage {
  reviewId: number;
  section: ReviewSection;
  items: ReviewItem[];
  nextCursor: string | null;
  returnedCount: number;
  retainedCount: number;
  totalCount: number;
  truncated: boolean;
  truncatedAtDepth: boolean;
}

export interface ChangeReviewResult {
  schemaVersion: number;
  baseCommit: string;
  baseTreeId: string | null;
  workingTreeFingerprint: string;
  userConfigurationFingerprint: string;
  effectiveBaselineFingerprint: string;
  workingTreeScanId: number;
  traversalDepth: number;
  fileChanges: ReviewGitChange[];
  edgeChanges: ReviewEdgeChange[];
  findingChanges: ReviewFindingChange[];
  architectureChanges: ReviewArchitectureChange[];
  cycleChanges: ReviewCycleChange[];
  exportChanges: ReviewExportChange[];
  affectedFiles: ReviewImpactItem[];
  candidateTests: ReviewImpactItem[];
  noKnownTests: ReviewNoKnownTest[];
  limitations: ReviewLimitation[];
  graphEvidence: ReviewGraphEvidence;
  counts: Record<ReviewSection, ReviewCategoryCount>;
}
```

Stable keys are lowercase hexadecimal SHA-256 of canonical identity objects: file `{ relativePath, oldPath, copiedFrom, changeType, staged, unstaged, untracked }`; edge `{ fromPath, toPath, edgeType, typeOnly }`; finding `{ findingType, fingerprint }`; architecture `{ ruleId, ruleFingerprint, sourcePath, targetPath }`; cycle `{ memberPaths }` after sorting members; export `{ entryPoint, exportedName, symbolKind, originPath }`; impact `{ itemType, destinationPath }`; no-known-test `{ changedPath }`; limitation `{ scope, code, paths }` after sorting paths. Direction is excluded where baseline/target comparison already determines it, allowing paired added/removed records to share evidence identity.

- [ ] **Step 5: Re-run the focused test and `npm run typecheck:node`.**

Expected: PASS.

- [ ] **Step 6: Commit.**

```powershell
git add src/shared/changeReview.ts src/shared/constants.ts src/main/services/changeReview/canonical.ts tests/unit/utils/changeReviewCanonical.test.ts
git commit -m "Define deterministic change review contracts" -m "Generated with [Devin](https://devin.ai)" -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Task 2: Persist only the latest completed review

**Files:**

- Modify: `src/main/db/migrations.ts:146-251`
- Modify: `src/main/db/rows.ts:114-147`
- Create: `src/main/db/repositories/changeReviewRepository.ts`
- Modify: `src/main/db/index.ts:1-63`
- Modify: `tests/unit/db/migrations.test.ts:31-90`
- Create: `tests/unit/db/changeReviewRepository.test.ts`

**Interfaces:**

- Produces `ChangeReviewInsertInput` plus `ChangeReviewRepository.latestForProject(projectId)`, `findById(id)`, `replaceLatest(input)`, and `removeForProject(projectId)`.
- `working_tree_scan_id` is informational and has no foreign key.
- `replaceLatest` serializes before its transaction, deletes the old row, inserts the candidate, and rolls back to the old row on insertion failure.

- [ ] **Step 1: Add migration assertions for `change_reviews` and upgrade from schema version 3.** Update the exact table-name expectation to include `change_reviews`.

```ts
it('upgrades a version 3 database with latest-only change reviews', () => {
  const db = new Database(':memory:');
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 3)) migration.up(db);
  db.pragma('user_version = 3');

  expect(runMigrations(db)).toBe(4);
  expect(tableNames(db)).toContain('change_reviews');
});
```

- [ ] **Step 2: Add failing repository tests for latest-only replacement, project cascade, corrupt JSON compatibility, and rollback.** Define `reviewInput(projectId, baseCommit)` in that test file as a complete `ChangeReviewInsertInput` with fixed fingerprints/version/depth, `workingTreeScanId: 1`, empty typed category arrays, zeroed counts for every `ReviewSection`, and no limitations.

```ts
it('rolls back replacement when the new insert fails', () => {
  const project = store.projects.createOrTouch('demo', '/tmp/demo');
  const first = store.changeReviews.replaceLatest(reviewInput(project.id, 'base-one'));
  store.db.exec(`
    CREATE TRIGGER reject_review BEFORE INSERT ON change_reviews
    WHEN NEW.base_commit = 'reject'
    BEGIN SELECT RAISE(ROLLBACK, 'rejected'); END;
  `);

  expect(() => store.changeReviews.replaceLatest(reviewInput(project.id, 'reject'))).toThrow();
  expect(store.changeReviews.latestForProject(project.id)?.id).toBe(first.id);
});
```

- [ ] **Step 3: Run `npx vitest run tests/unit/db/migrations.test.ts tests/unit/db/changeReviewRepository.test.ts`.**

Expected: FAIL because migration 4 and `store.changeReviews` do not exist.

- [ ] **Step 4: Add migration 4 with this schema.**

```sql
CREATE TABLE change_reviews (
  id                             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id                     INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  base_commit                    TEXT    NOT NULL,
  base_tree_id                   TEXT,
  working_tree_fingerprint       TEXT    NOT NULL,
  user_configuration_fingerprint TEXT    NOT NULL,
  effective_baseline_fingerprint TEXT    NOT NULL,
  working_tree_scan_id           INTEGER NOT NULL,
  tracedeck_version              TEXT    NOT NULL,
  result_schema_version          INTEGER NOT NULL,
  traversal_depth                INTEGER NOT NULL,
  completed_at                   TEXT    NOT NULL,
  summary_json                   TEXT    NOT NULL,
  retained_result_json           TEXT    NOT NULL
);
```

`working_tree_scan_id` deliberately has no `REFERENCES` clause, so ordinary scan pruning cannot delete a retained review.

- [ ] **Step 5: Implement row mapping and `ChangeReviewRepository`.** Decode malformed summary/result JSON as incompatible nullable data rather than casting `{}` to a valid result. Build `ChangeReviewSummary.reviewId` from the inserted row ID, not from pre-insert JSON.

- [ ] **Step 6: Wire the repository into `DataStore`, then run focused tests and `npm run typecheck:node`.**

Expected: PASS, including the existing generic migration rollback test.

- [ ] **Step 7: Commit.**

```powershell
git add src/main/db/migrations.ts src/main/db/rows.ts src/main/db/index.ts src/main/db/repositories/changeReviewRepository.ts tests/unit/db/migrations.test.ts tests/unit/db/changeReviewRepository.test.ts
git commit -m "Persist the latest completed change review" -m "Generated with [Devin](https://devin.ai)" -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Task 3: Read canonical Git state and bounded diffs

**Files:**

- Create: `src/main/services/changeReview/gitProcess.ts`
- Create: `src/main/services/changeReview/gitStatus.ts`
- Create: `tests/unit/services/changeReviewGit.test.ts`

**Interfaces:**

- Produces `runGitBuffered(options)`, `runGitNulRecords(options, onRecord)`, and `GitReviewError`.
- Produces `resolveReviewHead(root, signal)`, `readReviewStatus(root, signal)`, `captureWorkingTreeFingerprint(root, head, changes, signal)`, and `readReviewDiff(input)`.
- Process timeouts: 20 seconds `rev-parse`, 60 seconds status/tree, 30 seconds diff, 5 minutes batch blob reads.
- `readReviewStatus` uses `git -c status.renames=true status --porcelain=v2 -z --untracked-files=all --find-renames=50%` and a fatal UTF-8 decoder.

- [ ] **Step 1: Write failing pure parser tests for tracked, staged-plus-unstaged, rename, delete, untracked, chunk boundaries, and invalid UTF-8 records.**

```ts
import { describe, expect, it } from 'vitest';
import { parsePorcelainV2 } from '@main/services/changeReview/gitStatus';

describe('porcelain v2 status', () => {
  it('parses a NUL-delimited rename pair', () => {
    const output = Buffer.from(
      '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 src/new.ts\0src/old.ts\0',
    );
    expect(parsePorcelainV2(output)).toEqual([
      expect.objectContaining({
        relativePath: 'src/new.ts',
        oldPath: 'src/old.ts',
        changeType: 'renamed',
        staged: true,
        unstaged: false,
        untracked: false,
        similarity: 100,
      }),
    ]);
  });

  it('rejects invalid UTF-8 rather than replacing path bytes', () => {
    expect(() => parsePorcelainV2(Buffer.from([0x3f, 0x20, 0xff, 0x00]))).toThrow(
      expect.objectContaining({ code: 'INVALID_GIT_PATH_ENCODING' }),
    );
  });
});
```

- [ ] **Step 2: Run `npx vitest run tests/unit/services/changeReviewGit.test.ts`.**

Expected: FAIL because the Git review modules do not exist.

- [ ] **Step 3: Implement the process runner with `spawn('git', args, { cwd, windowsHide: true, shell: false })`.** Bound retained stderr, abort and kill on `AbortSignal`, distinguish `REVIEW_CANCELLED`, `REVIEW_GIT_TIMEOUT`, missing Git, unborn `HEAD`, and generic command failure, and remove listeners/timers in `finally`.

- [ ] **Step 4: Implement the porcelain-v2 state machine.** Type-2 rename/copy records consume the following NUL token as source path. Map Git `R` to `changeType: 'renamed'` with `oldPath`; map Git `C` to `changeType: 'added'` with `copiedFrom`; do not add a fifth product change type. Convert Git X/Y states into separate booleans and an aggregate disk-versus-`HEAD` classification without guessing add/delete similarity.

- [ ] **Step 5: Implement working-tree fingerprinting.** Hash canonical status evidence and streamed bytes for every present changed regular file; use `lstat` for deleted/symlink markers; recheck metadata after each regular-file hash and fail stale when it changed during capture.

- [ ] **Step 6: Implement bounded diff.** Run `git --no-pager diff --no-ext-diff --no-textconv <base> -- <path>` with rename old/new pathspecs, count complete bytes/lines while retaining only the configured prefix, and return exact omitted counts.

- [ ] **Step 7: Add local temporary-repository integration cases to the same test file using `execFile('git', args)` only.** Assert staged, unstaged, untracked, delete, and Git-supplied rename evidence.

- [ ] **Step 8: Run the focused test twice and `npm run typecheck:node`.**

Expected: PASS with byte-for-byte equal status ordering on both runs.

- [ ] **Step 9: Commit.**

```powershell
git add src/main/services/changeReview/gitProcess.ts src/main/services/changeReview/gitStatus.ts tests/unit/services/changeReviewGit.test.ts
git commit -m "Capture deterministic working tree evidence" -m "Generated with [Devin](https://devin.ai)" -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Task 4: Materialize `HEAD` without repository mutation or symlink traversal

**Files:**

- Create: `src/main/services/changeReview/materializer.ts`
- Create: `tests/unit/services/changeReviewMaterializer.test.ts`

**Interfaces:**

- Produces `createReviewTempRoot(version)`, `enumerateHeadTree(root, commit, signal)`, `materializeHeadTree(input)`, `removeVerifiedReviewTemp(root)`, and `cleanupAbandonedReviewTemps(version, now)`.
- A temp root contains `tree/`, `state/`, and a regular `.tracedeck-review-marker` with matching UUID, version, and start time.
- `MaterializedHead` returns tree ID, written relative paths, synthetic inventory evidence for omitted entries, byte/file totals, and coded limitations.

- [ ] **Step 1: Write failing preflight and path-security tests.**

```ts
it('rejects deterministic lowercase path collisions on every platform', () => {
  expect(() =>
    preflightTree([
      treeBlob('100644', 'a'.repeat(40), 12, 'src/Foo.ts'),
      treeBlob('100644', 'b'.repeat(40), 12, 'src/foo.ts'),
    ]),
  ).toThrow(expect.objectContaining({ code: 'CASE_COLLISION' }));
});

it('classifies links and submodules without materializing them', () => {
  const result = preflightTree([
    treeBlob('120000', 'a'.repeat(40), 8, 'linked.ts'),
    treeCommit('b'.repeat(40), 'vendor/module'),
  ]);
  expect(result.writable).toEqual([]);
  expect(result.inventory.map((entry) => entry.reason)).toEqual(['submodule', 'symlink']);
});
```

Define `treeBlob` and `treeCommit` in the test as literal `GitTreeEntry` builders so no production helper is hidden from the assertion.

- [ ] **Step 2: Write failing verified-cleanup tests.** Assert cleanup skips malformed, symlink, UUID-mismatched, and younger-than-24-hour markers and removes only an old direct `tracedeck-review-<uuid>` child.

- [ ] **Step 3: Run `npx vitest run tests/unit/services/changeReviewMaterializer.test.ts`.**

Expected: FAIL because `materializer.ts` does not exist.

- [ ] **Step 4: Implement NUL-delimited `git ls-tree -r -l -z --full-tree <commit>` parsing and preflight.** Reject malformed/invalid paths, absolute or escaping destinations, lowercase collisions, more than 100,000 entries, or more than 2 GiB of regular blobs before any blob write.

- [ ] **Step 5: Implement a streaming `git cat-file --batch` state machine.** Request sorted object IDs, parse each header and exact byte count, write only regular blobs beneath `tree/`, verify the destination parent remains inside the real temp tree, and check cancellation between blobs. Never call `symlink`, `readlink`, checkout, or an external filter.

- [ ] **Step 6: Detect Git LFS pointer headers and matching `.gitattributes` filter rules.** Add `GIT_FILTER_OR_LFS_NOT_APPLIED` once per affected path while analyzing raw committed bytes.

- [ ] **Step 7: Implement marker creation and cleanup.** Cleanup may call recursive removal only after prefix, direct-child, regular-marker, UUID, and age checks all pass.

- [ ] **Step 8: Add security-spy and repository-integrity tests.** Spy the injected filesystem adapter and assert no `symlink` or `readlink` operation occurs. Spy the injected Git runner and assert no argument array contains `checkout`, `reset`, `clean`, `worktree`, `submodule`, hook/filter execution, external diff configuration, or `--textconv`. In a temporary Git repository, prove worktree and index status bytes are unchanged after materialization.

- [ ] **Step 9: Run the focused test twice and `npm run typecheck:node`.**

Expected: PASS with identical tree evidence on both runs and no leftover verified temp root.

- [ ] **Step 10: Commit.**

```powershell
git add src/main/services/changeReview/materializer.ts tests/unit/services/changeReviewMaterializer.test.ts
git commit -m "Materialize review baselines safely" -m "Generated with [Devin](https://devin.ai)" -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Task 5: Extract normalized snapshots and reachable export names

**Files:**

- Create: `src/main/analysis/algorithms/reachableExports.ts`
- Create: `src/main/services/changeReview/snapshot.ts`
- Create: `tests/unit/algorithms/reachableExports.test.ts`
- Create: `tests/unit/services/changeReviewSnapshot.test.ts`

**Interfaces:**

- Produces `discoverReachableExports(entryPoints, modules)` with named/default/re-export traversal and explicit ambiguous-star limitations.
- Produces `extractReviewSnapshot({ store, project, side, identity, extraInventory, effectiveBaselineFingerprint })`.
- Snapshot extraction strips database IDs, timestamps, and absolute paths; it reads full edge metadata through `store.edges.listByProject` so type-only status is retained.
- Entry points are only configured paths plus that side’s manifest-backed `main`, `module`, `browser`, `types`, `exports`, and `bin`; no inferred no-dependent root is public API evidence.

- [ ] **Step 1: Write failing reachable-export tests for own, default, named re-export, unique star, alias, cycle, and ambiguous stars.**

```ts
it('does not invent an origin for conflicting star exports', () => {
  const result = discoverReachableExports(
    ['index.ts'],
    [
      moduleFact('index.ts', [], [star('a.ts'), star('b.ts')]),
      moduleFact('a.ts', [own('value', 'function', 1)], []),
      moduleFact('b.ts', [own('value', 'function', 1)], []),
    ],
  );

  expect(result.exports).toEqual([]);
  expect(result.limitations).toEqual([
    expect.objectContaining({ code: 'AMBIGUOUS_STAR_REEXPORT', path: 'index.ts' }),
  ]);
});
```

Define the four small builders in the test with complete `ExportModuleFact` values.

- [ ] **Step 2: Run `npx vitest run tests/unit/algorithms/reachableExports.test.ts`.**

Expected: FAIL because `reachableExports.ts` does not exist.

- [ ] **Step 3: Implement export-surface recursion.** Own and named exports override stars; star exports exclude `default`; one origin is accepted; several distinct origins produce a limitation and no export record; `(modulePath, exportName)` recursion guards prevent loops. Sort all output by entry point, exported name, kind, and origin using `compareCodePoints`.

- [ ] **Step 4: Write failing snapshot tests using an in-memory `DataStore`.** Assert relative inventory, resolved dependency edges only, type-only edge identity, comparable findings including dismissed evidence, architecture semantic fingerprints, canonical cycle membership, reachable exports, and `type-error` category unavailability.

```ts
const snapshot = extractReviewSnapshot({
  store,
  project,
  side: 'target',
  identity,
  extraInventory: [],
  effectiveBaselineFingerprint: null,
});
expect(snapshot.inventory.every((entry) => !('absolutePath' in entry))).toBe(true);
expect(snapshot.edges.every((edge) => edge.unresolved === false)).toBe(true);
expect(snapshot.findings.some((finding) => finding.findingType === 'type-error')).toBe(false);
```

- [ ] **Step 5: Run `npx vitest run tests/unit/services/changeReviewSnapshot.test.ts`.**

Expected: FAIL because snapshot extraction does not exist.

- [ ] **Step 6: Implement snapshot extraction.** Use `projectFiles.listByProject`, `files.listByProject`, `edges.listByProject`, `findings.list(project.id, { includeDismissed: true })`, `symbols.listExported`, `rules.listEnabled`, `scans.latestCompletedForProject`, `detectCycles`, and `packageEntryPointsFrom`. Collapse duplicate structural edges by source/target/type/type-only identity while retaining sorted source lines and specifiers as display evidence.

- [ ] **Step 7: Compute fingerprints and type-check availability exactly.** Semantic rule fingerprint hashes canonical name/type/patterns/severity/sorted exceptions. User configuration fingerprint hashes full project analysis configuration and rules. Effective baseline fingerprint uses the same structure with `typeCheck: false` and analyzer/result versions. When the user configuration has `typeCheck: true`, append one review-scoped limitation with code `TYPE_ERROR_BASELINE_NOT_COMPARABLE` and message `Type errors were not compared because the isolated HEAD baseline does not reproduce the working tree's compiler dependency environment.`

- [ ] **Step 8: Run both focused tests twice and `npm run typecheck:node`.**

Expected: PASS with equal snapshots under reversed repository insertion order.

- [ ] **Step 9: Commit.**

```powershell
git add src/main/analysis/algorithms/reachableExports.ts src/main/services/changeReview/snapshot.ts tests/unit/algorithms/reachableExports.test.ts tests/unit/services/changeReviewSnapshot.test.ts
git commit -m "Normalize review snapshots and export evidence" -m "Generated with [Devin](https://devin.ai)" -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Task 6: Compare structural evidence with stable identities

**Files:**

- Create: `src/main/analysis/algorithms/reviewComparator.ts`
- Create: `tests/unit/algorithms/reviewComparator.test.ts`

**Interfaces:**

- Produces `compareReviewSnapshots(baseline, target, changes, options)`.
- Produces `diffByStableKey(baseline, target, keyOf)` and `retainCategory(items, limit)`.
- Edge identity excludes line/specifier spelling; finding identity is type plus existing content fingerprint; cycle identity is sorted members; export identity is entry point/name/kind/origin.
- Architecture violations appear in their dedicated category and are excluded from general finding counts.

- [ ] **Step 1: Write failing delta tests.**

```ts
it('treats runtime and type-only edges as distinct', () => {
  const baseline = reviewSnapshot({ edges: [edge('a.ts', 'b.ts', false)] });
  const target = reviewSnapshot({ edges: [edge('a.ts', 'b.ts', true)] });
  const result = compareReviewSnapshots(baseline, target, [], compareOptions());

  expect(result.edgeChanges.map((item) => item.direction)).toEqual(['added', 'removed']);
});

it('sorts before retaining the first two thousand items', () => {
  const target = reviewSnapshot({
    edges: Array.from({ length: 2005 }, (_, index) =>
      edge(`z${2004 - index}.ts`, 'core.ts', false),
    ),
  });
  const result = compareReviewSnapshots(reviewSnapshot(), target, [], compareOptions());
  expect(result.counts.edges).toMatchObject({
    totalCount: 2005,
    retainedCount: 2000,
    truncated: true,
  });
  expect(result.edgeChanges).toEqual(stableBy(result.edgeChanges, (item) => item.stableKey));
});
```

Define `reviewSnapshot`, `edge`, and `compareOptions` in the test as typed literal builders.

- [ ] **Step 2: Add tests for introduced/resolved findings, dedicated architecture counts, SCC merge/split, reachable exports, unchanged line moves, and reversed input order.**

- [ ] **Step 3: Run `npx vitest run tests/unit/algorithms/reviewComparator.test.ts`.**

Expected: FAIL because `reviewComparator.ts` does not exist.

- [ ] **Step 4: Implement generic map-based deltas, stable keys, deduplication, complete totals, and sort-before-retain behavior.** Check the mutable cancellation flag between categories and every 500 items.

- [ ] **Step 5: Build `ChangeReviewResult` category arrays and coded availability.** Preserve both side-specific finding details and cycle paths; never infer rename or finding continuity.

- [ ] **Step 6: Re-run the focused test twice and `npm run typecheck:node`.**

Expected: PASS with identical serialized semantic results for shuffled inputs.

- [ ] **Step 7: Commit.**

```powershell
git add src/main/analysis/algorithms/reviewComparator.ts tests/unit/algorithms/reviewComparator.test.ts
git commit -m "Compare change review structural evidence" -m "Generated with [Devin](https://devin.ai)" -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Task 7: Compute provenance-preserving possible impact

**Files:**

- Create: `src/main/analysis/algorithms/reviewImpact.ts`
- Modify: `src/main/analysis/algorithms/reviewComparator.ts`
- Create: `tests/unit/algorithms/reviewImpact.test.ts`
- Modify: `tests/unit/algorithms/metricsExtras.test.ts:67-91`

**Interfaces:**

- Produces `computeReviewImpact({ baselineIndex, targetIndex, changes, maxDepth, maxRetained, signal })`.
- Each retained result contains destination path, minimum depth, directness, contributing origins, baseline/target presence, and one deterministic shortest explanation per applicable side.
- Added files seed target; deleted seed baseline; modified seed both; rename old seeds baseline and new seeds target.
- Existing `computeDiffImpact` delegates its flat Dashboard-compatible result to the target-side review traversal adapter rather than maintaining different reachability semantics.

- [ ] **Step 1: Write failing tests for graph-side selection, shortest paths, tie-breaking, candidate tests, no-known-test files, cycles, depth truncation, and order independence.**

```ts
it('uses the baseline graph for a deleted dependency', () => {
  const result = computeReviewImpact({
    baselineIndex: index([dependency('app.ts', 'gone.ts')]),
    targetIndex: index([]),
    changes: [changed('deleted', 'gone.ts')],
    maxDepth: 5,
    maxRetained: 2000,
    signal: { cancelled: false },
  });
  expect(result.affectedFiles[0]).toMatchObject({
    destinationPath: 'app.ts',
    depth: 1,
    direct: true,
    baselinePresent: true,
    targetPresent: false,
  });
});

it('breaks equal shortest paths by changed origin then full path', () => {
  const graph = index([dependency('consumer.ts', 'a.ts'), dependency('consumer.ts', 'b.ts')]);
  const result = computeReviewImpact({
    baselineIndex: graph,
    targetIndex: graph,
    changes: [changed('modified', 'b.ts'), changed('modified', 'a.ts')],
    maxDepth: 5,
    maxRetained: 2000,
    signal: { cancelled: false },
  });
  expect(result.affectedFiles[0]?.explanations[0]?.originPath).toBe('a.ts');
});
```

- [ ] **Step 2: Run `npx vitest run tests/unit/algorithms/reviewImpact.test.ts`.**

Expected: FAIL because `reviewImpact.ts` does not exist.

- [ ] **Step 3: Implement one multi-source BFS per graph side.** Sort seeds, frontier entries, and incoming edges with `compareCodePoints`; retain the first shortest visit; detect neighbors beyond max depth; continue counting all nodes within depth before applying the 2,000-detail cap.

- [ ] **Step 4: Merge sides by destination path.** Keep both explanations when paths differ, choose the shorter default, then baseline and code-point order on ties. Classify tests through existing `isTestFile` and derive changed files with no reached candidate test.

- [ ] **Step 5: Integrate impact arrays/counts into `compareReviewSnapshots` and adapt current `computeDiffImpact` without changing its public return shape.**

- [ ] **Step 6: Run `npx vitest run tests/unit/algorithms/reviewImpact.test.ts tests/unit/algorithms/metricsExtras.test.ts tests/unit/algorithms/blastRadius.test.ts` twice, then `npm run typecheck:node`.**

Expected: PASS; existing Dashboard impact behavior remains compatible.

- [ ] **Step 7: Commit.**

```powershell
git add src/main/analysis/algorithms/reviewImpact.ts src/main/analysis/algorithms/reviewComparator.ts src/main/analysis/algorithms/diffImpact.ts tests/unit/algorithms/reviewImpact.test.ts tests/unit/algorithms/metricsExtras.test.ts
git commit -m "Explain possible impact across review snapshots" -m "Generated with [Devin](https://devin.ai)" -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Task 8: Share project-operation ownership between scans and reviews

**Files:**

- Create: `src/main/services/projectOperations.ts`
- Modify: `src/main/ipc/scanHandlers.ts:10-98`
- Modify: `src/main/services/watchService.ts:4-44`
- Create: `tests/unit/services/projectOperations.test.ts`
- Modify: `tests/integration/scan.test.ts`

**Interfaces:**

- Produces singleton-per-app `ProjectOperationRegistry` with `acquire(projectId, kind)`, `active(projectId)`, `cancel(projectId, operationId?)`, `markWatcherDirty(projectId)`, and lease `release()`/`consumeWatcherDirty()`.
- Operation kinds are `scan` and `review`; each lease owns a mutable scanner signal and an `AbortController` for Git.
- `scanHandlers(store, operations)` preserves existing scan IPC responses and progress events.
- Watch events during review set the review lease stale/dirty and defer exactly one incremental scan until release.

- [ ] **Step 1: Write failing registry tests.**

```ts
it('allows one operation per project and keeps projects independent', () => {
  const registry = new ProjectOperationRegistry();
  const review = registry.acquire(1, 'review');
  expect(review).not.toBeNull();
  expect(registry.acquire(1, 'scan')).toBeNull();
  expect(registry.acquire(2, 'scan')).not.toBeNull();
  review?.release();
  expect(registry.acquire(1, 'scan')).not.toBeNull();
});

it('cancels both scanner and Git signals', () => {
  const registry = new ProjectOperationRegistry();
  const lease = registry.acquire(1, 'review') as ProjectOperationLease;
  expect(registry.cancel(1, lease.operationId)).toBe(true);
  expect(lease.scanSignal.cancelled).toBe(true);
  expect(lease.abortController.signal.aborted).toBe(true);
});
```

- [ ] **Step 2: Run `npx vitest run tests/unit/services/projectOperations.test.ts tests/integration/scan.test.ts`.**

Expected: FAIL because the registry does not exist and scan handlers still own a private map.

- [ ] **Step 3: Implement the registry with idempotent release and UUID operation IDs.** A release from an older lease must not clear a newer operation.

- [ ] **Step 4: Refactor `scanHandlers` to acquire/release scan leases and preserve `scan:cancel`, `scan:latest`, progress broadcasts, and `SCAN_IN_PROGRESS`.** Do not change scanner semantics.

- [ ] **Step 5: Extend `watchProject` callback context with the changed relative path.** In scan registration, mark a review lease dirty instead of launching a competing scan; after review release, consume one dirty flag and launch one incremental scan.

- [ ] **Step 6: Add integration assertions that a scan and review cannot overlap, cancellation still marks a scan cancelled, and two watcher events coalesce.**

- [ ] **Step 7: Run focused tests and `npm run typecheck:node`.**

Expected: PASS with existing scan tests unchanged.

- [ ] **Step 8: Commit.**

```powershell
git add src/main/services/projectOperations.ts src/main/ipc/scanHandlers.ts src/main/services/watchService.ts tests/unit/services/projectOperations.test.ts tests/integration/scan.test.ts
git commit -m "Coordinate scans and change reviews" -m "Generated with [Devin](https://devin.ai)" -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Task 9: Orchestrate the complete cancellable review pipeline

**Files:**

- Create: `src/main/services/changeReview/coordinator.ts`
- Create: `tests/integration/changeReview.test.ts`
- Modify: `src/main/index.ts:29-71`

**Interfaces:**

- Produces `ChangeReviewCoordinator.start(projectId, depth)`, `runNow(projectId, depth)`, `cancel(projectId, operationId)`, `status(projectId)`, `summary(projectId)`, and `markWatcherDirty(projectId)`.
- `start` registers background work and immediately returns `{ operationId }`; every background rejection is captured into operation status.
- `runNow` awaits the same internal pipeline for CLI use.
- The pipeline captures status/fingerprints, runs the current incremental scan, extracts target snapshot while the review lease is held, materializes/scans baseline with `typeCheck: false`, compares, revalidates identities, replaces persistence, and cleans up.

- [ ] **Step 1: Create a temporary Git repository test helper inside `tests/integration/changeReview.test.ts`.** Use `execFile` argument arrays to initialize, configure local test identity, commit a small TypeScript project, and mutate add/modify/delete/rename states without touching repository fixtures.

- [ ] **Step 2: Write the failing happy-path test.**

```ts
it('compares an already-dirty working tree with HEAD', async () => {
  const fixture = await createReviewRepository();
  await fixture.modifyWorkingTree();
  const coordinator = createTestCoordinator(fixture.root);

  const review = await coordinator.runNow(fixture.projectId, 5);

  expect(review.result.fileChanges.map((item) => item.changeType)).toEqual(
    expect.arrayContaining(['added', 'modified', 'deleted', 'renamed']),
  );
  expect(review.result.edgeChanges.length).toBeGreaterThan(0);
  expect(review.result.limitations.every((item) => !item.message.includes(fixture.root))).toBe(
    true,
  );
});
```

Implement `createTestCoordinator` in the test with real in-memory app `DataStore`, real Git/materializer/scanner/comparator dependencies, and an injected fixed TraceDeck version.

- [ ] **Step 3: Add failing tests for cancellation, stale `HEAD`, changed bytes during baseline analysis, changed rules/configuration, isolated type-check override, prior-review preservation, and temp cleanup.**

- [ ] **Step 4: Run `npx vitest run tests/integration/changeReview.test.ts`.**

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 5: Implement coordinator status and background lifecycle.** Keep only bounded phase/progress/error state in memory; store no source or temporary path. Pollable repository states are `ready`, `not-git`, and `unborn-head`.

- [ ] **Step 6: Implement isolated baseline scan.** Create `<verified-root>/state/baseline.sqlite`, create a synthetic project rooted at `<verified-root>/tree`, copy structural configuration/rules, force `typeCheck: false`, run full scan, merge synthetic inventory limitations, extract snapshot, and close the temporary `DataStore` in `finally`.

- [ ] **Step 7: Implement final freshness validation and atomic persistence.** Re-resolve full `HEAD`, status fingerprint, user configuration fingerprint, and effective baseline fingerprint. On mismatch throw `REVIEW_STALE`; do not replace the previous review.

- [ ] **Step 8: Invoke verified abandoned-temp cleanup during app startup.** Cleanup failure logs locally and does not prevent startup; no path crosses IPC.

- [ ] **Step 9: Run the integration test twice, then run `npx vitest run tests/integration/scan.test.ts tests/unit/db/changeReviewRepository.test.ts` and `npm run typecheck:node`.**

Expected: PASS with identical semantic review JSON after removing generated timestamps/review IDs.

- [ ] **Step 10: Commit.**

```powershell
git add src/main/services/changeReview/coordinator.ts src/main/index.ts tests/integration/changeReview.test.ts
git commit -m "Orchestrate working tree change reviews" -m "Generated with [Devin](https://devin.ai)" -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Task 10: Add filtered paging and the closed review IPC surface

**Files:**

- Create: `src/main/services/changeReview/query.ts`
- Create: `src/main/ipc/reviewValidation.ts`
- Create: `src/main/ipc/reviewHandlers.ts`
- Modify: `src/shared/ipc.ts:1-288`
- Modify: `src/main/ipc/index.ts:1-32`
- Create: `tests/unit/services/changeReviewQuery.test.ts`
- Create: `tests/unit/ipc/reviewValidation.test.ts`

**Interfaces:**

- Produces `queryReview(record, request)`, `encodeReviewCursor(reviewId, section, offset)`, and `decodeReviewCursor(cursor)`.
- Produces pure `parseReviewStart`, `parseReviewCancel`, `parseReviewQuery`, `parseReviewDiff`, and `parseReviewExport` payload validators.
- Adds exactly `review:status`, `review:start`, `review:cancel`, `review:summary`, `review:query`, `review:file-diff`, and `review:export` to `IpcContract` and `IPC_CHANNELS`.
- `review:status` is the only review-progress mechanism; preload still exposes exactly `invoke` and `onScanProgress`.

- [ ] **Step 1: Write failing query tests for every filter family, default/max page sizes, cursor review/section mismatch, truncated filtered-count wording data, and defensive empty arrays.** Define `reviewRecord(id)` in the test as a complete stored record whose result uses the exact `ChangeReviewResult` arrays from Task 1 and whose edges contain at least 150 stable-keyed items.

```ts
it('rejects a cursor from another retained review', () => {
  const cursor = encodeReviewCursor(7, 'edges', 100);
  expect(() =>
    queryReview(reviewRecord(8), {
      reviewId: 8,
      section: 'edges',
      filters: {},
      cursor,
      pageLimit: 100,
    }),
  ).toThrow(expect.objectContaining({ code: 'REVIEW_STALE' }));
});
```

- [ ] **Step 2: Write failing validation tests for non-object payloads, IDs, depth clamping, unknown sections/formats, inapplicable filters, absolute/escaping paths, oversized pages, and arbitrary ref fields.**

- [ ] **Step 3: Run `npx vitest run tests/unit/services/changeReviewQuery.test.ts tests/unit/ipc/reviewValidation.test.ts`.**

Expected: FAIL because query/validation modules do not exist.

- [ ] **Step 4: Implement opaque base64url cursors containing only review ID, section, and offset.** Validate decoded integers and exact review/section match. Apply stable retained-item filters in main and return page items with complete total/retained/truncation metadata.

- [ ] **Step 5: Implement closed payload parsers using existing validation helpers.** Reject fields that could become refs or absolute paths; check section-specific filter applicability rather than ignoring it.

- [ ] **Step 6: Extend `src/shared/ipc.ts` with exact typed requests/responses from the spec and add all seven names to `IPC_CHANNELS`.** Import review types from `./changeReview`; make no preload code change.

- [ ] **Step 7: Implement handlers and registration.** Construct one `ProjectOperationRegistry` and `ChangeReviewCoordinator` in `registerAllHandlers`, pass the registry to scan handlers, validate every review request before service calls, and preserve startup missing-handler enforcement.

- [ ] **Step 8: Implement freshness-safe file diff.** Require the path in captured status evidence plus lexical containment; return `REVIEW_STALE` without invoking Git when identities or commit differ. Return only basename from native export later, never destination path.

- [ ] **Step 9: Run focused tests, `tests/unit/ipc/validation.test.ts`, and `npm run typecheck:node`.**

Expected: PASS and no change to the preload surface.

- [ ] **Step 10: Commit.**

```powershell
git add src/shared/ipc.ts src/main/services/changeReview/query.ts src/main/ipc/reviewValidation.ts src/main/ipc/reviewHandlers.ts src/main/ipc/index.ts src/main/ipc/scanHandlers.ts tests/unit/services/changeReviewQuery.test.ts tests/unit/ipc/reviewValidation.test.ts
git commit -m "Expose typed change review queries" -m "Generated with [Devin](https://devin.ai)" -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Task 11: Render review reports and add backward-compatible CLI mode

**Files:**

- Create: `src/main/services/changeReview/report.ts`
- Create: `src/cli/options.ts`
- Modify: `src/cli/main.ts:1-136`
- Modify: `src/main/ipc/reviewHandlers.ts`
- Create: `tests/unit/services/changeReviewReport.test.ts`
- Create: `tests/unit/cli/options.test.ts`

**Interfaces:**

- Produces `renderChangeReview(result, context, format)` and `reviewFileExtension(format)`.
- Produces `parseCliOptions(argv, cwd)` and `renderCliHelp()` while preserving existing `--format text|json|sarif`, baseline, and fail-on behavior.
- Adds `--help`, `--review`, `--review-format text|json|markdown|html`, `--review-output`, and `--review-depth`; help exits before opening SQLite or scanning.
- GUI `review:export` uses native dialog and returns `{ cancelled, fileName }`; CLI uses an explicit path and never opens a dialog.

- [ ] **Step 1: Write failing renderer tests for equivalent semantic content in text, Markdown, JSON, and HTML; relative paths; stale banner; category availability; counts/truncation; shortest paths; HTML escaping; and no scripts/remote assets/absolute roots.** Define `reviewResult()` in the test as a complete Task 1 `ChangeReviewResult` with one item in each category and an impact path `core.ts → feature.ts → app.test.ts`.

```ts
it('renders an unavoidable stale warning in every human format', () => {
  const context = { freshness: 'stale' as const, staleReasons: ['WORKTREE_CHANGED'] };
  for (const format of ['text', 'markdown', 'html'] as const) {
    expect(renderChangeReview(reviewResult(), context, format)).toMatch(/stale/i);
  }
});
```

- [ ] **Step 2: Write failing CLI option tests proving old `--format sarif` remains unchanged and HTML review requires output.**

```ts
expect(parseCliOptions(['.', '--format', 'sarif'], '/work')).toMatchObject({
  format: 'sarif',
  review: false,
});
expect(() => parseCliOptions(['.', '--review', '--review-format', 'html'], '/work')).toThrow(
  /--review-output/,
);
```

- [ ] **Step 3: Run `npx vitest run tests/unit/services/changeReviewReport.test.ts tests/unit/cli/options.test.ts`.**

Expected: FAIL because the report/options modules do not exist.

- [ ] **Step 4: Implement four deterministic report renderers.** Reuse escaping behavior, include all required provenance/limits/availability/paths, never include result IDs in semantic JSON, and preserve sorted arrays.

- [ ] **Step 5: Move existing CLI parsing into `src/cli/options.ts` without behavior changes, then add help and review flags.** `renderCliHelp()` lists every existing and review option; `--help` writes it and returns before database creation. In review mode call `coordinator.runNow` instead of running a duplicate preliminary scan; write text/JSON/Markdown to stdout unless output is explicit; require output for HTML.

- [ ] **Step 6: Complete GUI `review:export`.** Revalidate freshness, render retained result with stale context, open a native save dialog with safe default basename, write UTF-8, and return basename only.

- [ ] **Step 7: Run focused tests, `tests/unit/services/reportService.test.ts`, `npm run typecheck:node`, and `npm run scan -- --help`.**

Expected: PASS; help prints without creating a database or scanning, and existing scan output remains byte-compatible for equivalent arguments.

- [ ] **Step 8: Commit.**

```powershell
git add src/main/services/changeReview/report.ts src/cli/options.ts src/cli/main.ts src/main/ipc/reviewHandlers.ts tests/unit/services/changeReviewReport.test.ts tests/unit/cli/options.test.ts
git commit -m "Export change reviews in GUI and CLI" -m "Generated with [Devin](https://devin.ai)" -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Task 12: Add the Change Review workspace shell and explicit run lifecycle

**Files:**

- Create: `src/renderer/src/store/reviewStore.ts`
- Create: `src/renderer/src/components/views/ChangeReview.tsx`
- Create: `src/renderer/src/components/changeReview/ReviewHeader.tsx`
- Create: `src/renderer/src/components/changeReview/ReviewTabs.tsx`
- Modify: `src/renderer/src/store/uiStore.ts:7-23`
- Modify: `src/renderer/src/App.tsx:1-46`
- Modify: `src/renderer/src/components/layout/Sidebar.tsx:199-203`
- Modify: `src/renderer/src/components/layout/MainPanel.tsx:7-41`
- Create: `tests/unit/renderer/changeReviewState.test.ts`
- Create: `tests/unit/renderer/ChangeReviewShell.test.ts`

**Interfaces:**

- Produces `useReviewStore` actions `loadStatus`, `loadSummary`, `startReview`, `cancelReview`, `selectTab`, `setFilters`, `resetForProject`, and `markRequestGeneration`.
- Store keeps status, summary, operation, selected workspace tab, filters, selected depth, request generation, loading/error state; page items remain component-local.
- Adds `change-review` to `ViewId`, app view map, primary sidebar navigation, title map, and `CODE_CAPABLE`.
- Workspace tabs are `overview`, `files-and-edges`, `findings`, `possible-impact`, and `limitations`.

- [ ] **Step 1: Write failing pure store tests with a mocked typed `invoke`.** Assert project reset, explicit start only, polling completion, cancellation-requested state, summary refresh, and stale generation ignoring older responses. Define `status(overrides)` in the test as a complete `ReviewStatus` with fixed project/base identity, empty `gitChanges`, no latest review, and no active operation before applying overrides.

```ts
it('does not start a review while loading status', async () => {
  invokeMock.mockResolvedValue(status({ repositoryState: 'ready', activeOperation: null }));
  await useReviewStore.getState().loadStatus(7);
  expect(invokeMock).toHaveBeenCalledWith('review:status', { projectId: 7 });
  expect(invokeMock).not.toHaveBeenCalledWith('review:start', expect.anything());
});
```

- [ ] **Step 2: Write failing static-render tests for no project, not-Git, unborn-HEAD, ready-not-run, running, cancellation requested, stale, and current states.** Assert `aria-live="polite"`, textual status beyond color, disabled Run Review for unavailable baselines, and no automatic start call.

- [ ] **Step 3: Run `npx vitest run tests/unit/renderer/changeReviewState.test.ts tests/unit/renderer/ChangeReviewShell.test.ts`.**

Expected: FAIL because the store and components do not exist.

- [ ] **Step 4: Implement the store with request generations and defensive arrays.** Poll `review:status` every 500 ms only while an operation is active; clear the timer on project change/unmount; load summary after operation disappears.

- [ ] **Step 5: Implement header and tabs.** Use semantic buttons, `role="tablist"`, `role="tab"`, `aria-selected`, arrow-key focus, visible focus, depth input clamped 1–25, and explicit Run/Cancel/Export controls.

- [ ] **Step 6: Wire navigation and render the shell.** Do not load detail pages yet; each tab gets a precise empty/loading state and the approved cautious wording.

- [ ] **Step 7: Run focused tests and `npm run typecheck:web`.**

Expected: PASS; preload remains unchanged.

- [ ] **Step 8: Commit.**

```powershell
git add src/renderer/src/store/reviewStore.ts src/renderer/src/components/views/ChangeReview.tsx src/renderer/src/components/changeReview/ReviewHeader.tsx src/renderer/src/components/changeReview/ReviewTabs.tsx src/renderer/src/store/uiStore.ts src/renderer/src/App.tsx src/renderer/src/components/layout/Sidebar.tsx src/renderer/src/components/layout/MainPanel.tsx tests/unit/renderer/changeReviewState.test.ts tests/unit/renderer/ChangeReviewShell.test.ts
git commit -m "Add the explicit Change Review workspace" -m "Generated with [Devin](https://devin.ai)" -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Task 13: Render paginated evidence, filters, limitations, diffs, and export

**Files:**

- Create: `src/renderer/src/components/changeReview/ReviewFilters.tsx`
- Create: `src/renderer/src/components/changeReview/ReviewPage.tsx`
- Create: `src/renderer/src/components/changeReview/ReviewDiff.tsx`
- Modify: `src/renderer/src/components/views/ChangeReview.tsx`
- Modify: `src/renderer/src/store/reviewStore.ts`
- Create: `tests/unit/renderer/ChangeReviewResults.test.ts`

**Interfaces:**

- `ReviewFilters` renders only controls applicable to the active query section and sends closed typed criteria.
- `ReviewPage` renders the discriminated `ReviewItem` union and next/previous cursor stack; it labels filtered counts as retained-only when the category is truncated.
- `ReviewDiff` shows old/new path, bounded diff, and exact omitted byte/line counts; it has no edit/save/format action.
- Export invokes `review:export` and shows returned basename only.

- [ ] **Step 1: Write failing static-render and pure view-model tests for all item types.** Cover file Git badges, added/removed edges, introduced/resolved findings, architecture, cycles, exports, direct/indirect impact, candidate tests, no-known-tests, and grouped limitations.

- [ ] **Step 2: Add failing tests for filter applicability, active textual labels, `aria-pressed`, total/retained/returned counts, cursor stack reset after filter changes, and defensive `page.items ?? []`.**

```ts
it('does not call a truncated filtered count the complete match total', () => {
  const html = renderResults(page({ totalCount: 5000, retainedCount: 2000, truncated: true }));
  expect(html).toContain('matching retained details');
  expect(html).toContain('5,000 total');
});
```

- [ ] **Step 3: Add failing diff tests for rename labels, truncation warning, omitted counts, stale-disabled action, and read-only presentation.**

- [ ] **Step 4: Run `npx vitest run tests/unit/renderer/ChangeReviewResults.test.ts`.**

Expected: FAIL because results components do not exist.

- [ ] **Step 5: Implement active-tab-to-query-section mapping and component-local page data.** Increment request generation on tab/filter/cursor/project/review changes and ignore older promises.

- [ ] **Step 6: Implement filters and rows using existing `Card`, `StatTile`, `SeverityBadge`, `PathLabel`, `Caveat`, `Warning`, and `Button`.** All delta/side states include words or symbols in addition to color and meet existing theme tokens. The empty impact copy is exactly `No additional affected files were found within the analyzed dependency graph and configured limits.` The empty test copy is exactly `No graph-reachable candidate test was found within the analyzed files and traversal limits. This does not mean no test exercises the change.`

- [ ] **Step 7: Implement diff and export actions.** Revalidation errors leave retained structural evidence visible, clear stale diff text, and announce the error without an absolute path.

- [ ] **Step 8: Run the focused test twice, `npm run typecheck:web`, and `npm run lint -- --quiet`.**

Expected: PASS with stable row order and no accessibility attribute regression.

- [ ] **Step 9: Commit.**

```powershell
git add src/renderer/src/components/changeReview/ReviewFilters.tsx src/renderer/src/components/changeReview/ReviewPage.tsx src/renderer/src/components/changeReview/ReviewDiff.tsx src/renderer/src/components/views/ChangeReview.tsx src/renderer/src/store/reviewStore.ts tests/unit/renderer/ChangeReviewResults.test.ts
git commit -m "Render change review evidence" -m "Generated with [Devin](https://devin.ai)" -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Task 14: Add freshness-safe graph, source, finding, rule, and inspector drill-down

**Files:**

- Create: `src/renderer/src/lib/reviewGraph.ts`
- Create: `src/renderer/src/components/changeReview/ReviewEvidenceInspector.tsx`
- Modify: `src/renderer/src/store/uiStore.ts:25-72`
- Modify: `src/renderer/src/components/views/GraphView.tsx:94-1058`
- Modify: `src/renderer/src/components/layout/Inspector.tsx:229-625`
- Modify: `src/renderer/src/components/views/Findings.tsx:284-446`
- Modify: `src/renderer/src/components/views/Dashboard.tsx:24-59`
- Modify: `src/renderer/src/components/views/ChangeReview.tsx`
- Create: `tests/unit/renderer/reviewGraph.test.ts`
- Create: `tests/unit/renderer/ChangeReviewDrilldown.test.ts`

**Interfaces:**

- Produces `reviewItemToGraphOverlay(item): ReviewGraphOverlay` from retained edge/cycle/impact path evidence; no extra IPC channel.
- Adds `reviewGraphOverlay`, `reviewEvidence`, `focusedFindingFingerprint`, `showReviewGraph`, `showReviewEvidence`, `focusFinding`, and `clearReviewContext` to `uiStore`.
- Normal current destinations are allowed only when summary freshness is current. Baseline-only and stale evidence stays in review overlay/inspector; deleted content opens current bounded diff evidence only.
- Dashboard working-tree card links to `change-review` and no longer computes a second detailed workflow.

- [ ] **Step 1: Write failing pure graph-overlay tests.** Assert node/edge construction from added/removed edge, cycle path, and baseline/target impact explanation; stable IDs; textual side/delta metadata; and 2D-only mode. Define `impactItem(overrides)` in the test as a complete `ReviewImpactItem` with `itemType: 'affected-file'`, fixed stable key/path/depth/directness, and empty origins/explanations before overrides.

```ts
const overlay = reviewItemToGraphOverlay(
  impactItem({
    explanations: [
      {
        side: 'baseline',
        originPath: 'core.ts',
        path: ['core.ts', 'feature.ts', 'app.ts'],
        edgeTypes: ['import', 'import'],
      },
    ],
  }),
);
expect(overlay.payload.nodes.map((node) => node.path)).toEqual(['app.ts', 'core.ts', 'feature.ts']);
expect(overlay.title).toContain('HEAD');
```

- [ ] **Step 2: Write failing drill-down tests.** Cover current source/graph/finding focus after revalidation; stale review staying in retained inspector; baseline-only node never invoking `graph:file-detail`; deleted file opening diff rather than `source:read`; rule semantic mismatch disabling the rule link; and focus return to the triggering row.

- [ ] **Step 3: Run `npx vitest run tests/unit/renderer/reviewGraph.test.ts tests/unit/renderer/ChangeReviewDrilldown.test.ts tests/unit/renderer/Dashboard.test.ts`.**

Expected: FAIL because review overlay state and drill-down do not exist.

- [ ] **Step 4: Implement `reviewItemToGraphOverlay` and review UI state.** Keep review selection separate from `selectedNodeId`, as existing multi-selection already does. Clear review context on project/review change.

- [ ] **Step 5: Add an explicit Review Evidence banner and Clear action to `GraphView`.** Replace the ordinary payload while overlay is active, disable 360 mode and current-only filters, apply deliberate added/removed/baseline/target classes, and do not add hover behavior.

- [ ] **Step 6: Branch `Inspector` to `ReviewEvidenceInspector` before current `graph:file-detail` effects.** Render retained metadata and paths only; never query a baseline-only node against current SQLite.

- [ ] **Step 7: Add fingerprint focus to `FindingsView`.** After current freshness validation, navigate to the existing finding-type view, load current findings, match fingerprint, move keyboard cursor/focus, and clear the one-shot focus state.

- [ ] **Step 8: Replace Dashboard’s sentence-only `ChangedImpact` detail with a defensive status summary and an `Open Change Review` action.** Git/status failures stay quiet only when the folder is not a Git repository; other sanitized failures show a bounded caveat.

- [ ] **Step 9: Run focused tests, `npm run typecheck:web`, and `npm run lint -- --quiet`.**

Expected: PASS with no current/baseline identity confusion and no pointer-driven repaint.

- [ ] **Step 10: Commit.**

```powershell
git add src/renderer/src/lib/reviewGraph.ts src/renderer/src/components/changeReview/ReviewEvidenceInspector.tsx src/renderer/src/store/uiStore.ts src/renderer/src/components/views/GraphView.tsx src/renderer/src/components/layout/Inspector.tsx src/renderer/src/components/views/Findings.tsx src/renderer/src/components/views/Dashboard.tsx src/renderer/src/components/views/ChangeReview.tsx tests/unit/renderer/reviewGraph.test.ts tests/unit/renderer/ChangeReviewDrilldown.test.ts tests/unit/renderer/Dashboard.test.ts
git commit -m "Connect review evidence to TraceDeck drill-down" -m "Generated with [Devin](https://devin.ai)" -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Task 15: Add a minimal Electron end-to-end review harness

**Files:**

- Modify through package manager: `package.json`, `package-lock.json`
- Create: `playwright.config.ts`
- Create: `tests/e2e/changeReview.spec.ts`

**Interfaces:**

- Adds scripts `test:e2e` and `test:e2e:build`.
- Uses the existing Electron binary; downloads no browser and makes no network request at test runtime.
- Seeds a temporary GUI database under a temporary Electron user-data directory, launches the real built main/preload/renderer, and points the seeded project row at a temporary Git repository.

- [ ] **Step 1: Verify the pinned packages remain older than seven days, then install through npm.**

Run: `npm install --save-dev @playwright/test@1.62.1 playwright@1.62.1`

Expected: `package.json` and `package-lock.json` change; no production dependency changes.

- [ ] **Step 2: Add `test:e2e:build` as `npm run build` and `test:e2e` as `npm run test:e2e:build && playwright test`.** Create `playwright.config.ts` with `testDir: './tests/e2e'`, one worker, no retries locally, 120-second test timeout, and list reporter.

- [ ] **Step 3: Write the failing Playwright scenario.** Before launch, create a temporary Git repository and `tracedeck.db`, run the real migrations, insert its project row, and launch Electron with that directory as user data. The scenario must navigate to Change Review, run, observe progress through the polite live region, inspect one affected path, open and clear the graph overlay, export through a main-process stubbed native save-dialog result, mutate the working tree, and observe stale state.

```ts
test('reviews the working tree without changing Git state', async ({}, testInfo) => {
  const fixture = await createElectronReviewFixture(testInfo.outputPath('fixture'));
  const before = await fixture.gitStatusBytes();
  const electronApp = await electron.launch({
    args: [resolve('out/main/index.js'), `--user-data-dir=${fixture.userData}`],
  });
  const page = await electronApp.firstWindow();

  await page.getByRole('button', { name: 'Change Review' }).click();
  await page.getByRole('button', { name: 'Run Review' }).click();
  await expect(page.getByText(/structurally affect/i)).toBeVisible();
  expect(await fixture.gitStatusBytes()).toEqual(before);

  await electronApp.close();
});
```

Implement the fixture in the same test file with `execFile` Git calls and direct `better-sqlite3` migration seeding; do not add a production test backdoor or automate an OS folder picker.

- [ ] **Step 4: Run `npm run test:e2e`.**

Expected before completing selectors/fixture: FAIL at the first missing review interaction. Expected after completion: PASS without browser download.

- [ ] **Step 5: Run `npm test`, `npm run typecheck`, and `npm run lint`.**

Expected: PASS.

- [ ] **Step 6: Commit.**

```powershell
git add package.json package-lock.json playwright.config.ts tests/e2e/changeReview.spec.ts
git commit -m "Test Change Review across Electron boundaries" -m "Generated with [Devin](https://devin.ai)" -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Task 16: Update product documentation and perform full cross-platform verification

**Files:**

- Modify: `README.md`
- Modify: `DEVELOPMENT-SPEC.md`
- Modify: `docs/AGENT-BRIEFING.md`
- Modify only if a covered defect is found: Task 1 production or test files listed above

**Interfaces:**

- Documents exact channels, migration, workflow, limits, type-check exclusion, stale behavior, CLI flags, report formats, security invariants, and honest limitations.
- Produces final evidence that normal/incremental scans, CLI, GUI build, and packaged targets retain existing behavior.

- [ ] **Step 1: Update docs from shipped behavior, not the plan.** Mark Task 1 delivered only after all focused tests pass. Keep working tree/Git/review-scan/ordinary-scan distinctions explicit and retain cautious impact/test wording.

- [ ] **Step 2: Run deterministic focused suites twice.**

```powershell
npx vitest run tests/unit/utils/changeReviewCanonical.test.ts tests/unit/algorithms/reachableExports.test.ts tests/unit/algorithms/reviewComparator.test.ts tests/unit/algorithms/reviewImpact.test.ts tests/integration/changeReview.test.ts
npx vitest run tests/unit/utils/changeReviewCanonical.test.ts tests/unit/algorithms/reachableExports.test.ts tests/unit/algorithms/reviewComparator.test.ts tests/unit/algorithms/reviewImpact.test.ts tests/integration/changeReview.test.ts
```

Expected: both runs PASS with equal serialized semantic fixtures.

- [ ] **Step 3: Run all quality gates.**

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

Expected: exit code 0 for each.

- [ ] **Step 4: Exercise CLI compatibility and review output against a temporary repository.**

```powershell
$reviewFixture = Join-Path $env:TEMP "tracedeck-review-cli-$PID"
New-Item -ItemType Directory -Path $reviewFixture | Out-Null
Copy-Item -Recurse "tests/fixtures/sample-project/*" $reviewFixture
git -C $reviewFixture init
git -C $reviewFixture -c user.name=TraceDeckTest -c user.email=test@example.invalid add .
git -C $reviewFixture -c user.name=TraceDeckTest -c user.email=test@example.invalid commit -m baseline
Add-Content (Join-Path $reviewFixture "src/app.ts") "`nexport const reviewChange = true;"
npm run scan -- "$reviewFixture" --format json
npm run scan -- "$reviewFixture" --review --review-format text
npm run scan -- "$reviewFixture" --review --review-format json
npm run scan -- "$reviewFixture" --review --review-format markdown --review-output "$env:TEMP\tracedeck-review.md"
npm run scan -- "$reviewFixture" --review --review-format html --review-output "$env:TEMP\tracedeck-review.html"
Remove-Item -Recurse -Path "$reviewFixture" -ErrorAction Stop
```

Expected: the existing JSON scan shape remains available; every review output names `HEAD`, uses relative evidence paths, and includes limitations/truncation. Remove only the just-created `$reviewFixture` after verification.

- [ ] **Step 5: Run unpacked packaging smoke checks on the host and require CI matrix checks for other platforms.**

```powershell
npm run package
```

Expected on Windows: NSIS-directory build succeeds and launches with `better-sqlite3` and local parser WASM. CI must run equivalent macOS DMG and Linux AppImage build/smoke jobs before release; no task claims those hosts were verified when they were not run.

- [ ] **Step 6: Inspect the complete diff.** Reject absolute-path leakage, source/diff persistence, arbitrary refs, shell commands, link traversal, hidden caps, renderer-held full results, unrelated refactors, new pointer-hover graph behavior, external assets, and weakened tests.

- [ ] **Step 7: Obtain an independent whole-change review and resolve every critical or important finding.** Re-run affected focused tests after every correction.

- [ ] **Step 8: Commit documentation and any verified corrections.**

```powershell
git add README.md DEVELOPMENT-SPEC.md docs/AGENT-BRIEFING.md
git commit -m "Document the Change Review workflow" -m "Generated with [Devin](https://devin.ai)" -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

## Plan Completion Gate

Do not begin Task 1 implementation until the user explicitly approves this plan and chooses an execution mode. Approval of the design document alone is not implementation approval.
