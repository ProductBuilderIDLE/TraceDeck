import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import type { EditorConfigSettings } from '@shared/types';

const DEFAULTS: EditorConfigSettings = {
  indentStyle: 'space',
  indentSize: 2,
  endOfLine: 'lf',
};

function matchesGlob(pattern: string, relativePath: string): boolean {
  if (pattern === '*' || pattern === '**') return true;
  const escaped = pattern
    .replaceAll('.', '\\.')
    .replaceAll('**', '::DOUBLE::')
    .replaceAll('*', '[^/]*')
    .replaceAll('::DOUBLE::', '.*');
  return new RegExp(`^${escaped}$`, 'i').test(relativePath.replaceAll('\\', '/'));
}

export async function readEditorConfig(
  rootPath: string,
  relativePath: string,
): Promise<EditorConfigSettings> {
  const settings = { ...DEFAULTS };
  let directory = dirname(join(rootPath, relativePath));
  const root = rootPath.replace(/[\\/]+$/, '');

  while (directory.startsWith(root) || directory === root) {
    try {
      const contents = await fs.readFile(join(directory, '.editorconfig'), 'utf8');
      let currentSection: string | null = null;
      for (const raw of contents.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
        const section = /^\[(.+)\]$/.exec(line);
        if (section) {
          currentSection = section[1] ?? null;
          continue;
        }
        if (currentSection === null) continue;
        const posix = relativePath.replaceAll('\\', '/');
        if (!matchesGlob(currentSection, posix) && !matchesGlob(currentSection, posix.split('/').pop() ?? posix)) {
          continue;
        }
        const [key, ...rest] = line.split('=');
        const value = rest.join('=').trim().toLowerCase();
        if (key?.trim().toLowerCase() === 'indent_style' && (value === 'space' || value === 'tab')) {
          settings.indentStyle = value;
        }
        if (key?.trim().toLowerCase() === 'indent_size') {
          const size = Number(value);
          if (Number.isInteger(size) && size > 0 && size <= 16) settings.indentSize = size;
        }
        if (key?.trim().toLowerCase() === 'end_of_line' && (value === 'lf' || value === 'crlf')) {
          settings.endOfLine = value;
        }
      }
    } catch {
      // no file at this level
    }
    if (directory === root) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return settings;
}

export async function formatWithProjectPrettier(
  rootPath: string,
  relativePath: string,
  text: string,
): Promise<string | null> {
  try {
    const require = createRequire(join(rootPath, 'package.json'));
    const prettier = require('prettier') as {
      format: (source: string, options: { filepath: string }) => Promise<string> | string;
    };
    const formatted = await prettier.format(text, { filepath: join(rootPath, relativePath) });
    return formatted;
  } catch {
    return null;
  }
}

export async function formatSource(
  rootPath: string,
  relativePath: string,
  text: string,
): Promise<{ text: string; usedPrettier: boolean; editorConfig: EditorConfigSettings }> {
  const editorConfig = await readEditorConfig(rootPath, relativePath);
  const prettier = await formatWithProjectPrettier(rootPath, relativePath, text);
  if (prettier !== null) return { text: prettier, usedPrettier: true, editorConfig };

  const newline = editorConfig.endOfLine === 'crlf' ? '\r\n' : '\n';
  const indent = editorConfig.indentStyle === 'tab' ? '\t' : ' '.repeat(editorConfig.indentSize);
  const lines = text.split(/\r?\n/).map((line) => {
    const match = /^(\s*)(.*)$/.exec(line);
    if (!match) return line;
    const leading = match[1] ?? '';
    const rest = match[2] ?? '';
    const width = leading.replaceAll('\t', '  ').length;
    const units = Math.round(width / 2);
    return `${indent.repeat(units)}${rest}`;
  });
  return { text: lines.join(newline), usedPrettier: false, editorConfig };
}
