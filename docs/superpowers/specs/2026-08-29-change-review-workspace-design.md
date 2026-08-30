# Change Review Workspace Design

**Date:** 2026-08-29  
**Status:** Approved for implementation planning  
**Roadmap project:** Task 1 of 13

## 1. Summary

TraceDeck will add a dedicated Change Review workspace that compares the current on-disk working tree with the repository's resolved `HEAD` commit. It will answer:

> What did this change structurally affect?

The workspace will combine Git change evidence, two TraceDeck analyses, structural deltas, possible impact, candidate tests, shortest explanation paths, and limitations. The first release supports only working tree versus `HEAD`. It does not support arbitrary refs, ref-to-ref comparison, unsaved editor buffers, or historical browsing.

A review runs only after the user chooses **Run Review**. TraceDeck refreshes the working-tree scan, materializes regular file blobs from the resolved `HEAD` tree into an application-owned OS temporary directory, scans that isolated tree into temporary SQLite, compares normalized analysis snapshots, and atomically retains only the latest completed review. It never checks out a commit, modifies the index, creates a Git worktree, follows a symlink, or writes source files.

All conclusions remain deterministic and evidence-backed. Empty affected sets are never described as proof that a file is safe. Unsupported or truncated analysis is shown as a limitation.

## 2. Product constraints

This design preserves the existing constitution:

- No AI, model integration, cloud service, account, synchronization, telemetry, analytics, or external API.
- Electron main process and local SQLite remain the architecture.
- `better-sqlite3` remains main-process only.
- The renderer remains sandboxed and has no filesystem, database, process, Git, or absolute-path access.
- The typed IPC contract remains closed and allowlisted.
- Git operations are local and read-only.
- Symlinks are listed but never traversed or created during baseline materialization.
- Complete inventory remains separate from graph-eligible sources.
- The existing editor unlock, guarded-write, and no-auto-save behavior is unchanged.
- Identical source, Git state, configuration, and analysis version produce identical semantic review results and stable ordering.
- Every conclusion comes from Git, parsed source, persisted graph evidence, or a deterministic algorithm over that evidence.
- Unsupported analysis and deliberate limits are visible.
- Product wording uses terms such as “possible impact,” “candidate test,” and “static analysis result.”

## 3. Scope decisions

The approved first-release decisions are:

1. **Comparison:** current on-disk working tree versus resolved `HEAD` only.
2. **Trigger:** explicit **Run Review**; opening the workspace does not start a scan.
3. **Persistence:** retain only the latest completed review per project across restarts.
4. **Export comparison:** compare JS/TS export names reachable from configured or manifest-backed entry points. Do not compare signatures or claim semantic-versioning impact.
5. **Historical state:** no review history and no arbitrary scan selection.
6. **Test evidence:** report graph-reachable candidate tests with shortest paths; do not claim coverage or sufficiency.

Task 1 establishes a reusable comparison envelope. Later roadmap projects may enrich individual providers without changing the workspace’s provenance and limitation model:

- Task 2 can provide simulated snapshots.
- Task 3 can replace the initial reachable-export provider with a deeper public API contract provider.
- Task 4 can replace the initial candidate-test provider with richer test-selection evidence.
- Task 5 can add repository-owned configuration and configuration equivalence rules.
- Tasks 6–8 can contribute new structural sections.
- Task 9 can generalize snapshot sources and persistence for time travel and arbitrary historical comparisons.

No later project is designed here.

## 4. Existing capabilities to reuse

The implementation should compose existing behavior rather than duplicate it:

- `src/main/services/gitService.ts` already provides an argument-array Git runner and per-file diff foundation. Task 1 must add a porcelain-v2 status parser because the current changed-file helper does not expose untracked files, staged/unstaged state, or rename pairs.
- `src/main/analysis/algorithms/blastRadius.ts` provides the GraphIndex traversal concepts, shortest-path evidence shape, and depth-truncation behavior that the review algorithm should reuse.
- `src/main/analysis/algorithms/diffImpact.ts` demonstrates current changed-file impact, test classification, entry-point detection, and touched-cycle behavior. A new `ReviewImpact` multi-source BFS is required because the current algorithm unions independent traversals and discards per-result provenance. The Dashboard helper should delegate to the shared review-impact primitives where possible rather than maintain a second change-impact implementation.
- `src/main/analysis/algorithms/scanCompare.ts` and `scan_snapshots` already compare finding fingerprints between recent scans. That Dashboard feature remains distinct from Change Review.
- `src/main/analysis/scanner.ts` already provides full and incremental scans, reconstructs unchanged parsed data, evaluates findings and architecture rules, and produces bounded limitations.
- Files, inventory, symbols, graph edges, findings, rules, dismissals, and snapshots already have main-process repositories.
- `src/main/services/reportService.ts` already renders Markdown, JSON, and escaped scriptless HTML.
- `src/shared/ipc.ts`, the preload allowlist, handler registry, payload validation, and path-boundary utilities already enforce the security boundary.
- Dashboard, Graph, Findings, Architecture, source panel, Inspector, and common UI components already provide most drill-down destinations.
- Graph highlighting and source selection already live in renderer state.

The current pieces are insufficient on their own because older graph rows are pruned, scan snapshots contain only finding fingerprints, `Scan.gitCommit` is currently written as `null`, current Git change parsing omits untracked files and does not model rename pairs, and `DiffImpactResult` discards per-result explanation paths.

## 5. Evidence model

### 5.1 Three evidence classes

The workspace must label and visually separate:

1. **Git differences**
   - Path and byte-state evidence from Git.
   - Staged, unstaged, and untracked state.
   - Aggregate added, modified, deleted, and renamed classification.

2. **TraceDeck review comparison**
   - Structural differences between an isolated full scan of `HEAD` and a completed scan of the captured working tree.
   - Added and removed dependency edges, findings, architecture violations, cycles, and reachable export names.
   - Possible impact and candidate tests derived from one or both graphs.

3. **Ordinary scan comparison**
   - Existing latest-two-scan finding comparison.
   - Remains on Dashboard and is never presented as equivalent to working tree versus `HEAD`.

### 5.2 Snapshot identity

Each review side has an immutable identity.

The baseline identity contains:

- Resolved full `HEAD` commit ID.
- Git tree ID where available.
- Baseline analysis fingerprint.
- User configuration fingerprint.
- Effective baseline analysis fingerprint.
- TraceDeck version and review-analysis schema version.

The working-tree identity contains:

- Resolved `HEAD` commit used as the base.
- Canonical Git status records.
- SHA-256 content evidence for every changed regular file.
- Explicit markers for deleted, unreadable, symlink, and unsupported entries.
- Working-tree scan ID and scan completion time.
- User configuration fingerprint.
- TraceDeck version and review-analysis schema version.

Mtime is not semantic identity. Regular changed files are hashed as byte streams so large binary or oversized files can be included in stale detection without being loaded into memory. Symlinks are identified with `lstat` and never dereferenced.

The semantic review fingerprint excludes generated timestamps, database row IDs, and UI preferences.

### 5.3 Configuration fingerprints

The review records two distinct fingerprints:

1. **User configuration fingerprint**
   - Full current project analysis configuration, including the requested type-check setting.
   - Enabled architecture rules, sorted by persistent rule ID and canonical semantic content.
   - Entry-point configuration.
   - Analysis constants and review-analysis schema version.
   - TraceDeck version when an analyzer change can alter results.

2. **Effective baseline analysis fingerprint**
   - The same parser, discovery, entry-point, and architecture inputs.
   - Type checking explicitly forced off for the isolated baseline.
   - The reason code `TYPE_ERROR_BASELINE_NOT_COMPARABLE` when the user enabled type checking.

Theme, window state, graph layout, open tabs, and other device UI preferences are excluded from both.

Baseline and working-tree structural analysis use the same current device-local discovery, parser, entry-point, and enabled architecture-rule configuration. Type checking is the sole deliberate difference and is represented explicitly rather than hidden. The review therefore answers how both trees fare under the structural policy active when the review runs. It does not claim to reconstruct architecture rules that may have existed when `HEAD` was created.

The **semantic rule fingerprint** is SHA-256 over canonical JSON containing rule name, rule type, normalized source pattern, normalized target pattern, severity, and sorted normalized exceptions. It excludes database row ID. Review violation identity combines the persistent rule ID with this semantic fingerprint so two same-shaped rules remain distinguishable while temporary-database IDs cannot alter comparison.

The **effective baseline analysis fingerprint** is SHA-256 over canonical JSON containing the structural project configuration with `typeCheck: false`, configured entry points, enabled rule records represented by persistent ID plus semantic rule fingerprint, structural analysis constants, review-analysis schema version, and TraceDeck analyzer version.

### 5.4 Normalized snapshot and result schema

A normalized `ReviewSnapshot` contains:

- Side: `baseline` or `target`.
- Snapshot identity and both applicable configuration fingerprints.
- Sorted inventory evidence with analysis eligibility and reason.
- Sorted graph-file records with language and entry-point state.
- Sorted resolved dependency-edge records.
- Sorted comparable findings with complete typed details.
- Sorted architecture violations.
- Sorted cycle identities and concrete paths.
- Sorted reachable export-name records.
- Category availability and side-specific limitations.

A persisted `ChangeReviewResult` contains:

- Review identity, provenance, selected depth, completion metadata, and fresh-at-completion state.
- Git change records with separate index/worktree state and aggregate classification.
- Added/removed edge records.
- Introduced/resolved finding records.
- Introduced/resolved architecture-violation records.
- Added/removed cycle records.
- Added/removed reachable-export records.
- Affected-file and candidate-test records from `ReviewImpact`.
- Changed files with no graph-reachable candidate test.
- Retained graph evidence: only normalized nodes and edges referenced by retained deltas and explanation paths.
- Per-category availability, total count, retained count, and truncation.
- Grouped, coded limitations.

The normalized source snapshots may be held in memory or temporary SQLite while comparison runs, but only `ChangeReviewResult` is retained in the application database. No source text is part of either IPC review results or persisted review JSON.

## 6. Review lifecycle

### 6.1 Opening the workspace

Opening Change Review performs only bounded, read-only status work:

- Verify that the folder is a Git repository.
- Resolve `HEAD`.
- Read canonical Git status.
- Load latest completed review metadata.
- Determine whether that review is current, stale, incompatible, or absent.

The UI may show Git changes before structural analysis exists, but it must label structural sections **Not analyzed** until Run Review succeeds.

Across a restart, status calculation recomputes the working-tree fingerprint. While the app is running, filesystem watcher events immediately mark a retained review stale; exact fingerprint validation still occurs before a stale review is reused or exported.

### 6.2 Run Review phases

The visible phases are:

1. **Capturing repository state**
   - Resolve `HEAD` once.
   - Parse porcelain-v2 status.
   - Hash changed on-disk entries.
   - Capture the user configuration fingerprint and derive the effective baseline analysis fingerprint.

2. **Refreshing working-tree analysis**
   - Acquire the project’s exclusive analysis-operation slot.
   - Run an incremental scan through the existing scanner.
   - The completed scan remains a valid normal scan even if the later review is cancelled.

3. **Preparing the `HEAD` baseline**
   - Enumerate the immutable tree.
   - Validate size and file-count ceilings.
   - Materialize regular blobs into an application-owned OS temporary directory.
   - Record symlinks, submodules, case collisions, unreadable blobs, and unsupported entries as limitations.

4. **Analyzing `HEAD`**
   - Create a temporary SQLite database and temporary project.
   - Copy analysis configuration and enabled architecture-rule identity.
   - Run a full scan.
   - Normalize temporary absolute paths from retained evidence.

5. **Comparing evidence**
   - Create normalized immutable snapshots.
   - Compute every available category.
   - Compute total counts before deterministic result truncation.

6. **Validating freshness**
   - Re-resolve `HEAD`.
   - Recompute the configuration and working-tree fingerprints.
   - Reject the candidate if any identity input changed.

7. **Persisting**
   - Atomically replace the previous completed review.
   - Publish the new review ID only after the transaction succeeds.

8. **Cleanup**
   - Close temporary SQLite.
   - Remove temporary files.
   - Release the project operation slot.

### 6.3 Stale and failure behavior

A candidate is discarded and the previous completed review remains intact when:

- The user cancels.
- `HEAD`, the working tree, or analysis configuration changes during the run.
- Baseline materialization exceeds its safety ceiling.
- A required Git object cannot be read.
- The isolated scan fails.
- Comparison or persistence fails.

A watcher event during review marks the candidate potentially stale. After review cleanup, TraceDeck schedules the normal incremental scan that the watcher would otherwise have requested.

A process crash leaves no completed candidate row. Each run creates exactly one root named `tracedeck-review-<uuid>` directly beneath the OS temporary directory and writes `.tracedeck-review-marker` inside it. The marker contains the same UUID, the creating TraceDeck version, and an ISO start time. On startup, cleanup examines only direct children matching that prefix, requires a regular non-symlink marker whose UUID matches the directory name, and removes only roots older than 24 hours. A missing, malformed, young, or symlink marker causes cleanup to skip the directory. TraceDeck never recursively deletes an unverified directory.

## 7. Main-process architecture

### 7.1 `ChangeReviewCoordinator`

Responsibilities:

- Enforce one active review per project.
- Share an exclusive project operation slot with ordinary scans.
- Own operation ID, phase, progress, cancellation state, and stale flag.
- Invoke current scan, materializer, isolated scan, comparator, and persistence.
- Keep active operation state in main-process memory only.
- Never publish partial result data.

A normal user-started scan while review is active receives `REVIEW_IN_PROGRESS`. Run Review while a normal scan is active receives `SCAN_IN_PROGRESS`. Watcher requests are coalesced for execution after the active operation.

### 7.2 `GitReviewService`

Responsibilities:

- Resolve `HEAD` to a commit without accepting an arbitrary renderer-provided ref.
- Add a `GitStatusV2` parser for `git status --porcelain=v2 -z --untracked-files=all`; the existing `gitChangedFiles` parser is not reused for review classification.
- Preserve staged and unstaged status independently.
- Preserve old and new paths only when Git supplies rename or copy evidence.
- Normalize path separators and sort records.
- Produce bounded unified diffs with external diff drivers and text conversion disabled.

Review Git operations use a new streaming process runner because status, tree, and blob output can exceed the existing 5 MiB buffered runner. It uses executable-plus-argument arrays, accepts an `AbortSignal`, kills the child on cancellation, bounds stderr retained for diagnostics, and never invokes a shell. Hard timeouts are 20 seconds for `rev-parse`, 60 seconds for status and tree enumeration, 30 seconds for a file diff, and 5 minutes for the streamed `cat-file` batch. Timeout and cancellation are distinct sanitized errors.

It does not run hooks, checkout, reset, clean, worktree, submodule initialization, smudge filters, mergetool, or configured external diff commands.

Ignored untracked files are outside the review change set. The status response reports their exclusion as a general Git-scope limitation without enumerating them.

### 7.3 `GitTreeMaterializer`

Responsibilities:

- Enumerate regular blobs, symlink blobs, and submodule entries from the resolved immutable tree.
- Parse NUL-delimited Git path output as bytes and reject a path that is not valid UTF-8 with `INVALID_GIT_PATH_ENCODING`; shared review paths are strings, so undecodable bytes are never replaced or guessed.
- Reject absolute paths, parent traversal, malformed records, and any resolved destination outside its temporary root.
- Detect destination collisions before writing by lowercasing each normalized POSIX path with Unicode-default case conversion; two distinct tree paths with the same lowered key produce `CASE_COLLISION` and abort on every operating system, including case-sensitive Linux.
- Write regular blobs only.
- Never create a filesystem symlink or follow a repository symlink.
- Check cancellation between blobs.
- Create the exact UUID-bearing ownership marker defined in section 6.3 before writing any blob.
- Merge tree metadata for omitted symlinks, submodules, and oversized entries into the normalized baseline inventory so they remain visible without being inserted as graph files.

Raw committed blob content is materialized. A Git LFS pointer or a matching `.gitattributes` filter rule records the deterministic limitation code `GIT_FILTER_OR_LFS_NOT_APPLIED`; TraceDeck analyzes only the committed blob representation and never runs the external filter.

Submodule entries are listed as unsupported baseline inventory evidence and are not initialized or traversed.

### 7.4 Isolated baseline analyzer

The review root contains separate `tree` and `state` children. Every selected regular Git blob—including package manifests, compiler configurations, language manifests, and ignore files—is written beneath `tree`. The temporary SQLite file is created beneath `state`, outside the synthetic project root, so discovery cannot inventory the review database. Type checking is disabled, so the baseline scan creates no tsbuildinfo cache.

The baseline analyzer creates a synthetic project whose root path is `tree`, copies the current structural project configuration, and runs the existing scanner through a temporary `DataStore`. Baseline files, symbols, edges, findings, inventory, and scans never enter the application’s project tables.

Architecture rules supplied to the isolated evaluation retain their persistent project rule IDs. Review-specific architecture identities additionally include the semantic rule fingerprint, preventing a temporary SQLite row ID from changing the result.

The baseline scan runs with type checking disabled in Task 1. Its effective baseline analysis fingerprint records that override separately from the user configuration fingerprint. The current working-tree scan still honors its configured type-check setting. Current type errors are shown only as current-scan context; they are never placed in introduced or resolved columns. The workspace records `TYPE_ERROR_BASELINE_NOT_COMPARABLE` whenever type checking is enabled.

This fixed rule avoids pretending that an OS-temporary tree without the working tree’s exact compiler dependency environment is equivalent.

### 7.5 `ReviewImpact`

`ReviewImpact` is a pure, deterministic, cancellation-aware multi-source BFS over normalized baseline and target `GraphIndex` instances. It owns the traversal and tie-breaking rules in section 8.6; the existing single-source blast traversal is a building block, not the final review algorithm.

Each affected-file or candidate-test record contains destination path, minimum depth, direct/indirect classification, contributing changed paths, baseline/target presence, and one or two retained explanations. Each explanation contains graph side, originating changed path, ordered path nodes, and edge type at every hop. A result also carries total count, retained count, selected depth, depth truncation, and item-limit truncation.

### 7.6 `ReviewComparator`

The comparator consumes normalized snapshots and has no filesystem, Git, Electron, or SQLite dependency. It computes:

- File classifications supplied by Git.
- Dependency-edge delta.
- Finding delta for comparable finding types.
- Architecture-violation delta.
- Cycle delta.
- Reachable export-name delta.
- Possible impact and candidate tests.
- Per-category availability, totals, truncation, and limitations.

Each comparison operation accepts cancellation state and checks it between bounded batches.

## 8. Deterministic comparison rules

### 8.1 Canonical serialization

Canonical data uses:

- Project-relative POSIX paths.
- Explicit enum values.
- Object keys in schema order.
- Arrays sorted by category-specific stable keys.
- Deduplication by stable identity before truncation.
- SHA-256 for fingerprints.

Locale-dependent ordering is not used. Task 1 adds one review-specific code-point comparator and requires status parsing, canonical serialization, review impact, review result ordering, pagination, and review reports to use it. Existing unrelated UI sort behavior is not refactored. Normalized review snapshots are re-sorted with this comparator even when their source repository methods used `localeCompare`, so host locale does not enter review fingerprints.

### 8.2 Stable identities

| Category               | Stable identity                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------- |
| File                   | normalized path and aggregate Git classification; a rename retains old and new path |
| Dependency edge        | source path, target path, dependency edge type, type-only status                    |
| Finding                | finding type and existing content fingerprint                                       |
| Architecture violation | persistent rule ID, semantic rule fingerprint, source path, target path             |
| Cycle                  | sorted member paths                                                                 |
| Reachable export       | entry point, exported name, export kind, resolved declaration origin                |
| Affected file/test     | destination path and graph side                                                     |

Line numbers and import spelling are display evidence. Moving an unchanged import does not create an edge removal and addition. Changing between type-only and runtime import does create an edge delta because the structural meaning changed.

Only resolved `import`, `re-export`, `dynamic-import`, and `require` edges participate in dependency-edge delta and impact traversal. Unresolved imports remain findings and limitations; TraceDeck does not invent a target to include them in graph comparison.

### 8.3 Findings

All current finding types except `type-error` are comparable when both scans made that category available. Existing fingerprints define continuity. Dismissal state does not remove a finding from review comparison because dismissal is a user review preference, not evidence that the finding disappeared. The UI may display dismissed state separately for current findings.

If an existing fingerprint legitimately changes, the result is one resolved and one introduced finding. TraceDeck does not infer continuity from similar titles.

Architecture violations are also shown in their dedicated category, but are not double-counted in overall totals.

### 8.4 Cycles

A cycle identity is its sorted strongly connected component membership. The displayed cycle path is the deterministic concrete traversal already produced by cycle detection.

If one change splits or merges strongly connected components, the old component is removed and the new component is added. TraceDeck does not describe that as the same cycle unless the member identity is unchanged.

### 8.5 Reachable export names

Task 1 supports JS/TS-family files parsed by the TypeScript compiler path. Entry points on each side are discovered from:

- Current configured TraceDeck entry points, applied to both sides when the path exists.
- That side’s `package.json` fields already supported by entry-point inference: `main`, `module`, `browser`, `types`, `exports`, and `bin`.

The provider follows deterministic named, default, and re-export chains to parser-extracted declarations. Each result retains:

- Entry point.
- Exported name.
- Export kind.
- Declaration origin path.
- Source location where available.
- Baseline or target side.

Ambiguous star re-exports do not produce an origin. The affected entry-point surface is marked incomplete. Task 1 does not compare function signatures, parameter or return types, class/interface surfaces, runtime exports, external consumers, or semantic-versioning impact.

### 8.6 Possible impact

Impact is calculated separately over the baseline and target graphs, then merged.

Graph selection by change type:

- Added file: target graph.
- Deleted file: baseline graph.
- Modified file: baseline and target graphs.
- Renamed file: old path in baseline and new path in target.

Each side uses deterministic multi-source BFS over reverse dependency edges:

- Seeds are sorted changed file nodes present in that side.
- The first result is a shortest path.
- Equal-length paths choose the lexicographically smallest changed-file origin and then the lexicographically smallest full path.
- Direct results have depth 1.
- Indirect results have depth greater than 1.
- The root changed files are not counted as affected dependents.

When the same destination is reached on both sides, the result retains both explanations if they differ. The default display chooses the shorter path, breaking ties toward baseline and then stable path order, while allowing the user to inspect both.

Candidate tests are affected destinations classified by existing test-file conventions. Every test retains its shortest path and originating changed file. Tests connected only as siblings through a shared dependency are not selected in Task 1.

## 9. Limits and truncation

The first release defines these product constants:

| Limit                                             |                Value | Behavior                                                         |
| ------------------------------------------------- | -------------------: | ---------------------------------------------------------------- |
| Default review traversal depth                    |                    5 | User-selectable when starting review                             |
| Maximum review traversal depth                    |                   25 | Clamped in main process                                          |
| Maximum retained detail items per result category |                2,000 | Compute total, sort, retain first 2,000, mark category truncated |
| Default review query page                         |                  100 | Main-process pagination                                          |
| Maximum review query page                         |                  500 | Clamped in main process                                          |
| Maximum unified diff bytes                        |                2 MiB | Return bounded prefix with omitted-byte marker                   |
| Maximum unified diff lines                        |               20,000 | Return bounded lines with omitted-line marker                    |
| Maximum baseline tree entries                     |              100,000 | Abort structural review before materialization                   |
| Maximum materialized baseline blob bytes          |          2 GiB total | Abort structural review before materialization                   |
| Maximum single graph-analyzed source              | Existing 2 MiB limit | Inventory remains visible; graph analysis records limitation     |
| Maximum retained limitations per side             |   Existing 500 limit | Deduplicate and show omitted count                               |

The baseline file and byte ceilings are checked from Git object metadata before any blob is written. Exceeding either returns `REVIEW_LIMIT_EXCEEDED`; Git status remains available, but no partial baseline structural result is published.

For result-category caps, totals are computed before truncation. Stable ordering occurs before taking the retained prefix. Every IPC page and export reports `totalCount`, `retainedCount`, and truncation reason.

A product constant may become configurable in a later project, but Task 1 does not silently read undocumented environment variables or repository files.

## 10. Persistence and migration

### 10.1 Table

Add schema migration 4 with a `change_reviews` table containing:

- Primary key.
- Unique project ID with `ON DELETE CASCADE`.
- Resolved base commit.
- Optional base tree ID.
- Working-tree fingerprint.
- User configuration fingerprint.
- Effective baseline analysis fingerprint.
- Working-tree scan ID as informational metadata, not a foreign key, because ordinary scan pruning must not delete the retained review.
- TraceDeck version.
- Review-result schema version.
- Traversal depth.
- Completion timestamp.
- Canonical summary JSON.
- Canonical retained result JSON.

Only completed reviews are stored. Active operation state is not persisted.

### 10.2 Atomic replacement

The complete candidate result is built and validated before opening the persistence transaction. The transaction deletes or replaces the project’s prior row and inserts the new row. A failure rolls back and leaves the previous completed review intact.

The result JSON is a self-contained structural review snapshot. It contains relative paths, normalized file and edge evidence needed by retained graph slices, complete retained finding details for both sides, fingerprints, shortest paths, category totals, category availability, and limitations. It contains no source code, unified diff text, Git credentials, remote URLs, temporary paths, or machine-specific absolute project paths.

The working-tree scan ID is provenance only. Ordinary scan pruning may remove that scan and its row IDs without damaging retained review detail. Normal source, Graph, Findings, and Inspector drill-down is enabled only after the review identity has been revalidated against the current project state; lookup uses paths and fingerprints rather than retained row IDs. A stale review routes all structural detail through its self-contained review snapshot and never labels current graph or finding rows as captured evidence.

A current unified diff is generated on demand only after the retained review identity is revalidated. When a review is stale, on-demand recomputation is disabled because current bytes no longer represent the captured target. Retained structural evidence remains viewable and exportable with a stale warning.

### 10.3 Migration and compatibility behavior

Migration 4 runs in its own existing `PRAGMA user_version` transaction. If table or index creation fails, the database remains at version 3 without a partial table.

Existing projects, scans, files, inventory, symbols, edges, findings, dismissals, architecture rules, scan snapshots, and saved reports are not rewritten.

Decoding applies defaults to missing arrays and optional fields. A retained row with a newer unsupported result-schema version is preserved but not interpreted. The UI reports that the review must be regenerated with a compatible TraceDeck build.

Opening an application database whose SQLite schema version is newer than the build continues to fail safely under the existing migration guard.

## 11. Typed IPC contract

The preload continues to expose exactly `invoke` and `onScanProgress`. Change Review adds every channel below to both `IpcContract` and `IPC_CHANNELS`, implements one registered main-process handler for each, and polls operation status; it does not widen the preload object with a filesystem or process primitive. Startup’s existing declared-channel/registered-handler equality check remains the enforcement point.

### 11.1 Channels

| Channel            | Purpose                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `review:status`    | Read-only current Git state, latest-review metadata and stale reasons, active operation phase/progress |
| `review:start`     | Start background review and return opaque operation ID                                                 |
| `review:cancel`    | Request cancellation for the active project review                                                     |
| `review:summary`   | Return latest completed summary, identities, availability and limitations                              |
| `review:query`     | Return one filtered, paginated result category                                                         |
| `review:file-diff` | Return a bounded diff for a path in the captured current change set                                    |
| `review:export`    | Render retained review and save through a native dialog                                                |

The contract uses project IDs, review IDs, operation IDs, enums, bounded relative paths, typed filters, cursor/page values, and format values. It accepts no arbitrary Git ref and no absolute path.

### 11.2 Response invariants

Every review detail response includes:

- Project ID.
- Review ID.
- Base commit.
- Working-tree fingerprint.
- User configuration fingerprint.
- Effective baseline analysis fingerprint.
- Result schema version.

Every list is present in the declared response. Renderer code nevertheless treats a missing list as `[]` for stale-main-process compatibility.

`review:status` returns a typed `ReviewStatus` containing canonical Git status records, latest-review freshness, stale reason codes, and an optional active operation with phase, processed count, total count, and cancellation-requested state. This is the sole review-progress mechanism; no new preload event is added.

`review:file-diff` returns the diff text, old and new relative paths when applicable, `truncated`, `returnedBytes`, `returnedLines`, `omittedBytes`, and `omittedLines`. Omitted counts are zero when the complete diff is returned.

Paginated results include stable cursor information, total count, retained count, returned count, and truncation metadata. Cursors are scoped to review ID and category. A cursor from an older review returns `REVIEW_STALE` rather than reading a different result.

### 11.3 Validation and errors

Expected error codes are:

- `NOT_A_GIT_REPO`
- `HEAD_UNBORN`
- `SCAN_IN_PROGRESS`
- `REVIEW_IN_PROGRESS`
- `REVIEW_NOT_FOUND`
- `REVIEW_STALE`
- `REVIEW_LIMIT_EXCEEDED`
- `INVALID_GIT_PATH_ENCODING`
- `REVIEW_CANCELLED`
- `REVIEW_GIT_TIMEOUT`
- `REVIEW_INCOMPATIBLE`
- Existing validation and internal error codes

Every review handler validates its payload with the existing structural validation utilities before reading SQLite, Git, or the filesystem. Validation covers positive project/review/operation IDs, known section and filter enums, bounded strings, relative-path length, page size, cursor shape, traversal depth, and export format. Unknown fields do not become command arguments. Arbitrary refs and absolute paths are rejected.

Expected errors use actionable messages without temporary or project absolute paths. Unexpected errors are logged locally and reduced to the existing generic IPC error envelope.

`review:file-diff` validates that the requested relative path belongs to the retained change set. Current existing paths use the established safe path checks. Deleted and old rename paths require both lexical project-boundary validation and an exact match against captured Git status evidence because they cannot pass a must-exist check. Out-of-range or cross-review cursors and paths return validation or stale-result errors without invoking Git.

For a stale review, `review:file-diff` returns `REVIEW_STALE` and does not invoke Git. The same response applies when the captured commit no longer resolves to the retained full commit ID.

### 11.4 Request and response shapes

The closed contract uses these exact semantic shapes:

| Channel            | Request                                                                                           | Response                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `review:status`    | Project ID                                                                                        | `ReviewStatus`                                                            |
| `review:start`     | Project ID and traversal depth                                                                    | Operation ID                                                              |
| `review:cancel`    | Project ID and operation ID                                                                       | Whether cancellation was requested                                        |
| `review:summary`   | Project ID                                                                                        | Latest `ChangeReviewSummary` or null                                      |
| `review:query`     | Project ID, review ID, result section, typed filters, optional opaque cursor, optional page limit | Typed `ReviewPage`                                                        |
| `review:file-diff` | Project ID, review ID, one captured relative path                                                 | `ReviewFileDiff`                                                          |
| `review:export`    | Project ID, review ID, review format                                                              | Cancelled flag and selected file name, never an absolute destination path |

`ReviewStatus` contains repository state (`ready`, `not-git`, or `unborn-head`), optional base commit/tree and branch display name, canonical Git change records, optional latest review identity and freshness, stale reason codes, and optional active operation. The active operation contains operation ID, phase, processed count, total count, message, and cancellation-requested state.

`ChangeReviewSummary` contains all retained identities and fingerprints, selected depth, completion time, category availability, per-category total/retained/truncated counts, and grouped limitations. It contains no detail arrays.

`ReviewPage` contains review identity, section enum, typed item union for that section, next opaque cursor or null, returned count, retained count, total count, and truncation metadata. Filters are a closed object containing optional arrays for change type, Git state, finding type, severity, delta direction, impact directness, language, normalized folder prefix, and minimum/maximum impact depth. A handler rejects a filter not applicable to the requested section rather than silently ignoring it.

`ReviewFileDiff` contains old relative path or null, new relative path or null, diff text, `truncated`, returned bytes, returned lines, omitted bytes, and omitted lines.

`review:export` does not return the native absolute destination. Its file-name field is the final basename for user confirmation.

## 12. Cancellation and stale-result handling

`review:start` returns immediately after registering an operation. The renderer polls `review:status` while the operation is active.

Cancellation checkpoints occur:

- Before and after each Git command.
- Between materialized blobs.
- At existing scanner checkpoints.
- Between comparator categories.
- During BFS batches.
- During canonical serialization.
- Immediately before persistence.

Git child processes use the streaming runner and command-specific timeouts from section 7.2. Cancellation aborts the child. A timeout kills it and returns `REVIEW_GIT_TIMEOUT` with the user-facing message “Git did not finish the review operation within its local time limit.” Temporary database close and verified review-root cleanup run in `finally`.

A compiler operation may not stop at the exact moment cancellation is requested. The UI changes to **Cancellation requested** and waits for control to return; it does not claim that the operation has already stopped.

Renderer requests are guarded by project ID, review ID, and a local request generation. Switching project, rerunning review, or unmounting the view causes older responses to be ignored.

## 13. Workspace user experience

### 13.1 Navigation and header

Change Review appears in primary navigation beside Dashboard, Graph, and Explorer. The Dashboard working-tree card becomes a compact summary and link into the workspace rather than a duplicate review implementation.

The sticky workspace header shows:

- `HEAD` and short commit ID.
- Working tree target.
- Current branch as informational text.
- Latest review completion time.
- Current, stale, running, cancellation-requested, failed, incompatible, or not-run state.
- **Run Review**, **Cancel**, and **Export** actions as applicable.

For `not-git`, the header explains that Change Review requires a local Git repository. For `unborn-head`, it explains that no committed `HEAD` exists to use as a baseline. Both states retain any basic project context, show no fabricated base, disable **Run Review** and diff actions, and leave ordinary TraceDeck scanning available. `review:status` returns these repository states successfully; `review:start` returns `NOT_A_GIT_REPO` or `HEAD_UNBORN` if called despite the disabled control.

Opening the view never starts analysis.

### 13.2 Sections

The workspace has five sections:

1. **Overview**
   - Provenance and freshness.
   - Counts for all result categories.
   - Availability and truncation banners.

2. **Files and edges**
   - Changed files with Git-state badges.
   - Added and removed dependency edges.
   - Added and removed reachable export names.

3. **Findings**
   - Introduced and resolved findings.
   - Introduced and resolved architecture violations.
   - Added and removed cycles.

4. **Possible impact**
   - Direct and indirect affected files.
   - Candidate tests.
   - Changed files for which no graph-reachable candidate test is known.
   - Shortest explanation paths and graph-side provenance.

5. **Limitations**
   - Baseline scan limitations.
   - Working-tree scan limitations.
   - Review-specific limitations.
   - Unavailable categories and every applied cap.

### 13.3 Filters

Folder and language filters apply to all compatible sections. Contextual filters include:

- Added, modified, deleted, or renamed file.
- Staged, unstaged, or untracked Git state.
- Added or removed edge.
- Introduced or resolved evidence.
- Finding type.
- Severity.
- Direct or indirect impact.
- Impact depth.
- Candidate test or non-test file.

The workspace shows total and filtered counts. When a category was truncated before persistence, the UI labels its filtered count as “matching retained details” and continues to show the larger unfiltered total; it does not imply that omitted items were tested against the filter. Filter selections live in renderer state and are sent as typed `review:query` criteria; the main process filters and pages retained evidence without mutating or recomputing the analysis.

### 13.4 Drill-down

Selections retain baseline, target, or both provenance.

- Current files and introduced current findings can open existing source, Graph, Findings, and Inspector destinations only while review identity revalidation says the result is current.
- A stale review keeps every structural drill-down inside retained review evidence; it never opens a later current graph or finding as though it were captured evidence.
- Deleted files and resolved findings open retained review evidence. They do not query current file details as though the entity still existed.
- Renames expose both paths and Git-supplied rename evidence.
- Edge and impact-path actions open a review graph slice containing only the self-contained retained nodes, edges, and paths needed for that evidence.
- Current nodes use the normal graph query only after successful revalidation.
- Baseline-only nodes appear only in an explicit **Review evidence: HEAD** overlay and are never inserted into the current project graph.
- Current findings can focus the normal Findings view by fingerprint after revalidation; retained database row IDs are never used.
- Resolved baseline findings open review-retained finding details.
- Architecture violations link to the current rule only when the same persistent rule and semantic rule fingerprint still exist.

The review graph slice is activated by deliberate action. Hovering does not trigger graph highlighting or a full-canvas repaint.

### 13.5 Source and diff behavior

A current review can request a read-only unified diff:

- Added file: additions.
- Deleted file: removals.
- Modified file: ordinary hunks.
- Rename: old path, new path, Git similarity evidence, and content hunks.

Stale reviews do not recompute diffs, and baseline source is not persisted. In Task 1, source drill-down for a baseline-only or deleted entity means its retained finding/edge metadata plus the removed lines in a current, bounded `review:file-diff` response. There is no separate baseline-blob source viewer.

Baseline-only content has no unlock, save, or format action. Current source retains all existing editor safeguards.

### 13.6 Empty-state wording

No empty list implies safety. A zero-result impact section says:

> No additional affected files were found within the analyzed dependency graph and configured limits.

A zero candidate-test section says:

> No graph-reachable candidate test was found within the analyzed files and traversal limits. This does not mean no test exercises the change.

## 14. Reports and CLI

### 14.1 GUI review export

`review:export` renders the retained normalized result without rerunning analysis. Formats are:

- Markdown.
- Versioned JSON.
- Escaped scriptless standalone HTML with no remote assets.
- Compact line-oriented text.

Every format includes:

- Base and target provenance.
- Fresh or stale state.
- Selected traversal depth.
- Category totals and retained counts.
- Category availability.
- Truncation.
- Limitations.
- Shortest paths for retained impact and test results.

Reports use project-relative paths by default. They contain no temporary paths, source text, Git credentials, remote URLs, or machine-specific absolute project paths. A stale review remains exportable only with an unavoidable stale warning in the output.

The destination is selected through a native save dialog. Renderer-provided destinations are not accepted.

### 14.2 CLI

The existing command gains review mode:

```text
npm run scan -- <path> --review --review-format text|json|markdown|html [--review-output <path>]
```

Rules:

- Base is always `HEAD`.
- Existing `--format text|json|sarif` scan behavior is unchanged; `--review-format` is separate so existing scripts remain compatible.
- The GUI and CLI share the same coordinator-independent materialization, comparison, fingerprint, limit, and rendering code.
- Text, JSON, and Markdown default to stdout when `--review-output` is absent.
- HTML requires `--review-output`. The CLI resolves and writes that explicit user-provided destination; native-dialog restrictions apply to the GUI, not a user-invoked CLI.
- CLI output ordering is stable and noninteractive.
- Operational failure or unavailable baseline analysis returns nonzero.
- Structural changes alone do not fail CI in Task 1.
- Existing `--fail-on` remains finding-scan behavior. CI policy for introduced review evidence belongs to Task 5.
- SARIF remains a finding-oriented scan format and is not used for structural review.
- CLI persistence remains under its existing `.tracedeck/cli.sqlite`; GUI review data remains in the application-data database.

## 15. Performance model

- Working-tree analysis uses incremental scan behavior.
- Baseline analysis is a full isolated scan.
- Baseline caching across reviews is deliberately deferred.
- The comparator builds identity maps and adjacency indexes once per side and shares them across categories.
- Total counts are computed before retained-detail truncation.
- The renderer receives summary and requested pages only; it never stores the entire review result in Zustand.
- Filter evaluation over retained result pages occurs in the main process when the filter changes; only view-specific local presentation state remains in the renderer.
- Progress communicates deterministic phases and processed counts, not time estimates.
- Cancellation does not leave an open temporary database or a published partial review.

Task 11 may change storage, paging, and baseline caching after measurement. It must preserve the same result semantics and visible limits.

## 16. Security

- No renderer request can select an arbitrary ref, process argument, absolute path, or temporary destination.
- Git commands use executable plus argument arrays, not shell strings.
- Diff commands disable external diff and text-conversion drivers.
- Git hooks, filters, submodule commands, checkout, reset, clean, and worktree operations are not run.
- Every Git tree path is normalized and contained beneath the TraceDeck-owned temporary root before writing.
- Symlinks and submodules are never traversed.
- Case-colliding files that cannot be represented faithfully abort structural baseline analysis.
- Temporary paths never cross IPC.
- Review JSON contains no source code.
- Unified diffs are bounded and requested only for a path retained in current, revalidated review evidence.
- GUI export uses a native dialog.
- The existing session-level network block, CSP, context isolation, sandbox, and navigation restrictions remain unchanged.

## 17. Accessibility and visual safety

- Workspace section navigation uses tab/list semantics and arrow-key navigation.
- Result rows and disclosures are keyboard reachable with visible focus.
- Progress and cancellation updates use a polite live region.
- Focus returns to the triggering review row after closing source, graph, or inspector context.
- Added/removed, introduced/resolved, stale/current, and baseline/target distinctions use text and icons in addition to color.
- New colors meet the existing contrast floor in every theme.
- Filter toggles expose pressed or checked state.
- Counts update with screen-reader-readable labels.
- No flashing transitions are added.
- No hover action highlights a large graph region or triggers repeated full-canvas repainting.
- Review graph highlighting occurs only after a click or keyboard action and remains until explicitly changed or cleared.

## 18. Honest limitations

The workspace always explains applicable limits, including:

- Absence from an affected set is not evidence that a file is safe.
- External consumers are outside the scanned repository.
- Runtime reflection, dependency injection, plugin registries, generated loading, and string lookup may be invisible.
- Computed dynamic imports do not have a statically knowable target.
- Ambiguous star re-exports prevent a complete reachable-export surface.
- Namespace-import usage remains incomplete under current analysis.
- Unsupported extensions and oversized files remain inventory evidence, not graph evidence.
- Python, Go, Rust, HTML, CSS, Sass, and component non-script regions retain their current analysis depth.
- Type errors are not compared between baseline and target in Task 1.
- Candidate tests are selected from dependency reachability, not runtime coverage.
- Tests connected only through a shared dependency are not selected by the first-release algorithm.
- Traversal depth and retained result details are capped and visibly truncated.
- Ignored untracked files are outside Git status scope.
- Structural analysis compares `HEAD` with current disk bytes, not a separate staged snapshot.
- Unsaved Monaco buffers are excluded.
- Rename status is accepted from Git only; an add/delete pair is not guessed to be a rename.
- `GIT_FILTER_OR_LFS_NOT_APPLIED`: raw committed blobs are analyzed without checkout filters or Git LFS materialization.
- Submodules and symlink targets are not analyzed.
- `CASE_COLLISION`: two distinct tree paths collide under the deterministic lowercase-path check, so structural baseline analysis is aborted on every platform.
- `INVALID_GIT_PATH_ENCODING`: a Git path cannot be represented as valid UTF-8, so TraceDeck aborts instead of substituting characters or merging distinct paths.
- A changed finding fingerprint is shown as resolved plus introduced rather than guessed continuity.
- A rewritten or garbage-collected captured commit prevents on-demand diff regeneration; retained structural evidence remains labeled with its original commit and the diff action becomes unavailable.

Limitations are bounded, deduplicated, stable-ordered, and grouped by baseline, target, review, and truncation rather than flattened into an unstructured flood.

## 19. Testing strategy

### 19.1 Unit tests

Add unit coverage for:

- Porcelain-v2 NUL-delimited status parsing.
- Paths with spaces, tabs where representable, Unicode, invalid UTF-8 bytes, and platform separators.
- Staged-only, unstaged-only, staged-plus-unstaged, untracked, deleted, renamed, and Git-unrecognized add/delete pairs.
- Path containment and traversal rejection.
- Symlink and submodule non-traversal.
- Case-collision detection.
- Materializer cancellation and size preflight.
- Canonical serialization and fingerprint stability.
- Comparator identity for files, edges, findings, violations, cycles, and reachable exports.
- Type-only edge changes.
- Ambiguous star re-export availability.
- Multi-source shortest paths and deterministic tie-breaking.
- Added, deleted, modified, and renamed impact provenance.
- Candidate-test classification and no-known-test grouping.
- Every category and traversal truncation boundary.
- Stale identity and incompatible-schema handling.
- Renderer defaults for every missing response array.
- Structural validation for every `review:*` request, including unknown enums, arbitrary refs, absolute paths, path escapes, stale cursors, and oversized page requests.
- Report escaping and stable output ordering.

Every deterministic algorithm test runs repeated and shuffled input orders.

### 19.2 Integration tests

Create local temporary Git repositories without network access and cover:

- Clean repository and unborn `HEAD`.
- Added, modified, deleted, renamed, staged, unstaged, and untracked files.
- A first review started from an already-dirty repository.
- An import addition/removal producing edge delta.
- Introduced and resolved findings.
- Introduced and resolved architecture violations under identical current rules.
- Added and removed cycles.
- Added and removed reachable export names.
- Deleted-file impact from the baseline graph.
- Added-file impact from the target graph.
- Working-tree full-scan versus incremental-scan review parity.
- Discovery order, database insertion order, and Git output order independence.
- Cancellation during materialization, baseline scan, traversal, and before persistence.
- Review/scan mutual exclusion and watcher-coalesced rescan.
- HEAD, working-tree, and configuration changes during review.
- Temporary database and verified-marker directory cleanup after success, failure, cancellation, and simulated process interruption.
- Native and lexical path-boundary rejection, including absolute Git paths and `..` entries.
- A materializer filesystem spy proving that no symlink is created or followed.
- A Git process spy proving that review never runs checkout, reset, clean, worktree, submodule, hooks, filters, external diff, or text-conversion commands.
- Rejection of arbitrary renderer refs and renderer-provided export paths.
- Visible `REVIEW_LIMIT_EXCEEDED` behavior for baseline ceilings and explicit truncation metadata for retained-detail caps.
- Sanitized IPC errors without absolute paths.
- Native save-dialog use for GUI review export.
- Markdown, JSON, HTML, and text semantic parity.

### 19.3 Database tests

Cover:

- Fresh migration through version 4.
- Upgrade from versions 1, 2, and 3.
- Migration idempotence.
- Transaction rollback on a failing migration.
- Atomic latest-review replacement failure retaining the previous row.
- Project deletion cascading to its review.
- Ordinary scan pruning not deleting the retained review.
- Defensive decoding of missing arrays.
- Preservation and refusal of an unsupported newer review-result schema.

### 19.4 End-to-end and regression tests

- Spawn the real CLI against a temporary Git repository and assert complete text and JSON review output.
- Add a minimal Playwright Electron-launcher harness and exercise the renderer workflow from status through Run Review, progress, cancellation, rerun, filtering, drill-down, and export. Dependency selection must follow the repository’s package-age policy during implementation.
- Add regression tests for untracked files, rename pairs, deleted-file impact, stale-result replacement, type-check unavailability, star re-export ambiguity, result truncation, and stale diff refusal.
- Run platform path and packaging smoke coverage on Windows, macOS, and Linux CI environments.

No test executes analyzed repository code or invokes a network service.

## 20. Documentation and packaging

Update in the same implementation change:

- `README.md` feature inventory, Git section, review workflow, limits, and limitations.
- `DEVELOPMENT-SPEC.md` architecture, database, IPC, Git, reports, CLI, testing, known limitations, and shipped-roadmap state.
- `docs/AGENT-BRIEFING.md` with new services, channels, invariants, and failure behavior.
- CLI help text and examples.
- User-facing terminology for possible impact, candidate tests, static analysis, stale results, and unsupported comparisons.

The Playwright Electron launcher is the only new test-harness dependency authorized by this design. It is justified because Run Review crosses renderer, preload, IPC, Git, scanner, SQLite, cancellation, and native-dialog boundaries that unit and CLI tests cannot cover together. The harness is limited to this critical workflow, remains a development dependency, performs no network access at test runtime, and must use a compatible fixed version published at least seven days before selection.

Packaging continues to use NSIS on Windows, DMG on macOS, and AppImage on Linux. No new hosted or native service is introduced. `better-sqlite3` remains unpacked and main-process only. Review temporary directories use standard OS temporary locations on every platform and do not depend on a Unix shell or command pipeline.

## 21. Explicit non-goals

Task 1 does not include:

- Arbitrary commits, branches, tags, merge bases, or ref-to-ref comparison.
- Separate staged-only or index-only structural analysis.
- Checkout, reset, clean, staging, committing, branch management, or Git worktrees.
- Review comments, approvals, assignments, notes, or collaboration state.
- Multiple retained reviews or historical review browsing.
- Unsaved editor-buffer analysis or hypothetical changes.
- Function, method, class, interface, type, or enum signature comparison.
- Semantic-versioning or definitive breaking-change claims.
- Imported runtime coverage.
- Test execution or claims that selected tests are sufficient.
- Shared-module sibling-test selection beyond reverse dependency reachability.
- Automated fixes, refactoring, renames, source writes, or import edits.
- Linting, vulnerability feeds, package recommendations, or runtime instrumentation.
- Baseline graph caching across reviews.
- Repository-owned architecture configuration.
- Unrelated refactoring of graph, scan, report, or renderer systems.

## 22. Acceptance criteria

Task 1 is complete when a developer can:

1. Open Change Review and immediately see a correctly classified working-tree status against `HEAD`.
2. Explicitly run and cancel a structural review without any Git or source mutation.
3. Review added/removed dependency edges, comparable findings, architecture violations, cycles, and reachable export names.
4. See direct and indirect possible impact, candidate tests, and a deterministic shortest explanation path for every retained result.
5. See every applied truncation and relevant analysis limitation.
6. Distinguish Git differences, review scan comparison, and ordinary latest-two-scan comparison.
7. Filter and drill into graph, source, inspector, finding, and rule evidence without baseline/current confusion.
8. Export equivalent Markdown, JSON, standalone HTML, or text output using relative paths and honest caveats.
9. Reopen the app and view the latest completed review, with accurate current/stale/incompatible state.
10. Obtain identical semantic results and ordering from full and incremental working-tree scans and from shuffled input orders.
11. Use the CLI for the same `HEAD` versus working-tree review without network access.
12. Encounter no source write, checkout, symlink traversal, renderer privilege expansion, hidden cap, or unsupported analysis presented as complete.
