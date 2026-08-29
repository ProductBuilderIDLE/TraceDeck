import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ValidationError,
  asObject,
  clampInt,
  expectVoid,
  optionalEnumArray,
  optionalInt,
  requireBoolean,
  requireEnum,
  requireInt,
  requireNonEmptyString,
  requireString,
  requireStringArray,
} from '@main/utils/validation';
import { parseNodeId } from '@shared/nodeIds';
import { resolveSafeProjectFile, resolveWithinProject } from '@main/utils/paths';

/**
 * The renderer is untrusted. These tests pin the boundary behaviour that stops a malformed or
 * hostile payload from reaching the database or the filesystem.
 */
describe('IPC payload validation', () => {
  it('rejects non-object payloads', () => {
    for (const value of [null, undefined, 42, 'text', [], true]) {
      expect(() => asObject(value)).toThrow(ValidationError);
    }
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
  });

  it('rejects non-integer and out-of-range numbers', () => {
    expect(() => requireInt('1', 'id', 1)).toThrow(ValidationError);
    expect(() => requireInt(1.5, 'id', 1)).toThrow(ValidationError);
    expect(() => requireInt(0, 'id', 1)).toThrow(ValidationError);
    expect(() => requireInt(Number.NaN, 'id', 1)).toThrow(ValidationError);
    expect(requireInt(7, 'id', 1)).toBe(7);
  });

  it('treats missing optional integers as undefined but still validates present ones', () => {
    expect(optionalInt(undefined, 'depth', 1)).toBeUndefined();
    expect(optionalInt(null, 'depth', 1)).toBeUndefined();
    expect(() => optionalInt(-3, 'depth', 1)).toThrow(ValidationError);
    expect(optionalInt(4, 'depth', 1)).toBe(4);
  });

  it('enforces string length limits', () => {
    expect(() => requireString('x'.repeat(5000), 'query', 4096)).toThrow(ValidationError);
    expect(() => requireNonEmptyString('   ', 'query')).toThrow(ValidationError);
    expect(requireNonEmptyString('ok', 'query')).toBe('ok');
  });

  it('rejects values outside an allowed enum', () => {
    expect(() => requireEnum('sideways', 'severity', ['low', 'high'] as const)).toThrow(
      ValidationError,
    );
    expect(requireEnum('high', 'severity', ['low', 'high'] as const)).toBe('high');
  });

  it('validates every element of an array', () => {
    expect(() => requireStringArray(['ok', 3], 'paths')).toThrow(ValidationError);
    expect(() => requireStringArray('not an array', 'paths')).toThrow(ValidationError);
    expect(() => requireStringArray(new Array(2000).fill('x'), 'paths', 100)).toThrow(
      ValidationError,
    );
    expect(requireStringArray(['a', 'b'], 'paths')).toEqual(['a', 'b']);
  });

  it('validates enum arrays element by element', () => {
    expect(() => optionalEnumArray(['import', 'nope'], 'edgeTypes', ['import'] as const)).toThrow(
      ValidationError,
    );
    expect(optionalEnumArray(undefined, 'edgeTypes', ['import'] as const)).toBeUndefined();
    expect(optionalEnumArray(['import'], 'edgeTypes', ['import'] as const)).toEqual(['import']);
  });

  it('requires booleans to actually be booleans', () => {
    expect(() => requireBoolean('true', 'enabled')).toThrow(ValidationError);
    expect(() => requireBoolean(1, 'enabled')).toThrow(ValidationError);
    expect(requireBoolean(false, 'enabled')).toBe(false);
  });

  it('rejects a payload on a channel that accepts none', () => {
    expect(() => expectVoid({ sneaky: true })).toThrow(ValidationError);
    expect(() => expectVoid(undefined)).not.toThrow();
  });

  it('clamps traversal depth into range', () => {
    expect(clampInt(999, 1, 25)).toBe(25);
    expect(clampInt(-4, 1, 25)).toBe(1);
    expect(clampInt(7, 1, 25)).toBe(7);
  });
});

describe('node id parsing', () => {
  it('accepts the three valid node shapes', () => {
    expect(parseNodeId('file:src/a.ts')).toEqual({ type: 'file', path: 'src/a.ts' });
    expect(parseNodeId('folder:src/lib')).toEqual({ type: 'folder', path: 'src/lib' });
    expect(parseNodeId('symbol:src/a.ts#doThing')).toEqual({
      type: 'symbol',
      path: 'src/a.ts',
      symbolName: 'doThing',
    });
  });

  it('rejects malformed node ids', () => {
    for (const value of ['', 'nonsense', 'file:', 'symbol:src/a.ts', 'symbol:#name', 'symbol:a.ts#']) {
      expect(parseNodeId(value)).toBeNull();
    }
  });

  it('splits a symbol name on the last hash so paths containing one still parse', () => {
    expect(parseNodeId('symbol:src/a#b.ts#doThing')).toEqual({
      type: 'symbol',
      path: 'src/a#b.ts',
      symbolName: 'doThing',
    });
  });
});

describe('path containment', () => {
  const root = process.platform === 'win32' ? 'C:\\projects\\demo' : '/projects/demo';

  it('resolves a path inside the project', () => {
    expect(() => resolveWithinProject(root, 'src/app.ts')).not.toThrow();
  });

  it('refuses a path that escapes the project root', () => {
    for (const attempt of ['../secrets.env', '../../etc/passwd', 'src/../../outside.ts']) {
      expect(() => resolveWithinProject(root, attempt)).toThrow(/outside the project/);
    }
  });

  it('refuses a sibling directory that merely shares a name prefix', () => {
    const sibling = process.platform === 'win32' ? '..\\demo-secrets\\a.ts' : '../demo-secrets/a.ts';
    expect(() => resolveWithinProject(root, sibling)).toThrow(/outside the project/);
  });
});

/**
 * Once writing is possible, lexical containment is no longer sufficient: a link inside the
 * project can point anywhere on the machine.
 */
/**
 * Creating a symlink needs elevated rights on Windows. Probing once lets the link guards
 * report as explicitly skipped rather than passing without ever executing — CI runs on
 * Linux, where they do run.
 */
const symlinksSupported = await (async () => {
  try {
    const from = await mkdtemp(join(tmpdir(), 'tracedeck-probe-'));
    const to = await mkdtemp(join(tmpdir(), 'tracedeck-probe-'));
    await writeFile(join(to, 't.txt'), 'x');
    await symlink(join(to, 't.txt'), join(from, 'l.txt'));
    await Promise.all([rm(from, { recursive: true, force: true }), rm(to, { recursive: true, force: true })]);
    return true;
  } catch {
    return false;
  }
})();

describe('resolveSafeProjectFile', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function scratch(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'tracedeck-safe-'));
    roots.push(root);
    return root;
  }

  it('resolves a regular file inside the project', async () => {
    const root = await scratch();
    await writeFile(join(root, 'a.ts'), 'x');

    await expect(resolveSafeProjectFile(root, 'a.ts')).resolves.toContain('a.ts');
  });

  it('refuses a traversal escape', async () => {
    const root = await scratch();

    await expect(resolveSafeProjectFile(root, '../outside.ts')).rejects.toThrow(/outside/i);
  });

  it('refuses a directory, which is not a regular file', async () => {
    const root = await scratch();
    await mkdir(join(root, 'sub'));

    await expect(resolveSafeProjectFile(root, 'sub')).rejects.toThrow(/regular file/i);
  });

  it('refuses a file that does not exist when existence is required', async () => {
    const root = await scratch();

    await expect(resolveSafeProjectFile(root, 'missing.ts')).rejects.toThrow(/no longer exists/i);
  });

  it.skipIf(!symlinksSupported)('refuses a symbolic link rather than following it', async () => {
    const root = await scratch();
    const outside = await scratch();
    await writeFile(join(outside, 'secret.txt'), 'private');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));

    await expect(resolveSafeProjectFile(root, 'link.txt')).rejects.toThrow(/link/i);
  });

  it.skipIf(!symlinksSupported)(
    'refuses a path whose real parent directory escapes the project',
    async () => {
      const root = await scratch();
      const outside = await scratch();
      await writeFile(join(outside, 'target.ts'), 'x');
      await symlink(outside, join(root, 'linked'), 'dir');

      // Lexically this is inside the project; really it is not.
      await expect(resolveSafeProjectFile(root, 'linked/target.ts')).rejects.toThrow(
        /outside the project/i,
      );
    },
  );
});
