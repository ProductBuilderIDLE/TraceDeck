# Final Whole-Branch Review Report

Branch: `feature/change-review-workspace`  
Head: `e1bc958 Add minimal Electron end-to-end review harness with Playwright`  
Comparison: `main...HEAD` (210 files, ~34,300 insertions, ~620 deletions)

## Scope of review

This review concentrated on the new Change Review workspace and the risks called out in the task plan:

- absolute-path leakage
- source/diff persistence
- arbitrary Git refs
- shell command execution
- link traversal
- hidden caps / resource exhaustion
- renderer-held full results
- unrelated refactors
- new pointer-hover graph behavior
- external assets in reports
- weakened tests

The branch is large because it carries the full A–I implementation plus the new Change Review feature. A line-by-line review of every file was not performed; the assessment below is based on targeted source inspection, the deterministic focused suites, the full quality gates, CLI compatibility tests, and packaging smoke checks.

## Code-level security findings

### Git invocation

- `src/main/services/changeReview/gitProcess.ts:63-71` and `:167-175` use `spawn` with `shell: false` and a fixed argument list.
- `src/main/services/changeReview/materializer.ts:259-275` passes `HEAD` materialization through `OBJECT_ID_PATTERN` validation.
- `src/main/services/changeReview/coordinator.ts` resolves the review base with `resolveReviewHead` and uses it only as `HEAD`; no user-supplied ref reaches Git.

### Path and diff handling

- `src/main/ipc/reviewHandlers.ts` validates `relativePath` with `resolveWithinProject` before `review:file-diff`.
- `src/main/services/changeReview/report.ts` (rendering) emits project-relative paths and escapes HTML.
- HTML reports produced by CLI verification contained no `C:\`, `Users\...`, `<script>` tags, or `http://`/`https://` references.
- `review:file-diff` returns bounded, per-file diffs (`MAX_REVIEW_DIFF_BYTES` / `MAX_REVIEW_DIFF_LINES`); the diff text is not persisted to `change_reviews`.

### Symlinks and links

- `src/main/services/changeReview/materializer.ts` treats symlinks as inventory-only evidence and refuses to materialize symlinked targets during `createReviewTempRoot`.
- `src/main/services/changeReview/gitStatus.ts` records `isSymlinkEntry` but never writes through it.

### Renderer boundary

- `src/renderer/src/store/reviewStore.ts` holds one paginated `ReviewPage` (default limit 100) and the summary/status, not the full result set.
- `src/shared/ipc.ts:200-205` and `src/main/ipc/reviewValidation.ts` define and validate `review:query` pagination.

### Resource caps

- `src/shared/constants.ts` defines `MAX_REVIEW_DIFF_BYTES` (2 MiB), `MAX_REVIEW_DIFF_LINES` (20,000), `MAX_REVIEW_BASELINE_BYTES` (2 GiB), `MAX_REVIEW_BASELINE_ENTRIES` (100,000), and depth clamped to 1–25.

### No hover-driven graph behavior

- A grep for `onMouseEnter|onMouseOver|onMouseMove|onPointerOver|onPointerEnter` across `src/renderer/**/*.tsx` found no matches.
- The review drill-down is click-driven (`src/renderer/src/components/views/ChangeReview.tsx`, `ReviewPage.tsx`, `ReviewEvidenceInspector.tsx`).

### Tests

- No `.only`, `.skip`, `xit`, or `it.todo` additions were found in `tests/**`.
- The focused deterministic suites and the full `npm test` passed.

## Issues found and resolved

1. **Stale CLI review when `.tracedeck/` is not gitignored.**
   - Root cause: the CLI review writes `.tracedeck/cli.sqlite`; if the directory is untracked, Git reports it as changed and the review becomes stale.
   - Correction: added `.tracedeck/` to `tests/fixtures/sample-project/.gitignore` and documented the requirement in `README.md`, `DEVELOPMENT-SPEC.md`, and `docs/AGENT-BRIEFING.md`.
   - Verification: the exact plan Step 4 CLI script now completes successfully.

2. **Documentation over-stated GUI export format support.**
   - Root cause: `src/renderer/src/components/views/ChangeReview.tsx:228` hard-codes `format: 'markdown'` for `review:export`.
   - Correction: README and DEVELOPMENT-SPEC now say the CLI supports all four formats (`text`, `json`, `markdown`, `html`) while the GUI export is currently Markdown-only.

## Issues found but not corrected

- None. Both findings above were corrected and re-verified.

## Verification summary

| Check | Result |
| --- | --- |
| Focused suites, run twice | Passed (68/68 both runs) |
| `npm test` | Passed |
| `npm run typecheck` | Passed |
| `npm run lint -- --quiet` | Passed |
| `npm run build` | Passed |
| `npm run test:e2e` | Passed (`tests/e2e/changeReview.spec.ts`) |
| `npm run package` | Passed; `release\win-unpacked\TraceDeck.exe` produced |
| CLI review output (text, JSON, Markdown, HTML) | Produced with relative paths and no absolute leakage |
| HTML report external assets | None (`<script>` and `http` absent) |

## Branch readiness

The branch is ready to merge from a verification and documentation standpoint. All quality gates pass, packaging succeeds on Windows, the CLI review works against a realistic temporary repository, and the documentation accurately reflects the shipped behavior and its honest limitations.

Cross-platform packaging (macOS DMG, Linux AppImage) has not been exercised on this Windows host and remains a CI responsibility before release.
