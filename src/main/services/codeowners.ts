import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface OwnerRule {
  pattern: string;
  owners: string[];
}

function globToRegExp(pattern: string): RegExp {
  const normalised = pattern.replaceAll('\\', '/');
  const escaped = normalised
    .replaceAll('.', '\\.')
    .replaceAll('**', '::DOUBLE::')
    .replaceAll('*', '[^/]*')
    .replaceAll('::DOUBLE::', '.*');
  const anchored = normalised.startsWith('/')
    ? `^${escaped.slice(1)}`
    : `(^|/)${escaped}`;
  return new RegExp(`${anchored}$`, 'i');
}

export function ownersForPath(rootPath: string, relativePath: string): string[] {
  let contents: string;
  try {
    contents = readFileSync(join(rootPath, 'CODEOWNERS'), 'utf8');
  } catch {
    try {
      contents = readFileSync(join(rootPath, '.github/CODEOWNERS'), 'utf8');
    } catch {
      try {
        contents = readFileSync(join(rootPath, 'docs/CODEOWNERS'), 'utf8');
      } catch {
        return [];
      }
    }
  }

  const rules: OwnerRule[] = [];
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    if (!pattern) continue;
    rules.push({ pattern, owners: parts.slice(1) });
  }

  const posix = relativePath.replaceAll('\\', '/');
  let owners: string[] = [];
  for (const rule of rules) {
    if (globToRegExp(rule.pattern).test(posix) || globToRegExp(rule.pattern).test(`/${posix}`)) {
      owners = rule.owners;
    }
  }
  return owners;
}
