# Complete Project Inventory and Local Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inventory every project file under explicit safety policy, expose all inventory entries in Explorer/viewer, report analysis coverage honestly, and add conflict-safe local text editing.

**Architecture:** Add a `project_files` inventory beside the existing graph-only `files` table. Discovery produces inventory plus the analyzable subset; IPC and UI consume inventory for file access while graph algorithms keep consuming `files`. Source writes remain main-process-owned, path-contained, hash-guarded, bounded, and followed by incremental analysis.

**Tech Stack:** Electron, TypeScript, Node.js filesystem/crypto APIs, SQLite via better-sqlite3, React, Zustand, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-complete-project-inventory-editor-design.md`

## Global Constraints

- Fully offline and private: no network access, telemetry, or external schema lookup.
- No new runtime dependency.
- Same project state yields the same sorted inventory, graph, findings, limitations, and reports.
- `.gitignore` records metadata and never removes a regular file from inventory.
- `.git`, dependency/vendor directories, build outputs, framework caches, and symlink traversal remain hard safety boundaries.
- Existing graph findings retain their meanings; non-source files never become fake graph nodes.
- Every production behavior is introduced with a focused test that is observed failing before implementation.
- Existing user changes are preserved and no existing test is weakened or deleted.

---

### Task 1: Persist an authoritative project inventory

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/db/migrations.ts`
- Modify: `src/main/db/rows.ts`
- Create: `src/main/db/repositories/projectFileRepository.ts`
- Modify: `src/main/db/index.ts`
- Modify: `tests/unit/db/migrations.test.ts`
- Modify: `tests/unit/db/repositories.test.ts`

**Interfaces:**
- Produces `ProjectFile`, `ProjectFileEntryKind`, `ProjectFileContentKind`, `ProjectFileAnalysisStatus`.
- Produces `ProjectFileRepository.listByProject`, `findByPath`, `upsertMany`, `reassignToScan`, `removeByIds`, `countByProject`, and `countsByCapability`.
- Existing `FileRepository` and its symbol/edge foreign keys remain unchanged.

- [ ] **Step 1: Write migration and repository tests that fail because `project_files` and `store.projectFiles` do not exist.**

```ts
expect(tableNames(db)).toContain('project_files');
expect(store.projectFiles.listByProject(project.id).map((file) => file.relativePath)).toEqual([
  'README.md',
  'src/index.ts',
]);
```

- [ ] **Step 2: Run `npx vitest run tests/unit/db/migrations.test.ts tests/unit/db/repositories.test.ts` and confirm the missing table/repository failures.**
- [ ] **Step 3: Add migration version 2 and the typed repository.** Use a unique `(project_id, relative_path)` constraint, a scan foreign key with cascade, deterministic path ordering, nullable content hash/encoding, booleans stored as integers, and checked enum columns from the design.
- [ ] **Step 4: Implement upsert/reassignment/removal and literal capability counts without changing `FileRepository`.**
- [ ] **Step 5: Re-run the focused database tests and confirm they pass.**

### Task 2: Discover every policy-visible entry and derive the analysis subset

**Files:**
- Modify: `src/main/analysis/discovery.ts`
- Modify: `src/main/utils/gitignore.ts`
- Create: `src/main/services/fileClassificationService.ts`
- Modify: `tests/unit/analysis/discovery.test.ts`
- Create: `tests/unit/services/fileClassificationService.test.ts`
- Modify: fixtures under `tests/fixtures/asset-heavy-project` and `tests/fixtures/ignore-precedence-project`

**Interfaces:**
- `DiscoveryResult.inventory` contains every regular file and symlink entry outside hard-excluded subtrees.
- `DiscoveryResult.files` remains the sorted graph-eligible `DiscoveredFile[]` compatibility subset.
- `classifyProjectFile(path, stats)` returns content kind, encoding, optional hash, and bounded capability status without decoding binary content.

- [ ] **Step 1: Add failing discovery tests asserting asset-heavy inventory paths include JS, HTML, CSS, JSON, Markdown, and `.gitignore`, while `files` contains only supported graph sources.**
- [ ] **Step 2: Add a failing test proving a `.gitignore`-matched source remains in inventory with its exact rule and is not removed merely because it is ignored.**
- [ ] **Step 3: Add failing classifier tests for UTF-8, UTF-8 BOM, UTF-16LE/BE BOM, invalid UTF-8/NUL binary content, empty files, and oversize metadata.**
- [ ] **Step 4: Run the two focused test files and confirm failures identify the absent inventory/classifier behavior.**
- [ ] **Step 5: Refactor discovery so hard exclusions alone prune traversal, policy decisions are metadata, and analyzer eligibility is derived after metadata/stat/classification.**
- [ ] **Step 6: Re-run focused tests twice and assert equal inventory order and diagnostics on both runs.**

### Task 3: Store complete scan inventory and accurate metrics

**Files:**
- Modify: `src/main/analysis/scanner.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/services/analysisService.ts`
- Modify: `tests/integration/scan.test.ts`
- Modify: `tests/unit/algorithms/*` only if typed fixture builders require the new dashboard fields

**Interfaces:**
- New `ScanSummary` fields: `inventoryFiles`, `graphEligibleFiles`, `textOnlyFiles`, `binaryFiles`, `ignoredFiles`, `unavailableFiles`.
- New `DashboardStats` fields use inventory counts; `totalFiles` becomes the inventory total and `graphEligibleFiles` is explicit.
- Scanner upserts/removes/reassigns inventory rows independently from graph rows before pruning old scans.

- [ ] **Step 1: Add an integration test that scans the mixed asset fixture and fails unless inventory count includes all files while graph count remains one.**
- [ ] **Step 2: Add incremental-scan assertions proving removed inventory entries disappear, unchanged graph files remain reusable, and scan pruning retains current inventory rows.**
- [ ] **Step 3: Run `npx vitest run tests/integration/scan.test.ts` and confirm the count/persistence failures.**
- [ ] **Step 4: Thread `DiscoveryResult.inventory` through scanner persistence and construct structured metrics from repository facts rather than limitation strings.**
- [ ] **Step 5: Make dashboard stats read `projectFiles` for inventory totals and `files` for graph totals.**
- [ ] **Step 6: Re-run integration and repository tests and confirm they pass.**

### Task 4: Expose complete inventory to Explorer and the viewer

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/main/ipc/analysisHandlers.ts`
- Modify: `src/main/services/analysisService.ts`
- Modify: `src/main/ipc/systemHandlers.ts`
- Modify: `src/main/services/sourceService.ts`
- Modify: `src/renderer/src/components/views/Explorer.tsx`
- Modify: `src/renderer/src/components/views/CodePanel.tsx`
- Modify: `tests/unit/ipc/validation.test.ts`
- Modify: `tests/unit/services/sourceService.test.ts`
- Create: `tests/unit/renderer/Explorer.test.tsx`

**Interfaces:**
- Add `inventory:list` returning every sorted `ProjectFile` for a project with no implicit cap.
- `source:read`, `system:open-path`, and `system:reveal-path` authorize against inventory rows.
- `SourceDocument` becomes a discriminated text/unavailable result; text includes raw text, encoding, hash, line metadata, and `editable`.

- [ ] **Step 1: Add failing service/IPC tests proving an inventory HTML file can be read/opened even though it has no graph row and binary/symlink entries return explicit unavailable results.**
- [ ] **Step 2: Add a failing Explorer behavior test proving extensionless and more-than-200 inventory paths are retained without querying for `"."`.**
- [ ] **Step 3: Run the focused service/renderer tests and confirm the current graph-row gate and 200-item cap fail them.**
- [ ] **Step 4: Add the inventory IPC and switch Explorer tree construction/search file paths to inventory data.**
- [ ] **Step 5: Make source reads classify and decode only supported text encodings, return bounded unavailable states, and preserve existing lossless syntax spans for code.**
- [ ] **Step 6: Render text, binary, oversized, unreadable, and symlink states explicitly; label the external action “Open with system default.”**
- [ ] **Step 7: Re-run focused tests and confirm they pass.**

### Task 5: Harden file access and add conflict-safe unlock/edit/save

**Files:**
- Modify: `src/main/utils/paths.ts`
- Modify: `src/main/ipc/registry.ts`
- Create: `src/main/services/sourceWriteService.ts`
- Modify: `src/main/ipc/systemHandlers.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/renderer/src/components/views/CodePanel.tsx`
- Modify: `src/renderer/src/store/appStore.ts`
- Modify: `tests/unit/ipc/validation.test.ts`
- Create: `tests/unit/services/sourceWriteService.test.ts`
- Create: `tests/unit/renderer/CodePanel.test.tsx`

**Interfaces:**
- `resolveSafeProjectFile(rootPath, relativePath)` validates lexical containment, real parent/target containment, regular-file status, and rejects links/reparse targets.
- Add `source:save` request `{ projectId, relativePath, baseHash, text }`; success returns a fresh text document, stale content returns `SOURCE_CONFLICT`.
- CodePanel modes are `locked` and `editing`, with Save and Discard Changes actions and dirty-navigation protection.

- [ ] **Step 1: Add failing path tests for a replaced symlink/junction target and a target whose real parent escapes the project.**
- [ ] **Step 2: Add failing write-service tests for successful bounded UTF-8 save, preserved mode, stale hash conflict with unchanged disk bytes, binary/oversize rejection, and temporary-file cleanup on failure.**
- [ ] **Step 3: Add failing renderer behavior tests for locked default, Unlock visibility only on editable text, dirty Save/Discard, conflict draft retention, and close/file-switch confirmation.**
- [ ] **Step 4: Run focused tests and confirm failures are caused by the missing hardened resolver/save/editor states.**
- [ ] **Step 5: Implement trusted-main-frame IPC validation and safe real-path resolution for read/open/reveal/save.**
- [ ] **Step 6: Implement hash-guarded same-directory temporary write and return a freshly read document.**
- [ ] **Step 7: Add CodePanel editing controls; after save call the existing incremental scan action and relock only after the write succeeds.**
- [ ] **Step 8: Re-run focused tests and confirm they pass.**

### Task 6: Surface concrete syntax and conflict findings

**Files:**
- Modify: `src/main/analysis/parser.ts`
- Create: `src/main/analysis/textDiagnostics.ts`
- Modify: `src/main/analysis/scanner.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc/analysisHandlers.ts`
- Modify: `tests/unit/analysis/parser.test.ts`
- Create: `tests/unit/analysis/textDiagnostics.test.ts`
- Modify: `tests/integration/scan.test.ts`

**Interfaces:**
- Extend `FindingType` with `syntax-error`, `merge-conflict`, and `file-read-error`.
- `ParsedFile.parseErrors` contains real TypeScript parser diagnostics with line, column, code, and message.
- `diagnoseTextFile` returns JSON parser diagnostics and complete merge-marker ranges for decodable inventory text.

- [ ] **Step 1: Add failing parser tests for malformed TS/JS syntax with stable locations and JSON syntax failures.**
- [ ] **Step 2: Add failing tests for complete and incomplete Git conflict-marker groups while ensuring marker-like prose is not reported.**
- [ ] **Step 3: Add an integration test asserting findings persist across incremental scans and disappear after the file is corrected.**
- [ ] **Step 4: Run focused tests and confirm syntax/conflict findings are absent before implementation.**
- [ ] **Step 5: Collect TypeScript `parseDiagnostics`, parse JSON through the TypeScript API, scan text lines for conflict groups, and persist typed findings with stable fingerprints.**
- [ ] **Step 6: Re-run focused tests and confirm they pass.**

### Task 7: Correct dashboard and report semantics

**Files:**
- Modify: `src/renderer/src/components/views/Dashboard.tsx`
- Modify: `src/main/services/reportService.ts`
- Modify: `tests/unit/renderer/Dashboard.test.ts`
- Modify: `tests/unit/services/reportService.test.ts`

**Interfaces:**
- Dashboard tiles and Markdown/JSON/HTML reports expose inventory and graph-eligible counts separately.
- “Parsed” appears only for parser-handled source/JSON counts; limitations remain bounded caveats, not substitute metrics.

- [ ] **Step 1: Add failing renderer/report assertions for `Project files`, `Graph source files`, `Text only`, `Binary`, `Ignored but included`, and changed/unchanged analysis counts.**
- [ ] **Step 2: Run focused tests and confirm current “Files scanned” wording/count fails.**
- [ ] **Step 3: Replace ambiguous labels and thread structured metrics through all report formats.**
- [ ] **Step 4: Re-run focused tests and confirm every format reports the same literal metrics.**

### Task 8: Real-project and full verification

**Files:**
- Modify only when verification reveals a covered defect.

**Interfaces:**
- Consumes final scanner, inventory, viewer, editor, findings, and report behavior.
- Produces fresh evidence for the user’s four real projects.

- [ ] **Step 1: Run the discovery and integration suites twice and compare deterministic outputs.**
- [ ] **Step 2: Re-measure the four real roots. For `C:\dev_project\RegexLab`, require six inventory entries, one graph source, five text-only/non-graph entries, and no silent exclusions.**
- [ ] **Step 3: Exercise viewer read and hash-conflict save against a temporary copy of RegexLab so the real project is never modified.**
- [ ] **Step 4: Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`; require exit code 0 for each.**
- [ ] **Step 5: Inspect the complete diff for project-specific logic, silent caps, network access, dependency changes, weakened tests, temporary instrumentation, and unhandled write paths.**
- [ ] **Step 6: Obtain an independent whole-change code review and address every critical or important finding before reporting completion.**
