import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  BlameLine,
  ChurnEntry,
  CoChangeEntry,
  GitDiffFile,
  RenameEntry,
} from '@shared/types';
import { toPosixPath } from '../utils/glob';

const execFileAsync = promisify(execFile);

async function git(
  cwd: string,
  args: string[],
  timeoutMs = 20000,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string; code?: string };
    if (err.code === 'ENOENT') {
      throw new Error('Git is not available on this computer.');
    }
    throw new Error(err.stderr?.trim() || err.message || 'Git command failed.');
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function gitChangedFiles(cwd: string, ref = 'HEAD'): Promise<GitDiffFile[]> {
  const { stdout } = await git(cwd, ['diff', '--name-status', ref]);
  const files: GitDiffFile[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([A-Z])\t(.+)$/.exec(line);
    if (!match) continue;
    files.push({ status: match[1] ?? 'M', relativePath: toPosixPath(match[2] ?? '') });
  }
  return files;
}

export async function gitDiff(cwd: string, relativePath: string, ref = 'HEAD'): Promise<string> {
  const { stdout } = await git(cwd, ['diff', ref, '--', relativePath]);
  return stdout;
}

export async function gitBlame(cwd: string, relativePath: string): Promise<BlameLine[]> {
  const { stdout } = await git(cwd, ['blame', '--line-porcelain', '--', relativePath]);
  const lines: BlameLine[] = [];
  let commit = '';
  let author = '';
  let date = '';
  let lineNumber = 0;
  for (const raw of stdout.split(/\r?\n/)) {
    if (/^[0-9a-f]{7,40} /.test(raw)) {
      commit = raw.slice(0, 40).trim();
      continue;
    }
    if (raw.startsWith('author ')) author = raw.slice('author '.length);
    else if (raw.startsWith('author-time ')) {
      const seconds = Number(raw.slice('author-time '.length));
      date = Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : '';
    } else if (raw.startsWith('\t')) {
      lineNumber += 1;
      lines.push({ line: lineNumber, commit, author, date });
    }
  }
  return lines;
}

export async function gitChurn(cwd: string): Promise<ChurnEntry[]> {
  const { stdout } = await git(cwd, [
    'log',
    '--since=90.days',
    '--numstat',
    '--pretty=format:',
  ]);
  const counts = new Map<string, ChurnEntry>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    const path = toPosixPath((match[3] ?? '').split('\t').pop() ?? '');
    if (!path) continue;
    const current = counts.get(path) ?? { relativePath: path, commits: 0, additions: 0, deletions: 0 };
    current.commits += 1;
    current.additions += match[1] === '-' ? 0 : Number(match[1]);
    current.deletions += match[2] === '-' ? 0 : Number(match[2]);
    counts.set(path, current);
  }
  return [...counts.values()].sort((left, right) => right.commits - left.commits).slice(0, 200);
}

export async function gitCoChange(cwd: string, relativePath: string): Promise<CoChangeEntry[]> {
  const { stdout } = await git(cwd, [
    'log',
    '-n',
    '50',
    '--pretty=format:%H',
    '--name-only',
    '--',
    relativePath,
  ]);
  const commits = stdout.split(/\r?\n\r?\n/).map((block) => block.trim()).filter(Boolean);
  const counts = new Map<string, number>();
  for (const block of commits) {
    const files = block.split(/\r?\n/).slice(1).map(toPosixPath);
    for (const path of files) {
      if (!path || path === toPosixPath(relativePath)) continue;
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([path, sharedCommits]) => ({ relativePath: path, sharedCommits }))
    .sort((left, right) => right.sharedCommits - left.sharedCommits)
    .slice(0, 30);
}

/** Recent rename events across the repository, used to caveat unused-export findings. */
export async function gitRecentRenames(cwd: string): Promise<RenameEntry[]> {
  const { stdout } = await git(cwd, [
    'log',
    '-n',
    '200',
    '-M',
    '--diff-filter=R',
    '--pretty=format:%H',
    '--name-status',
  ]);
  const entries: RenameEntry[] = [];
  let commit = '';
  for (const line of stdout.split(/\r?\n/)) {
    if (/^[0-9a-f]{7,40}$/.test(line)) {
      commit = line;
      continue;
    }
    const match = /^R\d+\t(.+)\t(.+)$/.exec(line);
    if (!match) continue;
    entries.push({
      commit,
      from: toPosixPath(match[1] ?? ''),
      to: toPosixPath(match[2] ?? ''),
    });
  }
  return entries.slice(0, 200);
}

export async function gitRenames(cwd: string, relativePath: string): Promise<RenameEntry[]> {
  const { stdout } = await git(cwd, [
    'log',
    '-M',
    '--follow',
    '--diff-filter=R',
    '--pretty=format:%H',
    '--name-status',
    '--',
    relativePath,
  ]);
  const entries: RenameEntry[] = [];
  let commit = '';
  for (const line of stdout.split(/\r?\n/)) {
    if (/^[0-9a-f]{7,40}$/.test(line)) {
      commit = line;
      continue;
    }
    const match = /^R\d+\t(.+)\t(.+)$/.exec(line);
    if (!match) continue;
    entries.push({
      commit,
      from: toPosixPath(match[1] ?? ''),
      to: toPosixPath(match[2] ?? ''),
    });
  }
  return entries.slice(0, 20);
}

export async function gitMergetool(cwd: string, relativePath: string): Promise<void> {
  await git(cwd, ['mergetool', '--no-prompt', '--', relativePath], 120000);
}
