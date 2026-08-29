# TraceDeck — Agent briefing (current state)

**Audience:** another agent or engineer continuing this repo.  
**Date:** 2026-08-28.  
**App version:** `0.1.0`.  
**Product docs:** [`README.md`](../README.md) (updated the same day; feature list and crash-fix notes live there).  
**If README, this file, and the code disagree, trust the code** (`src/shared/ipc.ts`, `src/shared/types.ts`, `src/main/analysis/scanner.ts`).

This is **not** a request to invent a new parsing strategy. Roadmap **A–I is implemented**. Section **J was skipped** (cloud, LSP, CVE fetch, remote services).

---

## 1. Status

TraceDeck is a **private, offline Electron app** for dependency graphs and change impact. SQLite via `better-sqlite3` in **main only**. Strict IPC in `src/shared/ipc.ts`. **No AI. No network.**

| Milestone | State |
| --- | --- |
| Inventory + Explorer + guarded in-app editor | Shipped (before A–I) |
| Tree-sitter HTML/CSS/Python/Go/Rust | Shipped |
| A–I (syntax findings, preview, watcher, git, Monaco, metrics, CLI, graph UX, Sass, language roots, …) | **Shipped** |
| Dashboard `undefined.length` crash after scan | **Fixed** (defensive `?? []` on IPC arrays; ErrorBoundary remounts on scan id) |
| Typecheck | Green (`npm run typecheck`) |
| Tests | **435 passed**, 2 skipped (after A–I) |
| J (LSP, cloud, CVE) | **Out of scope** — do not add |

Do **not** commit unless the owner asks.

---

## 2. Product in one paragraph

A developer opens a local folder, scans, and gets a file/symbol **dependency graph**, **findings**, **blast radius**, a transparent **change-impact score**, **metrics**, **architecture rules**, and an in-app **Monaco** editor. Explorer shows **inventory** (`project_files`), not only graph sources. Git helpers are **local** (diff, blame, churn, co-change, mergetool). A headless **CLI** writes `<root>/.tracedeck/cli.sqlite`.

Nothing is uploaded. Same repo → same graph and findings.

It is a **structure and impact** tool, not a linter, not a test runner, and not a language server. Opt-in TypeScript type checking is the one place it reports genuine `tsc` diagnostics.

---

## 3. Hard constraints (do not violate)

1. **Offline.** No network, CDNs, model APIs, telemetry, or grammar downloads. WASM ships in the install.
2. **Privacy.** Renderer has no Node, no fs, no SQLite. Typed IPC allowlist only.
3. **Determinism.** No ML ranking.
4. **No silent omission.** Skipped files/languages/regions become a **limitation** or a **finding**.
5. **Do not follow symlinks.**
6. **IPC contract is strict.** Startup fails if a declared channel has no handler.
7. **Source writes are guarded.** Save compares SHA-256 to `source:read`, then temp-file-then-rename. UTF-8 only. No auto-save.
8. **Graph table ≠ inventory.** Do not dump non-graph files into `files` just to “scan more.”
9. **`better-sqlite3` is main-only.**
10. After UI/IPC changes, default missing arrays to `[]`. Renderer HMR can leave **main stale**.

---

## 4. Tech stack

| Layer | Choice |
| --- | --- |
| Shell | Electron 38, electron-vite |
| UI | React 18, Zustand, Tailwind, Cytoscape (fcose + dagre), **Monaco** |
| Main | Node, TypeScript |
| DB | SQLite `better-sqlite3`, WAL. GUI: `userData/tracedeck.db`. CLI: `.tracedeck/cli.sqlite` |
| JS/TS | TypeScript Compiler API |
| Other languages + templates/styles | tree-sitter WASM (`web-tree-sitter`; `Parser.init({ locateFile })` must point at local wasm) |
| Vue / Svelte / Astro | **Scripts → TSC.** **Template + style regions → tree-sitter.** |
| Typecheck | Real `ts.Program` + `getPreEmitDiagnostics`; tsbuildinfo under `.tracedeck/cache` |
| Tests | Vitest |
| CLI | `src/cli/main.ts` via `vite-node` (`npm run scan`) |

**Why not tree-sitter for JS/TS?** Barrels, `export *`, `import type`, path aliases, `.js` → `.ts` rewrite are built on TSC. Unifying would be a semantic downgrade.

**Why not LSP?** Different product; rejected for privacy and “no extra runtime.” Monaco’s semantic TS checker is **off on purpose**.

---

## 5. Two file universes

### Inventory (`project_files`)

Every regular file except hard-excluded trees:

`node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `out`, `vendor`, `.turbo`, `.cache`, `.svelte-kit`, `.nuxt`, **`.tracedeck`**

- `.gitignore` does **not** hide inventory; it is metadata.
- Symlinks listed, never followed.
- Analysis cap `MAX_FILE_SIZE_BYTES` = 2 MiB; editor cap `MAX_SOURCE_BYTES` = 1 MiB, `MAX_SOURCE_LINES` = 8000.

### Graph sources (`files` + `symbols` + `graph_edges`)

`SOURCE_EXTENSIONS` in `src/shared/constants.ts`:

**TSC:** `.ts .tsx .mts .cts .js .jsx .mjs .cjs .vue .svelte .astro` (scripts)  
**tree-sitter:** `.html .htm .css .scss .sass .less .py .go .rs` (+ Vue/Svelte/Astro template/style)

`.styl` remains a **non-source asset**. JSON/images/fonts/md/wasm/etc. are valid imports (not file-not-found) and **not** graph nodes. **Missing `.scss` is `file-not-found`.**

Package-root rewrites: `languageRoots.ts` (Go `go.mod`, Python `pyproject.toml`/`setup.cfg` + `__init__.py`, Rust `Cargo.toml`). Applied in the scanner and in `previewService`.

---

## 6. Scan pipeline (`scanner.ts`)

Phases: `discovering` → `parsing` → `resolving` → `analysing` → optional `type-checking` → `persisting` → `done`.

### Discover

Walk + inventory + graph-eligible list + exclusion diagnostics (kinds, census). Nested `.gitignore` last-matcher-wins including negations. Empty/tiny graphs get an explicit limitation.

### Hash graph sources

Every graph file is read and SHA-256 hashed even on incremental scans.

Skip AST parse only when `fullRescan` is false **and** stored fingerprint exists **and** `contentHash` **and** `modifiedAt` match. Unchanged files are **reconstructed** from SQLite and still participate in `buildGraph`.

Incremental **copies** previous merge-conflict / todo / JSON syntax findings for hash-stable inventory text instead of re-reading every file. Clones recompute for **changed** files.

### Parse

`parseWithTreeSitter(...) ?? parseSourceFile(...)`. tree-sitter returns `null` for non-matching extensions.

**Line-addressable** parser failures become `syntax-error` **findings** (TSC `syntaxIssues`, tree-sitter `ERROR` nodes / `hasError` fallback at 1:1). Failures without a line stay **limitations**.

TSC `createSourceFile` is error-tolerant; typecheck (opt-in) is still required for full compile errors (`type-error`).

### Resolve / graph

`resolver.ts`: aliases, nested tsconfig (deepest wins), package.json externals, builtins, ESM `.js`→`.ts`, `.d.ts` only if no implementation beside it, language-specific dir indexes gated by importer language, `rewriteLanguageImports`.

Unresolved reasons include `dynamic-expression`, `alias-not-configured`, `file-not-found`, `external-package`, `non-source-asset`. Only actionable cases become findings.

Barrels: named re-exports attributed to the declaration file. Ambiguous `export *` → caveat, no fake edge.

**Call edges** are conservative; inspector can set `graphSliceEdgeTypes: ['call']`. `ALL_EDGE_TYPES` includes `'call'`. Type-only edges can be hidden.

### Algorithms (every scan)

Iterative Tarjan SCC (≥2). Unused-export candidates (entry points excluded; rename caveats from git). Architecture rules on **resolved** imports only. Complexity / LCOM / todos / clones. Martin folder metrics. Risk score (chosen weights). Scan snapshot for comparison.

Blast radius is **on demand** (BFS reverse edges).

### After save / on disk change

Editor save → `startScan(false)`. `watchService` → debounced incremental scan. Draft buffer also uses `analysis:preview` (no persist).

---

## 7. Editor and git

- **Monaco** in `CodePanel` / `SourceEditor`. Unlock to edit. Hash-checked atomic save.
- Live merge-conflict + JSON marks on the open buffer (`sourceMarkers.ts`, `mergeConflicts.ts`).
- Preview findings while typing. F8 next finding. EditorConfig + optional project Prettier (`formatService.ts`).
- Session diff vs open snapshot is **not** git. Git is separate IPC (`gitService.ts`): changed files, diff HEAD, blame, co-change, renames, churn 90d, mergetool.
- Dashboard git impact: `git:changed-files` + `analysis:diff-impact`.

---

## 8. Findings vs limitations

**Findings** (`analysis_findings`): lists, gutter, dismissals (fingerprint, not line), reports.

Types: `circular-dependency`, `unused-export-candidate`, `architecture-violation`, `unresolved-import`, `type-error`, `syntax-error`, `merge-conflict`, `todo-comment`, `duplicate-code`, `complexity-hotspot`.

**Limitations** (`ScanSummary.limitations`): bounded unique strings (exclusions, missing grammar, dynamic imports, …). Dashboard must treat `limitations` as optional (`?? []`) — that field was implicated in the `.length` crash.

---

## 9. IPC extras (beyond the original CRUD)

See full contract in `src/shared/ipc.ts`. Notable channels: `source:read` / save / format, `search:text`, `analysis:preview`, `analysis:diff-impact`, `analysis:folder-metrics` → **`ProjectMetrics` `{ folders, outliers }`**, `git:*`, `rules:apply-pack`, `system:save-export` (PNG/SVG), `inventory:list`.

`analysis:folder-metrics` used to be consumed as an array; Metrics.tsx accepts both shapes.

---

## 10. UI crash lesson

Do not assume dashboard/graph/metrics payloads always include new arrays. HMR or an older main process will omit them. Pattern: `payload.nodes ?? []`, `stats.publicApi ?? []`, `scanComparison.addedTitles ?? []`, etc. ErrorBoundary key includes `lastScan?.id` so a completed scan remounts the view.

---

## 11. CLI

```text
npm run scan -- [root] [--full] [--fail-on type,type] [--format text|json|sarif] [--baseline file] [--write-baseline]
```

DB at `<root>/.tracedeck/cli.sqlite`. `tsconfig.node.json` must include **`src/main/**/*.ts` and `src/cli/**/*.ts`**.

---

## 12. Remaining honesty gaps (not a backlog to invent J)

- Call graph is conservative, not points-to.
- Risk percentile is **in-repo rank**, not calibrated incident risk.
- Python/Go/Rust/HTML/CSS/Sass: edges, not unused-exports or types.
- Draft preview is this-file analysis, not a live whole-project resolve.
- No LSP, no AI, no CVE feed — by design.

---

## 13. Key files

| Topic | Path |
| --- | --- |
| IPC | `src/shared/ipc.ts` |
| Types / findings | `src/shared/types.ts` |
| Extensions / limits | `src/shared/constants.ts` |
| Rule packs | `src/shared/rulePacks.ts` |
| Scan | `src/main/analysis/scanner.ts` |
| TSC parse | `src/main/analysis/parser.ts` |
| Language roots | `src/main/analysis/languageRoots.ts` |
| tree-sitter | `src/main/analysis/treeSitter/` |
| Preview | `src/main/services/previewService.ts` |
| Git | `src/main/services/gitService.ts` |
| Watch | `src/main/services/watchService.ts` |
| Format | `src/main/services/formatService.ts` |
| Licenses / owners | `licenseInventory.ts`, `codeowners.ts` |
| Reports | `src/main/services/reportService.ts` |
| Extra IPC | `src/main/ipc/extraHandlers.ts` |
| CLI | `src/cli/main.ts` |
| Dashboard / graph / metrics / inspector | `src/renderer/src/components/views/` |
| Editor | `CodePanel.tsx`, `SourceEditor.tsx` |
| UI state | `src/renderer/src/store/uiStore.ts` |

Tests worth knowing: `tests/unit/analysis/languageRoots.test.ts`, `parser.test.ts` (template/style analysed), `packageManifest.test.ts` (missing SCSS = file-not-found).

---

## 14. One-sentence summary

TraceDeck is an offline Electron+SQLite dependency-graph app: TSC for JS/TS (and Vue/Svelte/Astro scripts), tree-sitter for HTML/CSS/Sass/Python/Go/Rust and component templates/styles, incremental scan + watcher + draft preview, Monaco (not LSP), local git helpers, metrics/CLI/graph UX, and defensive dashboard rendering after a `.length` crash on missing IPC arrays — continue work without adding network, AI, or a language server.
