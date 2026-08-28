import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import type { LineMark } from '@shared/sourceMarkers';
import { sourceLanguage } from '@shared/sourceLanguage';
import type { ThemeId } from '@shared/theme';
import { applyMonacoTheme, configureMonaco, monaco } from '../../lib/monacoSetup';
import 'monaco-editor/min/vs/editor/editor.main.css';

export function SourceEditor({
  path,
  value,
  readOnly,
  marks,
  revealLine,
  themeId,
  tabSize = 2,
  insertSpaces = true,
  onChange,
  onSave,
}: {
  path: string;
  value: string;
  readOnly: boolean;
  marks: Map<number, LineMark>;
  revealLine: number | null;
  themeId: ThemeId;
  tabSize?: number;
  insertSpaces?: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    configureMonaco();
    applyMonacoTheme(themeId);

    const editor = monaco.editor.create(host, {
      value,
      language: sourceLanguage(path),
      readOnly,
      theme: themeId,
      automaticLayout: true,
      fontFamily: "Cascadia Code, Consolas, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 20,
      tabSize,
      insertSpaces,
      detectIndentation: false,
      wordWrap: 'off',
      minimap: { enabled: true, maxColumn: 80, showSlider: 'mouseover' },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      matchBrackets: 'always',
      folding: true,
      glyphMargin: true,
      lineNumbers: 'on',
      padding: { top: 4, bottom: 4 },
      contextmenu: true,
      links: false,
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      parameterHints: { enabled: false },
      wordBasedSuggestions: 'off',
      inlineSuggest: { enabled: false },
      hover: { enabled: true },
      find: { addExtraSpaceOnTop: false, autoFindInSelection: 'never' },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      overviewRulerLanes: 3,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      cursorBlinking: 'blink',
      cursorStyle: 'line',
      mouseWheelZoom: true,
      ariaLabel: readOnly ? `Source ${path}` : `Edit ${path}`,
    });

    editorRef.current = editor;

    editor.onDidChangeModelContent(() => {
      if (editor.getOption(monaco.editor.EditorOption.readOnly)) return;
      changeRef.current(editor.getValue());
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveRef.current();
    });
    editor.addCommand(monaco.KeyCode.F8, () => {
      const lines = [...marksRef.current.keys()].sort((a, b) => a - b);
      if (lines.length === 0) return;
      const current = editor.getPosition()?.lineNumber ?? 0;
      const next = lines.find((line) => line > current) ?? lines[0];
      if (next === undefined) return;
      editor.revealLineInCenter(next);
      editor.setPosition({ lineNumber: next, column: 1 });
    });

    return () => {
      editorRef.current = null;
      editor.dispose();
    };
    // Created once; path/value/theme are synced in the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    applyMonacoTheme(themeId);
  }, [themeId]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions({
      readOnly,
      domReadOnly: readOnly,
      contextmenu: !readOnly,
      mouseWheelZoom: !readOnly,
      tabSize,
      insertSpaces,
      quickSuggestions: readOnly ? false : { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: !readOnly,
      wordBasedSuggestions: readOnly ? 'off' : 'currentDocument',
      inlineSuggest: { enabled: !readOnly },
      ariaLabel: readOnly ? `Source ${path}` : `Edit ${path}`,
    });
  }, [readOnly, path, tabSize, insertSpaces]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const language = sourceLanguage(path);
    let model = editor.getModel();
    const uri = monaco.Uri.parse(`inmemory://tracedeck/${encodeURIComponent(path)}`);
    const existing = monaco.editor.getModel(uri);

    if (!model || model.uri.toString() !== uri.toString()) {
      if (existing) {
        editor.setModel(existing);
        model = existing;
      } else {
        model = monaco.editor.createModel(value, language, uri);
        editor.setModel(model);
      }
    }

    monaco.editor.setModelLanguage(model, language);
    if (model.getValue() !== value) {
      model.setValue(value);
    }
  }, [path, value]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const next: monaco.editor.IModelDeltaDecoration[] = [];
    for (const [line, mark] of marks) {
      const conflict = mark.kind === 'conflict';
      next.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: conflict ? 'td-mark-conflict' : 'td-mark-broken',
          linesDecorationsClassName: conflict ? 'td-gutter-conflict' : 'td-gutter-broken',
          overviewRuler: {
            color: conflict ? 'rgb(224 175 104)' : 'rgb(247 118 142)',
            position: monaco.editor.OverviewRulerLane.Left,
          },
          glyphMarginClassName: conflict ? 'td-glyph-conflict' : 'td-glyph-broken',
          hoverMessage: { value: mark.titles.join('\n') },
        },
      });
    }

    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, next);
  }, [marks]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || revealLine === null || revealLine < 1) return;
    editor.revealLineInCenter(revealLine);
    editor.setPosition({ lineNumber: revealLine, column: 1 });
  }, [revealLine, path]);

  return (
    <div className={clsx('relative h-full min-h-0 w-full', readOnly && 'td-source-dim')}>
      <div ref={hostRef} className="td-source-editor h-full min-h-0 w-full" />
      {readOnly && (
        <div
          className="td-source-lock-veil"
          title="Unlock to edit"
          onWheel={(event) => {
            event.preventDefault();
            const editor = editorRef.current;
            if (!editor) return;
            editor.setScrollTop(editor.getScrollTop() + event.deltaY);
            editor.setScrollLeft(editor.getScrollLeft() + event.deltaX);
          }}
        />
      )}
    </div>
  );
}
