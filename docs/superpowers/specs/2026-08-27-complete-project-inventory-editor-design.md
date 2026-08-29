# Complete Project Inventory, Analysis Coverage, and Local Editing Design

## Problem and evidence

TraceDeck currently uses one `files` table for two different concepts: files present in the project
and files eligible for its JavaScript/TypeScript dependency graph. Discovery drops every other file
before persistence, so the dashboard, Explorer, viewer authorization, search, and reports all inherit
the reduced graph-source count.

The corrected real-project measurement is:

| Project root | Regular files outside hard-excluded directories | Current graph-source rows |
| --- | ---: | ---: |
| `C:\TraceDeck Claude` | 159 | 125 |
| `C:\dev_app` | 38 | 9 |
| `C:\dev_app\regexlab` | 36 | 9 |
| `C:\dev_project\RegexLab` | 6 | 1 |

`C:\dev_project\RegexLab` contains `.claude/launch.json`, `.gitignore`, `README.md`, `app.js`,
`index.html`, and `style.css`. Only `app.js` is currently retained. Explorer also obtains its tree by
searching for a dot and caps the response at 200, creating a second independent omission.

## Chosen approach

Add an authoritative project inventory beside the existing graph-analysis table. Do not broaden the
meaning of the existing `files` table: it remains the graph-eligible source subset referenced by
symbols and edges. The new inventory owns file presence, capabilities, ignore metadata, Explorer,
viewer authorization, and user-facing file counts.

Rejected alternatives:

1. Adding every extension to `SOURCE_EXTENSIONS` would falsely claim HTML, CSS, documentation, data,
   and binaries were JavaScript/TypeScript graph sources.
2. Replacing the existing `files` table in place would mix non-code assets into graph algorithms and
   risk existing symbol/edge foreign keys and scan history.
3. Keeping the current database and returning a transient filesystem list would make viewer/search
   results diverge from stored scan results and would not support deterministic reports.

## Inventory policy

- Inventory every regular file under the selected project root.
- `.gitignore` never removes a file from inventory. Its final matching rule is recorded as metadata.
- User exclude patterns and the `includeTestFiles` setting control analysis eligibility, not inventory
  visibility.
- Never traverse `.git`, `node_modules`, dependency/vendor directories, build outputs, or framework
  caches listed by the hard-exclusion policy. Report each skipped subtree with its exact rule.
- List symlink entries as non-viewable inventory entries but never follow them.
- Sort paths and diagnostic groups deterministically.
- Store enough metadata to explain each capability: entry kind, byte size, modification time,
  extension, text/binary classification, encoding when known, ignore state, analysis eligibility, and
  the concrete reason when a capability is unavailable.

## Data model

Add a migration for `project_files`, unique by `(project_id, relative_path)`. Each row contains:

- identity and location: `id`, `project_id`, `relative_path`, `absolute_path`, `scan_id`;
- filesystem facts: `entry_kind`, `extension`, `size_bytes`, `modified_at`;
- content capability: `content_kind`, nullable `encoding`, nullable `content_hash`;
- policy metadata: `is_git_ignored`, nullable `gitignore_rule`, `is_user_excluded`;
- analysis capability: `analysis_status` and a concrete `analysis_reason`.

`analysis_status` is one of `eligible`, `text-only`, `binary`, `excluded`, `oversize`, `unreadable`,
or `symlink`. An inventory row is not evidence that a parser ran. Existing `files` rows continue to
represent only supported graph sources that were actually read for analysis.

Inventory rows are upserted onto the current completed scan and missing rows are removed. Older scans
are pruned only after all surviving inventory and graph rows have been reassigned, preserving the
current crash-safety behavior.

## Discovery and analysis pipeline

Discovery returns two explicit collections:

1. all project inventory entries under policy; and
2. the supported source subset eligible for dependency analysis.

File-level `.gitignore` and user-exclude decisions are evaluated before analyzer eligibility so an
HTML file cannot be mislabeled merely because extension filtering ran first. Ignored directories are
still traversed unless they match the hard-exclusion list. Large, binary, unreadable, and symlink
entries remain visible with unavailable capabilities.

Supported JS/TS and script regions in Vue/Svelte/Astro use the existing TypeScript parser and graph
resolver. JSON uses the TypeScript JSON parser for concrete syntax diagnostics. HTML, CSS, Markdown,
and other decodable text are honestly labeled `text-only`; they are viewable and searchable but not
claimed as structurally parsed. Binary files are listed without decoding.

Every text file is also checked for unresolved merge-conflict markers. JavaScript/TypeScript parser
diagnostics, JSON syntax diagnostics, merge conflicts, decoding failures, and read failures become
typed findings with stable fingerprints and file/line/column details. Existing cycle, architecture,
unresolved-import, unused-export, and optional compiler diagnostics remain separate.

## Accurate results and wording

Dashboard, scan summary, and exported reports distinguish:

- project files inventoried;
- graph-eligible source files;
- changed source files parsed this scan;
- unchanged source files reused;
- text-only files;
- binary files;
- ignored files retained in inventory;
- policy-excluded or unreadable entries;
- syntax, merge-conflict, type, and graph findings.

No surface may label the graph-source count as the project file count. “Parsed” is used only for a
file handled by a real parser. “Viewed” means content was safely decoded or an unavailable-state was
shown; it does not imply analysis.

## Explorer and viewer

Explorer reads the inventory directly, without a synthetic search query or silent result cap. Search
uses inventory paths for files/folders and the analysis tables for symbols. Selecting any inventory
entry opens the viewer. Decodable text is displayed; oversized text shows bounded preview metadata;
binary, symlink, and unreadable entries show an explicit unavailable state and retain reveal/system
open actions where safe.

The code viewer is locked by default. For editable text at or below `MAX_SOURCE_BYTES`, an Unlock
button switches to a plain-text editor. The user can Save, Discard Changes, or relock. Closing or
switching files with a dirty draft requires an explicit decision.

## Safe local writing

The renderer never receives arbitrary filesystem authority. `source:save` accepts only project id,
inventory-relative path, the hash from the last read, and bounded text. Main-process validation:

- verifies the IPC caller is the main app frame;
- requires the path to exist in the latest inventory;
- resolves root, parent, and target with real paths immediately before access;
- rejects path escapes, symlinks/reparse points, non-regular targets, binary content, unsupported
  encoding, and files above the edit limit;
- compares the current byte hash with `baseHash` and returns `SOURCE_CONFLICT` without overwriting an
  external change;
- writes a same-directory temporary file, preserves the original mode, rechecks the base hash, and
  atomically replaces the target;
- removes a temporary file on failure.

A successful save refreshes the viewer and starts an incremental scan so findings describe the new
disk content. “Open externally” is labeled “Open with system default”; TraceDeck does not claim the OS
association is a code editor.

## Constraints

- Fully offline and private: no network access, telemetry, or external schema lookup.
- No new runtime dependency.
- Same project state yields the same sorted inventory, graph, findings, limitations, and reports.
- No project-specific path or extension special case.
- Hard-excluded directories and symlink traversal remain safety boundaries.
- Existing findings retain their meanings; new coverage is additive and explicitly labeled.
- Existing user changes are preserved and no test is weakened or deleted.

## Acceptance criteria

- A scan of `C:\dev_project\RegexLab` inventories exactly its six regular project files while keeping
  one graph-eligible source file.
- Explorer exposes all six paths and each text file can be opened in the viewer.
- `.gitignore`-matched files remain inventoried with ignore metadata.
- No Explorer or inventory API silently caps or dot-filters paths.
- Unlock is unavailable for binary, unreadable, symlink, and oversized entries.
- Saving an unlocked text file changes only that project file; a stale base hash produces a visible
  conflict without overwriting disk content.
- Malformed JS/TS and JSON plus merge markers produce file-located findings.
- Dashboard and every report format present inventory and analyzed-source counts separately.
- Real-project before/after measurements, the full test suite, typecheck, lint, and build complete
  successfully before the work is reported complete.
