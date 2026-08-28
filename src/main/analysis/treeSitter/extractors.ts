import { posix } from 'node:path';
import type { Node } from 'web-tree-sitter';

export interface ExtractedReference {
  specifier: string;
  line: number;
}

/** Walks every node in the tree, depth-first, in source order. */
function* walk(node: Node): Generator<Node> {
  yield node;
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (child) yield* walk(child);
  }
}

/** A specifier that names a remote resource or inline data is not a project file. */
function isProjectRelative(specifier: string): boolean {
  const trimmed = specifier.trim();
  if (trimmed.length === 0) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false; // http:, https:, data:, mailto:
  if (trimmed.startsWith('//')) return false; // protocol-relative
  if (trimmed.startsWith('#')) return false; // in-page fragment
  return true;
}

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && /^["'`]/u.test(trimmed) && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Drops a query string or fragment, which are addressing, not part of the path. */
function cleanSpecifier(specifier: string): string {
  return stripQuotes(specifier).split(/[?#]/)[0] ?? '';
}

/** Returns the first named child of the given type, or null. */
function childOfType(node: Node, type: string): Node | null {
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (child?.type === type) return child;
  }
  return null;
}

function posixPath(relativePath: string): string {
  return relativePath.replaceAll('\\', '/');
}

/**
 * Reads the literal text a value node carries.
 *
 * The CSS grammar nests the actual characters inside a string_content node, so reading the
 * string_value wrapper directly would include the surrounding quotes.
 */
function valueText(node: Node): string {
  if (node.type === 'string_value') {
    return (childOfType(node, 'string_content') ?? node).text;
  }
  return node.text;
}

/** Unwraps url(...) and @import url(...) to the node holding the target. */
function callArgument(call: Node): Node | null {
  const args = childOfType(call, 'arguments');
  if (!args) return null;
  for (let index = 0; index < args.namedChildCount; index += 1) {
    const child = args.namedChild(index);
    if (child && (child.type === 'string_value' || child.type === 'plain_value')) return child;
  }
  return null;
}

function attributeValue(tag: Node, wanted: string): { value: string; line: number } | null {
  for (let index = 0; index < tag.namedChildCount; index += 1) {
    const attribute = tag.namedChild(index);
    if (!attribute || attribute.type !== 'attribute') continue;

    const name = attribute.namedChild(0);
    if (!name || name.text.toLowerCase() !== wanted) continue;

    for (let inner = 1; inner < attribute.namedChildCount; inner += 1) {
      const holder = attribute.namedChild(inner);
      if (!holder) continue;
      // Values appear either quoted (with a nested attribute_value) or bare.
      const value = holder.type === 'quoted_attribute_value' ? holder.namedChild(0) : holder;
      if (value) return { value: value.text, line: attribute.startPosition.row + 1 };
    }
  }
  return null;
}

function pushUnique(found: ExtractedReference[], specifier: string, line: number): void {
  if (found.some((entry) => entry.specifier === specifier && entry.line === line)) return;
  found.push({ specifier, line });
}

/**
 * Extracts the files an HTML document actually depends on.
 *
 * Only `src` and `href` on the elements that load code or styles are followed. `href` on an
 * anchor is navigation, not a dependency, so anchors are deliberately excluded — treating
 * them as edges would fill the graph with links to pages rather than real module structure.
 */
export function extractHtmlReferences(root: Node): ExtractedReference[] {
  const found: ExtractedReference[] = [];

  for (const node of walk(root)) {
    if (node.type !== 'start_tag' && node.type !== 'self_closing_tag') continue;

    const tagName = node.namedChild(0);
    if (!tagName || tagName.type !== 'tag_name') continue;
    const tag = tagName.text.toLowerCase();

    let attribute: string | null = null;
    if (tag === 'script' || tag === 'img' || tag === 'iframe' || tag === 'source') {
      attribute = 'src';
    } else if (tag === 'link') {
      attribute = 'href';
    }
    if (!attribute) continue;

    const raw = attributeValue(node, attribute);
    if (!raw) continue;

    const specifier = cleanSpecifier(raw.value);
    if (isProjectRelative(specifier)) found.push({ specifier, line: raw.line });
  }

  return found;
}

/**
 * Extracts the files a stylesheet depends on: `@import` targets and `url()` references.
 *
 * `url()` is included because a stylesheet genuinely cannot render without the assets it
 * names, and those assets are inventoried project files.
 */
export function extractCssReferences(root: Node): ExtractedReference[] {
  const found: ExtractedReference[] = [];

  for (const node of walk(root)) {
    if (node.type === 'import_statement') {
      // Either a bare string, or the target wrapped in url().
      const direct = childOfType(node, 'string_value');
      const call = childOfType(node, 'call_expression');
      const target = direct ?? (call ? callArgument(call) : null);
      if (!target) continue;

      const specifier = cleanSpecifier(valueText(target));
      if (isProjectRelative(specifier)) {
        found.push({ specifier, line: node.startPosition.row + 1 });
      }
      continue;
    }

    if (node.type === 'call_expression') {
      const name = childOfType(node, 'function_name');
      if (!name || name.text.toLowerCase() !== 'url') continue;
      // The call inside an @import is handled above; counting it here would duplicate it.
      if (node.parent?.type === 'import_statement') continue;

      const target = callArgument(node);
      if (!target) continue;

      const specifier = cleanSpecifier(valueText(target));
      if (isProjectRelative(specifier)) {
        found.push({ specifier, line: node.startPosition.row + 1 });
      }
    }
  }

  return found;
}

function dottedModuleName(node: Node): string {
  if (node.type === 'aliased_import') {
    return childOfType(node, 'dotted_name')?.text ?? node.text;
  }
  return node.text;
}

/** Converts `from ..pkg.mod import x` into a resolver-friendly relative path. */
function pythonRelativePath(dotCount: number, moduleName: string | null): string {
  const base = dotCount <= 1 ? '.' : Array.from({ length: dotCount - 1 }, () => '..').join('/');
  if (!moduleName) return base;
  const rest = moduleName.replaceAll('.', '/');
  return `${base}/${rest}`;
}

function pythonImportedModules(statement: Node): string[] {
  const names: string[] = [];
  for (let index = 0; index < statement.namedChildCount; index += 1) {
    const child = statement.namedChild(index);
    if (!child) continue;
    if (child.type === 'relative_import') continue;
    if (child.type === 'wildcard_import') continue;
    if (child.type === 'dotted_name' || child.type === 'aliased_import') {
      names.push(dottedModuleName(child));
    }
  }
  return names;
}

/**
 * Extracts Python imports.
 *
 * Only relative imports become file paths: `from .foo import bar` is `./foo`, which the
 * existing resolver can probe. Absolute imports (`import os`, `from pkg.mod import x`) are
 * left as module names so they surface as external packages rather than invented files.
 * `from . import local` is the exception — the imported name *is* the sibling module.
 */
export function extractPythonReferences(root: Node): ExtractedReference[] {
  const found: ExtractedReference[] = [];

  for (const node of walk(root)) {
    if (node.type === 'import_statement') {
      for (let index = 0; index < node.namedChildCount; index += 1) {
        const child = node.namedChild(index);
        if (!child) continue;
        if (child.type !== 'dotted_name' && child.type !== 'aliased_import') continue;
        pushUnique(found, dottedModuleName(child), node.startPosition.row + 1);
      }
      continue;
    }

    if (node.type !== 'import_from_statement') continue;

    const relative = childOfType(node, 'relative_import');
    const line = node.startPosition.row + 1;

    if (relative) {
      const dots = childOfType(relative, 'import_prefix')?.text.length ?? 1;
      const relativeModule = childOfType(relative, 'dotted_name')?.text ?? null;
      if (relativeModule) {
        pushUnique(found, pythonRelativePath(dots, relativeModule), line);
      } else {
        for (const name of pythonImportedModules(node)) {
          pushUnique(found, pythonRelativePath(dots, name), line);
        }
      }
      continue;
    }

    const absoluteModule = childOfType(node, 'dotted_name');
    if (absoluteModule) pushUnique(found, absoluteModule.text, line);
  }

  return found;
}

function goImportPath(spec: Node): string | null {
  const interpreted = childOfType(spec, 'interpreted_string_literal');
  const raw = childOfType(spec, 'raw_string_literal');
  const literal = interpreted ?? raw;
  if (!literal) return null;
  const content =
    childOfType(literal, 'interpreted_string_literal_content') ??
    childOfType(literal, 'raw_string_literal_content');
  const value = stripQuotes(content?.text ?? literal.text);
  return value.length > 0 ? value : null;
}

/**
 * Extracts Go import paths from both single-import and grouped import declarations.
 *
 * Relative paths (`./local`) stay relative. Everything else is left as the import path so
 * standard library and module imports are reported as external rather than guessed at.
 */
export function extractGoReferences(root: Node): ExtractedReference[] {
  const found: ExtractedReference[] = [];

  for (const node of walk(root)) {
    if (node.type !== 'import_spec') continue;
    const specifier = goImportPath(node);
    if (!specifier) continue;
    pushUnique(found, specifier, node.startPosition.row + 1);
  }

  return found;
}

function rustCrateDir(relativePath: string): string {
  const path = posixPath(relativePath);
  const marker = '/src/';
  const index = path.lastIndexOf(marker);
  if (index >= 0) return path.slice(0, index + 4);
  if (path.startsWith('src/')) return 'src';
  const directory = posix.dirname(path);
  return directory === '.' ? '' : directory;
}

function rustRelativeTo(fromFile: string, target: string): string {
  const fromDir = posix.dirname(posixPath(fromFile));
  let relative = posix.relative(fromDir === '.' ? '' : fromDir, target);
  if (relative.length === 0) relative = '.';
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative;
}

function rustModSpecifier(relativePath: string, modName: string): string {
  const path = posixPath(relativePath);
  const file = posix.basename(path);
  if (file === 'mod.rs' || file === 'lib.rs' || file === 'main.rs') return `./${modName}`;
  const stem = file.replace(/\.rs$/i, '');
  return `./${stem}/${modName}`;
}

function rustUseRoot(pathNode: Node): Node | null {
  let current: Node | null = pathNode;
  while (current) {
    if (
      current.type === 'identifier' ||
      current.type === 'super' ||
      current.type === 'crate' ||
      current.type === 'self'
    ) {
      return current;
    }
    current = current.namedChild(0);
  }
  return null;
}

function rustNextSegment(keyword: Node): string | null {
  const parent = keyword.parent;
  if (!parent) return null;
  const next = parent.namedChild(1);
  return next?.type === 'identifier' ? next.text : null;
}

function rustUseSpecifier(pathNode: Node, relativePath: string): string | null {
  const root = rustUseRoot(pathNode);
  if (!root) return null;
  const file = posix.basename(posixPath(relativePath));

  if (root.type === 'crate' || root.text === 'crate') {
    const segment = rustNextSegment(root);
    if (!segment) return null;
    const crateDir = rustCrateDir(relativePath);
    const target = crateDir.length > 0 ? posix.join(crateDir, segment) : segment;
    return rustRelativeTo(relativePath, target);
  }

  if (root.type === 'super' || root.text === 'super') {
    const segment = rustNextSegment(root);
    if (!segment) return null;
    if (file === 'lib.rs' || file === 'main.rs') return null;
    return file === 'mod.rs' ? `../${segment}` : `./${segment}`;
  }

  if (root.type === 'self' || root.text === 'self') {
    const segment = rustNextSegment(root);
    if (!segment) return null;
    if (file === 'mod.rs' || file === 'lib.rs' || file === 'main.rs') return `./${segment}`;
    const stem = file.replace(/\.rs$/i, '');
    return `./${stem}/${segment}`;
  }

  return root.text;
}

function rustIncludePath(invocation: Node): string | null {
  const name = invocation.namedChild(0);
  if (!name || name.text !== 'include') return null;
  for (const node of walk(invocation)) {
    if (node.type !== 'string_literal' && node.type !== 'raw_string_literal') continue;
    const content = childOfType(node, 'string_content') ?? childOfType(node, 'raw_string_literal_content');
    const specifier = cleanSpecifier(content?.text ?? node.text);
    return specifier.length > 0 ? specifier : null;
  }
  return null;
}

/**
 * Extracts the files a Rust source file declares as modules or includes.
 *
 * `mod foo;` follows Rust's file-module layout. `use crate::` / `use super::` / `use self::`
 * become relative paths. Other `use` roots are crate names and stay external. Inline
 * `mod foo { ... }` bodies live in this file, so they do not produce an edge.
 */
export function extractRustReferences(root: Node, relativePath: string): ExtractedReference[] {
  const found: ExtractedReference[] = [];

  for (const node of walk(root)) {
    if (node.type === 'mod_item') {
      if (childOfType(node, 'declaration_list')) continue;
      const identifier = childOfType(node, 'identifier');
      if (!identifier) continue;
      pushUnique(
        found,
        rustModSpecifier(relativePath, identifier.text),
        node.startPosition.row + 1,
      );
      continue;
    }

    if (node.type === 'use_declaration') {
      let pathNode = node.namedChild(0);
      if (pathNode?.type === 'visibility_modifier') pathNode = node.namedChild(1);
      if (!pathNode) continue;
      const specifier = rustUseSpecifier(pathNode, relativePath);
      if (specifier) pushUnique(found, specifier, node.startPosition.row + 1);
      continue;
    }

    if (node.type === 'macro_invocation') {
      const specifier = rustIncludePath(node);
      if (specifier && isProjectRelative(specifier)) {
        pushUnique(found, specifier, node.startPosition.row + 1);
      }
    }
  }

  return found;
}
