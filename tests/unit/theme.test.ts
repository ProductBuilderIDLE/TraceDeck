import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME_ID,
  THEMES,
  THEME_IDS,
  THEME_TOKEN_NAMES,
  getTheme,
  isThemeId,
  themeAppearance,
  themeWindowBackground,
} from '@shared/theme';

const CSS_PATH = resolve(__dirname, '../../src/renderer/src/styles/globals.css');

describe('theme definitions', () => {
  it('defines every token for every theme', () => {
    for (const id of THEME_IDS) {
      const theme = getTheme(id);
      for (const token of THEME_TOKEN_NAMES) {
        expect(theme.tokens[token], `${id} is missing --${token}`).toBeDefined();
      }
    }
  });

  it('stores tokens as three space-separated channels in range', () => {
    for (const id of THEME_IDS) {
      for (const token of THEME_TOKEN_NAMES) {
        const value = getTheme(id).tokens[token];
        const channels = value.split(' ').map(Number);

        expect(channels, `${id} --${token} = "${value}"`).toHaveLength(3);
        for (const channel of channels) {
          expect(Number.isInteger(channel)).toBe(true);
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it('ships both dark and light options', () => {
    const appearances = THEME_IDS.map((id) => themeAppearance(id));

    expect(appearances).toContain('dark');
    expect(appearances).toContain('light');
  });

  it('keeps text and background far enough apart to be readable', () => {
    // Relative luminance per WCAG, used only as a floor against an unreadable palette.
    const luminance = (channels: string): number => {
      const [r, g, b] = channels.split(' ').map((value) => {
        const channel = Number(value) / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    const contrast = (a: string, b: string): number => {
      const first = luminance(a);
      const second = luminance(b);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };

    for (const id of THEME_IDS) {
      const { tokens } = getTheme(id);

      expect(contrast(tokens.ink, tokens['surface-0']), `${id} body text`).toBeGreaterThan(7);
      expect(contrast(tokens['ink-muted'], tokens['surface-1']), `${id} muted text`).toBeGreaterThan(3.5);
      expect(contrast(tokens.brand, tokens['surface-1']), `${id} accent`).toBeGreaterThan(3);
      expect(contrast(tokens['risk-crit'], tokens['surface-1']), `${id} critical`).toBeGreaterThan(3);
    }
  });

  it('derives a hex window background from the base surface', () => {
    for (const id of THEME_IDS) {
      expect(themeWindowBackground(id)).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(themeWindowBackground('vscode-light')).toBe('#ffffff');
  });

  it('recognises only known theme ids', () => {
    expect(isThemeId('vscode-dark')).toBe(true);
    expect(isThemeId('not-a-theme')).toBe(false);
    expect(isThemeId(42)).toBe(false);
    expect(isThemeId(null)).toBe(false);
  });

  it('has a default theme that exists', () => {
    expect(THEMES[DEFAULT_THEME_ID]).toBeDefined();
  });
});

describe('CSS first-paint fallback', () => {
  /**
   * globals.css inlines the default theme so the very first paint is already correct. If it
   * drifts from the TypeScript definition the app flashes the wrong colours on launch, so the
   * two are pinned together here.
   */
  it('matches the default theme token for token', () => {
    const css = readFileSync(CSS_PATH, 'utf8');
    const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    const defaults = getTheme(DEFAULT_THEME_ID).tokens;

    for (const token of THEME_TOKEN_NAMES) {
      expect(rootBlock, `globals.css --${token}`).toContain(`--${token}: ${defaults[token]};`);
    }
  });
});
