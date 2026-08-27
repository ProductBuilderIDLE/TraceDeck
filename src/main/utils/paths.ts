import { join } from 'node:path';

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
