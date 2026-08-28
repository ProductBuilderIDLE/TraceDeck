# Discovery Consistency and Explainability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make project discovery complete for supported source containers, deterministic, and explicit about every exclusion and near-empty result.

**Architecture:** Discovery produces detailed, sorted exclusion evidence; scanner converts it into bounded user-facing limitations. Gitignore scope and workspace config selection are corrected at their sources. Vue/Svelte/Astro files reuse the TypeScript parser after deterministic script-region extraction, and the dashboard surfaces completed zero-file scans.

**Tech Stack:** Electron, TypeScript, Node.js filesystem/path APIs, TypeScript Compiler API, Vitest, React.

**Spec:** `docs/superpowers/specs/2026-08-27-discovery-consistency-design.md`

## Global Constraints

- Analysis remains fully offline and private: no network requests or telemetry.
- The same project produces the same sorted files, exclusions, limitations, and edges across scans.
- Symlinks are not followed.
- No new dependency is introduced.
- Every exclusion is attributable to a concrete rule or supported-extension decision.
- Existing tests are not weakened or deleted.

---

### Task 1: Reproduce discovery silence and ignore precedence

**Files:**
- Create: `tests/fixtures/asset-heavy-project/app.js`
- Create: `tests/fixtures/asset-heavy-project/index.html`
- Create: `tests/fixtures/asset-heavy-project/style.css`
- Create: `tests/fixtures/asset-heavy-project/package.json`
- Create: `tests/fixtures/asset-only-project/index.html`
- Create: `tests/fixtures/asset-only-project/style.css`
- Create: `tests/fixtures/ignore-precedence-project/.gitignore`
- Create: `tests/fixtures/ignore-precedence-project/src/.gitignore`
- Create: `tests/fixtures/ignore-precedence-project/src/keep.ts`
- Create: `tests/fixtures/ignore-precedence-project/src/drop.ts`
- Modify: `tests/unit/analysis/discovery.test.ts`
- Modify: `tests/integration/scan.test.ts`

**Interfaces:**
- Consumes: existing `discoverFiles(DiscoveryOptions): Promise<DiscoveryResult>` and `runScan`.
- Produces: desired `DiscoveryResult.diagnostics` contract and explicit near-empty limitations.

- [ ] **Step 1: Add literal fixture projects and failing discovery assertions**

  Assert one JS file is returned for the asset-heavy fixture while diagnostics name `.html` and
  `.css`; assert the child ignore negation includes only `src/keep.ts`; assert two runs return equal
  diagnostics.

- [ ] **Step 2: Add failing scan assertions**

  Assert the one-file summary states that only one supported graph source was found and lists omitted
  extensions. Assert the asset-only summary states that no supported source was found.

- [ ] **Step 3: Run the focused tests and verify RED**

  Run: `npx vitest run tests/unit/analysis/discovery.test.ts tests/integration/scan.test.ts`

  Expected: failures because `diagnostics` does not exist, the nested negation loses to the parent,
  and scanner limitations contain no discovery-scope explanation.

### Task 2: Add deterministic discovery evidence and correct ignore layering

**Files:**
- Modify: `src/main/utils/gitignore.ts`
- Modify: `src/main/analysis/discovery.ts`
- Test: `tests/unit/utils/gitignore.test.ts`
- Test: `tests/unit/analysis/discovery.test.ts`

**Interfaces:**
- Produces: `GitignoreDecision`, `GitignoreMatcher.decision(relativePath)`,
  `DiscoveryExclusion`, and `DiscoveryDiagnostics`.
- `DiscoveryResult.diagnostics` contains `directoriesVisited`, `filesConsidered`, and sorted
  `exclusions` with exact `relativePath`, `kind`, and `detail`.

- [ ] **Step 1: Add a matcher decision test and verify RED**

  The test asserts that a matching negation is distinguishable from no matching rule.

- [ ] **Step 2: Implement matcher decisions and layered last-match-wins evaluation**

  Preserve `ignores()` as a compatibility wrapper. Store each raw pattern so the decision can identify
  it. In discovery, a later scoped matcher changes the decision only when it matched a rule.

- [ ] **Step 3: Record each exclusion branch**

  Record built-in directories, exact user patterns, exact `.gitignore` file/pattern, unsupported
  extensions, disabled tests, symlinks, unreadable paths, oversize files, and duplicate real paths.
  Lower-case file extensions before source matching. Treat only `ENOENT` as a normal missing
  `.gitignore`; surface other read errors.

- [ ] **Step 4: Sort files, skipped entries, and exclusions and verify GREEN**

  Run: `npx vitest run tests/unit/utils/gitignore.test.ts tests/unit/analysis/discovery.test.ts`

### Task 3: Surface bounded discovery limitations and zero-file UI state

**Files:**
- Modify: `src/main/analysis/scanner.ts`
- Modify: `src/renderer/src/components/views/Dashboard.tsx`
- Test: `tests/integration/scan.test.ts`

**Interfaces:**
- Consumes: `DiscoveryResult.diagnostics`.
- Produces: deterministic limitation strings grouped by exclusion kind/detail, including an explicit
  zero/one-file message.

- [ ] **Step 1: Implement scanner grouping with literal counts and rule details**

  Group exclusions without losing the exact cause. Keep examples bounded and sorted so large projects
  do not exceed summary storage or bury other limitations.

- [ ] **Step 2: Render completed zero-file scans distinctly**

  Keep the existing pre-scan state only when `lastScan` or stats are absent. For a completed scan with
  zero files, show “No supported source files found,” the first discovery explanation, and rescan.

- [ ] **Step 3: Verify integration GREEN**

  Run: `npx vitest run tests/integration/scan.test.ts`

### Task 4: Add source-container coverage

**Files:**
- Create: `tests/fixtures/source-containers-project/src/Widget.vue`
- Create: `tests/fixtures/source-containers-project/src/Panel.svelte`
- Create: `tests/fixtures/source-containers-project/src/Page.astro`
- Create: `tests/fixtures/source-containers-project/src/shared.ts`
- Modify: `src/shared/constants.ts`
- Modify: `src/main/analysis/parser.ts`
- Modify: `src/main/analysis/resolver.ts`
- Test: `tests/unit/analysis/discovery.test.ts`
- Test: `tests/unit/analysis/parser.test.ts`
- Test: `tests/unit/analysis/resolver.test.ts`
- Test: `tests/integration/scan.test.ts`

**Interfaces:**
- `SOURCE_EXTENSIONS` and `RESOLUTION_EXTENSIONS` add `.vue`, `.svelte`, and `.astro`.
- `ParsedFile` adds `limitations: string[]`.
- `parseSourceFile` preserves line positions while exposing only standard script/frontmatter regions
  to TypeScript.

- [ ] **Step 1: Add failing discovery/parser/resolver tests and verify RED**

  Assert all three containers are discovered, their imports of `shared.ts` resolve, exported symbols
  inside scripts are parsed at original line numbers, and the parser returns an honest container
  limitation.

- [ ] **Step 2: Implement deterministic source-region masking**

  Replace characters outside Vue/Svelte `<script>` blocks and Astro frontmatter/script blocks with
  spaces while retaining line breaks. Parse the masked text with the existing compiler API.

- [ ] **Step 3: Thread parser limitations through scanner and verify GREEN**

  Run: `npx vitest run tests/unit/analysis/parser.test.ts tests/unit/analysis/resolver.test.ts tests/integration/scan.test.ts`

### Task 5: Resolve imports with the nearest workspace config

**Files:**
- Create: `tests/fixtures/monorepo-project/package.json`
- Create: `tests/fixtures/monorepo-project/apps/web/tsconfig.json`
- Create: `tests/fixtures/monorepo-project/apps/web/src/index.ts`
- Create: `tests/fixtures/monorepo-project/apps/web/src/lib/value.ts`
- Create: `tests/fixtures/monorepo-project/packages/core/tsconfig.json`
- Create: `tests/fixtures/monorepo-project/packages/core/src/index.ts`
- Modify: `src/main/analysis/tsconfig.ts`
- Modify: `src/main/analysis/diagnostics.ts`
- Modify: `src/main/analysis/resolver.ts`
- Modify: `src/main/analysis/scanner.ts`
- Test: `tests/unit/analysis/resolver.test.ts`
- Test: `tests/unit/analysis/diagnostics.test.ts`
- Test: `tests/integration/scan.test.ts`

**Interfaces:**
- Produces: `discoverProjectTsConfigs(rootPath): ProjectTsConfig[]` sorted by config path.
- `ResolverContext` adds `tsConfigs: readonly ProjectTsConfig[]` while retaining `tsConfig` as the
  fallback for existing callers.
- `resolveImport` selects the deepest config directory that contains `fromAbsolutePath`.

- [ ] **Step 1: Add a failing monorepo scan assertion and verify RED**

  Assert `@web/lib/value` resolves from `apps/web/src/index.ts` with no unresolved-import finding even
  though the repository root has no `tsconfig.json`.

- [ ] **Step 2: Centralize config discovery and parsing**

  Move the bounded-depth, excluded-directory config walk from diagnostics into `tsconfig.ts`. Keep a
  stable cap and deterministic ordering. Reuse it from type checking.

- [ ] **Step 3: Select the nearest config per importer and verify GREEN**

  Run: `npx vitest run tests/unit/analysis/resolver.test.ts tests/unit/analysis/diagnostics.test.ts tests/integration/scan.test.ts`

### Task 6: Re-measure and verify the complete change

**Files:**
- Modify only if verification exposes a defect in the preceding tasks.

**Interfaces:**
- Consumes: final discovery/scanner behavior.
- Produces: before/after counts and exclusion explanations for four real project roots.

- [ ] **Step 1: Run focused determinism tests twice**

  Run the discovery and scan tests twice and compare output/failures.

- [ ] **Step 2: Re-run real-project diagnostics**

  Measure `C:\TraceDeck Claude`, `C:\dev_app`, `C:\dev_app\regexlab`, and
  `C:\dev_project\RegexLab`. Compare discovered graph-source counts to `git ls-files` and report every
  remaining excluded category. The vanilla app may remain one graph source, but must now say exactly
  why HTML/CSS are outside the graph.

- [ ] **Step 3: Run the required full verification**

  Run: `npm test`

  Expected: at least 279 tests, zero failures.

  Run: `npm run typecheck`

  Expected: exit 0.

  Run: `npm run lint`

  Expected: exit 0 with no errors.

- [ ] **Step 4: Inspect the final diff and requirement coverage**

  Confirm no temporary instrumentation, network access, telemetry, dependency changes, weakened tests,
  project-specific paths, or symlink traversal remain.

