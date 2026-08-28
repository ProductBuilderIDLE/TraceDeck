import { promises as fs, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyProjectFile } from '@main/services/fileClassificationService';
import { MAX_FILE_SIZE_BYTES } from '@shared/constants';

const temporaryDirectories: string[] = [];

async function classifyFixture(name: string, bytes: Uint8Array | string) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'tracedeck-classifier-'));
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  await fs.writeFile(path, bytes);
  return classifyProjectFile(path, await fs.stat(path));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('classifyProjectFile', () => {
  it.each([
    { label: 'UTF-8', bytes: new TextEncoder().encode('hello'), encoding: 'utf-8' },
    {
      label: 'UTF-8 BOM',
      bytes: Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]),
      encoding: 'utf-8',
    },
    {
      label: 'UTF-16LE BOM',
      bytes: Uint8Array.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]),
      encoding: 'utf-16le',
    },
    {
      label: 'UTF-16BE BOM',
      bytes: Uint8Array.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]),
      encoding: 'utf-16be',
    },
  ])('classifies $label text without losing its encoding', async ({ bytes, encoding }) => {
    const result = await classifyFixture('notes.md', bytes);

    expect(result).toEqual(
      expect.objectContaining({
        contentKind: 'text',
        encoding,
        analysisStatus: 'text-only',
      }),
    );
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    { label: 'invalid UTF-8', bytes: Uint8Array.from([0xc3, 0x28]) },
    { label: 'NUL-containing content', bytes: Uint8Array.from([0x61, 0x00, 0x62]) },
  ])('classifies $label as binary without decoding it as text', async ({ bytes }) => {
    const result = await classifyFixture('payload.bin', bytes);

    expect(result).toEqual({
      contentKind: 'binary',
      encoding: null,
      contentHash: null,
      analysisStatus: 'binary',
      analysisReason: 'Binary content is not analyzed.',
    });
  });

  it('classifies an empty supported source as UTF-8 and graph-eligible', async () => {
    const result = await classifyFixture('empty.ts', new Uint8Array());

    expect(result).toEqual({
      contentKind: 'text',
      encoding: 'utf-8',
      contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      analysisStatus: 'eligible',
      analysisReason: 'Supported source file is eligible for graph analysis.',
    });
  });

  it('returns bounded oversize metadata without opening the file', async () => {
    const result = await classifyProjectFile('does-not-exist.ts', {
      size: MAX_FILE_SIZE_BYTES + 1,
    } as Stats);

    expect(result).toEqual({
      contentKind: 'unknown',
      encoding: null,
      contentHash: null,
      analysisStatus: 'oversize',
      analysisReason: `File exceeds the ${MAX_FILE_SIZE_BYTES}-byte analysis limit.`,
    });
  });
});
