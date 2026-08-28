# TraceDeck — Project Briefing for Independent Review

**Audience:** another agent or engineer who has not seen this repository.  
**Purpose:** explain the product, architecture, language choices, and current analysis pipeline so you can recommend the **best next step for parsing completeness and failure surfacing** — not a generic “make it faster” plan.  
**Date of this briefing:** 2026-08-28.  
**App version:** `0.1.0`.  
**Repo:** private Electron desktop app. Analysis is local-only.

This document describes the **current shipped/in-progress design**, including work that is newer than `README.md` (tree-sitter languages, project inventory, in-app source editor, live merge-conflict gutter marks). If README and this file disagree, this file is the source of truth.

---

## 1. What you are being asked to decide

The product owner’s complaint, in their words:

> The parsing algorithm is lackluster. It is **too fast** and does **not scan everything**. It should be scanning an entire project just in case, so that when a conflict appears after a change, it can show.

They are **not** asking to make scans slower for theatre. They want **completeness of detection**: after an edit (especially a merge conflict or a broken file), the app should surface it in findings and in the source gutter.

Please recommend a concrete strategy for **this kind of app** (offline Electron, local SQLite graph, mixed-language static analysis, no network). Trade-offs matter more than a laundry list of parsers.

Open questions at the end of this document. Constraints you must not violate are in §4.

---

## 2. Product in one paragraph

TraceDeck is a **private, offline-first dependency explorer and change-impact analyzer**. A developer opens a local project folder, scans it, and gets:

- a file/symbol **dependency graph**
- **findings** (cycles, unused-export *candidates*, architecture-rule violations, unresolved imports, optional TypeScript type errors, JSON syntax errors, git merge conflicts)
- **blast radius** and a transparent **change-impact score**
- an **Explorer** of the full project inventory (not only graph sources)
- an in-app **source viewer/editor** with line numbers, gutter marks, session diffs, and save that refuses silently overwriting outside edits

Nothing is uploaded. There are no accounts, no telemetry, no update check, no AI in the analysis path. The same repo always produces the same graph and the same findings.

It is a **structure and impact** tool, not a linter, not a test runner, and not a language server. The one place it can report genuine compile errors is **opt-in TypeScript type checking**.

---

## 3. What it is not

- Not a git client. Merge-conflict *markers in file text* are detected; there is no `git status`, blame, or history.
- Not a runtime. No execution, no coverage from running tests.
- Not an LSP / IDE. Editing exists so a developer can fix a conflict or a small issue without leaving the graph; it is not meant to replace VS Code.
- Not a multi-language type checker. Python/Go/Rust/HTML/CSS contribute **import-like edges**, not full semantic analysis.
- Not a remote service. The Electron session **cancels every outbound request** that is not a local file or the Vite dev server.

Honesty language is deliberate: *unused export candidate*, *possible impact*, *could not resolve dynamically imported module*. The app must not claim code is dead, broken, or safe unless a check actually proved it.

---

## 4. Hard constraints (do not recommend violating these)

1. **Offline.** No new network calls, CDNs, model APIs, telemetry, or “phone home” grammar downloads. WASM grammars must ship in the install.
2. **Privacy.** Renderer has no Node, no fs, no SQLite. It may only call the typed IPC allowlist in `src/shared/ipc.ts`. Do not add channels unless the recommendation truly requires them.
3. **Determinism.** Same files → same graph, findings, and scores. No ML ranking.
4. **No silent omission.** If a file, language, or region is skipped, that must become a **limitation** (or a finding), not disappear.
5. **Do not follow symlinks.** A link must not pull code from outside the project root.
6. **Do not rewrite the whole app.** Incremental, local changes over a parser rewrite unless the rewrite is clearly the only sound option.
7. **IPC contract is strict.** `src/shared/ipc.ts` is the single source of truth. Startup fails if a declared channel has no handler.
8. **Source writes are guarded.** Saves compare SHA-256 of bytes on disk to the hash from `source:read`. Writes go temp-file-then-rename in the same directory. UTF-8 only. Binary, oversize, and encoding-mismatched files are not editable.
9. **No auto-save.** Unlock is explicit; Ctrl/Cmd+S saves only while unlocked.
10. **Graph table ≠ inventory.** `files` is graph-eligible sources (symbols/edges). `project_files` is every retained filesystem entry. Do not dump HTML/docs/binaries into the graph table just to “scan more.”

---

## 5. Tech stack and why those choices exist

| Layer | Choice | Why |
| --- | --- | --- |
| Shell | Electron 38, `electron-vite` | Desktop, local fs, native dialogs, no browser-origin restrictions. |
| UI | React 18, Zustand, Tailwind, Cytoscape (fcose + dagre) | Graph is canvas; theme tokens live in `src/shared/theme.ts` because Cytoscape cannot read CSS variables. |
| Main process | Node, TypeScript | All analysis and I/O. |
| DB | SQLite via `better-sqlite3`, WAL | Local, transactional, UI can read counts while a scan writes. Native binary unpacked from asar. |
| JS/TS parse | **TypeScript Compiler API** (`typescript` is a runtime dependency) | Same parser the ecosystem already trusts; extracts imports/exports/symbols; used again for highlighting and optional `tsc` diagnostics. |
| Other languages | **tree-sitter WASM** (`web-tree-sitter` + `@vscode/tree-sitter-wasm` + `tree-sitter-html`) | Regex import scraping is wrong for comments, strings, and multi-line forms. WASM ships on disk; `Parser.init({ locateFile })` points at the local `web-tree-sitter.wasm` (required in Electron — relative lookup fails). |
| Vue / Svelte / Astro | Script-region extraction, then TSC | Containers are in `SOURCE_EXTENSIONS`. Templates and styles are **not** analysed; each file gets an explicit limitation. |
| Typecheck | Real `ts.Program` + `getPreEmitDiagnostics` | Opt-in per project. Slow (orders of magnitude vs import scan). Nested configs supported. |
| Tests | Vitest | Unit + integration, including fixtures that encode cycles, barrels, missing imports, mixed languages. |
| Packaging | electron-builder; `npmRebuild: false` | better-sqlite3 v13 Node-API prebuilds load under Electron without a C++ toolchain. WASM packages are `asarUnpack`’d. |

**Why not a single parser for everything?**  
JS/TS graph quality (barrels, `export *`, `import type`, path aliases, `.js` → `.ts` ESM rewrite) is built on TSC. tree-sitter was added later for languages TSC cannot parse. Unifying on tree-sitter for JS/TS would be a large semantic downgrade unless someone reimplements that resolution layer.

**Why not LSP?**  
Would imply language servers per ecosystem, possible network/plugin surface, and a different product (IDE). Currently rejected by the privacy and “no extra runtime” posture — but you may argue for a *local* `tsc`/tree-sitter-only path if it solves failure surfacing better.

**Why SQLite instead of keeping the graph only in memory?**  
Scans persist; incremental rescan reconstructs unchanged files from stored symbols/edges; dashboard and reports query after the process restarts.

---

## 6. Layout of the codebase

```
src/
├── main/                       Electron main (Node)
│   ├── index.ts                Lifecycle, DB bootstrap
│   ├── security.ts             Sandbox, CSP, block all non-local network
│   ├── window.ts
│   ├── ipc/                    Validated handlers; registry fails closed
│   ├── analysis/
│   │   ├── discovery.ts        Walk + inventory + exclusion diagnostics
│   │   ├── parser.ts           TSC extraction (+ Vue/Svelte/Astro script regions)
│   │   ├── treeSitter/         WASM grammars: html, css, python, go, rust
│   │   ├── resolver.ts         Aliases, index files, language-specific dir indexes
│   │   ├── tsconfig.ts         Root + nested configs; deepest wins for an importer
│   │   ├── graph.ts            Edges, barrel forwarding, unresolved records
│   │   ├── scanner.ts          Orchestration, incremental skip, findings
│   │   ├── diagnostics.ts      Optional typecheck
│   │   ├── textDiagnostics.ts  JSON via TSC parseJsonText + strict JSON.parse
│   │   └── algorithms/         cycles, blast radius, unused exports, rules, risk
│   ├── db/                     migrations, repositories
│   ├── services/               analysis reads, reports, source read/write, classification
│   └── utils/                  hashing, glob, gitignore, path sandboxing
├── preload/                    contextBridge: invoke + onScanProgress only
├── renderer/src/               React UI, Zustand stores
└── shared/                     types, IPC contract, constants, mergeConflicts, sourceMarkers
```

Shared types must be structured-clone friendly (no classes).

---

## 7. User workflow

1. **Open a project** via native folder dialog. Path is stored in SQLite (`projects.root_path`). Renderer never supplies an absolute filesystem path.
2. **Scan** (incremental) or **Full** (force re-parse every graph file). Progress phases: `discovering` → `parsing` → `resolving` → `analysing` → optional `type-checking` → `persisting` → `done`.
3. **Dashboard** shows inventory counts vs graph-eligible counts, finding tallies, top impact files, and scan **limitations** (capped, de-duplicated).
4. **Graph** (Cytoscape). Focus, folder prefix, node-type filters. Soft/hard node limits (`GRAPH_NODE_SOFT_LIMIT` 1500 / `HARD` 5000) because canvas interaction dies past that. Double-click opens source.
5. **Explorer** lists **inventory** (`inventory:list`), not only graph files. Status: eligible / text-only / binary / excluded / oversize / unreadable / symlink.
6. **Findings** views: cycles, unused exports, architecture, unresolved imports, type errors, syntax errors, merge conflicts. Dismissals keyed by **content fingerprint**, not line, so an edit above a finding does not resurrect a dismissal.
7. **Architecture rules:** glob “files matching A must not import files matching B,” optional exceptions, severity. Only **resolved** imports are judged.
8. **Code pane** (Ctrl/Cmd+\`): split view, numbered gutter. Unlock (pencil) to edit in the **same** pane (not a separate textarea without line numbers). Save / Discard. Session **Changes** (Myers line diff vs snapshot when the file was opened — not git). After a successful save, the app starts **`startScan(false)`** (incremental). If a scan is already running, it only refreshes analysis.
9. **Gutter marks:** orange = merge conflict; red = syntax / type / unresolved import. Conflict wins on overlap. Dismissed findings ignored. **Live** merge-conflict detection on the open buffer (`src/shared/mergeConflicts.ts`) replaces stale scan conflict marks for that file so typing `<<<<<<<` shows immediately.
10. **Reports:** Markdown, JSON, or scriptless standalone HTML, via native save dialog.
11. **Settings:** theme, per-project exclude globs, entry points, gitignore, include tests, **typeCheck**, unused-export exclusions.

---

## 8. Two file universes (this is easy to get wrong)

### 8.1 Inventory (`project_files`)

Every regular file under the project root **except** hard-excluded directory trees:

`node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `out`, `vendor`, `.turbo`, `.cache`, `.svelte-kit`, `.nuxt`

- `.gitignore` **does not hide** a file from inventory; it is stored as metadata (`isGitIgnored`, `gitignoreRule`).
- User exclude patterns and `includeTestFiles` affect **analysis eligibility**, not whether Explorer can see the file.
- Symlinks are listed, never followed.
- Oversize: `MAX_FILE_SIZE_BYTES` = 2 MiB for analysis classification; viewer/editor cap is `MAX_SOURCE_BYTES` = 1 MiB and `MAX_SOURCE_LINES` = 8000.
- Text vs binary is classified (encoding detection). Viewer can show text; only UTF-8 is writable.

### 8.2 Graph sources (`files` + `symbols` + `graph_edges`)

Only extensions in `SOURCE_EXTENSIONS`:

**TSC path:** `.ts .tsx .mts .cts .js .jsx .mjs .cjs .vue .svelte .astro`  
**tree-sitter path:** `.html .htm .css .py .go .rs`

HTML/CSS **are** graph sources now (script `src`, link `href`, `@import`, `url()`). Anchors’ `href` are **not** edges (navigation ≠ module dependency).

`NON_SOURCE_IMPORT_EXTENSIONS` (scss, json, images, fonts, md, wasm, …) are valid imports: they must **not** become “file not found,” and they do **not** become graph nodes.

---

## 9. Scan pipeline (what “a scan” actually does)

Implemented in `src/main/analysis/scanner.ts`.

### 9.1 Discover

Walk the tree. Produce:

- `inventory` — all retained entries
- `files` — graph-eligible sources
- `diagnostics.exclusions` — every skip with a **kind** (`always-excluded-directory`, `gitignore`, `unsupported-extension`, `file-too-large`, …)
- `skipped` — exceptional skips

Limitations always include a census: directories visited, files considered, source files included, exclusion counts. Zero- or one-file graphs get an explicit “this is why the graph is empty” limitation. Nested `.gitignore` uses last-matcher-wins (git-like), including negations.

### 9.2 Hash every graph source

Every discovered graph file is **read** and SHA-256 hashed, even on incremental scans.

A file is **unchanged** (skip AST parse) only when **all** of:

- `fullRescan` is false
- a stored fingerprint exists
- `contentHash` matches
- `modifiedAt` matches

Unchanged files are **not** omitted from the graph. They are reconstructed from SQLite (`reconstructParsedFile`): symbols + import-like edges from `graph_edges`. Then **the whole set** (changed parsed + unchanged reconstructed) is passed to `buildGraph`.

**Important incompleteness in reconstruction:** reconstructed `ParsedFile` sets `parseErrors: []` and `limitations: []`. Per-file template/style limitations and prior parse errors are **not** replayed from DB; they are only recorded when the file is actually parsed. Incremental scans can therefore **drop** those limitation strings until a full rescan or a content change.

### 9.3 Parse changed files only (incremental)

```
parseWithTreeSitter(path, source) ?? parseSourceFile(absolutePath, source)
```

tree-sitter returns `null` for non-matching extensions, so JS/TS/containers stay on TSC.

**Parse failures today:**

| Event | Destination |
| --- | --- |
| TSC `parseErrors` (mostly non-literal export specifiers, not syntax) | Scan **limitations** + `errorCount`. **Not** a `syntax-error` finding. |
| tree-sitter `parser.parse` returns no tree | `parseErrors` → limitations. |
| tree-sitter `rootNode.hasError` (error-tolerant recover) | **Limitation** “parser recovered from a syntax error, so some references may be missing.” References that *were* extracted are kept. **Not** a finding. |
| Grammar WASM failed to load | Limitation; file contributes no edges. Scan continues. |
| Thrown parse exception | Limitation; file skipped. |

TSC `createSourceFile` is **error-tolerant**. A broken `.ts` file still usually yields a tree. That is why “syntax errors” in JS/TS **do not** appear as findings unless typecheck is on (and even then they are `type-error`, i.e. compiler diagnostics).

### 9.4 Resolve and build graph

`resolver.ts`:

- relative paths, `tsconfig`/`jsconfig` `paths` / `baseUrl`
- deepest nested config containing the importer
- `package.json` manifests so `@scope/pkg` is **external**, not a missing alias
- Node builtins
- ESM `.js` import → `.ts` on disk
- `.d.ts` only if no implementation sits beside it (graph wants runtime edges)
- Python `__init__.py` / Rust `mod.rs` as directory indexes **only when the importer is that language**
- Go package dirs similarly gated

Unresolved reasons: `dynamic-expression`, `alias-not-configured`, `file-not-found`, `external-package`, `non-source-asset`.

Only `file-not-found` and `alias-not-configured` (and similar *actionable* cases) become unresolved-import **findings**. External packages are a dashboard statistic, not a problem. Computed `import(\`./mods/${name}\`)` is recorded, never guessed.

Barrels: named re-exports are attributed to the **declaration file**. Ambiguous `export *` creates no fake reference; a caveat is stored.

**Persist:** new symbols/edges written for **changed** files only. Unchanged file/symbol/edge rows are **reassigned** to the new `scan_id`. Removed files delete their graph rows. After completion, old scans are pruned.

### 9.5 Graph algorithms (always, on the in-memory graph)

- **Cycles:** iterative Tarjan SCC; components of size ≥ 2; concrete cycle path for the UI.
- **Unused export candidates:** no incoming reference edge; excludes entry points, package.json `main`/`exports`/`bin`/`types`, framework convention files, re-export forwarding rows; caveats for default exports / components / `export *`.
- **Architecture rules:** resolved imports only.
- **Risk/impact score:** weighted arithmetic (dependents, transitive, entry reachability, cycle membership, unresolved, no test dependent). Weights are **chosen constants**, not calibrated. Inspector shows the arithmetic.

Blast radius is **on demand** (BFS on reverse edges, shortest path as explanation), not stored.

### 9.6 Optional typecheck

If `project.configuration.typeCheck`: build program(s) from every discovered tsconfig in the tree, `getPreEmitDiagnostics`, drop diagnostics outside the project / in `node_modules`, cap `MAX_TYPE_DIAGNOSTICS` (2000). Findings are `type-error` with file/line/column/code/message. Fingerprint = type + path + code + message (not line).

Off by default because a ~90-file monorepo was measured at ~0.3s import scan vs ~5s typecheck.

### 9.7 Inventory text pass (every scan, including incremental)

This is the “scan the whole project for conflicts” pass **already implemented**:

For every inventory entry that is regular, `contentKind === 'text'`, and under `MAX_SOURCE_BYTES`:

1. Re-read from disk (second read; graph files were already read in 9.2 if they were graph-eligible).
2. `findMergeConflicts(text)` → `merge-conflict` findings (complete or unterminated groups). Regex is anchored: exactly seven `<` / `=` / `>` at line start, so prose and heading underlines do not match.
3. If path looks like JSON (`json|jsonc|json5`): `diagnoseJson` → `syntax-error` findings. `.json` also runs strict `JSON.parse` because TSC accepts JSONC trailing commas.

**So:** merge conflicts in **any inventoried text file** (markdown, yaml, css, json, source, …) are already in scope on **every** scan, incremental or full. Incremental does **not** skip this pass.

What incremental **does** skip: re-running TSC/tree-sitter on hash-stable graph files.

### 9.8 After an in-app save

`CodePanel` → `source:save` → `startScan(false)`.

The saved file’s hash changed, so it **will** be re-parsed. Other files’ ASTs will not, unless their hash changed on disk too. Conflict pass still re-reads all inventory text.

**Gap the owner hit:** while editing, marks used to disappear because the editor swapped to a full-pane textarea. That is fixed (same gutter). Live conflict overlay updates **before** save. Syntax/type/unresolved marks still come from the **last completed scan**, so a newly broken import in the draft will not turn the gutter red until save + scan.

---

## 10. Parsers in detail

### 10.1 TypeScript Compiler API (`parser.ts`)

Extracts:

- `import` / `export … from` / `import()` / `require()` / `import x = require()`
- named, default, re-export, `export *`
- functions, classes, interfaces, types, enums, variables
- React components only when deterministic (PascalCase + JSX in body, or `extends React.Component`)

Vue/Svelte/Astro: regex-isolate `<script>` regions (skip HTML comments, skip `src=` external scripts, skip non-js/ts `lang`/`type`), preserve line breaks so line numbers stay honest, then TSC. Limitation string is stored on the file when parsed.

### 10.2 tree-sitter (`treeSitter/`)

One `Parser` instance cached per language. Load failure is sticky for the process (recorded once).

Extractors walk named nodes and emit `{ specifier, line }` as kind `'import'`. **No export/symbol surface** for these languages, so unused-export analysis ignores them.

| Language | What becomes an edge |
| --- | --- |
| HTML | `script`/`img`/`iframe`/`source` `src`; `link` `href`. Not `<a href>`. Skip `http(s):`, `data:`, `//`, `#`. |
| CSS | `@import` and `url()`. |
| Python | Relative `from .foo` → `./foo`; `from . import x` → sibling; absolute `import os` left as module name (external). |
| Go | Import paths; `./local` stays relative; the rest external. |
| Rust | `mod foo;` file layout; `use crate::` / `super::` / `self::`; `include!("…")`; other `use` roots external. Inline `mod foo { }` has no edge. |

Error recovery: `hasError` → limitation, keep whatever references were found.

### 10.3 JSON

Not a graph language. Syntax findings only, via the inventory pass.

### 10.4 Highlighting

`sourceService.ts` uses **TSC scanner** in main, not a renderer highlighter. JSX colouring is occasionally loose; text is exact. Non-TS files still get whatever the TS scanner does with the bytes (good enough for viewing).

---

## 11. Findings vs limitations (the failure model)

**Findings** (`analysis_findings`) are first-class UI: lists, counts, gutter, dismissals, reports.

Current `FindingType`s:

- `circular-dependency`
- `unused-export-candidate`
- `architecture-violation`
- `unresolved-import`
- `type-error` (only if typecheck ran)
- `syntax-error` (currently **JSON only**)
- `merge-conflict` (any inventory text)

**Limitations** (`ScanSummary.limitations`) are a bounded string list (max 500 unique). They explain exclusions, parser recoveries, missing grammars, Vue template skips, dynamic imports, etc. They do **not** appear in the gutter and are easy to ignore.

This split is the core product tension:

- Limitations = honesty about analysis bounds  
- Findings = “you should look at this”  
- JS/TS **syntax** problems currently live in neither, unless typecheck is on  
- tree-sitter **syntax** problems are limitations, even when `hasError` is true  
- Merge conflicts **are** findings, and the inventory pass already covers the whole tree on disk  

The owner’s “too fast / didn’t scan everything” feeling is largely this split: incremental parse skip + failures that never become findings + editor marks that used to be scan-lagged.

---

## 12. Security and data

- `contextIsolation`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`
- CSP on `connect-src` / `script-src` / `frame-src`
- Session handler aborts non-local requests
- IPC payloads structurally validated; errors stripped of stacks and absolute paths before the renderer
- `resolveSafeProjectFile` refuses path escape
- DB at `app.getPath("userData")/tracedeck.db` — never inside the user’s repo
- WAL; parameterized queries; `PRAGMA user_version` migrations, each in its own transaction

---

## 13. Known static-analysis limits (accepted)

These are documented to users and should stay honest:

- Computed dynamic imports: no target guessed
- `import * as ns`: whole module consumed; per-symbol unused analysis weak
- Ambiguous `export *`: no invented reference
- Runtime reflection / DI / plugins: invisible
- Consumers outside the scanned folder: why package entry points are not “unused”
- `node_modules` never walked
- Type-level-only usage without typecheck
- Vue/Svelte/Astro **templates and styles** unparsed
- Python/Go/Rust: import edges only, no types, no unused-exports
- Impact score weights are not empirically validated

---

## 14. Current parsing / failure issues (please focus here)

Treat these as the problem statement.

### 14.1 Completeness vs speed (owner intuition vs code)

| Owner intuition | What the code does |
| --- | --- |
| Scan is too fast, so it skipped files | Incremental **must** be fast. Discovery still walks the tree. Graph files are still hashed. Unchanged files still participate in `buildGraph` via SQLite reconstruction. |
| Should scan the entire project for conflicts after a change | Inventory merge-conflict + JSON pass **already reads every eligible text file every scan**. Full rescan would re-parse unchanged TS/Python/etc. and would **not** find more on-disk conflicts. |
| After I type a conflict, it should show | Until recently, the edit UI dropped the gutter and marks were last-scan-only. **Live conflict overlay** now updates the open buffer. Other files still need a scan (and the file must be saved if the conflict exists only in the draft). |
| After I break an import, it should show | Unresolved-import findings require a scan of **that file’s parse**. Incremental does re-parse the saved file. Dependents that did not change are not re-parsed (usually correct). Gutter red for unresolved waits for scan completion. Draft buffer is **not** re-resolved live. |
| JS/TS looks “fine” when it does not compile | Typecheck is opt-in. TSC parse is error-tolerant. Parse issues go to limitations. |

**Recommendation we are *not* looking for:** “always `fullRescan: true` after save” as the default. That is the nuclear option; the owner already has a Full button. If you disagree, say why for this architecture.

### 14.2 Failure types that do not become gutter findings

1. JS/TS parse / syntax problems without typecheck  
2. tree-sitter `hasError` (HTML/CSS/Py/Go/Rust)  
3. Vue/Svelte/Astro template or style syntax / conflicts inside those regions (conflict **markers** in those files *are* caught by the inventory text pass, because it is raw text)  
4. TSC `parseErrors` strings without line numbers suitable for the gutter  
5. Reconstruction wiping per-file limitations on incremental scans  

### 14.3 Dual-read cost vs dual-skip risk

Every scan may read graph sources once (hash/parse) and inventory text again (conflicts/JSON). That is completeness for conflicts at the cost of I/O. Hashing inventory text and skipping unchanged conflict scans would be **faster** but is the opposite of the owner’s request unless paired with a proof that no conflict can be missed.

### 14.4 Language coverage holes (graph, not inventory)

Still not graph-parsed: SCSS/Less, JSON-as-module (edges exist as non-source assets), Markdown, SQL, Ruby, Java, C#, etc. They **are** inventoried and **do** get merge-conflict findings if they are text.

Vue/Svelte templates: no HTML/CSS tree-sitter on those regions.

### 14.5 Live vs persisted analysis

| Signal | Live on draft | After save + incremental scan | Needs typecheck |
| --- | --- | --- | --- |
| Merge conflict in open file | Yes (shared regex) | Yes (inventory pass) | No |
| Merge conflict in another file | No | Yes if on disk | No |
| JSON syntax | No | Yes if on disk | No |
| Unresolved import | No | Yes for re-parsed files | No |
| TS type error | No | Only if enabled | Yes |
| TS/JS syntax | No | Limitations only, unless typecheck | Usually |
| tree-sitter syntax | No | Limitation only | n/a |

### 14.6 Product-fit question

TraceDeck’s value is **impact of a change** (graph + blast radius), not being ESLint. Over-producing findings (every recovered HTML error) could bury cycles and architecture violations. Under-producing them is what the owner is feeling now.

A good recommendation will say **which failures deserve findings**, **which stay limitations**, and **which should be live in the editor** without a full project parse.

---

## 15. What has already been tried or built

Do not recommend these as if they were missing:

- Incremental parse skip with hash + mtime  
- Reconstruct unchanged files so barrels still work  
- Full inventory + Explorer  
- Discovery explainability (exclusion kinds, zero-file messaging)  
- Nested tsconfig / monorepo aliases  
- Optional typecheck  
- tree-sitter for html/css/python/go/rust  
- Merge-conflict + JSON findings on all inventory text  
- In-app editor with hash conflict, atomic save, numbered gutter while editing  
- Live conflict marks on the open buffer  
- Session (not git) diff hunks  
- Incremental rescan after save  

---

## 16. Please recommend (output format)

Please answer as an architecture recommendation, not a patch. Prefer one primary path plus what not to do.

1. **Primary recommendation** for “scan feels incomplete / conflicts and breakage after a change should show” in *this* architecture.  
2. **Finding model:** which parser failures become `syntax-error` (or a new type) with line numbers vs stay limitations.  
3. **Incremental policy:** keep skip-unchanged-AST, hash inventory for conflicts, live draft analysis, file watcher, or something else.  
4. **Parser strategy:** keep TSC + tree-sitter split, extend tree-sitter to Vue/Svelte templates, unify, or add something else — with cost to barrel/alias fidelity.  
5. **Editor:** how far live analysis should go (conflicts only vs resolve-this-file vs full project) without turning TraceDeck into an LSP.  
6. **Order of work:** 2–4 sequenced steps, smallest change that would actually satisfy the owner.  
7. **Reject list:** ideas that look attractive but are wrong for an offline graph tool (e.g. always-full-rescan, remote analysis, slowing the parser on purpose).

If you need a default bias from the current maintainers: **do not slow the parser for show; do not Full-rescan on every save; do prefer turning real, line-addressable failures into findings and live marks; do keep inventory and graph as separate tables.**

---

## 17. Pointers if you also have the repo

| Topic | Path |
| --- | --- |
| IPC surface | `src/shared/ipc.ts` |
| Domain types / findings | `src/shared/types.ts` |
| Extensions / limits | `src/shared/constants.ts` |
| Scan orchestration | `src/main/analysis/scanner.ts` |
| TSC parse | `src/main/analysis/parser.ts` |
| tree-sitter | `src/main/analysis/treeSitter/` |
| Conflicts | `src/shared/mergeConflicts.ts` |
| Gutter marks | `src/shared/sourceMarkers.ts` |
| Editor | `src/renderer/src/components/views/CodePanel.tsx` |
| Typecheck | `src/main/analysis/diagnostics.ts` |
| JSON diagnostics | `src/main/analysis/textDiagnostics.ts` |
| Inventory vs graph design | `docs/superpowers/specs/2026-08-27-complete-project-inventory-editor-design.md` |
| Older README (partially stale) | `README.md` |

---

## 18. One-sentence summary for context packing

TraceDeck is an offline Electron+SQLite static **dependency graph** app: TSC for JS/TS (and script tags in Vue/Svelte/Astro), tree-sitter WASM for HTML/CSS/Python/Go/Rust, a full-text inventory pass every scan for git conflict markers and JSON syntax, optional `tsc` typecheck, incremental AST skip for unchanged hashes, and an in-app editor whose live analysis currently covers **merge conflicts in the open buffer only** — the owner wants post-change breakage and conflicts to be visibly complete without pretending that “slower = more scanned.”
