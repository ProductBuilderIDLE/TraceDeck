import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';

/**
 * Loads tree-sitter grammars compiled to WebAssembly.
 *
 * The TypeScript compiler can only parse the JavaScript/TypeScript family, so every other
 * language in a project contributes no dependency edges at all. tree-sitter fills that gap
 * with real grammars rather than regular expressions, which matters because an import can be
 * commented out, inside a string, or split across lines — cases a pattern match gets wrong in
 * exactly the direction that produces false edges.
 *
 * Grammars are `.wasm` files read from disk. Nothing is fetched: the files ship inside the
 * installed packages, so this stays fully offline. Vue, Svelte, and Astro keep using the
 * TypeScript path for their script regions; this runtime covers languages that path cannot
 * parse at all.
 */

export type TreeSitterLanguageId = 'html' | 'css' | 'python' | 'go' | 'rust';

const require = createRequire(import.meta.url);

function runtimeWasmPath(): string {
  return require.resolve('web-tree-sitter/web-tree-sitter.wasm');
}

/** Resolved lazily so a missing grammar is reported once, not on every file. */
const grammarPaths: Record<TreeSitterLanguageId, () => string> = {
  css: () => require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-css.wasm'),
  go: () => require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm'),
  html: () => require.resolve('tree-sitter-html/tree-sitter-html.wasm'),
  python: () => require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm'),
  rust: () => require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm'),
};

const parsers = new Map<TreeSitterLanguageId, Parser>();
const failures = new Map<TreeSitterLanguageId, string>();
let initialised: Promise<void> | null = null;

async function ensureInitialised(): Promise<void> {
  // Parser.init compiles the shared runtime once per process; concurrent scans must not
  // race it, so the promise itself is cached rather than a boolean flag.
  //
  // locateFile is required in Electron: the bundled main process is not next to the
  // `.wasm` file, so the default relative lookup fails and every grammar degrades to
  // text-only. The path is always a local install — never a URL.
  initialised ??= Parser.init({
    locateFile(scriptName: string) {
      return scriptName.endsWith('.wasm') ? runtimeWasmPath() : scriptName;
    },
  });
  await initialised;
}

/**
 * Returns a parser for the language, or null when its grammar could not be loaded.
 *
 * A load failure is recorded and returned as null rather than thrown: one unavailable grammar
 * must degrade that language's files to text-only, never abort the whole scan.
 */
export async function getParser(language: TreeSitterLanguageId): Promise<Parser | null> {
  const cached = parsers.get(language);
  if (cached) return cached;
  if (failures.has(language)) return null;

  try {
    await ensureInitialised();
    const grammar = await Language.load(grammarPaths[language]());
    const parser = new Parser();
    parser.setLanguage(grammar);
    parsers.set(language, parser);
    return parser;
  } catch (error) {
    failures.set(language, error instanceof Error ? error.message : 'unknown error');
    return null;
  }
}

/** Why a grammar is unavailable, for reporting as a scan limitation. */
export function grammarFailure(language: TreeSitterLanguageId): string | null {
  return failures.get(language) ?? null;
}

/** Frees every cached parser. Used by tests to keep runs independent. */
export function disposeParsers(): void {
  for (const parser of parsers.values()) parser.delete();
  parsers.clear();
  failures.clear();
}
