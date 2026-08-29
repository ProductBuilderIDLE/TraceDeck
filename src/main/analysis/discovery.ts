import { promises as fs } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import {
  ALWAYS_EXCLUDED_DIRS,
  SOURCE_EXTENSIONS,
  TEST_FILE_PATTERNS,
} from '@shared/constants';
import type {
  ProjectFileAnalysisStatus,
  ProjectFileContentKind,
  ProjectFileEntryKind,
} from '@shared/types';
import { classifyProjectFile } from '../services/fileClassificationService';
import { GitignoreMatcher } from '../utils/gitignore';
import { createGlobMatchers, toPosixPath } from '../utils/glob';

export interface DiscoveredFile {
  relativePath: string;
  absolutePath: string;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
  isTestFile: boolean;
}

export interface DiscoveryOptions {
  rootPath: string;
  respectGitignore: boolean;
  includeTestFiles: boolean;
  excludePatterns: readonly string[];
}

export interface DiscoveryResult {
  inventory: DiscoveryInventoryEntry[];
  files: DiscoveredFile[];
  /** Paths skipped for a reason worth surfacing, rather than by routine exclusion. */
  skipped: Array<{ relativePath: string; reason: string }>;
  diagnostics: DiscoveryDiagnostics;
}

export interface DiscoveryInventoryEntry {
  relativePath: string;
  absolutePath: string;
  entryKind: ProjectFileEntryKind;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
  contentKind: ProjectFileContentKind;
  encoding: string | null;
  contentHash: string | null;
  isGitIgnored: boolean;
  gitignoreRule: string | null;
  isUserExcluded: boolean;
  analysisStatus: ProjectFileAnalysisStatus;
  analysisReason: string;
}

export type DiscoveryExclusionKind =
  | 'always-excluded-directory'
  | 'user-exclude'
  | 'gitignore'
  | 'unsupported-extension'
  | 'test-file-disabled'
  | 'symbolic-link'
  | 'unreadable-directory'
  | 'unreadable-file'
  | 'file-too-large'
  | 'duplicate-real-path'
  | 'non-regular-entry';

export interface DiscoveryExclusion {
  relativePath: string;
  kind: DiscoveryExclusionKind;
  /** Concrete extension, directory name, glob, ignore rule, or filesystem reason. */
  detail: string;
  isDirectory: boolean;
}

export interface DiscoveryDiagnostics {
  directoriesVisited: number;
  /** Regular files encountered before extension and policy filtering. */
  filesConsidered: number;
  exclusions: DiscoveryExclusion[];
}

const excludedDirNames = new Set(ALWAYS_EXCLUDED_DIRS);
const sourceExtensions = new Set(SOURCE_EXTENSIONS);

export function isTestFile(relativePath: string): boolean {
  const posix = toPosixPath(relativePath);
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(posix));
}

interface GitignoreReadResult {
  matcher: GitignoreMatcher | null;
  error: string | null;
}

async function readGitignore(directory: string): Promise<GitignoreReadResult> {
  try {
    const contents = await fs.readFile(join(directory, '.gitignore'), 'utf8');
    return { matcher: GitignoreMatcher.fromFileContents(contents), error: null };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : null;
    if (code === 'ENOENT') return { matcher: null, error: null };
    return {
      matcher: null,
      error: `The .gitignore file could not be read${code ? ` (${code})` : ''}.`,
    };
  }
}

/**
 * Walks the project tree and returns the source files worth parsing.
 *
 * Nested .gitignore files are honoured: each directory's own rules are layered on top of the
 * ones inherited from its ancestors, which is how git itself evaluates them. Symlinks are not
 * followed, so a link pointing outside the project cannot pull unrelated code into the scan.
 */
export async function discoverFiles(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const { rootPath, respectGitignore, includeTestFiles } = options;
  const userExcludes = createGlobMatchers(options.excludePatterns);

  const inventory: DiscoveryInventoryEntry[] = [];
  const files: DiscoveredFile[] = [];
  const skipped: DiscoveryResult['skipped'] = [];
  const exclusions: DiscoveryExclusion[] = [];
  const visitedRealPaths = new Set<string>();
  let directoriesVisited = 0;
  let filesConsidered = 0;

  const recordExclusion = (
    relativePath: string,
    kind: DiscoveryExclusionKind,
    detail: string,
    isDirectory: boolean,
  ): void => {
    exclusions.push({ relativePath: relativePath || '.', kind, detail, isDirectory });
  };

  // A .gitignore applies to paths relative to its own directory, so each matcher carries the
  // directory it was loaded from rather than being tested against a bare file name.
  interface ScopedIgnore {
    baseDir: string;
    matcher: GitignoreMatcher;
  }

  interface ScopedIgnoreDecision {
    ignored: boolean;
    ignoreFile: string;
    pattern: string;
  }

  const ignoreDecision = (
    stack: ScopedIgnore[],
    absolutePath: string,
  ): ScopedIgnoreDecision | null => {
    let finalDecision: ScopedIgnoreDecision | null = null;

    for (const scoped of stack) {
      const decision = scoped.matcher.decision(
        toPosixPath(relative(scoped.baseDir, absolutePath)),
      );
      if (!decision.matched || decision.pattern === null) continue;
      finalDecision = {
        ignored: decision.ignored,
        ignoreFile: toPosixPath(relative(rootPath, join(scoped.baseDir, '.gitignore'))) ||
          '.gitignore',
        pattern: decision.pattern,
      };
    }

    return finalDecision?.ignored ? finalDecision : null;
  };

  const userExcludeDecision = (relativePath: string): string | null => {
    const segments = toPosixPath(relativePath).split('/');
    const candidates = segments.map((_, index) => segments.slice(0, index + 1).join('/'));
    for (const matcher of userExcludes) {
      if (candidates.some((candidate) => matcher.test(candidate))) return matcher.pattern;
    }
    return null;
  };

  const policyStatus = (
    classification: Awaited<ReturnType<typeof classifyProjectFile>>,
    ignored: ScopedIgnoreDecision | null,
    userExclude: string | null,
    testDisabled: boolean,
  ): Pick<DiscoveryInventoryEntry, 'analysisStatus' | 'analysisReason'> => {
    if (userExclude) {
      return {
        analysisStatus: 'excluded',
        analysisReason: `Excluded by user pattern: ${userExclude}`,
      };
    }
    if (ignored) {
      return {
        analysisStatus: 'excluded',
        analysisReason: `Ignored by ${ignored.ignoreFile}: ${ignored.pattern}`,
      };
    }
    if (testDisabled) {
      return {
        analysisStatus: 'excluded',
        analysisReason: 'Test files are disabled by includeTestFiles=false.',
      };
    }
    return classification;
  };

  async function walk(directory: string, inheritedIgnores: ScopedIgnore[]): Promise<void> {
    directoriesVisited += 1;
    const ignoreStack = respectGitignore ? [...inheritedIgnores] : [];

    if (respectGitignore) {
      const local = await readGitignore(directory);
      if (local.error) {
        const ignorePath = toPosixPath(relative(rootPath, join(directory, '.gitignore')));
        skipped.push({ relativePath: ignorePath, reason: local.error });
        recordExclusion(ignorePath, 'unreadable-file', local.error, false);
      }
      if (local.matcher && local.matcher.ruleCount > 0) {
        ignoreStack.push({ baseDir: directory, matcher: local.matcher });
      }
    }

    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      const relativeDirectory = toPosixPath(relative(rootPath, directory)) || '.';
      skipped.push({
        relativePath: relativeDirectory,
        reason: 'Directory could not be read.',
      });
      recordExclusion(
        relativeDirectory,
        'unreadable-directory',
        'Directory could not be read.',
        true,
      );
      return;
    }

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = toPosixPath(relative(rootPath, absolutePath));

      if (entry.isSymbolicLink()) {
        const reason = 'Symbolic link; not followed so the scan stays inside the project.';
        skipped.push({
          relativePath,
          reason,
        });
        recordExclusion(relativePath, 'symbolic-link', reason, entry.isDirectory());
        const ignored = ignoreDecision(ignoreStack, absolutePath);
        const userExclude = userExcludeDecision(relativePath);
        let sizeBytes = 0;
        let modifiedAt = new Date(0).toISOString();
        try {
          const stats = await fs.lstat(absolutePath);
          sizeBytes = stats.size;
          modifiedAt = stats.mtime.toISOString();
        } catch {
          // The directory entry is still useful inventory even if its link metadata raced away.
        }
        inventory.push({
          relativePath,
          absolutePath,
          entryKind: 'symlink',
          extension: extname(entry.name).toLowerCase(),
          sizeBytes,
          modifiedAt,
          contentKind: 'unknown',
          encoding: null,
          contentHash: null,
          isGitIgnored: ignored !== null,
          gitignoreRule: ignored ? `${ignored.ignoreFile}: ${ignored.pattern}` : null,
          isUserExcluded: userExclude !== null,
          analysisStatus: 'symlink',
          analysisReason: reason,
        });
        continue;
      }

      if (entry.isDirectory()) {
        if (excludedDirNames.has(entry.name)) {
          recordExclusion(relativePath, 'always-excluded-directory', entry.name, true);
          continue;
        }
        const userExclude = userExcludeDecision(relativePath);
        if (userExclude) recordExclusion(relativePath, 'user-exclude', userExclude, true);
        const ignored = ignoreDecision(ignoreStack, absolutePath);
        if (ignored) {
          recordExclusion(
            relativePath,
            'gitignore',
            `${ignored.ignoreFile}: ${ignored.pattern}`,
            true,
          );
        }

        // Guards against a directory cycle created by hard links or a mount loop.
        let realPath: string;
        try {
          realPath = await fs.realpath(absolutePath);
        } catch {
          realPath = absolutePath;
          const reason = 'Directory real path could not be resolved.';
          skipped.push({ relativePath, reason });
          recordExclusion(relativePath, 'unreadable-directory', reason, true);
        }
        if (visitedRealPaths.has(realPath)) {
          recordExclusion(
            relativePath,
            'duplicate-real-path',
            toPosixPath(realPath),
            true,
          );
          continue;
        }
        visitedRealPaths.add(realPath);

        await walk(absolutePath, ignoreStack);
        continue;
      }

      if (!entry.isFile()) {
        recordExclusion(relativePath, 'non-regular-entry', entry.name, false);
        continue;
      }
      filesConsidered += 1;

      const extension = extname(entry.name).toLowerCase();
      if (!sourceExtensions.has(extension)) {
        recordExclusion(
          relativePath,
          'unsupported-extension',
          extension || '<none>',
          false,
        );
      }
      const userExclude = userExcludeDecision(relativePath);
      if (userExclude) {
        recordExclusion(relativePath, 'user-exclude', userExclude, false);
      }
      const ignored = ignoreDecision(ignoreStack, absolutePath);
      if (ignored) {
        recordExclusion(
          relativePath,
          'gitignore',
          `${ignored.ignoreFile}: ${ignored.pattern}`,
          false,
        );
      }

      const fileIsTest = isTestFile(relativePath);
      if (!includeTestFiles && fileIsTest) {
        recordExclusion(relativePath, 'test-file-disabled', 'includeTestFiles=false', false);
      }

      let stats;
      try {
        stats = await fs.stat(absolutePath);
      } catch {
        const reason = 'File metadata could not be read.';
        skipped.push({ relativePath, reason });
        recordExclusion(relativePath, 'unreadable-file', reason, false);
        inventory.push({
          relativePath,
          absolutePath,
          entryKind: 'regular',
          extension,
          sizeBytes: 0,
          modifiedAt: new Date(0).toISOString(),
          contentKind: 'unknown',
          encoding: null,
          contentHash: null,
          isGitIgnored: ignored !== null,
          gitignoreRule: ignored ? `${ignored.ignoreFile}: ${ignored.pattern}` : null,
          isUserExcluded: userExclude !== null,
          analysisStatus: 'unreadable',
          analysisReason: reason,
        });
        continue;
      }

      const classification = await classifyProjectFile(absolutePath, stats);
      const status = policyStatus(
        classification,
        ignored,
        userExclude,
        !includeTestFiles && fileIsTest,
      );
      const inventoryEntry: DiscoveryInventoryEntry = {
        relativePath,
        absolutePath,
        entryKind: 'regular',
        extension,
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        contentKind: classification.contentKind,
        encoding: classification.encoding,
        contentHash: classification.contentHash,
        isGitIgnored: ignored !== null,
        gitignoreRule: ignored ? `${ignored.ignoreFile}: ${ignored.pattern}` : null,
        isUserExcluded: userExclude !== null,
        analysisStatus: status.analysisStatus,
        analysisReason: status.analysisReason,
      };
      inventory.push(inventoryEntry);

      if (classification.analysisStatus === 'oversize') {
        skipped.push({
          relativePath,
          reason: classification.analysisReason,
        });
        recordExclusion(
          relativePath,
          'file-too-large',
          classification.analysisReason,
          false,
        );
      }

      if (inventoryEntry.analysisStatus !== 'eligible') continue;
      files.push({
        relativePath,
        absolutePath,
        extension,
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        isTestFile: fileIsTest,
      });
    }
  }

  await walk(rootPath, []);

  inventory.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  skipped.sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath) || a.reason.localeCompare(b.reason),
  );
  exclusions.sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath) ||
    a.kind.localeCompare(b.kind) ||
    a.detail.localeCompare(b.detail),
  );

  return {
    inventory,
    files,
    skipped,
    diagnostics: { directoriesVisited, filesConsidered, exclusions },
  };
}

/** Splits a posix relative path into its directory segments, excluding the file name. */
export function folderSegments(relativePath: string): string[] {
  const parts = toPosixPath(relativePath).split('/');
  parts.pop();

  const folders: string[] = [];
  let current = '';
  for (const part of parts) {
    current = current.length === 0 ? part : `${current}/${part}`;
    folders.push(current);
  }
  return folders;
}

export function toRelativePosix(rootPath: string, absolutePath: string): string {
  return toPosixPath(relative(rootPath, absolutePath));
}

export function toAbsolute(rootPath: string, relativePath: string): string {
  return join(rootPath, relativePath.split('/').join(sep));
}
