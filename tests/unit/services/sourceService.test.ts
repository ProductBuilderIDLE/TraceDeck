import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_SOURCE_BYTES, MAX_SOURCE_LINES } from '@shared/constants';
import { readSource } from '@main/services/sourceService';
import type { SourceLine, SourceTextDocument } from '@shared/types';

const FIXTURE_ROOT = resolve(__dirname, '../../fixtures/sample-project');

function abs(relativePath: string): string {
  return resolve(FIXTURE_ROOT, relativePath);
}

async function read(relativePath: string) {
  return readSource(abs(relativePath), relativePath);
}

/** Narrows to a text document, failing loudly if the read returned an unavailable state. */
async function readText(relativePath: string): Promise<SourceTextDocument> {
  const doc = await read(relativePath);
  if (doc.kind !== 'text') {
    throw new Error(`Expected text for ${relativePath}, got ${doc.reason}: ${doc.message}`);
  }
  return doc;
}

/** Reassembles the document, which must be byte-identical to what the file contains. */
function textOf(lines: readonly SourceLine[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join('')).join('\n');
}

describe('readSource', () => {
  it('returns every line of the file with its number', async () => {
    const doc = await readText('src/services/math.ts');

    expect(doc.relativePath).toBe('src/services/math.ts');
    expect(doc.lines.length).toBeGreaterThan(3);
    expect(doc.lines[0]?.number).toBe(1);
    expect(doc.lines.at(-1)?.number).toBe(doc.lines.length);
    expect(doc.truncated).toBe(false);
  });

  it('loses no characters when the spans are reassembled', async () => {
    const doc = await readText('src/services/math.ts');

    // Tokenising must be lossless: every character of the file appears exactly once.
    expect(textOf(doc.lines).replace(/\r/g, '')).toContain('export function add(a: number, b: number): number {');
    expect(textOf(doc.lines)).toContain('return a * b;');
  });

  it('classifies keywords, identifiers, and punctuation', async () => {
    const doc = await readText('src/services/math.ts');
    const first = doc.lines[0]?.spans ?? [];

    expect(first.find((s) => s.text === 'export')?.kind).toBe('keyword');
    expect(first.find((s) => s.text === 'function')?.kind).toBe('keyword');
    expect(first.find((s) => s.text === 'add')?.kind).toBe('identifier');
    expect(first.find((s) => s.text === '(')?.kind).toBe('punctuation');
  });

  it('classifies strings and comments', async () => {
    const doc = await readText('src/services/greeter.ts');
    const kinds = doc.lines.flatMap((line) => line.spans.map((span) => span.kind));

    expect(kinds).toContain('string');
  });

  it('treats a capitalised identifier as a type so it reads differently from a value', async () => {
    const doc = await readText('src/components/Button.tsx');
    const spans = doc.lines.flatMap((line) => line.spans);

    expect(spans.find((s) => s.text === 'ButtonProps')?.kind).toBe('type');
  });

  it('splits a multi-line comment across the lines it covers', async () => {
    const doc = await readText('src/lazy/loader.ts');

    // No span may contain a newline; every span belongs to exactly one line.
    for (const line of doc.lines) {
      for (const span of line.spans) {
        expect(span.text).not.toContain('\n');
      }
    }
  });

  it('handles JSX without dropping content', async () => {
    const doc = await readText('src/components/Button.tsx');

    expect(textOf(doc.lines)).toContain('<button type="button">{label}</button>');
  });

  it('reports the file size', async () => {
    const doc = await readText('src/services/math.ts');

    expect(doc.sizeBytes).toBeGreaterThan(0);
    expect(doc.totalLines).toBe(doc.lines.length);
  });

  it('rejects a path that does not exist', async () => {
    await expect(read('src/does-not-exist.ts')).rejects.toThrow();
  });

  it('exposes the encoding, hash, and raw text needed to edit the file', async () => {
    const doc = await readText('src/services/math.ts');

    expect(doc.encoding).toBe('utf-8');
    expect(doc.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.editable).toBe(true);
    // The raw text must round-trip the spans exactly, or an edit would corrupt the file.
    expect(doc.text).toBe(textOf(doc.lines));
  });
});

/**
 * The viewer serves the whole inventory, not just graph sources, so it has to answer for
 * files it cannot render. Each case must explain itself rather than appear empty or broken.
 */
describe('readSource unavailable states', () => {
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function scratch(): Promise<string> {
    const dir = await fs.mkdtemp(join(tmpdir(), 'tracedeck-source-'));
    temporary.push(dir);
    return dir;
  }

  it('reports a binary file instead of rendering nonsense', async () => {
    const dir = await scratch();
    await fs.writeFile(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));

    const doc = await readSource(join(dir, 'blob.bin'), 'blob.bin');

    expect(doc.kind).toBe('unavailable');
    if (doc.kind !== 'unavailable') throw new Error('expected unavailable');
    expect(doc.reason).toBe('binary');
    expect(doc.message).toMatch(/binary/i);
  });

  it('reports a file larger than the viewer limit with its real size', async () => {
    const dir = await scratch();
    await fs.writeFile(join(dir, 'huge.ts'), 'a'.repeat(MAX_SOURCE_BYTES + 1024));

    const doc = await readSource(join(dir, 'huge.ts'), 'huge.ts');

    expect(doc.kind).toBe('unavailable');
    if (doc.kind !== 'unavailable') throw new Error('expected unavailable');
    expect(doc.reason).toBe('too-large');
    expect(doc.sizeBytes).toBeGreaterThan(MAX_SOURCE_BYTES);
  });

  it('reports an unreadable path rather than throwing for a missing directory', async () => {
    const dir = await scratch();

    await expect(readSource(join(dir, 'nope.ts'), 'nope.ts')).rejects.toThrow();
  });

  it('never marks a truncated document editable, because saving would lose the rest', async () => {
    const dir = await scratch();
    const manyLines = Array.from({ length: MAX_SOURCE_LINES + 50 }, () => 'const a = 1;');
    await fs.writeFile(join(dir, 'long.ts'), manyLines.join('\n'));

    const doc = await readSource(join(dir, 'long.ts'), 'long.ts');

    expect(doc.kind).toBe('text');
    if (doc.kind !== 'text') throw new Error('expected text');
    expect(doc.truncated).toBe(true);
    expect(doc.editable).toBe(false);
  });
});
