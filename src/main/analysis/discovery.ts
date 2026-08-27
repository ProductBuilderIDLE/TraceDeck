import { promises as fs } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import {
  ALWAYS_EXCLUDED_DIRS,
  MAX_FILE_SIZE_BYTES,
  SOURCE_EXTENSIONS,
  TEST_FILE_PATTERNS,
} from '@shared/constants';
import { GitignoreMatcher } from '../utils/gitignore';
import { createGlobMatchers, matchesAny, toPosixPath } from '../utils/glob';

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
  files: DiscoveredFile[];
  /** Paths skipped for a reason worth surfacing, rather than by routine exclusion. */
  skipped: Array<{ relativePath: string; reason: string }>;
}

const excludedDirNames = new Set(ALWAYS_EXCLUDED_DIRS);
const sourceExtensions = new Set(SOURCE_EXTENSIONS);

export function isTestFile(relativePath: string): boolean {
  const posix = toPosixPath(relativePath);
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(posix));
}

async function readGitignore(directory: string): Promise<GitignoreMatcher | null> {
  try {
    const contents = await fs.readFile(join(directory, '.gitignore'), 'utf8');
    return GitignoreMatcher.fromFileContents(contents);
  } catch {
    return null;
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

  const files: DiscoveredFile[] = [];
  const skipped: DiscoveryResult['skipped'] = [];
  const visitedRealPaths = new Set<string>();

  // A .gitignore applies to paths relative to its own directory, so each matcher carries the
  // directory it was loaded from rather than being tested against a bare file name.
  interface ScopedIgnore {
    baseDir: string;
    matcher: GitignoreMatcher;
  }

  const isIgnored = (stack: ScopedIgnore[], absolutePath: string): boolean =>
    stack.some((scoped) => scoped.matcher.ignores(toPosixPath(relative(scoped.baseDir, absolutePath))));

  async function walk(directory: string, inheritedIgnores: ScopedIgnore[]): Promise<void> {
    const ignoreStack = respectGitignore ? [...inheritedIgnores] : [];

    if (respectGitignore) {
      const local = await readGitignore(directory);
      if (local && local.ruleCount > 0) ignoreStack.push({ baseDir: directory, matcher: local });
    }

    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      skipped.push({
        relativePath: toPosixPath(relative(rootPath, directory)),
        reason: 'Directory could not be read.',
      });
      return;
    }

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = toPosixPath(relative(rootPath, absolutePath));

      if (entry.isSymbolicLink()) {
        skipped.push({
          relativePath,
          reason: 'Symbolic link; not followed so the scan stays inside the project.',
        });
        continue;
      }

      if (entry.isDirectory()) {
        if (excludedDirNames.has(entry.name)) continue;
        if (matchesAny(userExcludes, relativePath)) continue;
        if (isIgnored(ignoreStack, absolutePath)) continue;

        // Guards against a directory cycle created by hard links or a mount loop.
        const realPath = await fs.realpath(absolutePath).catch(() => absolutePath);
        if (visitedRealPaths.has(realPath)) continue;
        visitedRealPaths.add(realPath);

        await walk(absolutePath, ignoreStack);
        continue;
      }

      if (!entry.isFile()) continue;

      const extension = extname(entry.name);
      if (!sourceExtensions.has(extension)) continue;
      if (matchesAny(userExcludes, relativePath)) continue;
      if (isIgnored(ignoreStack, absolutePath)) continue;

      const fileIsTest = isTestFile(relativePath);
      if (!includeTestFiles && fileIsTest) continue;

      let stats;
      try {
        stats = await fs.stat(absolutePath);
      } catch {
        skipped.push({ relativePath, reason: 'File could not be read.' });
        continue;
      }

      if (stats.size > MAX_FILE_SIZE_BYTES) {
        skipped.push({
          relativePath,
          reason: `File is larger than ${Math.round(MAX_FILE_SIZE_BYTES / 1024)} KB and was not parsed.`,
        });
        continue;
      }

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

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files, skipped };
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
