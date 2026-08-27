/**
 * Theme definitions, and the single source of truth for every colour in the app.
 *
 * Tokens are stored as space-separated sRGB channels ("122 162 247") rather than hex, because
 * Tailwind composes them as `rgb(var(--token) / <alpha-value>)`. That is what makes opacity
 * modifiers like `bg-brand/15` work against a runtime-swappable variable.
 *
 * The editor-derived themes are careful approximations built from published UI colours, not
 * exact copies, and they are labelled that way in the UI.
 */

export type ThemeId = 'tracedeck-dark' | 'cursor-dark' | 'vscode-dark' | 'vscode-light';

export type ThemeAppearance = 'dark' | 'light';

export interface ThemeTokens {
  'surface-0': string;
  'surface-1': string;
  'surface-2': string;
  'surface-3': string;
  'surface-4': string;
  edge: string;
  ink: string;
  'ink-muted': string;
  'ink-faint': string;
  brand: string;
  'brand-dim': string;
  'risk-low': string;
  'risk-med': string;
  'risk-high': string;
  'risk-crit': string;
}

export interface Theme {
  id: ThemeId;
  label: string;
  description: string;
  appearance: ThemeAppearance;
  tokens: ThemeTokens;
}

export const THEME_TOKEN_NAMES = [
  'surface-0',
  'surface-1',
  'surface-2',
  'surface-3',
  'surface-4',
  'edge',
  'ink',
  'ink-muted',
  'ink-faint',
  'brand',
  'brand-dim',
  'risk-low',
  'risk-med',
  'risk-high',
  'risk-crit',
] as const satisfies readonly (keyof ThemeTokens)[];

export const THEMES: Record<ThemeId, Theme> = {
  'tracedeck-dark': {
    id: 'tracedeck-dark',
    label: 'TraceDeck Dark',
    description: 'A cool blue-violet palette tuned so the graph reads clearly at small sizes.',
    appearance: 'dark',
    tokens: {
      'surface-0': '26 27 38',
      'surface-1': '31 33 46',
      'surface-2': '36 40 59',
      'surface-3': '46 51 74',
      'surface-4': '59 66 97',
      edge: '41 46 66',
      ink: '192 202 245',
      'ink-muted': '154 165 206',
      'ink-faint': '104 113 154',
      brand: '122 162 247',
      'brand-dim': '61 90 154',
      'risk-low': '158 206 106',
      'risk-med': '224 175 104',
      'risk-high': '255 158 100',
      'risk-crit': '247 118 142',
    },
  },

  'cursor-dark': {
    id: 'cursor-dark',
    label: 'Cursor Dark',
    description: 'Near-neutral dark greys, approximating the Cursor editor interface.',
    appearance: 'dark',
    tokens: {
      'surface-0': '24 24 24',
      'surface-1': '31 31 31',
      'surface-2': '38 38 38',
      'surface-3': '48 48 48',
      'surface-4': '62 62 62',
      edge: '47 47 47',
      ink: '226 226 226',
      'ink-muted': '161 161 161',
      'ink-faint': '117 117 117',
      brand: '77 156 255',
      'brand-dim': '42 96 163',
      'risk-low': '74 195 137',
      'risk-med': '224 178 90',
      'risk-high': '240 138 82',
      'risk-crit': '240 97 97',
    },
  },

  'vscode-dark': {
    id: 'vscode-dark',
    label: 'VS Code Dark',
    description: 'Approximates the Visual Studio Code Dark Modern interface.',
    appearance: 'dark',
    tokens: {
      'surface-0': '31 31 31',
      'surface-1': '24 24 24',
      'surface-2': '42 42 42',
      'surface-3': '55 55 55',
      'surface-4': '69 69 69',
      edge: '43 43 43',
      ink: '204 204 204',
      'ink-muted': '156 156 156',
      'ink-faint': '117 117 117',
      brand: '77 170 252',
      'brand-dim': '0 120 212',
      'risk-low': '137 209 133',
      'risk-med': '204 167 0',
      'risk-high': '255 140 0',
      'risk-crit': '241 76 76',
    },
  },

  'vscode-light': {
    id: 'vscode-light',
    label: 'VS Code Light',
    description: 'Approximates the Visual Studio Code Light Modern interface.',
    appearance: 'light',
    tokens: {
      'surface-0': '255 255 255',
      'surface-1': '248 248 248',
      'surface-2': '241 241 241',
      'surface-3': '229 229 229',
      'surface-4': '212 212 212',
      edge: '225 225 225',
      ink: '59 59 59',
      'ink-muted': '97 97 97',
      'ink-faint': '133 133 133',
      brand: '0 95 184',
      'brand-dim': '0 120 212',
      'risk-low': '19 122 63',
      'risk-med': '154 103 0',
      'risk-high': '191 87 0',
      'risk-crit': '205 43 49',
    },
  },
};

export const DEFAULT_THEME_ID: ThemeId = 'tracedeck-dark';

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && value in THEMES;
}

export function getTheme(id: ThemeId): Theme {
  return THEMES[id];
}

function channelsToHex(channels: string): string {
  const parts = channels.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return '#000000';
  return `#${parts.map((part) => Math.max(0, Math.min(255, part)).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The colour Electron paints behind the page. Matching it to the theme's base surface stops
 * the window flashing a mismatched colour while the renderer boots or during a resize.
 */
export function themeWindowBackground(id: ThemeId): string {
  return channelsToHex(THEMES[id].tokens['surface-0']);
}

export function themeAppearance(id: ThemeId): ThemeAppearance {
  return THEMES[id].appearance;
}
