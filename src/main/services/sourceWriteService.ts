import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { MAX_SOURCE_BYTES } from '@shared/constants';
import type { SourceDocument } from '@shared/types';
import { resolveSafeProjectFile } from '../utils/paths';
import { detectEncoding, isDecodableText } from './fileClassificationService';
import { readSource } from './sourceService';

export class SourceWriteError extends Error {
  constructor(
    message: string,
    readonly code: 'SOURCE_CONFLICT' | 'NOT_EDITABLE' | 'TOO_LARGE' | 'WRITE_FAILED',
  ) {
    super(message);
    this.name = 'SourceWriteError';
  }
}

export interface SaveSourceRequest {
  rootPath: string;
  relativePath: string;
  /** Hash of the bytes the editor started from, used to detect outside edits. */
  baseHash: string;
  text: string;
}

/**
 * Writes one project text file, refusing the write if the file changed since it was opened.
 *
 * The guard is a content hash rather than a modification time: timestamps have coarse
 * resolution, can be identical for two edits within the same tick, and can be rewritten by
 * other tools. Comparing the bytes actually on disk is the only check that cannot be fooled
 * into silently discarding someone else's work.
 *
 * The write itself goes to a temporary file in the same directory and is then renamed over
 * the target. Rename within a directory is atomic on both Windows and POSIX, so an
 * interrupted save can never leave a half-written source file behind. Writing to a system
 * temp directory instead would cross a device boundary and turn the rename into a copy,
 * losing that guarantee.
 */
export async function saveSource(request: SaveSourceRequest): Promise<SourceDocument> {
  const { rootPath, relativePath, baseHash, text } = request;

  // Re-resolved, not trusted from the read: the path may have been replaced by a link in the
  // time the file sat open in the editor.
  const target = await resolveSafeProjectFile(rootPath, relativePath);

  const nextBytes = Buffer.from(text, 'utf8');
  if (nextBytes.byteLength > MAX_SOURCE_BYTES) {
    throw new SourceWriteError(
      `The edited file is larger than the ${Math.round(
        MAX_SOURCE_BYTES / 1024 / 1024,
      )} MB write limit.`,
      'TOO_LARGE',
    );
  }

  let currentBytes: Buffer;
  try {
    currentBytes = await fs.readFile(target);
  } catch {
    throw new SourceWriteError('That file could not be read before saving.', 'WRITE_FAILED');
  }

  // A binary file is never editable, and must not become writable by way of the save channel.
  const encoding = detectEncoding(currentBytes);
  if (!isDecodableText(currentBytes, encoding)) {
    throw new SourceWriteError('That file is binary and cannot be edited here.', 'NOT_EDITABLE');
  }
  if (encoding !== 'utf-8') {
    throw new SourceWriteError(
      `That file uses the ${encoding} encoding. Only UTF-8 files can be saved from here.`,
      'NOT_EDITABLE',
    );
  }

  const currentHash = createHash('sha256').update(currentBytes).digest('hex');
  if (currentHash !== baseHash) {
    throw new SourceWriteError(
      'This file changed on disk since you opened it. Your edits were not saved, so nothing ' +
        'was overwritten.',
      'SOURCE_CONFLICT',
    );
  }

  // Preserve the existing permission bits; a fresh temp file would otherwise default to the
  // process umask and could silently drop the executable bit from a script.
  const mode = (await fs.stat(target)).mode;

  const temporary = join(dirname(target), `.${basename(target)}.tracedeck-${process.pid}.tmp`);
  try {
    await fs.writeFile(temporary, nextBytes, { mode });
    await fs.rename(temporary, target);
  } catch {
    // Never leave a stray temp file behind when the write fails partway.
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw new SourceWriteError('That file could not be written to disk.', 'WRITE_FAILED');
  }

  // Returned freshly from disk so the editor's hash and line data match the saved bytes
  // exactly, rather than being reconstructed from what the renderer believed it sent.
  return readSource(target, relativePath);
}
