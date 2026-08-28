import { describe, expect, it } from 'vitest';
import { sourceLanguage } from '@shared/sourceLanguage';

describe('sourceLanguage', () => {
  it('maps JS/TS family to monaco languages', () => {
    expect(sourceLanguage('src/app.ts')).toBe('typescript');
    expect(sourceLanguage('src/Widget.tsx')).toBe('typescript');
    expect(sourceLanguage('src/legacy.js')).toBe('javascript');
    expect(sourceLanguage('src/legacy.jsx')).toBe('javascript');
  });

  it('maps web, data, and systems languages', () => {
    expect(sourceLanguage('index.html')).toBe('html');
    expect(sourceLanguage('App.vue')).toBe('html');
    expect(sourceLanguage('styles.css')).toBe('css');
    expect(sourceLanguage('main.py')).toBe('python');
    expect(sourceLanguage('cmd.go')).toBe('go');
    expect(sourceLanguage('lib.rs')).toBe('rust');
    expect(sourceLanguage('package.json')).toBe('json');
  });

  it('falls back to plaintext for unknown extensions', () => {
    expect(sourceLanguage('notes.weird')).toBe('plaintext');
    expect(sourceLanguage('.gitignore')).toBe('plaintext');
  });
});
