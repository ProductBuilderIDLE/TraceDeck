# Discovery Consistency and Explainability Design

> Superseded by `2026-08-27-complete-project-inventory-editor-design.md`. This earlier design
> incorrectly accepted a one-file RegexLab inventory because it equated graph-eligible source files
> with project files.

## Evidence

Environment-gated instrumentation was run against four real project roots on this machine.

| Project root | Files considered | JS/TS files discovered | Independent tracked JS/TS count | Material exclusions |
| --- | ---: | ---: | ---: | --- |
| `C:\TraceDeck Claude` | 135 | 116 | 116 before accounting for one ignored tracked fixture and one temporary diagnostic | generated fixture, build/dependency directories, HTML/CSS/config files |
| `C:\dev_app` | 21 | 9 | nested repository contains 9 | child config exists below a config-less root |
| `C:\dev_app\regexlab` | 19 | 9 | 9 | generated directories, one CSS file, assets/config files |
| `C:\dev_project\RegexLab` | 6 | 1 | 1 | `index.html` and `style.css` were silently outside the JS/TS graph |

The measured one-file scan did not exit early. It walked the complete small tree, then silently
discarded every file whose extension was not in `SOURCE_EXTENSIONS`. The same silence applies to
routine `.gitignore`, built-in-directory, user-pattern, and disabled-test exclusions. A completed
zero-file scan is additionally rendered as “not scanned yet,” hiding any scanner limitations.

Code inspection also found that scoped `.gitignore` matchers are combined with `some()`. A child
`.gitignore` negation therefore cannot override a parent rule for a file in an otherwise traversable
directory. Git gives lower-level ignore files higher precedence. The config loader similarly checks
only the selected root, so aliases in child workspace configs are unavailable to graph resolution.

## Design

Discovery will return a deterministic diagnostic record alongside discovered files. Each excluded
path will identify a concrete category and rule: built-in directory name, user glob, ignore-file
path plus matching pattern, unsupported extension, disabled-test setting, symlink policy, read
failure, oversize cap, or duplicate real path. Exceptional `skipped` entries remain for compatibility.
The scanner will turn the detailed records into bounded, sorted limitation summaries and add an
explicit warning whenever only zero or one graph source file is found.

`GitignoreMatcher` will expose its final matching decision. Discovery will evaluate scoped matchers
from the project root toward the file and let the last matcher that actually matched win. Missing
`.gitignore` files remain normal; other read errors become explicit skip records.

Source coverage will expand additively to Vue, Svelte, and Astro source containers. Their standard
script regions will be isolated while preserving line breaks, then parsed by the existing TypeScript
compiler API. Each such file will carry a limitation explaining that template/style regions are not
part of the JS/TS graph. HTML, CSS, data, documentation, and binary assets remain outside the graph
and are reported by extension rather than silently counted as source.

Workspace config discovery will move into `tsconfig.ts` and be shared by graph resolution and optional
type checking. The resolver will choose the deepest configuration directory containing the importing
file, falling back to the root configuration or no-config behavior. This supports `apps/*` and
`packages/*` aliases without project-specific paths.

The dashboard will distinguish “never scanned” from a completed zero-file scan. A zero-file result
will display the scanner’s explicit discovery explanation and retain a rescan action.

## Constraints

- No network, telemetry, or new dependency.
- Symlinks remain unfollowed.
- No project-specific path or extension heuristics.
- File lists, diagnostic groups, limitations, and graph outputs remain deterministically sorted.
- Existing scan-history meaning changes only through additive source-container support, which is
  surfaced as a limitation on each affected file.
- All 279 baseline tests must remain green; new tests must demonstrate red before production changes.
