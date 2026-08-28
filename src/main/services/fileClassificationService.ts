import { createHash } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import { extname } from 'node:path';
import { MAX_FILE_SIZE_BYTES, SOURCE_EXTENSIONS } from '@shared/constants';
import type {
  ProjectFileAnalysisStatus,
  ProjectFileContentKind,
} from '@shared/types';

const sourceExtensions = new Set(SOURCE_EXTENSIONS);

export interface FileClassification {
  contentKind: ProjectFileContentKind;
  encoding: string | null;
  contentHash: string | null;
  analysisStatus: ProjectFileAnalysisStatus;
  analysisReason: string;
}

function textClassification(absolutePath: string, bytes: Uint8Array): FileClassification {
  const extension = extname(absolutePath).toLowerCase();
  const eligible = sourceExtensions.has(extension);

  return {
    contentKind: 'text',
    encoding: detectEncoding(bytes),
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    analysisStatus: eligible ? 'eligible' : 'text-only',
    analysisReason: eligible
      ? 'Supported source file is eligible for graph analysis.'
      : 'Text files of this type are not graph sources.',
  };
}

function detectEncoding(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return 'utf-8';
}

function isDecodableText(bytes: Uint8Array, encoding: string): boolean {
  const body = encoding === 'utf-8' && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : encoding.startsWith('utf-16')
      ? bytes.subarray(2)
      : bytes;

  if (encoding === 'utf-8' && body.includes(0)) return false;

  try {
    new TextDecoder(encoding, { fatal: true }).decode(body);
    return true;
  } catch {
    return false;
  }
}

export async function classifyProjectFile(
  absolutePath: string,
  stats: Stats,
): Promise<FileClassification> {
  if (stats.size > MAX_FILE_SIZE_BYTES) {
    return {
      contentKind: 'unknown',
      encoding: null,
      contentHash: null,
      analysisStatus: 'oversize',
      analysisReason: `File exceeds the ${MAX_FILE_SIZE_BYTES}-byte analysis limit.`,
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(absolutePath);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : 'unknown error';
    return {
      contentKind: 'unknown',
      encoding: null,
      contentHash: null,
      analysisStatus: 'unreadable',
      analysisReason: `File content could not be read (${code}).`,
    };
  }

  const encoding = detectEncoding(bytes);
  if (!isDecodableText(bytes, encoding)) {
    return {
      contentKind: 'binary',
      encoding: null,
      contentHash: null,
      analysisStatus: 'binary',
      analysisReason: 'Binary content is not analyzed.',
    };
  }

  return textClassification(absolutePath, bytes);
}
