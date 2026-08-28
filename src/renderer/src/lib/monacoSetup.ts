import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { lineCompletion } from '@shared/bufferCompletion';
import { THEMES, type Theme, type ThemeId } from '@shared/theme';

function hex(channels: string): string {
  const parts = channels.trim().split(/\s+/).map(Number);
  return `#${parts.map((part) => Math.max(0, Math.min(255, part)).toString(16).padStart(2, '0')).join('')}`;
}

function fg(channels: string): string {
  return hex(channels).slice(1);
}

/**
 * VS Code Dark+ / Light+ token colours, so the editor reads as the same environment
 * developers already use. Editor chrome (background, line numbers) still follows TraceDeck.
 */
const VS_DARK_TOKENS: monaco.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '6A9955' },
  { token: 'keyword', foreground: '569CD6' },
  { token: 'number', foreground: 'B5CEA8' },
  { token: 'string', foreground: 'CE9178' },
  { token: 'regexp', foreground: 'D16969' },
  { token: 'type', foreground: '4EC9B0' },
  { token: 'class', foreground: '4EC9B0' },
  { token: 'interface', foreground: 'B8D7A3' },
  { token: 'function', foreground: 'DCDCAA' },
  { token: 'variable', foreground: '9CDCFE' },
  { token: 'identifier', foreground: '9CDCFE' },
  { token: 'delimiter', foreground: 'D4D4D4' },
  { token: 'tag', foreground: '569CD6' },
  { token: 'attribute.name', foreground: '9CDCFE' },
  { token: 'attribute.value', foreground: 'CE9178' },
  { token: 'metatag', foreground: '569CD6' },
];

const VS_LIGHT_TOKENS: monaco.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '008000' },
  { token: 'keyword', foreground: '0000FF' },
  { token: 'number', foreground: '098658' },
  { token: 'string', foreground: 'A31515' },
  { token: 'regexp', foreground: '811F3F' },
  { token: 'type', foreground: '267F99' },
  { token: 'class', foreground: '267F99' },
  { token: 'function', foreground: '795E26' },
  { token: 'variable', foreground: '001080' },
  { token: 'identifier', foreground: '001080' },
  { token: 'delimiter', foreground: '000000' },
  { token: 'tag', foreground: '800000' },
  { token: 'attribute.name', foreground: 'FF0000' },
  { token: 'attribute.value', foreground: '0000FF' },
];

function tokenRules(theme: Theme): monaco.editor.ITokenThemeRule[] {
  if (theme.id === 'vscode-light') return VS_LIGHT_TOKENS;
  if (theme.id === 'vscode-dark') return VS_DARK_TOKENS;

  const t = theme.tokens;
  return [
    { token: 'comment', foreground: fg(t['ink-faint']), fontStyle: 'italic' },
    { token: 'keyword', foreground: fg(t.brand) },
    { token: 'number', foreground: fg(t['risk-med']) },
    { token: 'string', foreground: fg(t['risk-low']) },
    { token: 'regexp', foreground: fg(t['risk-crit']) },
    { token: 'type', foreground: fg(t['risk-high']) },
    { token: 'class', foreground: fg(t['risk-high']) },
    { token: 'function', foreground: fg(t.brand) },
    { token: 'variable', foreground: fg(t.ink) },
    { token: 'identifier', foreground: fg(t.ink) },
    { token: 'delimiter', foreground: fg(t['ink-muted']) },
    { token: 'tag', foreground: fg(t.brand) },
    { token: 'attribute.name', foreground: fg(t['risk-high']) },
    { token: 'attribute.value', foreground: fg(t['risk-low']) },
  ];
}

function editorColors(theme: Theme): monaco.editor.IColors {
  const t = theme.tokens;
  const bg = hex(t['surface-1']);
  const ink = hex(t.ink);
  const faint = hex(t['ink-faint']);
  const muted = hex(t['ink-muted']);
  const brand = hex(t.brand);
  const edge = hex(t.edge);
  const select = hex(t['surface-3']);
  const line = hex(t['surface-2']);
  const crit = hex(t['risk-crit']);
  const med = hex(t['risk-med']);

  return {
    'editor.background': bg,
    'editor.foreground': ink,
    'editorLineNumber.foreground': faint,
    'editorLineNumber.activeForeground': muted,
    'editor.selectionBackground': select,
    'editor.inactiveSelectionBackground': line,
    'editor.lineHighlightBackground': line,
    'editorCursor.foreground': brand,
    'editorWhitespace.foreground': edge,
    'editorIndentGuide.background1': edge,
    'editorIndentGuide.activeBackground1': faint,
    'editorGutter.background': bg,
    'editorWidget.background': hex(t['surface-2']),
    'editorWidget.border': edge,
    'editorSuggestWidget.background': hex(t['surface-2']),
    'editorSuggestWidget.border': edge,
    'editorHoverWidget.background': hex(t['surface-2']),
    'editorHoverWidget.border': edge,
    'editor.findMatchBackground': med,
    'editor.findMatchHighlightBackground': select,
    'editorOverviewRuler.border': edge,
    'editorError.foreground': crit,
    'editorWarning.foreground': med,
    'minimap.background': bg,
    'scrollbarSlider.background': hex(t['surface-4']),
    'scrollbarSlider.hoverBackground': faint,
    focusBorder: brand,
  };
}

function defineAppThemes(): void {
  for (const theme of Object.values(THEMES)) {
    monaco.editor.defineTheme(theme.id, {
      base: theme.appearance === 'light' ? 'vs' : 'vs-dark',
      inherit: true,
      rules: tokenRules(theme),
      colors: editorColors(theme),
    });
  }
}

let configured = false;

/**
 * Workers and language defaults are process-global. Call once before creating an editor.
 *
 * Semantic validation is off: Monaco's TypeScript worker does not have the project, so its
 * squiggles would contradict TraceDeck's own scan. Colouring still comes from the tokenizer.
 */
export function configureMonaco(): void {
  if (configured) return;
  configured = true;

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      if (label === 'json') return new JsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
      if (label === 'typescript' || label === 'javascript') return new TsWorker();
      return new EditorWorker();
    },
  };

  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
    jsx: monaco.languages.typescript.JsxEmit.React,
    allowJs: true,
    target: monaco.languages.typescript.ScriptTarget.ESNext,
  });
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    jsx: monaco.languages.typescript.JsxEmit.React,
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    module: monaco.languages.typescript.ModuleKind.ESNext,
  });
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: false });

  monaco.languages.registerInlineCompletionsProvider('*', {
    provideInlineCompletions(model, position) {
      const lines = model.getLinesContent();
      const rest = lineCompletion(lines, position.lineNumber - 1, position.column - 1);
      if (!rest) return { items: [] };
      return {
        items: [
          {
            insertText: rest,
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column,
            ),
          },
        ],
      };
    },
    freeInlineCompletions() {
      /* nothing to dispose */
    },
  });

  defineAppThemes();
}

export function applyMonacoTheme(themeId: ThemeId): void {
  configureMonaco();
  monaco.editor.setTheme(themeId);
}

export { monaco };
