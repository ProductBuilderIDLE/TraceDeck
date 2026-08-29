import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export class PathEscapeError extends Error {
  readonly code = 'PATH_ESCAPE';
  constructor(message = 'That path is outside the project folder.') {
    super(message);
    this.name = 'PathEscapeError';
  }
}

/**
 * Resolves a project-relative path to an absolute one, refusing anything that escapes the root.
 *
 * This lives in a dependency-free module rather than beside the IPC handlers that use it, so
 * the containment rule can be unit tested without pulling Electron into the test process.
 */
export function resolveWithinProject(rootPath: string, relativePath: string): string {
  const absolute = join(rootPath, relativePath);
  const normalisedRoot = rootPath.replace(/[\\/]+$/, '');

  // The separator check matters: without it, a sibling directory whose name merely starts
  // with the project's name would be accepted.
  if (absolute !== normalisedRoot && !absolute.startsWith(`${normalisedRoot}${pathSeparator()}`)) {
    throw new PathEscapeError();
  }
  return absolute;
}

function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

/**
 * Resolves a project-relative path for reading or writing, refusing anything whose *real*
 * location escapes the project.
 *
 * Lexical containment alone is not sufficient once writing is possible. If a directory inside
 * the project is a symlink or a Windows junction pointing elsewhere, then a path like
 * `project/linked/file.ts` passes every string check while actually resolving outside the
 * project. Resolving the real parent directory closes that hole, and refusing a non-regular
 * target stops a link being followed or a device being written to.
 */
export async function resolveSafeProjectFile(
  rootPath: string,
  relativePath: string,
  options: { mustExist?: boolean } = {},
): Promise<string> {
  const { mustExist = true } = options;
  const absolute = resolveWithinProject(rootPath, relativePath);

  const realRoot = await realpath(rootPath).catch(() => {
    throw new PathEscapeError('The project folder could not be resolved on disk.');
  });

  // The parent must be resolved rather than the file itself: resolving the file would follow
  // a symlink and hide exactly the case being guarded against.
  const realParent = await realpath(dirname(absolute)).catch(() => {
    throw new PathEscapeError('That location does not exist inside the project.');
  });

  const normalisedRealRoot = realRoot.replace(/[\\/]+$/, '');
  if (
    realParent !== normalisedRealRoot &&
    !realParent.startsWith(`${normalisedRealRoot}${pathSeparator()}`)
  ) {
    throw new PathEscapeError(
      'That path resolves outside the project folder through a link or junction.',
    );
  }

  const target = join(realParent, basename(absolute));

  let stats;
  try {
    stats = await lstat(target);
  } catch {
    if (mustExist) throw new PathEscapeError('That file no longer exists in the project.');
    return target;
  }

  if (stats.isSymbolicLink()) {
    throw new PathEscapeError('That entry is a link, and links are never followed or written.');
  }
  if (!stats.isFile()) {
    throw new PathEscapeError('That entry is not a regular file.');
  }

  return target;
}
