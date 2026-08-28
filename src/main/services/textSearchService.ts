import { promises as fs } from 'node:fs';
import type { TextSearchHit } from '@shared/types';
import { MAX_SOURCE_BYTES } from '@shared/constants';
import type { DataStore } from '../db';
import { decodeText, detectEncoding, isDecodableText } from './fileClassificationService';

export async function searchProjectText(
  store: DataStore,
  projectId: number,
  query: string,
  limit = 100,
): Promise<TextSearchHit[]> {
  const needle = query.trim();
  if (needle.length < 2) return [];

  const hits: TextSearchHit[] = [];
  const files = store.projectFiles.listByProject(projectId);

  for (const file of files) {
    if (file.contentKind !== 'text' || file.entryKind !== 'regular') continue;
    if (file.sizeBytes > MAX_SOURCE_BYTES) continue;
    if (file.analysisStatus === 'excluded' || file.analysisStatus === 'binary') continue;

    let text: string;
    try {
      const bytes = await fs.readFile(file.absolutePath);
      const encoding = detectEncoding(bytes);
      if (!isDecodableText(bytes, encoding)) continue;
      text = decodeText(bytes, encoding);
    } catch {
      continue;
    }

    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const column = line.indexOf(needle);
      if (column < 0) continue;
      hits.push({
        relativePath: file.relativePath,
        line: index + 1,
        column: column + 1,
        preview: line.trim().slice(0, 200),
      });
      if (hits.length >= limit) return hits;
    }
  }

  return hits;
}
