import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SourceWriteError, saveSource } from '@main/services/sourceWriteService';
import { MAX_SOURCE_BYTES } from '@shared/constants';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function project(files: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'tracedeck-write-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(join(root, name), content);
  }
  return root;
}

function hashOf(content: string | Buffer): string {
  return createHash('sha256').update(Buffer.from(content as never)).digest('hex');
}

describe('saveSource', () => {
  it('writes the edited text and returns a document matching the saved bytes', async () => {
    const root = await project({ 'a.ts': 'const a = 1;\n' });

    const doc = await saveSource({
      rootPath: root,
      relativePath: 'a.ts',
      baseHash: hashOf('const a = 1;\n'),
      text: 'const a = 2;\n',
    });

    expect(await fs.readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 2;\n');
    expect(doc.kind).toBe('text');
    if (doc.kind !== 'text') throw new Error('expected text');
    // The returned hash must describe what is on disk now, not what was sent.
    expect(doc.contentHash).toBe(hashOf('const a = 2;\n'));
    expect(doc.text).toBe('const a = 2;\n');
  });

  it('refuses to overwrite a file that changed on disk since it was opened', async () => {
    const root = await project({ 'a.ts': 'original\n' });
    const staleHash = hashOf('original\n');
    await fs.writeFile(join(root, 'a.ts'), 'changed by another tool\n');

    await expect(
      saveSource({ rootPath: root, relativePath: 'a.ts', baseHash: staleHash, text: 'mine\n' }),
    ).rejects.toMatchObject({ code: 'SOURCE_CONFLICT' });

    // The other tool's work must survive the rejected save.
    expect(await fs.readFile(join(root, 'a.ts'), 'utf8')).toBe('changed by another tool\n');
  });

  it('detects a conflict even when the file size is unchanged', async () => {
    const root = await project({ 'a.ts': 'aaaa\n' });
    const staleHash = hashOf('aaaa\n');
    // Same byte length, different content: a size or mtime check could miss this.
    await fs.writeFile(join(root, 'a.ts'), 'bbbb\n');

    await expect(
      saveSource({ rootPath: root, relativePath: 'a.ts', baseHash: staleHash, text: 'cccc\n' }),
    ).rejects.toMatchObject({ code: 'SOURCE_CONFLICT' });
  });

  it('refuses to write a binary file', async () => {
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0x00]);
    const root = await project({ 'blob.bin': bytes });

    await expect(
      saveSource({
        rootPath: root,
        relativePath: 'blob.bin',
        baseHash: hashOf(bytes),
        text: 'text',
      }),
    ).rejects.toMatchObject({ code: 'NOT_EDITABLE' });
  });

  it('refuses text larger than the write limit', async () => {
    const root = await project({ 'a.ts': 'x\n' });

    await expect(
      saveSource({
        rootPath: root,
        relativePath: 'a.ts',
        baseHash: hashOf('x\n'),
        text: 'y'.repeat(MAX_SOURCE_BYTES + 10),
      }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('leaves no temporary file behind after a successful save', async () => {
    const root = await project({ 'a.ts': 'one\n' });

    await saveSource({
      rootPath: root,
      relativePath: 'a.ts',
      baseHash: hashOf('one\n'),
      text: 'two\n',
    });

    expect((await fs.readdir(root)).filter((name) => name.includes('tracedeck-'))).toEqual([]);
  });

  it('refuses a path that escapes the project', async () => {
    const root = await project({ 'a.ts': 'x\n' });

    await expect(
      saveSource({
        rootPath: root,
        relativePath: '../escape.ts',
        baseHash: hashOf('x\n'),
        text: 'nope',
      }),
    ).rejects.toThrow();
  });

  it('refuses a file that no longer exists', async () => {
    const root = await project({ 'a.ts': 'x\n' });
    await fs.rm(join(root, 'a.ts'));

    await expect(
      saveSource({ rootPath: root, relativePath: 'a.ts', baseHash: hashOf('x\n'), text: 'y' }),
    ).rejects.toThrow();
  });

  it('reports a typed error rather than a bare Error', async () => {
    const root = await project({ 'a.ts': 'x\n' });

    await expect(
      saveSource({ rootPath: root, relativePath: 'a.ts', baseHash: 'wrong', text: 'y' }),
    ).rejects.toBeInstanceOf(SourceWriteError);
  });
});
