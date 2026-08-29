# TraceDeck — Development Specification

> A single, complete brief for building TraceDeck from nothing. Read it as the product's
> constitution: what it is, what it refuses to be, how every part works, and what it should
> become. If this document and the code disagree, the code is the truth and this document is
> the bug.

**App version:** `0.1.0` · **Scale:** 112 TypeScript/TSX source files, ~21,500 lines, 35 test
files, 481 passing tests.

---

## Table of contents

1. [The mandate](#1-the-mandate)
2. [Inviolable constraints](#2-inviolable-constraints)
3. [The honesty doctrine](#3-the-honesty-doctrine)
4. [Technology](#4-technology)
5. [Process architecture and security](#5-process-architecture-and-security)
6. [The two file universes](#6-the-two-file-universes)
7. [Database](#7-database)
8. [The IPC contract](#8-the-ipc-contract)
9. [Discovery](#9-discovery)
10. [Parsing](#10-parsing)
11. [Resolution](#11-resolution)
12. [Graph construction](#12-graph-construction)
13. [Algorithms](#13-algorithms)
14. [Type checking](#14-type-checking)
15. [Findings versus limitations](#15-findings-versus-limitations)
16. [Change impact](#16-change-impact)
17. [The scan pipeline](#17-the-scan-pipeline)
18. [The interface](#18-the-interface)
19. [The graph, in depth](#19-the-graph-in-depth)
20. [The editor](#20-the-editor)
21. [Git](#21-git)
22. [Reports](#22-reports)
23. [The CLI](#23-the-cli)
24. [Themes and accessibility](#24-themes-and-accessibility)
25. [Testing doctrine](#25-testing-doctrine)
26. [Packaging](#26-packaging)
27. [Known limitations](#27-known-limitations)
28. [What it should become](#28-what-it-should-become)
29. [Anti-goals](#29-anti-goals)

---

## 1. The mandate

Build a private, offline-first dependency explorer and change-impact analyser for JavaScript,
TypeScript, and mixed-language repositories.

A developer opens a local folder. TraceDeck parses it, builds a dependency graph of files and
symbols, stores everything in a local SQLite database, and answers one question well:

> **If I change this, what else might break?**

It shows what depends on what, which files sit in cycles, which exports nothing references,
which architectural rules the code violates, and how far a change can travel. It never uploads
source code, never contacts a network, and never uses a language model in the analysis path.

It is a **structure and impact** tool. It is not a linter, a test runner, a language server, or
an IDE. The value is precision about a narrow question, not breadth.

---

## 2. Inviolable constraints

These are not preferences. A change that breaks one of these is wrong regardless of what it
gains.

1. **Offline.** No network calls, CDNs, model APIs, telemetry, analytics, crash reporting,
   update checks, or grammar downloads. WASM grammars ship inside the install. There is no
   `.env` file because there is nothing to configure — no keys, no endpoints, no services.
2. **No AI in the analysis path.** The same repository must always produce the same graph, the
   same findings, and the same scores. No heuristic ranking, no learned weights, no model
   inference. Determinism is testable and is tested.
3. **The renderer is powerless.** No Node integration, no filesystem, no database, no absolute
   paths. It may only call an explicit allowlist of typed IPC channels.
4. **The IPC contract is closed.** `src/shared/ipc.ts` is the single source of truth. Startup
   fails loudly if a declared channel has no handler. Adding a channel there and implementing
   its handler is the only supported way to widen the surface.
5. **Never follow symlinks.** List them; never traverse them.
6. **Inventory is not the graph.** `project_files` and `files` are separate tables with
   separate purposes. Never dump non-graph files into `files` to "scan more".
7. **Source writes are guarded.** Compare SHA-256 of bytes on disk against the hash returned by
   `source:read`, then write temp-file-then-rename in the same directory. UTF-8 only. No
   auto-save, ever.
8. **`better-sqlite3` is main-process only.**
9. **No silent omission.** Any file, language, or region the analyser skips becomes either a
   **limitation** or a **finding**. Silence is a lie.
10. **Defensive rendering.** Renderer-only hot reload can leave the main process stale. Default
    every array arriving over IPC to `[]`.

---

## 3. The honesty doctrine

This is the product's differentiator and the hardest thing to preserve under feature pressure.

**Grounded in parsed facts:**

- **Import edges** come from the AST and resolve against files that exist on disk.
- **Circular dependencies** are a verifiable property of that graph.
- **Unresolved imports** are the closest thing to broken-code detection: an import that cannot
  be resolved is often a typo, a deleted file, or a bad relative path.
- **Unused export candidates** are a real absence of reference edges, reported conservatively.
- **Architecture violations** are real, against rules the user wrote.
- **Syntax findings** are line-addressable parser failures.
- **Merge conflicts** are regex-detected conflict markers.
- **Type errors** (opt-in) are the actual TypeScript compiler's diagnostics.

**Where the limit is — scores.** Change-impact *inputs* are real counts from the graph.
*Weights* are chosen constants, not derived from incident data. Percentile ranks a file inside
its own repository. Treat a score as a way to sort by connectivity, never as a measurement of
production risk. The inspector must always show the arithmetic.

**Language rules.** The UI says *unused export candidate*, *possible impact*, *static analysis
result*, *could not resolve dynamically imported module*. It never says code is dead, broken,
or safe to remove. A file with a high score is not broken. A file with a low score is not safe.

---

## 4. Technology

| Layer | Choice | Why |
| --- | --- | --- |
| Shell | Electron 38 + electron-vite | Local filesystem access with a web UI |
| UI | React 18, Zustand, Tailwind | Small, no heavy framework runtime |
| 2D graph | Cytoscape (+ fcose, dagre) | Mature layouts, canvas rendering, SVG export |
| 3D graph | three.js | Instanced rendering scales past canvas hit-testing |
| Editor | Monaco | Real editing without becoming an IDE |
| Main | Node + TypeScript | — |
| Database | SQLite via `better-sqlite3`, WAL | Synchronous, embedded, no server |
| JS/TS parsing | TypeScript Compiler API | Barrels, `export *`, aliases, `.js`→`.ts` |
| Other languages | tree-sitter WASM (`web-tree-sitter`) | Uniform grammars, ships offline |
| Type checking | Real `ts.Program` + `getPreEmitDiagnostics` | Genuine compiler truth |
| Tests | Vitest | — |
| CLI | `vite-node` | Reuses main-process code unchanged |

**Why not tree-sitter for JS/TS?** Barrel forwarding, `export *`, `import type`, path aliases,
and the `./foo.js` → `foo.ts` convention are all built on TSC semantics. Unifying on
tree-sitter would be a semantic downgrade.

**Why not an LSP?** Different product. Rejected for privacy and for refusing a second runtime.
Monaco's semantic TypeScript checker is disabled **on purpose**.

`Parser.init({ locateFile })` must point at local WASM. Never a CDN.

---

## 5. Process architecture and security

```
src/
├── main/                       Electron main process (Node)
│   ├── index.ts                App lifecycle, database bootstrap
│   ├── security.ts             Sandboxing, CSP, navigation and network blocking
│   ├── window.ts               BrowserWindow creation
│   ├── ipc/                    Typed, validated IPC handlers
│   │   ├── registry.ts         Handler registration and error envelopes
│   │   ├── projectHandlers.ts  Open, list, configure, remove projects
│   │   ├── scanHandlers.ts     Start, cancel, progress; starts the file watcher
│   │   ├── analysisHandlers.ts Graph, blast radius, risk, search, findings
│   │   ├── extraHandlers.ts    Source, git, preview, metrics, format, packs
│   │   ├── ruleHandlers.ts     Architecture rule CRUD and evaluation
│   │   ├── reportHandlers.ts   Report export through a native save dialog
│   │   └── systemHandlers.ts   Open/reveal a file, app info, save-export
│   ├── analysis/
│   │   ├── discovery.ts        Walking, inventory, .gitignore, exclusions
│   │   ├── parser.ts           TypeScript Compiler API (+ component scripts)
│   │   ├── languageRoots.ts    Go/Python/Rust package-root rewrites
│   │   ├── treeSitter/         WASM grammars and extractors
│   │   ├── resolver.ts         Import resolution and path aliases
│   │   ├── tsconfig.ts         tsconfig/jsconfig loading
│   │   ├── graph.ts            Edge construction, barrel forwarding, calls
│   │   ├── scanner.ts          Scan orchestration and incremental rescan
│   │   ├── diagnostics.ts      Optional typecheck
│   │   ├── textDiagnostics.ts  JSON syntax, merge conflicts
│   │   └── algorithms/         cycles, blast, unusedExports, rules, riskScore,
│   │                           complexity, todos, clones, martin, scanCompare,
│   │                           diffImpact, graphIndex
│   ├── db/
│   │   ├── connection.ts       Connection and pragmas
│   │   ├── migrations.ts       Versioned schema migrations
│   │   ├── appDatabase.ts      userData path resolution
│   │   └── repositories/       One repository per table group
│   ├── services/               analysis reads, reports, source, git, watch,
│   │                           preview, format, licenses, codeowners, search
│   └── utils/                  Hashing, glob, gitignore, validation, paths
├── cli/main.ts                 Headless scan
├── preload/index.ts            contextBridge surface
├── renderer/src/               React UI
│   ├── components/
│   │   ├── layout/             Sidebar, main panel, inspector
│   │   ├── views/              Dashboard, GraphView, SpaceCanvas, Explorer,
│   │   │                       Findings, Metrics, ArchitectureRules, Reports,
│   │   │                       Settings, CodePanel, SourceEditor, CodeChanges
│   │   └── common/             Shared primitives and error boundary
│   ├── store/                  Zustand state (appStore, uiStore)
│   └── lib/                    Typed IPC client, theme, Monaco setup
└── shared/                     Types, IPC contract, constants, rule packs, theme,
                                mergeConflicts, sourceMarkers, jsonSyntax, lineDiff,
                                communities, radialLayout, nodeIds, sourceLanguage
```

### Security settings

| Setting | Value |
| --- | --- |
| `contextIsolation` | `true` |
| `nodeIntegration` | `false` |
| `sandbox` | `true` (plus `app.enableSandbox()`) |
| `webviewTag` | `false` |
| `webSecurity` | `true` |

- The preload script exposes exactly two functions: `invoke` and `onScanProgress`. It checks
  the channel against an allowlist before forwarding.
- The Electron session cancels every outbound request that is not a local file or the Vite dev
  server, so even an accidental `fetch` cannot leave the machine.
- A Content-Security-Policy header restricts `connect-src`, `script-src`, and `frame-src`.
- Every handler validates its payload structurally before touching the database or filesystem.
- Unexpected errors are logged locally and reduced to a generic message before crossing the
  bridge, so internal paths and stack frames never reach the renderer.
- The renderer never supplies a filesystem path. Opening a project and saving a report go
  through native dialogs. "Open file" and "reveal file" resolve a project-relative path and
  refuse anything escaping the project root.
- Navigation away from the bundled UI is blocked. `window.open` is denied; `https://` links are
  handed to the OS browser.

---

## 6. The two file universes

Keeping these separate is a load-bearing decision. Collapsing them is the most common way to
ruin this product.

### Inventory — `project_files`

Every regular file except hard-excluded trees. This is what Explorer lists.

Hard exclusions (`ALWAYS_EXCLUDED_DIRS`): `node_modules`, `.git`, `dist`, `build`, `coverage`,
`.next`, `out`, `vendor`, `.turbo`, `.cache`, `.svelte-kit`, `.nuxt`, `.tracedeck`.

- `.gitignore` does **not** hide a file from inventory. It is stored as metadata.
- Symlinks are listed, never followed.
- User exclude patterns and `includeTestFiles` affect analysis eligibility, not visibility.

### Graph sources — `files` + `symbols` + `graph_edges`

Only files that can carry edges. `SOURCE_EXTENSIONS`:

| Parser | Extensions |
| --- | --- |
| TypeScript Compiler API | `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs`, plus `<script>` in `.vue` `.svelte` `.astro` |
| tree-sitter | `.html` `.htm` `.css` `.scss` `.sass` `.less` `.py` `.go` `.rs`, plus Vue/Svelte/Astro template and style regions |

**Non-source assets** — JSON, images, fonts, markdown, wasm, `.styl` — are valid import targets
but never graph nodes. Importing one is not an error. A **missing `.scss` is `file-not-found`**,
because Sass *is* a graph source; a missing `.styl` is `non-source-asset`.

### Size limits

| Constant | Value | Meaning |
| --- | --- | --- |
| `MAX_FILE_SIZE_BYTES` | 2 MiB | Analysis cap |
| `MAX_SOURCE_BYTES` | 1 MiB | Editor cap |
| `MAX_SOURCE_LINES` | 8000 | Editor cap |
| `GRAPH_NODE_SOFT_LIMIT` | 1500 | Default query cap (2D) |
| `GRAPH_NODE_HARD_LIMIT` | 5000 | Absolute ceiling, clamped server-side |
| `DEFAULT_MAX_TRAVERSAL_DEPTH` | 5 | Blast radius default |
| `MAX_TRAVERSAL_DEPTH` | 25 | Blast radius ceiling |
| `MAX_TYPE_DIAGNOSTICS` | 2000 | Typecheck output cap |

---

## 7. Database

SQLite via `better-sqlite3`, opened only in the main process.

- **GUI:** `app.getPath("userData")/tracedeck.db` — never inside the scanned repository.
- **CLI:** `<project>/.tracedeck/cli.sqlite` — and `.tracedeck` is itself excluded from
  discovery, so the tool never scans its own output.

### Tables

| Table | Holds |
| --- | --- |
| `projects` | Root path, name, configuration JSON |
| `scans` | Status, timings, summary JSON |
| `files` | Graph-eligible sources with content hash and mtime |
| `symbols` | Declarations with kind, export flags, line span, metadata |
| `graph_edges` | Typed edges with source line and metadata JSON |
| `analysis_findings` | Every finding, with a stable content fingerprint |
| `architecture_rules` | User rules: pattern, forbidden pattern, exceptions, severity |
| `saved_reports` | Report metadata |
| `finding_dismissals` | Fingerprints the user dismissed |
| `project_files` | Full inventory |
| `scan_snapshots` | Fingerprint lists, for scan-to-scan comparison |

### Rules

- Schema versioning uses `PRAGMA user_version`. Each migration runs inside its own transaction;
  a failure rolls back and aborts, leaving the database at the last version that applied
  cleanly rather than half-migrated.
- WAL is enabled so the UI can read dashboard counts while a scan writes thousands of rows.
- Bulk inserts use prepared statements inside transactions. All queries are parameterised.
- Indexes cover project and scan lookups plus **both directions** of every graph edge.
- Dismissals are keyed by a stable **content fingerprint**, never a row id or a line number, so
  a review decision survives a rescan and an edit above the finding does not resurrect it.
- After a scan completes, superseded scans are pruned. Rows for unchanged files are *moved*
  onto the current scan rather than rebuilt, which is what makes that pruning safe.

---

## 8. The IPC contract

45 channels. `src/shared/ipc.ts` declares the payload and return type of each. Startup fails if
any declared channel lacks a handler. `scan:progress` is an event pushed to the renderer via
`onScanProgress`, not an invoke.

| Group | Channels |
| --- | --- |
| **project** | `list`, `open-dialog`, `select`, `update-config`, `remove` |
| **scan** | `start`, `cancel`, `latest`, `progress` (event) |
| **graph** | `query`, `blast-radius`, `risk-score`, `file-detail` |
| **analysis** | `preview`, `diff-impact`, `folder-metrics` |
| **findings** | `list`, `dismiss` |
| **rules** | `list`, `upsert`, `delete`, `evaluate`, `apply-pack` |
| **reports** | `list`, `export`, `delete` |
| **source** | `read`, `save`, `format` |
| **search** | `query`, `text` |
| **git** | `changed-files`, `diff`, `blame`, `cochange`, `renames`, `churn`, `mergetool` |
| **inventory** | `list` |
| **dashboard** | `stats` |
| **system** | `app-info`, `open-path`, `reveal-path`, `save-export`, `set-theme` |

**Shape traps that have bitten before:**

- `analysis:folder-metrics` returns `ProjectMetrics` — `{ folders, outliers }` — **not** a bare
  array. The Metrics view accepts both shapes for safety.
- Dashboard payloads may omit newer arrays when the main process is stale. Always `?? []`.

---

## 9. Discovery

Walk the project directory.

- Honour nested `.gitignore` files with **last-matcher-wins** semantics, including negations.
- Skip `ALWAYS_EXCLUDED_DIRS` outright.
- List symlinks; never traverse them.
- Record every retained file into inventory with size, mtime, extension, and gitignore status.
- Build the graph-eligible subset by extension and size.
- Produce **exclusion diagnostics**: what kinds were skipped, and a census of how many.
- An empty or tiny graph gets an explicit limitation. A project with sources but no graph is a
  bug the user must be told about, not a blank screen.

`TEST_FILE_PATTERNS` classify test files. `FRAMEWORK_CONVENTION_PATTERNS` mark files a
framework loads by convention, which unused-export analysis must exclude.

---

## 10. Parsing

Dispatch: `parseWithTreeSitter(...) ?? parseSourceFile(...)`. tree-sitter returns `null` for
extensions it does not handle, so TSC is the fallback.

### TypeScript Compiler API

`ts.createSourceFile` with `setParentNodes: true` and a script kind chosen per extension. It is
error-tolerant by design, which is why real compile errors need the opt-in type check.

Extracts:

- Static imports, dynamic `import()`, `require()`, `import x = require()`
- Named, default, and namespace imports — the namespace **binding name** is retained
- Named re-exports, default re-exports, `export *`
- Functions, classes, interfaces, type aliases, enums, variables
- React components **only where deterministically identifiable**: PascalCase with JSX in the
  body, or a class extending `React.Component`
- Conservative **call** records: callee name, line, whether it was a property access, and the
  receiver identifier when there is one
- Cyclomatic complexity and nesting depth per function; simplified LCOM per class

### tree-sitter

WASM grammars for HTML, CSS, Python, Go, Rust, plus the template and style regions of Vue,
Svelte, and Astro. These contribute **import-like edges only** — `symbols` stays empty for
them, by design and stated in the limitations. That has a second consequence worth naming
explicitly: because complexity findings read `symbol.metadata.complexity`, tree-sitter
languages also get **no complexity hotspots**.

### Syntax errors

**Line-addressable** parser failures become `syntax-error` **findings**: TSC parse diagnostics,
tree-sitter `ERROR` nodes, and a `hasError` fallback reported at 1:1. Failures without a line
stay **limitations**. Never invent a line number to make a limitation look like a finding.

---

## 11. Resolution

`resolver.ts` performs **no filesystem access**. It works entirely from a prebuilt index of
known files, which makes it fast, testable, and trivially deterministic.

Resolution order:

1. Relative paths
2. `tsconfig.json` / `jsconfig.json` path aliases and `baseUrl` — nested configs, deepest wins
3. Directory `index` files (`INDEX_BASENAMES`)
4. The TypeScript convention where `./foo.js` refers to `foo.ts`
5. Language-specific directory indexes, gated by the importing file's language
6. `rewriteLanguageImports` for package roots: Go `go.mod`, Python `pyproject.toml` /
   `setup.cfg` + `__init__.py`, Rust `Cargo.toml`

**`.d.ts` is tried *after* implementation extensions**, which deliberately differs from the
compiler's own order. The compiler prefers a declaration because it is authoritative for types;
this tool builds a dependency graph, where the implementation carries the runtime imports.
Preferring the declaration made `./foo` resolve to a `foo.d.ts` beside `foo.js`, silently
dropping every edge `foo.js` contributed. A declaration now wins only when no implementation
sits beside it.

Every `package.json` in the project, including workspace manifests, is read so a declared
dependency can be told apart from a broken path alias. Node builtins and workspace packages are
recognised the same way.

`UnresolvedReason` is one of: `dynamic-expression`, `alias-not-configured`, `file-not-found`,
`external-package`, `non-source-asset`. Only actionable reasons become findings.

---

## 12. Graph construction

`EdgeType` is exactly: `import`, `export`, `re-export`, `dynamic-import`, `require`,
`reference`, `call`.

`NodeType` is `file`, `symbol`, or `folder`. Node ids are `file:<path>`,
`symbol:<path>#<name>`, `folder:<path>`.

### Barrel forwarding

When `app.ts` imports `{ Button }` from a `components` barrel that re-exports it from
`Button.tsx`, the `reference` edge is attributed to the declaration in `Button.tsx` — not to the
barrel. Where `export *` makes an origin genuinely ambiguous, **no reference is invented**; the
ambiguity is recorded as a caveat on the file.

### Call edges

Conservative, and honest about which direction the conservatism runs.

- A **bare call** `send()` is matched against the file's imported names, else against locally
  declared functions and React components.
- A **property access** `x.send()` is attributed **only** when `x` is a namespace import
  binding. `logger.send()` and an imported `send` share a member name and nothing else;
  matching on the name alone invented edges the code does not contain.
- `ns.send()` resolves through the namespace binding to the declaration in that module.
- The receiver and the namespace binding are persisted in edge metadata so an **incremental
  rescan rebuilds exactly what a full scan would**. This parity is non-negotiable and tested.

Call edges run `file → symbol`, not `symbol → symbol`. The view is "this file calls that
symbol", never "this function calls that function". Do not describe it as a call graph.

---

## 13. Algorithms

All deterministic. All tested for stability across runs and input orderings.

### Circular dependencies

**Tarjan's strongly connected components, implemented iteratively** so a deeply nested import
chain cannot overflow the call stack — the test suite includes a 20,000-node chain that would
kill a recursive implementation. Only components of two or more files are reported; a file
importing itself is a degenerate self-loop, not a cycle worth breaking. Each result carries a
concrete traversal that returns to its start, so the UI can show `a → b → c → a` rather than an
unordered set.

### Blast radius

Breadth-first traversal of **reverse** edges. BFS rather than DFS is deliberate: the first time
a node is reached is along a *shortest* path, which is exactly the explanation a developer wants
— the most direct reason a change here can affect that file. Depth is user-controlled and a
result that stops at the limit says so.

### Unused export candidates

An exported symbol with no resolved incoming reference edge. Deliberately conservative:

- Configured entry points, `package.json` entry points (`main`, `module`, `exports`, `bin`,
  `types`), and framework convention files are excluded outright
- Re-export forwarding rows are skipped — the underlying declaration is analysed on its own
- Default exports and React components carry an explicit caveat
- A file with an unresolvable `export *` carries that caveat forward
- Recent git **renames** add a caveat so a moved file is not treated as dead code

Always labelled **candidates**.

### Architecture rules

*Files matching A must not import files matching B*, with glob patterns (`**`, `*`, `?`,
`{a,b}`), optional exception patterns, and a severity. **Only resolved imports are evaluated** —
judging a rule against a path the analyser could not confirm would produce false accusations.

Built-in packs: `layered`, `client-server`, `no-tests-from-src`.

### Communities

**Louvain modularity optimisation**, in TypeScript, no dependency.

Start with every node in its own community; repeatedly move each node into whichever
neighbouring community most improves modularity; collapse each community into a single node and
repeat, up to 4 levels. Edges are treated as **undirected** — for grouping, `a` importing `b`
couples the two whichever way the arrow points.

Determinism is engineered, not incidental: nodes are visited in sorted order, ties break toward
the lowest community index, and the final numbering is by community size with the lowest member
id breaking ties. The largest community is always `0`, so it keeps its colour when a smaller one
appears or disappears.

Each community is named after the deepest directory shared by most of its members, with depth
breaking ties toward the more specific name.

### Radial 3D layout

Folders own equal-area regions of a sphere; children divide the parent's region in proportion to
how many files they contain; depth becomes distance from the root.

Equal area matters — a latitude/longitude split would crowd the poles and empty the equator.
Splitting along the region's **longer side** keeps regions compact rather than degenerating into
slivers as the tree deepens. Dependency arcs are quadratic Béziers with a control point pulled
to 55% of the midpoint's distance from the origin, so a long edge reads as one line with two
ends instead of attaching itself to whatever it crosses.

Deterministic: the same file list always produces the same positions, so a rescan does not
shuffle a space the reader has learned. Verified holding 3000 distinct positions.

### Complexity, clones, todos, Martin metrics

Function cyclomatic complexity (`COMPLEXITY_HOTSPOT_THRESHOLD = 10`, high severity at 20) and
nesting depth; simplified LCOM on classes; duplicate-code detection; todo comments; Martin
instability and abstractness per folder with file-level fan-in/out outliers. Thresholds are
product constants, not learned.

### Scan comparison

After each completed scan, a snapshot of finding fingerprints is stored. The dashboard shows
what appeared and disappeared versus the previous scan.

---

## 14. Type checking

**Off by default.** Enabled per project, then rescan.

Builds a real `ts.Program` and reports `getPreEmitDiagnostics` — TS2322, TS2554, TS2339 and the
rest, each with file, line, column, and the compiler's own message. This is the one part of
TraceDeck that can tell you TypeScript is genuinely broken. Findings are dismissible, keyed by
file, error code, and message rather than line number.

**Cost.** Much slower than the import scan, because building a program resolves and parses every
declaration file the project pulls in. On a 90-file monorepo the dependency scan takes about
0.3 s and the type check about 5 s. That ratio is why it is opt-in. Incremental checks reuse
**tsbuildinfo** under `.tracedeck/cache`.

**Monorepos.** A repository whose root holds only a `tsconfig.base.json`, with real
configurations one or two levels down, is handled: every configuration in the tree is discovered
and checked separately, duplicate diagnostics from overlapping configurations are removed, and
each configuration is parsed relative to its own directory so options like `rootDir` resolve the
way the compiler resolves them.

**What it will not catch.** Type checking honours the project's own settings, which cuts both
ways. A project with `skipLibCheck: true` has its `.d.ts` files skipped entirely, including its
own — a broken import inside a hand-written `.d.ts` is invisible to `tsc` there, and is caught
by the import resolver instead. The two checks overlap deliberately rather than duplicating.

Diagnostics originating outside the project, typically inside dependency type definitions, are
dropped. They are rarely actionable and would bury the ones that are.

**A known sharp edge:** when no tsconfig covers the files, the fallback builds a program with
empty compiler options, and TypeScript then auto-includes every `@types/*` package it can find
near the files. That makes the fallback as slow as the ambient environment is large, and its
results depend on what happens to be installed nearby. Setting `types: []` would make it
deterministic but would start reporting missing globals on plain JavaScript projects, so the
current behaviour stands and the limitation is stated.

---

## 15. Findings versus limitations

**Findings** are line-addressable, dismissible, exportable, and shown in the gutter. Exactly ten
types:

`circular-dependency`, `unused-export-candidate`, `architecture-violation`, `unresolved-import`,
`type-error`, `syntax-error`, `merge-conflict`, `todo-comment`, `duplicate-code`,
`complexity-hotspot`

Severity is `info`, `low`, `medium`, or `high`.

**Limitations** are bounded unique strings on `ScanSummary.limitations`: exclusions, missing
grammars, dynamic imports, unanalysed regions, default-compiler-options fallbacks. They are how
the tool admits what it could not see. The dashboard must treat the array as optional.

The rule: if analysis skipped something, it becomes one or the other. Never neither.

---

## 16. Change impact

An optional, fully transparent score from 0 to 100. Arithmetic over the graph — **not a
prediction and not a judgement about code quality**.

| Factor | Maximum | How it is counted |
| --- | ---: | --- |
| Files that import this directly | 30 | 3 points each |
| Files reached indirectly | 30 | 1 point each |
| Reachable from an entry point | 15 | All or nothing |
| Part of a circular dependency | 15 | All or nothing |
| Imports that could not be resolved | 5 | 1 point each |
| No test file depends on this | 5 | All or nothing |

Each factor is capped at its own maximum; the total is capped at 100. The inspector shows every
factor's raw value, points awarded, maximum, and a plain-language explanation.

**Percentile** is the standard mid-rank: the share of files scoring strictly lower, plus half
the share scoring the same. It is a function of the score itself, never of a file's position in
a sorted array — ranking by index spread tied scores across a wide band and invited comparisons
the numbers did not support. Ties always match. The only file in a project sits at 50 rather
than at an extreme.

**Working-tree impact** takes `git status`-style changed paths and walks the graph so the
dashboard can list affected files and tests before you commit.

---

## 17. The scan pipeline

Phases, surfaced to the renderer as progress: `discovering` → `parsing` → `resolving` →
`analysing` → optional `type-checking` → `persisting` → `done` (or `failed`).

1. **Discover.** Walk, inventory, graph-eligible list, exclusion diagnostics.
2. **Hash.** Every graph file is read and SHA-256 hashed **even on incremental scans**. Hashing
   is cheap; being wrong about what changed is not.
3. **Skip.** Skip the AST parse only when the scan is incremental **and** a stored fingerprint
   exists **and** both `contentHash` and `modifiedAt` match. Unchanged files are **reconstructed
   from SQLite** — imports, symbols, and calls rebuilt from persisted rows — and still
   participate in `buildGraph`. Incremental and full scans must produce identical graphs.
4. **Copy text findings.** Previous merge-conflict, todo, and JSON-syntax findings are copied
   for hash-stable inventory text rather than re-reading every file. Clones recompute only for
   changed files.
5. **Parse** changed files.
6. **Resolve** and **build the graph**.
7. **Run every algorithm.** Cycles, unused exports, rules, complexity, LCOM, todos, clones,
   Martin metrics, risk scores, and a scan snapshot. Blast radius is on demand only.
8. **Persist**, then prune superseded scans.

### Triggers

- Editor save → incremental scan
- Filesystem watcher → debounced incremental scan
- Sidebar **Scan** (incremental) vs **Full** (force every graph file)
- Typing in the editor → `analysis:preview`, which never persists

The preview resolver context is cached per project and keyed on the latest completed scan id, so
a finished scan invalidates it with no cross-module wiring. Rebuilding it per keystroke meant
walking the project for tsconfigs and reading every `package.json` while the user typed.

---

## 18. The interface

Sidebar → main panel → inspector. Views:

| View | Shows |
| --- | --- |
| **Dashboard** | Counts, scan summary, limitations, git impact, scan comparison, public API, licenses, top impact files |
| **Graph** | The 2D dependency graph and the 360 mode |
| **Explorer** | Full inventory with kind filters, exported-only, recents, in-file text hits |
| **Findings** | One view per finding type, with `j`/`k`/`Enter` navigation |
| **Metrics** | Martin instability/abstractness, fan-in/out, outliers, churn heatmap |
| **Architecture** | Rule CRUD, packs, forbidden-import matrix, layer diagram |
| **Reports** | Scope, sections, format, destination |
| **Settings** | Scan settings, exclusions, entry points, type checking, appearance |

**Inspector** shows, for a selected node: dependents, dependencies, tests covering it, entry
points reaching it, fan-in/out, risk score with full factor breakdown, percentile, symbols,
CODEOWNERS, git information, and a blast-path button.

**ErrorBoundary** is keyed on `` `${activeView}:${lastScan?.id ?? 'none'}` `` so a completed scan
remounts the view instead of leaving a stale crash on screen.

---

## 19. The graph, in depth

### 2D — Cytoscape

- File, symbol, and folder nodes. Node **size** grows with connectivity, damped by a square
  root so one hub cannot dwarf everything else.
- Node **colour is community, not folder.** Folder hues showed how the repository is *filed*,
  which the sidebar already says. Communities show how it is *coupled* — a folder whose files
  never reference each other is three groups wearing one name, and two folders that constantly
  cross-import are one group pretending to be two. Hues step by the golden angle so consecutive
  communities land far apart on the wheel.
- Legend lists communities with names and file counts.
- Focus neighbourhood, folder prefix filter, node-type and edge-type filters, hide type-only
  edges, collapse barrels, minimap, saved views in `localStorage` under `tracedeck.graph-views`.
- Layouts: fcose and dagre.
- Export to **PNG and SVG**.
- Call-graph slice: restricts to `call` edges and symbol nodes, with a clear button.

**Interaction:**

| Gesture | Effect |
| --- | --- |
| Click a node | Select; highlight neighbourhood; open inspector |
| Click empty canvas | Clear selection and gathered set; **do not** open the inspector |
| Double-click | Open the file in the editor |
| Ctrl/Cmd-click | Gather into a multi-selection, ringed rather than refilled |
| Shift-drag | Sweep a box; add everything caught to the same set |
| Ctrl-Shift-click / Ctrl-Shift-drag | Open every gathered file at once, capped at 12 tabs |

The gathered set lives apart from `selectedNodeId`, because the inspector describes exactly one
node and would otherwise flicker through everything added.

**Hovering does nothing, on purpose.** Highlighting a neighbourhood on mouseover faded and
unfaded the entire canvas every time the pointer crossed a node; on a dense graph that is a
full-screen flash several times a second — a photosensitivity hazard. This must not be
reintroduced as a feature.

### 360 — three.js

A second mode, never a replacement. The 2D view keeps the exact layouts and the vector export,
which WebGL cannot produce.

- Folders branch outward from a single root; dependency arcs cross the tree; orbit camera.
- One `InstancedMesh` plus two `LineSegments` sets, so node count costs memory rather than draw
  calls. Requests `GRAPH_NODE_HARD_LIMIT` rather than the soft limit, because the soft limit
  exists for canvas hit-testing, which WebGL does not share.
- Node geometry is a 20-triangle icosahedron. Every triangle is also a triangle the picker may
  test per instance, so detail costs interaction latency, not just draw time.
- **Render every frame.** On-demand rendering — redraw only when the camera moved — left the
  view blank until the first drag, because a scene rebuilt between frames had no way to
  announce itself. The optimisation was the bug.
- **Pick once per frame.** Pointer events fire far faster than frames, and each pick walks every
  instance, so raycasting per event made moving the mouse cost more than drawing the scene.
- Colours are read from live theme tokens and rebaked on theme change, because a canvas cannot
  read CSS variables.
- Ctrl-click gathering works here too. Box sweeping does not: a screen rectangle does not
  describe a selection in a scene you have rotated.

---

## 20. The editor

Monaco, split between the graph and the inspector, with a draggable divider. `Ctrl`/`Cmd` + `` ` ``
toggles it.

- Clicking a symbol in the inspector jumps to its declaration; double-clicking a graph node
  opens that file.
- Tabs and recent files live in renderer state, capped at 12.
- **Unlock is explicit. There is no auto-save.** `Ctrl`/`Cmd`+S saves only while unlocked.
- Saves compare SHA-256 of bytes on disk against the hash from `source:read`, then write
  temp-file-then-rename in the same directory. UTF-8 only. Binary, oversize, and
  encoding-mismatched files are not editable.
- Gutter marks: merge conflicts (including live, unsaved buffer), syntax, type, and unresolved
  findings, todos, complexity. `F8` cycles findings in the current file.
- Indent comes from EditorConfig when present. Format uses the **project's own** Prettier, if it
  can be loaded locally.
- Monaco highlights; **its semantic TypeScript checker stays off** so TraceDeck does not pretend
  to be an IDE.

---

## 21. Git

TraceDeck is not a git client. It shells out locally for read-only helpers plus mergetool.

| Action | Channel |
| --- | --- |
| Working-tree changes vs a ref (default HEAD) | `git:changed-files` |
| Unified diff | `git:diff` |
| Blame | `git:blame` |
| Files that often change together | `git:cochange` |
| Recent renames for a path | `git:renames` |
| 90-day churn | `git:churn` |
| Open the system mergetool | `git:mergetool` |

The session diff against the open snapshot is **not** git; it is a separate line-diff.

---

## 22. Reports

Export as **Markdown**, **JSON**, or **standalone HTML**. Scope: whole project, one file, one
symbol, or one finding type. Sections are selectable: summary, cycles, unused exports,
architecture violations, unresolved imports, type errors, changed-since-scan, blast-radius, and
more.

The HTML report is a single self-contained file: inlined styles, **no scripts**, no external
stylesheets, no fonts, no images. It adapts to the reader's light or dark theme and can be
opened from disk or attached to an email without ever touching the network. All output is
escaped; escaping is tested.

Reports are written only to a location chosen in a native save dialog.

---

## 23. The CLI

Headless scan for CI. Database at `<root>/.tracedeck/cli.sqlite`.

```bash
npm run scan -- [path] [--full] [--fail-on type,type] [--format text|json|sarif] [--baseline file] [--write-baseline]
```

| Flag | Meaning |
| --- | --- |
| `--full` | Force a full rescan |
| `--fail-on` | Comma-separated `FindingType`s; non-zero exit if any match |
| `--format` | `text` (default), `json`, or `sarif` |
| `--baseline` | Ignore fingerprints listed in that JSON file |
| `--write-baseline` | Write current fingerprints as a baseline |

`tsconfig.node.json` must include both `src/main/**/*.ts` and `src/cli/**/*.ts`.

---

## 24. Themes and accessibility

Four presets: **TraceDeck Dark** (default), **Cursor Dark**, **VS Code Dark**, **VS Code Light**.
Careful approximations designed to sit comfortably beside those editors, not exact copies.

Every colour resolves through CSS custom properties defined in `src/shared/theme.ts` — the
single source of truth. Tokens: `surface-0` through `surface-4`, `edge`, `ink`, `ink-muted`,
`ink-faint`, `brand`, `brand-dim`, `risk-low`, `risk-med`, `risk-high`, `risk-crit`.

Tailwind composes them as `rgb(var(--token) / <alpha-value>)` so opacity modifiers keep working.
Canvas and WebGL renderers cannot read CSS variables, so they read live token values and
restyle on theme change. The Electron window background and native title bar follow. The choice
is stored per device in `localStorage`.

A unit test pins the CSS first-paint fallback to the TypeScript definition. Another asserts
every theme clears a contrast floor.

**Accessibility rules:**

- No flashing. Nothing may repeatedly change large areas of the screen in response to pointer
  movement. Highlighting is bound to deliberate actions that hold.
- The inspector opens only when something real was clicked.
- Keyboard navigation in Findings (`j`/`k`/`Enter`) and the editor (`F8`).

---

## 25. Testing doctrine

Vitest. 35 test files, 481 passing tests.

Coverage must include: import resolution and path aliases; Tarjan cycle detection including a
20,000-node chain; blast-radius traversal and explanation paths; unused-export conservatism;
architecture rule evaluation; SQLite migrations **and rollback**; repository operations; IPC
payload validation; path-escape rejection; report rendering and HTML escaping; language-root
rewrites; template and style analysis; community detection determinism; radial layout
determinism at 3000 nodes; and a full end-to-end scan.

**Determinism is a test target, not an aspiration.** Every algorithm has a test asserting that
input order does not change the result and that repeated runs agree.

`tests/fixtures/sample-project/` deliberately contains: normal imports, a circular dependency,
used and unused exports, a barrel, an `export *` barrel, a path alias, a dynamic import, a
computed dynamic import, a missing import, an external package import, a React component, a
`.gitignore`d folder, and an architecture violation. Other fixtures cover monorepos, mixed
languages, asset-only projects, source containers, and ignore precedence.

**Behaviour pins that surprised older docs:** a missing `.scss` is `file-not-found`, not
`non-source-asset`; Vue/Svelte/Astro **style** regions are analysed alongside templates.

---

## 26. Packaging

electron-builder: NSIS on Windows, DMG on macOS, AppImage on Linux.

`better-sqlite3` is unpacked from the asar archive so its native binary can be loaded at
runtime. `npmRebuild` is disabled because better-sqlite3 v13 ships Node-API prebuilds that load
unchanged under both Node and Electron — rebuilding from source would demand a C++ toolchain for
no benefit. Tree-sitter WASM files are likewise unpacked.

If `npm install` stops on a `node-gyp` error, `npm install --ignore-scripts && npx electron
install` skips the unnecessary compile and fetches the Electron binary. CI installs the same way
and needs no toolchain.

---

## 27. Known limitations

Report these in the app rather than hiding them.

- **Computed dynamic imports.** `` import(`./mods/${name}`) `` has no statically knowable target.
  Recorded as unresolved, never guessed.
- **Namespace imports.** `import * as ns from './m'` consumes the whole module surface, so
  individual symbol usage is unknown. Affected files carry a caveat.
- **Ambiguous `export *`.** When several star re-exports could supply a name, no reference edge
  is created and the ambiguity is reported.
- **Runtime reflection.** Anything reached by string lookup, a DI container, or a plugin
  registry is invisible to import analysis.
- **Consumers outside the scanned folder.** A published package's API may be used by code the
  scan never sees, which is why entry points are excluded from unused-export analysis.
- **External packages** are recorded as external and not walked.
- **Type-level-only usage** is tracked through imports but not fully without type checking.
- **Python, Go, Rust, HTML, CSS, Sass:** import-like edges only. No unused-export surface, no
  symbols, and therefore no complexity findings.
- **Call extraction is conservative and file-level.** Not points-to, not CHA, not symbol-to-symbol.
- **Risk percentile is in-repo rank**, not calibrated incident risk.
- **Draft preview is single-file.** It reports what is wrong *in* the buffer, never that
  deleting an export here breaks three dependents.
- **Parser failures without a line** stay limitations.
- **The 360 view ceiling is `GRAPH_NODE_HARD_LIMIT`**, so "every file at once" currently means
  up to 5000.

---

## 28. What it should become

Ordered by value per unit of risk. Nothing here may violate section 2.

### Near term

1. **Lift the 3D node ceiling.** The 5000 cap exists for canvas hit-testing. WebGL does not
   share it. Measure the instanced path at 20k and 50k nodes, then introduce a renderer-aware
   limit rather than raising a constant blind.
2. **Reverse-direction preview.** Tell the user that removing this export breaks three
   dependents, while they are still typing. This is the single highest-value gap in the editor.
3. **Symbol-level call edges.** Attribute the caller to its enclosing function so the call slice
   becomes a real call graph rather than a file-level view wearing the name.
4. **New files in preview resolution.** Preview resolves against the last scan's file list, so a
   file created since the scan reads as unresolvable. Union the on-disk list.
5. **Community-aware layout.** Feed detected communities into the 2D layout so clusters are
   spatially separated, not merely coloured.

### Medium term

6. **Namespace-import usage tracking.** `ns.foo()` already resolves; extend that to reference
   edges so namespace imports stop being a blanket caveat.
7. **Cross-community bridge findings.** A file that is the sole connection between two large
   communities is architecturally interesting and currently invisible.
8. **Watch-mode CLI** for CI that reports only what changed against a baseline.
9. **Per-language symbol extraction** for Python, Go, and Rust via tree-sitter, unlocking
   unused-export analysis and complexity for those languages.
10. **Incremental typecheck scoping** — check only the configurations that own changed files.

### Long term

11. **A stable, versioned export format** so other tools can consume the graph without reading
    SQLite.
12. **Rule authoring from the graph** — select two clusters, generate the forbidden-import rule.
13. **Time travel.** Scan snapshots already exist; show how the graph's shape moved over the
    last fifty commits.

### Standing quality bar

Every addition must arrive with: deterministic behaviour, tests including an order-independence
test, an honest limitation if it cannot see something, defensive `?? []` on any new IPC array,
and documentation updated in the same commit.

---

## 29. Anti-goals

Things this product deliberately will not do. Each was considered and rejected.

- **No cloud, no sync, no accounts, no telemetry.** Not "off by default" — absent from the
  codebase.
- **No AI in analysis.** Not for ranking, not for naming, not for summarising findings.
- **No language server.** Monaco's semantic checker stays off.
- **No CVE database, no dependency vulnerability feed.** That requires the network.
- **No linting or style analysis**, beyond formatting the open buffer with the project's own
  Prettier.
- **No runtime instrumentation.** TraceDeck never executes the code it analyses, so it cannot
  and will not report runtime errors.
- **No guessing.** Where a target is genuinely ambiguous, record the ambiguity. Never invent an
  edge to make a picture look complete.
- **No flashing UI**, and no interaction that repaints large screen areas in response to mere
  pointer movement.
- **No auto-save**, and no write to a user's source that they did not explicitly request.

---

## The one-sentence version

TraceDeck is an offline Electron and SQLite dependency-graph application — TypeScript Compiler
API for JS/TS, tree-sitter for other languages and component templates, incremental scanning
with a watcher and live draft preview, Monaco rather than a language server, local-only git
helpers, deterministic community detection and a 3D branching view, a transparent change-impact
score that always shows its arithmetic, and a standing refusal to guess, phone home, or claim
more than static analysis can prove.
