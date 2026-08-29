# TraceDeck

A private, offline-first dependency explorer and change-impact analyzer for JavaScript,
TypeScript, and mixed-language repositories.

> Open a project. See what depends on what. Understand what might break when you change
> code — without uploading source code.

TraceDeck parses your repository (TypeScript Compiler API for JS/TS and component scripts;
tree-sitter for other graph languages), builds a dependency graph, and stores everything in a
local SQLite database. It makes no network requests, has no accounts, and collects no telemetry.
There is **no AI** in the analysis path.

App version: `0.1.0`.

---

## Contents

- [Recently completed (handoff)](#recently-completed-handoff)
- [What it does and does not detect](#what-it-does-and-does-not-detect)
- [Features](#features)
- [Editor](#editor)
- [Git (local only)](#git-local-only)
- [Themes](#themes)
- [Accessibility](#accessibility)
- [Privacy](#privacy)
- [Getting started](#getting-started)
- [CLI](#cli)
- [Scripts](#scripts)
- [What TraceDeck analyses](#what-tracedeck-analyses)
- [Type checking](#type-checking)
- [Algorithms](#algorithms)
- [Change impact](#change-impact)
- [Architecture](#architecture)
- [Security model](#security-model)
- [Database](#database)
- [Reports](#reports)
- [Known limitations](#known-limitations)
- [Testing](#testing)
- [Packaging](#packaging)
- [Constraints for the next contributor](#constraints-for-the-next-contributor)

A longer architecture briefing for another agent lives in [`docs/AGENT-BRIEFING.md`](docs/AGENT-BRIEFING.md).

---

## Recently completed (handoff)

Use this section if you are continuing work in another tool. Roadmap sections **A–I are
implemented**. Section **J was skipped** on purpose (cloud, LSP, CVE fetch, remote anything).

### Product work that shipped (A–I)

| Area | What exists now |
| --- | --- |
| **A. After a change** | Syntax findings with line numbers (TSC + tree-sitter `ERROR` nodes). Live merge-conflict and JSON marks on the open buffer. Incremental scan after save. Sidebar **Scan** vs **Full**. Draft preview (`analysis:preview`) while editing. File watcher → debounced incremental scan. Vue/Svelte/Astro templates and styles via tree-sitter; scripts stay on TSC. Unchanged files skip parse (hash + mtime); previous merge/todo/json findings are copied; clones recompute only for changed files. |
| **B. Change impact** | Inspector: dependents, tests, entry points, fan-in/out, percentile risk, blast path on the graph. Dashboard working-tree git impact (`git:changed-files` + `analysis:diff-impact`). Scan comparison via `scan_snapshots`. Call-graph slice in the inspector (sets `graphSliceEdgeTypes: ['call']`). Hide type-only edges. |
| **C. Editor** | Monaco for view and edit (semantic TS checker **off** on purpose — not an LSP). Tabs and recents. Project text search (`search:text`). F8 next finding in file. EditorConfig indent from `source:read`. Format with project Prettier if present (`source:format`). |
| **D. Git** | Local only: diff vs HEAD, blame, mergetool, co-change, per-file renames, 90-day churn. Rename history caveats unused-export findings. Inspector Git section. |
| **E. Metrics** | Cyclomatic + nesting on functions; simplified LCOM on classes. Complexity / todo / duplicate findings. Metrics view: Martin I/A, fan-in/out, file outliers, churn heatmap. `analysis:folder-metrics` returns `{ folders, outliers }` (`ProjectMetrics`), not a bare array. |
| **F. Architecture** | Rule packs (`src/shared/rulePacks.ts`, `rules:apply-pack`). Forbidden matrix + layer diagram. Public API + licenses on the dashboard. Headless CLI (`npm run scan`). |
| **G. Graph UX** | Saved views (`localStorage` key `tracedeck.graph-views`). Collapse barrels, edge filters, minimap, PNG **and** SVG export. Focus neighborhood; call-slice clear button. Community colouring; 360 mode. Hovering does not highlight — see [Accessibility](#accessibility). |
| **H. Search / reports** | Explorer kind filters, exported-only, recents, text hits. Findings j/k/Enter. Report sections `changed-since-scan` and `blast-radius`. CODEOWNERS overlay on file detail. |
| **I. Languages** | TSC for JS/TS with tsbuildinfo cache under `.tracedeck/cache`. SCSS/Sass/Less are **graph sources**. `.styl` stays a non-source asset. JSON imports remain graph leaves. Package-root rewrites: Go `go.mod`, Python `pyproject.toml`/`setup.cfg` + `__init__.py`, Rust `Cargo.toml`. `.tracedeck` is excluded from discovery. |

### Crash fix (dashboard `.length`)

After a scan, the ErrorBoundary could show *This view could not be displayed. Cannot read
properties of undefined ('length')*.

**Cause:** Dashboard and related views assumed newer stats fields were always present
(`publicApi`, `licenses`, `topImpactFiles`, `scanComparison.addedTitles`,
`summary.limitations`). Renderer HMR with a stale main process, or a partial IPC payload,
could omit them.

**Fix:**

- `Dashboard.tsx`: `?? []` on those arrays; LimitationsCard accepts undefined; git impact card
  guards `files` / `affectedPaths` / `testPaths`.
- `GraphView.tsx`: `payload.nodes ?? []`, `payload.edges ?? []`.
- `Metrics.tsx`: accepts `{ folders, outliers }` **or** a legacy array.
- `Findings.tsx`: optional `cyclePath` / `edges` / `caveats` / `filePaths`.
- `Inspector.tsx`: optional `owners` / `entryPointsCovering` / `testDependents` / `symbols`.
- `analysisService.dashboardStats`: try/catch around snapshots + license/public API;
  fingerprints coerced to arrays.
- `snapshotRepository.latestTwo`: `Array.isArray(parsed)`.
- `App.tsx` ErrorBoundary key: `` `${activeView}:${lastScan?.id ?? 'none'}` `` so a finished
  scan remounts the view.

Typecheck was green. Tests: **435 passed**, 2 skipped (after A–I).

### Honest remaining limits (do not “fix” by adding AI or network)

- Call-graph extraction is conservative, not a full points-to analysis.
- Risk percentile is **relative to this project**, not calibrated against incidents.
- No LSP / IntelliSense. Monaco’s semantic TypeScript checker is disabled on purpose.
- Electron renderer-only HMR can leave **main stale**; keep defensive `?? []` on IPC arrays.
- `better-sqlite3` is **main-process only**.

---

## What it does and does not detect

TraceDeck is a **dependency and structure** tool. Being precise about the boundary matters more
than sounding capable.

**Grounded in parsed facts:**

- **Import edges** come from the AST and are resolved against files that exist on disk.
- **Circular dependencies** are a verifiable property of that graph.
- **Unresolved imports** are the closest thing here to broken-code detection: an import that
  cannot be resolved is often a typo, a deleted file, or a bad relative path.
- **Unused export candidates** are a real absence of reference edges, reported conservatively.
- **Architecture violations** are real, against rules you wrote or applied from a pack.
- **Syntax findings** are line-addressable parser failures (TSC parse issues, tree-sitter
  `ERROR` nodes, JSON). Failures without a line stay scan **limitations**, not findings.
- **Merge conflicts** are regex-detected conflict markers in inventoried text files, plus live
  marks on the open editor buffer.

**Real compile errors (opt-in).** Turning on type checking runs the actual TypeScript
compiler and reports its diagnostics. That is the one part of TraceDeck that can tell you
TypeScript is genuinely broken. See [Type checking](#type-checking).

**Where the honesty limit is — scores.** Change-impact *inputs* are real counts from the
graph. *Weights* (dependents, cycles, no test coverage, …) are chosen constants, not derived
from incident data. Percentile risk ranks files **inside this repo**. Treat scores as a way to
sort by connectivity, not as a measurement of production risk. The inspector shows the
arithmetic.

**What TraceDeck does not do:**

- No execution. It cannot find runtime errors.
- No linting or style analysis (except optional Prettier format of the open buffer).
- No language server, no IntelliSense, no go-to-definition across a project via LSP.
- No network, no CVE database fetch, no AI ranking.

A file with a high score is not broken, and a file with a low score is not safe. The score
says "many things point at this," nothing more.

---

## Features

### After you change code

- **Scan** re-parses files whose SHA-256 and mtime changed; **Full** forces every graph file.
- Saving from the editor starts an incremental scan (`startScan(false)`).
- A filesystem watcher also triggers a debounced incremental scan when files change on disk.
- While you type, **preview analysis** (`analysis:preview`) updates draft findings for the
  open buffer without waiting for a full persist.
- The dashboard copy explains incremental vs Full so a fast scan is not mistaken for a skip.

### Graph and inspector

- File and symbol graph (Cytoscape). Focus neighborhood, folder prefix, node-type and edge-type
  filters (including hiding type-only edges).
- Soft/hard node limits (`GRAPH_NODE_SOFT_LIMIT` 1500 / `HARD` 5000) because canvas interaction
  dies past that.
- Blast radius (BFS on reverse edges, shortest path as the explanation).
- Call-graph slice: inspector button restricts the graph to `'call'` edges and symbol nodes.
- Saved layouts/views, collapse barrels, minimap, PNG and SVG export.
- **Ctrl-click** (or Cmd-click) gathers nodes into a set, ringed rather than recoloured so
  the community colours stay readable. **Shift-drag** sweeps a box and adds everything it
  catches to the same set, so several sweeps accumulate. Adding **Ctrl** to either — 
  Ctrl-Shift-click, or Ctrl-Shift-drag — opens every gathered file in the editor at once,
  capped at twelve tabs. Clicking empty canvas clears the set. Ctrl-click works in 360 too;
  box sweeping is 2D only, since a rectangle does not describe a selection in a rotated 3D
  scene.
- The inspector opens when you click something real. Clicking empty canvas clears the
  selection without opening an empty panel.
- Nodes are coloured by **community** — files that depend on each other more than on the rest
  of the project — not by folder. Communities are found with deterministic modularity
  optimisation (Louvain) and named after the directory most of their files share, so the
  colour shows how the code is coupled rather than how it is filed.
- A **360** mode renders the same graph in 3D: folders branch outward from a single root and
  dependencies are drawn as arcs across the tree, with an orbit camera. It is a second mode,
  not a replacement — the 2D view keeps the exact layouts and the vector export.

### Findings

Current `FindingType`s: `circular-dependency`, `unused-export-candidate`,
`architecture-violation`, `unresolved-import`, `type-error`, `syntax-error`, `merge-conflict`,
`todo-comment`, `duplicate-code`, `complexity-hotspot`.

Dismissals are keyed by a **content fingerprint**, not a line number, so an edit above a
finding does not resurrect a dismissal.

### Explorer, metrics, architecture, reports

- Explorer lists **inventory** (every retained filesystem entry), not only graph sources.
  Kind filters, exported-only, recents, in-file text hits.
- Metrics: Martin instability/abstractness, fan-in/out bars, outliers, git churn heatmap.
- Architecture: glob rules, built-in packs (layered, client-server, no-tests-from-src),
  forbidden-import matrix, layer diagram.
- Reports: Markdown, JSON, or scriptless HTML; extra sections for changed-since-scan and
  blast-radius. CODEOWNERS shown on file detail when a `CODEOWNERS` file exists.

---

## Editor

Selecting a file and pressing **Code** (or `Ctrl`/`Cmd` + `` ` ``) splits the main area so
**Monaco** sits between the graph and the inspector. The divider is draggable.

- Clicking a symbol in the inspector jumps to its declaration; double-clicking a graph node
  opens that file.
- Tabs and recent files live in renderer state (`uiStore`).
- Unlock is explicit; there is **no auto-save**. `Ctrl`/`Cmd`+S saves only while unlocked.
- Saves compare SHA-256 of bytes on disk to the hash from `source:read`, then write
  temp-file-then-rename in the same directory. UTF-8 only. Binary, oversize, and
  encoding-mismatched files are not editable.
- Gutter: merge conflict (including live buffer), syntax / type / unresolved, todos and
  complexity. F8 cycles findings in the current file.
- Indent comes from EditorConfig when present. Format uses the project’s Prettier if it can
  be loaded locally.

The TypeScript scanner in main is **not** the colourizer anymore. Monaco highlights; its
semantic checker stays off so TraceDeck does not pretend to be an IDE.

---

## Git (local only)

TraceDeck is not a git client. It shells out locally for read-only (and mergetool) helpers:

| Action | Channel |
| --- | --- |
| Working-tree changes vs a ref (default HEAD) | `git:changed-files` |
| Unified diff | `git:diff` |
| Blame | `git:blame` |
| Files that often change together | `git:cochange` |
| Recent renames for a path | `git:renames` |
| 90-day churn | `git:churn` |
| Open system mergetool | `git:mergetool` |

The dashboard can show **git impact**: changed paths plus graph dependents and tests. Unused-export
findings can carry a caveat when git rename history suggests the export moved rather than died.

---

## Themes

Four presets, selectable under **Settings → Appearance**:

| Theme | Notes |
| --- | --- |
| **TraceDeck Dark** (default) | Cool blue-violet palette tuned for graph legibility |
| **Cursor Dark** | Near-neutral dark greys |
| **VS Code Dark** | Approximates Dark Modern |
| **VS Code Light** | Approximates Light Modern |

The editor themes are careful approximations designed to sit comfortably beside those editors,
not exact copies of them.

Every colour in the app resolves through CSS custom properties defined in `src/shared/theme.ts`,
which is the single source of truth. Tailwind composes them as `rgb(var(--token) / <alpha-value>)`
so opacity modifiers keep working. The Cytoscape graph paints to a canvas and cannot read CSS
variables, so it reads the live token values and restyles when the theme changes. The Electron
window background and native title bar follow too, and the choice is stored per device in
`localStorage`. A unit test pins the CSS first-paint fallback to the TypeScript definition, and
another asserts every theme clears a contrast floor.

---

## Accessibility

**Hovering a graph node does nothing on purpose.** An earlier build highlighted a node's
neighbourhood on mouseover, which faded and unfaded the entire canvas every time the pointer
crossed a node. Moving across a dense graph made that a full-screen flash repeating several
times a second — a photosensitivity hazard, and unpleasant for everyone else.

Highlighting is bound to **click** instead. A selection holds until you clear it, so the
neighbourhood stays readable while you work with it rather than disappearing when the mouse
drifts.

---

## Privacy

**Analysis stays on this device.** This is the product's central promise, and it is enforced
in several independent places rather than merely intended:

- The Electron session cancels every outbound request that is not a local file or the Vite
  dev server, so even an accidental `fetch` cannot leave the machine.
- A Content-Security-Policy header restricts `connect-src`, `script-src`, and `frame-src`.
- The renderer has no Node.js, no filesystem, and no database access. It can only call an
  explicit allowlist of IPC channels.
- No telemetry, analytics, crash reporting, update check, or sync exists in the codebase.
- The **app database** lives in the OS application-data directory
  (`app.getPath("userData")/tracedeck.db`), not inside your repository.
- The GUI writes your source **only** when you explicitly save an unlocked file. Reports are
  written only to a location you pick in a native save dialog, and contain no remote assets.
- The **CLI** writes `<project>/.tracedeck/cli.sqlite` (and may write a tsbuildinfo cache under
  `.tracedeck/cache`). `.tracedeck` is excluded from discovery so those files are not scanned
  as project source.

There is no environment configuration and no `.env` file, because there is nothing to
configure — no keys, no endpoints, no services.

---

## Getting started

Requirements: **Node.js 20+** and npm.

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` starts Vite for the renderer and launches Electron with hot reload.

`better-sqlite3` ships prebuilt Node-API binaries that load unchanged under both Node and
Electron, so no native rebuild is needed. Its install script nevertheless runs `node-gyp
rebuild` unconditionally, which fails on a machine without a C++ toolchain. If `npm install`
stops on a `node-gyp` error, skip the unnecessary compile:

```bash
npm install --ignore-scripts && npx electron install
```

The second command fetches the Electron binary that the skipped postinstall would have
downloaded. Continuous integration installs the same way and needs no toolchain at all.

If the native module was built for the wrong ABI (app fails to open SQLite),
`npm run rebuild` rebuilds `better-sqlite3` for Electron.

### First run

1. Click **Open a project folder…** in the sidebar and pick a repository.
2. Click **Scan** (incremental). Use **Full** when you want every graph file re-parsed.
3. Explore the dashboard, graph, findings, metrics, and architecture views.

Re-scanning is incremental: files whose SHA-256 hash and modification time are unchanged are
not re-parsed. Use **Full** to force a complete re-parse.

---

## CLI

Headless scan for CI or scripts. Database: `<root>/.tracedeck/cli.sqlite`.

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

Example: `npm run scan -- . --fail-on circular-dependency,architecture-violation --format sarif`

`tsconfig.node.json` must include both `src/main/**/*.ts` and `src/cli/**/*.ts`.

---

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Run the app in development with hot reload |
| `npm run build` | Type-check, then build main, preload, and renderer bundles |
| `npm start` | Run the production build locally |
| `npm run typecheck` | Type-check both the Node and browser projects |
| `npm run lint` | Lint with ESLint |
| `npm run format` | Format with Prettier |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with a coverage report |
| `npm run scan` | Headless CLI scan (`src/cli/main.ts` via vite-node) |
| `npm run rebuild` | Rebuild `better-sqlite3` for Electron |
| `npm run package` | Build an unpacked application directory |
| `npm run dist` | Build a distributable installer for the current platform |

---

## What TraceDeck analyses

**Two file universes.** `project_files` is inventory (Explorer). `files` / `symbols` /
`graph_edges` are graph-eligible sources only. Do not dump HTML docs or binaries into the
graph table just to “scan more.”

**Discovery** walks the project, honouring nested `.gitignore` files and skipping
`node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `out`, `vendor`, `.turbo`,
`.cache`, `.svelte-kit`, `.nuxt`, and `.tracedeck`. Symlinks are listed, never followed.

`.gitignore` does **not** hide a file from inventory; it is stored as metadata. User exclude
patterns and `includeTestFiles` affect analysis eligibility, not whether Explorer can see the
file.

**Graph sources** (`SOURCE_EXTENSIONS`):

| Parser | Extensions |
| --- | --- |
| TypeScript Compiler API | `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs`, plus `<script>` in `.vue` `.svelte` `.astro` |
| tree-sitter | `.html` `.htm` `.css` `.scss` `.sass` `.less` `.py` `.go` `.rs`, plus Vue/Svelte/Astro **template and style** regions |

`.styl` and JSON/images/fonts/markdown/wasm/etc. stay **non-source assets**: a valid import
must not become “file not found,” and they are not graph nodes. Missing `.scss` **is**
`file-not-found` because Sass is a graph source.

**JS/TS extraction:** static imports, dynamic `import()`, `require()`, `import x = require()`,
named/default/re-exports, `export *`, functions, classes, interfaces, type aliases, enums,
variables, and React components only where deterministically identifiable (PascalCase + JSX in
body, or a class extending `React.Component`). Conservative **call** edges feed the call-graph
slice.

**Resolution** follows relative paths, `tsconfig.json`/`jsconfig.json` path aliases, `baseUrl`,
directory `index` files, and the TypeScript convention where `./foo.js` refers to `foo.ts`.
Package-root rewrites use `go.mod`, `pyproject.toml`/`setup.cfg` + `__init__.py`, and
`Cargo.toml` (`languageRoots.ts`).

Every `package.json` in the project, including workspace manifests, is read so that a declared
dependency can be told apart from a broken path alias. Node builtins and workspace packages are
recognised the same way.

**Barrel files** are traced through. When `app.ts` imports `{ Button }` from a `components`
barrel that re-exports it from `Button.tsx`, the reference is attributed to the declaration in
`Button.tsx` — not to the barrel. Where `export *` makes an origin genuinely ambiguous, no
reference is invented and the ambiguity is recorded as a caveat.

tree-sitter languages contribute **import-like edges**, not a full export/symbol surface, so
unused-export analysis does not apply to them.

---

## Type checking

Off by default. Enable it per project under **Settings → Scan settings**, then rescan.

It builds a real `ts.Program` and reports `getPreEmitDiagnostics`, so what you see is what
`tsc` sees: TS2322, TS2554, TS2339 and the rest, each with file, line, column, and the
compiler's own message. Findings can be dismissed like any other, keyed by file, error code,
and message rather than line number.

Incremental typecheck can reuse **tsbuildinfo** under `.tracedeck/cache`.

**Cost.** This is much slower than the import scan, because building a program resolves and
parses every declaration file the project pulls in. On a 90-file monorepo the dependency scan
takes about 0.3 seconds and the type check about 5 seconds. That ratio is why it is opt-in.

**Monorepos are handled.** A repository whose root holds only a `tsconfig.base.json`, with the
real configurations one or two levels down in each app or package, is checked correctly: every
configuration in the tree is discovered and checked separately, and duplicate diagnostics from
overlapping configurations are removed. Each configuration is parsed relative to its own
directory, so options like `rootDir` resolve the way the compiler resolves them.

**What it will not catch.** Type checking honours your project's own settings, which cuts both
ways. A project with `skipLibCheck: true` — a very common setting — has its `.d.ts` files
skipped by the compiler entirely, including its own. A broken import inside a hand-written
`.d.ts` is invisible to `tsc` there, and is caught by the import resolver instead. The two
checks overlap deliberately rather than duplicating each other.

Diagnostics originating outside the project, typically inside dependency type definitions, are
dropped. They are rarely actionable and would bury the ones that are.

---

## Algorithms

All analysis is deterministic. The same repository always produces the same graph, the same
findings, and the same scores. No AI, no heuristic ranking, no external service.

### Circular dependencies

Tarjan's strongly connected components algorithm, implemented iteratively so that a deeply
nested import chain cannot overflow the call stack. Only components of two or more files are
reported; a file importing itself is a degenerate self-loop, not a cycle worth breaking. Each
result includes a concrete traversal that returns to its starting file, so the UI can show
`a → b → c → a` rather than an unordered set.

### Blast radius

Breadth-first traversal of reverse edges. BFS rather than DFS is deliberate: the first time a
node is reached is along a *shortest* path, which is exactly the explanation a developer
wants — the most direct reason a change here can affect that file. Depth is user-controlled,
and a result that stops at the limit says so.

### Unused export candidates

An exported symbol with no resolved incoming reference edge. This is deliberately conservative:

- configured entry points, `package.json` entry points (`main`, `module`, `exports`, `bin`,
  `types`), and framework convention files are excluded outright
- re-export forwarding rows are skipped, since the underlying declaration is analysed on its own
- default exports and React components carry an explicit caveat
- a file with an unresolvable `export *` carries that caveat forward
- recent git **renames** can add a caveat so a moved file is not treated as dead code

Results are always labelled **candidates**. TraceDeck never claims code is dead.

### Architecture rules

User-defined rules of the form *files matching A must not import files matching B*, using glob
patterns (`**`, `*`, `?`, `{a,b}`) with optional exception patterns and a severity. Only
resolved imports are evaluated — judging a rule against a path the analyser could not confirm
would produce false accusations. Packs in `src/shared/rulePacks.ts` insert a starter set.

### Complexity, clones, todos

Function cyclomatic complexity and nesting depth; simplified LCOM on classes. Duplicate-code
and todo-comment findings. Thresholds are product constants, not learned.

### Martin metrics

Instability and abstractness per folder, plus file-level fan-in/out outliers, shown on the
Metrics view.

### Scan comparison

After each completed scan, a snapshot of finding fingerprints is stored. The dashboard can
show what appeared or disappeared versus the previous scan.

---

## Change impact

An optional, fully transparent score from 0 to 100. It is arithmetic over the graph, **not a
prediction and not a judgement about code quality**.

| Factor | Maximum | How it is counted |
| --- | ---: | --- |
| Files that import this directly | 30 | 3 points each |
| Files reached indirectly | 30 | 1 point each |
| Reachable from an entry point | 15 | All or nothing |
| Part of a circular dependency | 15 | All or nothing |
| Imports that could not be resolved | 5 | 1 point each |
| No test file depends on this | 5 | All or nothing |

Each factor is capped at its own maximum and the total is capped at 100. The inspector shows
every factor's raw value, points awarded, maximum, and a plain-language explanation, so the
number can always be traced back to the graph.

**Percentile risk** ranks that score against other files in the same project, as the share
scoring lower plus half the share scoring the same. Files with equal scores always share a
percentile. It is not a calibrated probability.

**Working-tree impact** takes `git status`-style changed paths and walks the graph
(`analysis:diff-impact`) so the dashboard can list affected files and tests before you commit.

---

## Architecture

```
src/
├── main/                       Electron main process (Node)
│   ├── index.ts                App lifecycle, database bootstrap
│   ├── security.ts             Sandboxing, CSP, navigation and network blocking
│   ├── window.ts               BrowserWindow creation
│   ├── ipc/                    Typed, validated IPC handlers
│   │   ├── registry.ts         Handler registration and error envelopes
│   │   ├── projectHandlers.ts  Open, list, configure projects
│   │   ├── scanHandlers.ts     Start, cancel, progress; starts file watcher
│   │   ├── analysisHandlers.ts Graph, blast radius, risk, search, findings
│   │   ├── extraHandlers.ts    Source, git, preview, metrics, format, packs
│   │   ├── ruleHandlers.ts     Architecture rule CRUD and evaluation
│   │   ├── reportHandlers.ts   Report export through a native save dialog
│   │   └── systemHandlers.ts   Open/reveal a file, app info, save-export
│   ├── analysis/
│   │   ├── discovery.ts        File walking, inventory, .gitignore, exclusions
│   │   ├── parser.ts           TypeScript Compiler API (+ component scripts)
│   │   ├── languageRoots.ts    Go/Python/Rust package-root rewrites
│   │   ├── treeSitter/         WASM grammars (html, css, python, go, rust, …)
│   │   ├── resolver.ts         Import resolution and path aliases
│   │   ├── tsconfig.ts         tsconfig/jsconfig loading
│   │   ├── graph.ts            Edge construction, barrel forwarding, calls
│   │   ├── scanner.ts          Scan orchestration and incremental rescan
│   │   ├── diagnostics.ts      Optional typecheck
│   │   ├── textDiagnostics.ts  JSON syntax
│   │   └── algorithms/         cycles, blast, unused exports, rules, risk,
│   │                           complexity, todos, clones, martin, scanCompare,
│   │                           diffImpact
│   ├── db/
│   │   ├── connection.ts       SQLite connection and pragmas
│   │   ├── migrations.ts       Versioned schema migrations
│   │   ├── appDatabase.ts      userData path resolution
│   │   └── repositories/       One repository per table group
│   ├── services/               analysis reads, reports, source, git, watch,
│   │                           preview, format, licenses, codeowners
│   └── utils/                  Hashing, glob, gitignore, validation
├── cli/main.ts                 Headless scan (vite-node)
├── preload/index.ts            contextBridge surface (invoke + onScanProgress)
├── renderer/src/               React UI
│   ├── components/
│   │   ├── layout/             Sidebar, main panel, inspector
│   │   ├── views/              Dashboard, graph, explorer, findings, metrics,
│   │   │                       architecture, reports, settings, code panel
│   │   └── common/             Shared primitives and error boundary
│   ├── store/                  Zustand state (including graph slice / tabs)
│   └── lib/ipc.ts              Typed IPC client
└── shared/                     Types, IPC contract, constants, rule packs,
                                theme, mergeConflicts, sourceMarkers
```

The IPC contract in `src/shared/ipc.ts` is the single source of truth for what the renderer can
reach. Adding a channel there and implementing its handler is the only supported way to widen
the surface; startup fails if a declared channel has no handler.

---

## Security model

| Setting | Value |
| --- | --- |
| `contextIsolation` | `true` |
| `nodeIntegration` | `false` |
| `sandbox` | `true` (plus `app.enableSandbox()`) |
| `webviewTag` | `false` |
| `webSecurity` | `true` |

- The preload script exposes exactly two functions: `invoke` and `onScanProgress`. It checks
  the channel against an allowlist before forwarding.
- Every handler validates its payload structurally before touching the database or the
  filesystem. Unexpected errors are logged locally and reduced to a generic message before
  crossing the bridge, so internal paths and stack frames never reach the renderer.
- The renderer never supplies a filesystem path. Opening a project and saving a report both go
  through native dialogs, and "open file" / "reveal file" resolve a project-relative path and
  refuse anything that escapes the project root.
- Navigation away from the bundled UI is blocked; `window.open` is denied, with `https://`
  links handed to the OS browser instead.

---

## Database

SQLite via `better-sqlite3`, opened only in the main process.

- **GUI:** `app.getPath("userData")/tracedeck.db`
- **CLI:** `<project>/.tracedeck/cli.sqlite`

Tables include `projects`, `scans`, `files`, `symbols`, `graph_edges`, `analysis_findings`,
`architecture_rules`, `saved_reports`, `finding_dismissals`, `project_files` (inventory), and
`scan_snapshots` (fingerprint lists for scan comparison).

- Schema versioning uses `PRAGMA user_version`. Each migration runs inside its own
  transaction; a failure rolls back and aborts the run, leaving the database at the last
  version that applied cleanly rather than half-migrated.
- WAL is enabled so the UI can read dashboard counts while a scan writes thousands of rows.
- Bulk inserts use prepared statements inside transactions; all queries are parameterised.
- Indexes cover project and scan lookups plus both directions of every graph edge.
- Dismissed findings are keyed by a stable content fingerprint rather than a row id, so a
  review decision survives a rescan that regenerates the finding.
- After a scan completes, superseded scans are pruned. Rows for unchanged files are moved onto
  the current scan rather than rebuilt, which is what makes that pruning safe.

---

## Reports

Export locally as **Markdown**, **JSON**, or **standalone HTML**. You choose the scope (whole
project, selected file, selected symbol, or one finding type), which sections to include, the
title, and the destination.

Sections include the original graph/findings/limitations material plus **changed-since-scan**
and **blast-radius** when selected.

The HTML report is a single self-contained file: styles are inlined, there are no scripts, no
external stylesheets, no fonts, and no images. It adapts to the reader's light or dark theme
and can be opened from disk or attached to an email without ever touching the network.

---

## Known limitations

TraceDeck reports these in the app rather than hiding them. Static analysis cannot see:

- **Computed dynamic imports.** `import(\`./mods/${name}\`)` has no statically knowable target.
  These are recorded as unresolved, never guessed.
- **Namespace imports.** `import * as ns from './m'` consumes the whole module surface, so
  individual symbol usage is unknown. Affected files carry a caveat.
- **Ambiguous `export *`.** When several star re-exports could supply the same name, no
  reference edge is created and the ambiguity is reported.
- **Runtime reflection.** Anything reached by string lookup, a DI container, or a plugin
  registry is invisible to import analysis.
- **Consumers outside the scanned folder.** A published package's API may be used by code this
  scan never sees, which is why entry points are excluded from unused-export analysis.
- **External packages.** Dependencies in `node_modules` are recorded as external and not walked.
- **Type-level-only usage** is tracked through imports but not through full type checking
  unless typecheck is on.
- **Python / Go / Rust / HTML / CSS / Sass:** import-like edges only. No unused-export surface.
- **Call graph:** conservative extraction; not a points-to or CHA analysis. A method call is
  attributed only when its receiver is a namespace import, because `logger.send()` and an
  imported `send` share a name and nothing else.
- **Parser failures without a line** stay limitations. Line-addressable failures become
  `syntax-error` findings.

Because of these, TraceDeck deliberately uses cautious language everywhere: *unused export
candidate*, *possible impact*, *static analysis result*, *could not resolve dynamically
imported module*. It never claims code is definitely dead, broken, or safe to remove.

---

## Testing

```bash
npm test
```

The suite covers import resolution and path aliases, Tarjan cycle detection (including a
20,000-node chain that would overflow a recursive implementation), blast-radius traversal and
explanation paths, unused-export conservatism, architecture rule evaluation, SQLite migrations
and rollback, repository operations, IPC payload validation, path-escape rejection, report
rendering and HTML escaping, language-root rewrites, template/style analysis, and a full
end-to-end scan.

Behaviour pins that surprised older docs:

- Vue/Svelte/Astro limitations mention template **and** style regions analysed (scripts still
  TSC).
- A missing `.scss` import is `file-not-found`, not `non-source-asset`.

`tests/fixtures/sample-project/` is a small TypeScript repository containing, on purpose:
normal imports, a circular dependency, used and unused exports, a barrel export, a `export *`
barrel, a path alias, a dynamic import, a computed dynamic import, a missing import, an
external package import, a React component, a `.gitignore`d folder, and an architecture
violation.

---

## Packaging

```bash
npm run dist
```

Builds a distributable for the current platform with electron-builder (NSIS on Windows, DMG on
macOS, AppImage on Linux). `npm run package` produces an unpacked directory, which is faster
for testing a production build.

`better-sqlite3` is unpacked from the asar archive so its native binary can be loaded at
runtime. `npmRebuild` is disabled in the electron-builder configuration because
better-sqlite3 v13 ships Node-API prebuilds that are ABI-independent — they load unchanged
under both Node and Electron, so rebuilding from source would need a C++ toolchain for no
benefit. Tree-sitter WASM files are similarly unpacked.

---

## Constraints for the next contributor

1. **Offline.** No new network calls, CDNs, model APIs, telemetry, or grammar downloads.
   WASM grammars must ship in the install.
2. **No AI** in the analysis path. Same files → same graph, findings, and scores.
3. **IPC is closed.** `src/shared/ipc.ts` is the contract. Startup fails if a channel has no
   handler. Renderer never sends absolute filesystem paths.
4. **Do not follow symlinks.**
5. **Inventory ≠ graph.** Keep `project_files` and `files` separate.
6. **Source writes are guarded** (hash check, atomic rename, UTF-8, no auto-save).
7. **Do not add LSP, CVE fetch, or cloud.** That was section J and was skipped.
8. **Do not commit** unless the owner asks.
9. After UI changes, prefer running `npm run typecheck` and `npm test`. If the dashboard
   assumes new IPC fields, default missing arrays to `[]`.

---

## License

MIT
