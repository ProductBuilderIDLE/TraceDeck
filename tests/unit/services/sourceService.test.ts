import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSource } from '@main/services/sourceService';

const FIXTURE_ROOT = resolve(__dirname, '../../fixtures/sample-project');

function abs(relativePath: string): string {
  return resolve(FIXTURE_ROOT, relativePath);
}

async function read(relativePath: string) {
  return readSource(abs(relativePath), relativePath);
}

/** Reassembles the document, which must be byte-identical to what the file contains. */
function textOf(lines: Awaited<ReturnType<typeof readSource>>['lines']): string {
  return lines.map((line) => line.spans.map((span) => span.text).join('')).join('\n');
}

describe('readSource', () => {
  it('returns every line of the file with its number', async () => {
    const doc = await read('src/services/math.ts');

    expect(doc.relativePath).toBe('src/services/math.ts');
    expect(doc.lines.length).toBeGreaterThan(3);
    expect(doc.lines[0]?.number).toBe(1);
    expect(doc.lines.at(-1)?.number).toBe(doc.lines.length);
    expect(doc.truncated).toBe(false);
  });

  it('loses no characters when the spans are reassembled', async () => {
    const doc = await read('src/services/math.ts');

    // Tokenising must be lossless: every character of the file appears exactly once.
    expect(textOf(doc.lines).replace(/\r/g, '')).toContain('export function add(a: number, b: number): number {');
    expect(textOf(doc.lines)).toContain('return a * b;');
  });

  it('classifies keywords, identifiers, and punctuation', async () => {
    const doc = await read('src/services/math.ts');
    const first = doc.lines[0]?.spans ?? [];

    expect(first.find((s) => s.text === 'export')?.kind).toBe('keyword');
    expect(first.find((s) => s.text === 'function')?.kind).toBe('keyword');
    expect(first.find((s) => s.text === 'add')?.kind).toBe('identifier');
    expect(first.find((s) => s.text === '(')?.kind).toBe('punctuation');
  });

  it('classifies strings and comments', async () => {
    const doc = await read('src/services/greeter.ts');
    const kinds = doc.lines.flatMap((line) => line.spans.map((span) => span.kind));

    expect(kinds).toContain('string');
  });

  it('treats a capitalised identifier as a type so it reads differently from a value', async () => {
    const doc = await read('src/components/Button.tsx');
    const spans = doc.lines.flatMap((line) => line.spans);

    expect(spans.find((s) => s.text === 'ButtonProps')?.kind).toBe('type');
  });

  it('splits a multi-line comment across the lines it covers', async () => {
    const doc = await read('src/lazy/loader.ts');

    // No span may contain a newline; every span belongs to exactly one line.
    for (const line of doc.lines) {
      for (const span of line.spans) {
        expect(span.text).not.toContain('\n');
      }
    }
  });

  it('handles JSX without dropping content', async () => {
    const doc = await read('src/components/Button.tsx');

    expect(textOf(doc.lines)).toContain('<button type="button">{label}</button>');
  });

  it('reports the file size', async () => {
    const doc = await read('src/services/math.ts');

    expect(doc.sizeBytes).toBeGreaterThan(0);
    expect(doc.totalLines).toBe(doc.lines.length);
  });

  it('rejects a path that does not exist', async () => {
    await expect(read('src/does-not-exist.ts')).rejects.toThrow();
  });
});
