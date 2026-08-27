# TraceDeck

A private, offline-first dependency explorer and change-impact analyzer for JavaScript and
TypeScript repositories.

> Open a project. See what depends on what. Understand what might break when you change
> code — without uploading source code.

TraceDeck parses your repository with the TypeScript Compiler API, builds a dependency graph,
and stores everything in a local SQLite database. It makes no network requests, has no
accounts, and collects no telemetry.

---

## Contents

- [What it does and does not detect](#what-it-does-and-does-not-detect)
- [Themes](#themes)
- [Privacy](#privacy)
- [Getting started](#getting-started)
- [Scripts](#scripts)
- [What TraceDeck analyses](#what-tracedeck-analyses)
- [Type checking](#type-checking)
- [Algorithms](#algorithms)
- [Change impact score](#change-impact-score)
- [Architecture](#architecture)
- [Security model](#security-model)
- [Database](#database)
- [Reports](#reports)
- [Known limitations](#known-limitations)
- [Testing](#testing)
- [Packaging](#packaging)

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
- **Architecture violations** are real, against rules you wrote.

**Real compile errors (opt-in).** Turning on type checking runs the actual TypeScript
compiler and reports its diagnostics. That is the one part of TraceDeck that can tell you code
is genuinely broken. See [Type checking](#type-checking).

**Where the honesty limit is — the change impact score.** Its *inputs* are real counts from the
graph. Its *weights* — 3 points per dependent, 15 for a cycle, 5 for no test coverage — are
chosen constants. They are not derived from data and not validated against real incidents. Treat
the score as a transparent way to sort files by how connected they are, not as a measurement of
risk. Every factor is shown with its arithmetic so you can judge it yourself.

**What TraceDeck does not do:**

- No execution. It cannot find runtime errors.
- No linting or style analysis.
- Without type checking enabled, no compile errors at all.

A file with a high score is not broken, and a file with a low score is not safe. The score says
"many things point at this," nothing more.

---

## Reading source in the app

Selecting a file and pressing **Code** (or `Ctrl`/`Cmd` + `` ` ``) splits the main area so the
source sits between the graph and the inspector. The divider is draggable. Clicking a symbol in
the inspector jumps to its declaration, and double-clicking a node in the graph opens that
file directly.

Highlighting is produced by TypeScript's own scanner in the main process rather than by a
highlighter shipped to the renderer. TypeScript is already a dependency there, so this is
accurate for real syntax and costs the renderer bundle nothing. Raw scanning is not JSX-aware
the way a full parse is, so the occasional span in a `.tsx` file is coloured loosely; the text
shown is always exact.

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

## Privacy

**Analysis stays on this device.** This is the product's central promise, and it is enforced
in several independent places rather than merely intended:

- The Electron session cancels every outbound request that is not a local file or the dev
  server, so even an accidental `fetch` cannot leave the machine.
- A Content-Security-Policy header restricts `connect-src`, `script-src`, and `frame-src`.
- The renderer has no Node.js, no filesystem, and no database access. It can only call an
  explicit allowlist of IPC channels.
- No telemetry, analytics, crash reporting, update check, or sync exists in the codebase.
- The database lives in the OS application-data directory, never inside your repository.
  TraceDeck reads your source files and never writes to them.
- Reports are written only to a location you pick in a native save dialog, and contain no
  remote assets.

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

### First run

1. Click **Open a project folder…** in the sidebar and pick a JavaScript or TypeScript repo.
2. Click **Scan**.
3. Explore the dashboard, graph, and findings.

Re-scanning is incremental: files whose SHA-256 hash and modification time are unchanged are
not re-parsed. Use **Full** to force a complete re-parse.

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
| `npm run package` | Build an unpacked application directory |
| `npm run dist` | Build a distributable installer for the current platform |

---

## What TraceDeck analyses

**Discovery** walks the project, honouring nested `.gitignore` files and skipping
`node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `out`, and `vendor`. Symlinks are
not followed, so a link cannot pull code from outside the project into the scan.

**Parsing** uses the TypeScript Compiler API on every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`,
`.jsx`, `.mjs`, and `.cjs` file, extracting:

- static imports, dynamic `import()`, `require()`, and `import x = require()`
- named exports, default exports, re-exports, and `export *`
- functions, classes, interfaces, type aliases, enums, and variables
- React components, but only where deterministically identifiable — a PascalCase declaration
  whose body contains JSX, or a class extending `React.Component`

**Resolution** follows relative paths, `tsconfig.json`/`jsconfig.json` path aliases, `baseUrl`,
directory `index` files, and the TypeScript convention where `./foo.js` refers to `foo.ts`.

Every `package.json` in the project, including workspace manifests, is read so that a declared
dependency can be told apart from a broken path alias. Without that, `@tanstack/react-query` and
`@app/db` are indistinguishable by shape, and ordinary packages get reported as problems. Node
builtins and workspace packages are recognised the same way. Imports of stylesheets, images,
JSON, and other non-JavaScript assets are recognised as valid and left out of the graph rather
than reported as missing files.

Only imports that genuinely fail to resolve become findings. Importing `react` is not a problem
and is not reported as one; third-party packages are counted separately as a neutral statistic.

**Barrel files** are traced through. When `app.ts` imports `{ Button }` from a `components`
barrel that re-exports it from `Button.tsx`, the reference is attributed to the declaration in
`Button.tsx` — not to the barrel. Where `export *` makes an origin genuinely ambiguous, no
reference is invented and the ambiguity is recorded as a caveat.

---

## Type checking

Off by default. Enable it per project under **Settings → Scan settings**, then rescan.

It builds a real `ts.Program` and reports `getPreEmitDiagnostics`, so what you see is what
`tsc` sees: TS2322, TS2554, TS2339 and the rest, each with file, line, column, and the
compiler's own message. Findings can be dismissed like any other, keyed by file, error code,
and message rather than line number, so unrelated edits above an error do not resurrect a
dismissal you already made.

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

Results are always labelled **candidates**. TraceDeck never claims code is dead.

### Architecture rules

User-defined rules of the form *files matching A must not import files matching B*, using glob
patterns (`**`, `*`, `?`, `{a,b}`) with optional exception patterns and a severity. Only
resolved imports are evaluated — judging a rule against a path the analyser could not confirm
would produce false accusations.

---

## Change impact score

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
│   │   ├── scanHandlers.ts     Start, cancel, and report scan progress
│   │   ├── analysisHandlers.ts Graph, blast radius, risk score, search, findings
│   │   ├── ruleHandlers.ts     Architecture rule CRUD and evaluation
│   │   ├── reportHandlers.ts   Report export through a native save dialog
│   │   └── systemHandlers.ts   Open/reveal a file, app info
│   ├── analysis/
│   │   ├── discovery.ts        File walking, .gitignore, exclusions
│   │   ├── parser.ts           TypeScript Compiler API extraction
│   │   ├── resolver.ts         Import resolution and path aliases
│   │   ├── tsconfig.ts         tsconfig/jsconfig loading
│   │   ├── graph.ts            Edge construction, barrel forwarding
│   │   ├── scanner.ts          Scan orchestration and incremental rescan
│   │   └── algorithms/
│   │       ├── graphIndex.ts   In-memory adjacency index
│   │       ├── cycles.ts       Tarjan SCC
│   │       ├── blastRadius.ts  BFS traversal with explanation paths
│   │       ├── unusedExports.ts
│   │       ├── architectureRules.ts
│   │       └── riskScore.ts
│   ├── db/
│   │   ├── connection.ts       SQLite connection and pragmas
│   │   ├── migrations.ts       Versioned schema migrations
│   │   ├── appDatabase.ts      userData path resolution
│   │   └── repositories/       One repository per table group
│   ├── services/
│   │   ├── analysisService.ts  Read-side queries for the UI
│   │   └── reportService.ts    Markdown, JSON, and HTML rendering
│   └── utils/                  Hashing, glob, gitignore, validation
├── preload/index.ts            contextBridge surface (invoke + onScanProgress)
├── renderer/src/               React UI
│   ├── components/
│   │   ├── layout/             Sidebar, main panel, inspector
│   │   ├── views/              Dashboard, graph, explorer, findings, rules, reports, settings
│   │   └── common/             Shared primitives and error boundary
│   ├── store/                  Zustand state
│   └── lib/ipc.ts              Typed IPC client
└── shared/                     Types, IPC contract, node ids, constants
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

SQLite via `better-sqlite3`, opened only in the main process, stored at
`app.getPath("userData")/tracedeck.db`.

Tables: `projects`, `scans`, `files`, `symbols`, `graph_edges`, `analysis_findings`,
`architecture_rules`, `saved_reports`, and `finding_dismissals`.

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
- **Type-level-only usage** is tracked through imports but not through full type checking.

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
rendering and HTML escaping, and a full end-to-end scan.

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
benefit.

---

## License

MIT
