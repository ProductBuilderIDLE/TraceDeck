import {
  DEFAULT_THEME_ID,
  THEME_TOKEN_NAMES,
  getTheme,
  isThemeId,
  type ThemeId,
} from '@shared/theme';

const STORAGE_KEY = 'tracedeck.theme';

/**
 * Reads the stored theme. Storage can throw in a restricted context, and its contents are
 * user-editable, so an unrecognised value falls back rather than propagating.
 */
export function loadStoredTheme(): ThemeId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isThemeId(stored) ? stored : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function storeTheme(id: ThemeId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // A theme that cannot be remembered is a minor annoyance, not a failure worth surfacing.
  }
}

/**
 * Writes the theme's tokens onto the document root. Tailwind reads them through
 * `rgb(var(--token) / <alpha-value>)`, so every colour in the UI updates at once.
 */
export function applyTheme(id: ThemeId): void {
  const theme = getTheme(id);
  const root = document.documentElement;

  for (const token of THEME_TOKEN_NAMES) {
    root.style.setProperty(`--${token}`, theme.tokens[token]);
  }

  root.dataset['theme'] = theme.id;
  // Drives the native form-control and scrollbar rendering for this appearance.
  root.style.colorScheme = theme.appearance;
}

/**
 * Resolves a theme token to a concrete `rgb()` string for canvas rendering.
 *
 * The comma-separated form is deliberate: Cytoscape's colour parser does not understand the
 * modern space-separated syntax and silently falls back to a default when given it.
 */
export function tokenColor(token: string, fallback = 'rgb(0, 0, 0)'): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--${token}`).trim();
  if (value.length === 0) return fallback;
  return `rgb(${value.split(/\s+/).join(', ')})`;
}
