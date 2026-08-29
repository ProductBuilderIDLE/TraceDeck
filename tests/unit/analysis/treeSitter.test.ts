import { afterAll, describe, expect, it } from 'vitest';
import { parseWithTreeSitter, treeSitterLanguageFor } from '@main/analysis/treeSitter';
import { disposeParsers } from '@main/analysis/treeSitter/runtime';

afterAll(() => disposeParsers());

async function specifiers(path: string, text: string): Promise<string[]> {
  const parsed = await parseWithTreeSitter(path, text);
  return (parsed?.imports ?? []).map((entry) => entry.specifier);
}

describe('language selection', () => {
  it('claims HTML, CSS, Python, Go, and Rust, and leaves JS/TS to the TypeScript path', () => {
    expect(treeSitterLanguageFor('index.html')).toBe('html');
    expect(treeSitterLanguageFor('page.HTM')).toBe('html');
    expect(treeSitterLanguageFor('style.css')).toBe('css');
    expect(treeSitterLanguageFor('app.py')).toBe('python');
    expect(treeSitterLanguageFor('main.go')).toBe('go');
    expect(treeSitterLanguageFor('lib.rs')).toBe('rust');
    expect(treeSitterLanguageFor('app.ts')).toBeNull();
    expect(treeSitterLanguageFor('Widget.vue')).toBeNull();
    expect(treeSitterLanguageFor('README.md')).toBeNull();
  });
});

describe('HTML references', () => {
  it('finds scripts and stylesheets', async () => {
    const html = [
      '<html><head>',
      '<link rel="stylesheet" href="style.css">',
      '</head><body>',
      '<script src="app.js"></script>',
      '</body></html>',
    ].join('\n');

    expect(await specifiers('index.html', html)).toEqual(['style.css', 'app.js']);
  });

  it('records the line each reference appears on', async () => {
    const parsed = await parseWithTreeSitter(
      'index.html',
      '<html>\n<body>\n<script src="app.js"></script>\n</body>\n</html>',
    );

    expect(parsed?.imports[0]?.line).toBe(3);
  });

  it('ignores remote and inline sources, which are not project files', async () => {
    const html = [
      '<script src="https://cdn.example.com/lib.js"></script>',
      '<script src="//cdn.example.com/other.js"></script>',
      '<img src="data:image/png;base64,AAAA">',
      '<script src="local.js"></script>',
    ].join('\n');

    expect(await specifiers('index.html', html)).toEqual(['local.js']);
  });

  it('ignores anchors, because navigation is not a dependency', async () => {
    const html = '<a href="about.html">About</a><link rel="stylesheet" href="s.css">';

    expect(await specifiers('index.html', html)).toEqual(['s.css']);
  });

  it('ignores an inline script with no src', async () => {
    expect(await specifiers('index.html', '<script>const a = 1;</script>')).toEqual([]);
  });

  it('strips a query string or fragment from the path', async () => {
    const html = '<script src="app.js?v=2"></script><link rel="stylesheet" href="s.css#top">';

    expect(await specifiers('index.html', html)).toEqual(['app.js', 's.css']);
  });

  it('does not mistake a src written inside a comment for a real reference', async () => {
    const html = '<!-- <script src="ghost.js"></script> --><script src="real.js"></script>';

    expect(await specifiers('index.html', html)).toEqual(['real.js']);
  });

  it('recovers from malformed markup and reports the uncertainty', async () => {
    const parsed = await parseWithTreeSitter(
      'broken.html',
      '<div><span><script src="app.js"></script>',
    );

    expect(parsed?.imports.map((i) => i.specifier)).toContain('app.js');
  });
});

describe('CSS references', () => {
  it('finds quoted and url() imports', async () => {
    const css = ['@import "base.css";', '@import url("theme.css");'].join('\n');

    expect(await specifiers('style.css', css)).toEqual(['base.css', 'theme.css']);
  });

  it('finds assets referenced through url()', async () => {
    const css = '.hero { background: url("hero.png"); }';

    expect(await specifiers('style.css', css)).toEqual(['hero.png']);
  });

  it('handles an unquoted url()', async () => {
    expect(await specifiers('style.css', '.a { background: url(bg.png); }')).toEqual(['bg.png']);
  });

  it('ignores remote and data URLs', async () => {
    const css = [
      '@import url("https://fonts.example.com/x.css");',
      '.a { background: url(data:image/gif;base64,AAAA); }',
      '.b { background: url("local.png"); }',
    ].join('\n');

    expect(await specifiers('style.css', css)).toEqual(['local.png']);
  });

  it('does not report a url written inside a comment', async () => {
    const css = '/* url("ghost.png") */ .a { background: url("real.png"); }';

    expect(await specifiers('style.css', css)).toEqual(['real.png']);
  });

  it('reports each @import exactly once', async () => {
    const found = await specifiers('style.css', '@import url("a.css");');

    expect(found).toEqual(['a.css']);
  });

  it('finds nothing in a stylesheet with no references', async () => {
    expect(await specifiers('style.css', 'body { color: red; }')).toEqual([]);
  });
});

describe('Python references', () => {
  it('converts relative imports into file paths and leaves absolute imports as modules', async () => {
    const source = [
      'import os',
      'from . import helper',
      'from .pkg.util import thing',
      'from ..shared import config',
      'from collections.abc import Mapping',
    ].join('\n');

    expect(await specifiers('src/app.py', source)).toEqual([
      'os',
      './helper',
      './pkg/util',
      '../shared',
      'collections.abc',
    ]);
  });

  it('does not treat a commented-out import as a real reference', async () => {
    expect(await specifiers('app.py', '# from .ghost import x\nfrom .real import y')).toEqual([
      './real',
    ]);
  });
});

describe('Go references', () => {
  it('extracts grouped and single imports, including relative paths', async () => {
    const source = [
      'package main',
      'import "fmt"',
      'import (',
      '\t"net/http"',
      '\talias "os"',
      '\t"./local"',
      '\t"github.com/user/repo/pkg"',
      ')',
    ].join('\n');

    expect(await specifiers('main.go', source)).toEqual([
      'fmt',
      'net/http',
      'os',
      './local',
      'github.com/user/repo/pkg',
    ]);
  });

  it('does not treat a commented-out import as a real reference', async () => {
    const source = ['package main', '// import "./ghost"', 'import "./real"'].join('\n');

    expect(await specifiers('main.go', source)).toEqual(['./real']);
  });
});

describe('Rust references', () => {
  it('maps mod declarations from a crate root onto sibling files', async () => {
    const source = ['mod foo;', 'mod bar { }', 'use serde::Deserialize;', 'include!("generated.rs");'].join(
      '\n',
    );

    expect(await specifiers('src/lib.rs', source)).toEqual(['./foo', 'serde', 'generated.rs']);
  });

  it('maps a nested file-module onto a subdirectory', async () => {
    expect(await specifiers('src/foo.rs', 'mod bar;')).toEqual(['./foo/bar']);
  });

  it('maps crate, super, and self paths relative to the current file', async () => {
    expect(await specifiers('src/foo/bar.rs', 'use crate::internal::util;')).toEqual([
      '../internal',
    ]);
    expect(await specifiers('src/foo/bar.rs', 'use super::sibling;')).toEqual(['./sibling']);
    expect(await specifiers('src/foo/mod.rs', 'use super::sibling;')).toEqual(['../sibling']);
    expect(await specifiers('src/foo.rs', 'use self::nested::x;')).toEqual(['./foo/nested']);
  });

  it('does not treat a commented-out mod as a real reference', async () => {
    expect(await specifiers('src/lib.rs', '// mod ghost;\nmod real;')).toEqual(['./real']);
  });
});

describe('determinism', () => {
  it('returns the same references across repeated parses', async () => {
    const html = '<link rel="stylesheet" href="a.css"><script src="b.js"></script>';

    expect(await specifiers('index.html', html)).toEqual(await specifiers('index.html', html));
  });
});
